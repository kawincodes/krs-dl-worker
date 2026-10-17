// Streams a remote file into R2 without holding the whole file in memory.

const MIB = 1024 * 1024;
// Smallest multipart part. R2 needs at least 5 MiB, and every part except the
// last must be the same size.
export const PART_SIZE = 16 * MIB;
// The Workers Free plan allows 1,000 calls to Cloudflare services (R2) per
// request. Leave room for creating and completing the upload.
export const MAX_PARTS = 900;
// While one part uploads the next one downloads, so two part buffers are in
// memory. A Worker has 128 MB, so above this size upload one part at a time.
const PIPELINE_MAX_PART = 40 * MIB;
// Files over this size, from sources that support range requests, are fetched
// one byte range at a time, each piped natively into one multipart part. That
// keeps CPU time near zero and lets us report progress after each part.
export const RANGED_MIN = 256 * MIB;
// Otherwise, files with a known length up to this size go up in a single
// streamed put. R2's single-put limit is just under 5 GiB.
const SINGLE_PUT_MAX = 4 * 1024 * MIB;
// The Free plan allows 50 fetch() calls per request, so use at most 40 ranges
// and keep the rest for retries. Ranges are at least 128 MiB because some
// hosts throttle clients that make many requests per minute.
const RANGED_MAX_PARTS = 40;
const RANGED_MIN_PART = 128 * MIB;
const RANGED_RETRIES = 8;

export class HttpError extends Error {
	constructor(
		readonly status: number,
		message: string,
	) {
		super(message);
	}
}

export interface SaveOptions {
	key: string;
	body: ReadableStream<Uint8Array>;
	// Exact byte count, or null when the upstream did not give a usable one.
	length: number | null;
	maxBytes: number;
	httpMetadata: R2HTTPMetadata;
	customMetadata: Record<string, string>;
	// Final URL of a source that advertised `Accept-Ranges: bytes`, else null.
	rangeUrl: string | null;
	fetchHeaders: Record<string, string>;
	// Called with the number of bytes stored so far, after each part.
	onProgress?: (bytes: number) => void;
}

export async function saveStream(bucket: R2Bucket, opts: SaveOptions): Promise<number> {
	if (opts.length !== null && opts.length > opts.maxBytes) {
		await opts.body.cancel();
		throw new HttpError(413, `File is ${opts.length} bytes; the limit is ${opts.maxBytes}`);
	}
	const putOptions = { httpMetadata: opts.httpMetadata, customMetadata: opts.customMetadata };

	if (opts.length !== null && opts.length > RANGED_MIN && opts.rangeUrl !== null) {
		await opts.body.cancel();
		return rangedUpload(bucket, opts.key, opts.rangeUrl, opts.length, opts.fetchHeaders, putOptions, opts.onProgress);
	}
	if (opts.length !== null && opts.length <= SINGLE_PUT_MAX) {
		// R2 needs to know the length of a streamed body up front.
		const { readable, writable } = new FixedLengthStream(opts.length);
		const [object] = await Promise.all([
			bucket.put(opts.key, readable, putOptions),
			opts.body.pipeTo(writable),
		]);
		return object.size;
	}
	// Fallback for unknown sizes, or big files from sources without range
	// support. Bytes pass through memory, which costs CPU time, so on the Free
	// plan this only works up to a few hundred MB.
	const partSize = opts.length === null ? PART_SIZE : partSizeFor(opts.length);
	return multipartUpload(bucket, opts.key, opts.body, partSize, opts.maxBytes, putOptions, opts.onProgress);
}

// Smallest part size (in whole MiB) that fits the file in MAX_PARTS parts.
export function partSizeFor(length: number): number {
	return Math.max(PART_SIZE, Math.ceil(length / MAX_PARTS / MIB) * MIB);
}

// Part size (in whole MiB) for ranged uploads; parts can be up to 5 GiB.
export function rangedPartSize(length: number): number {
	return Math.max(RANGED_MIN_PART, Math.ceil(length / RANGED_MAX_PARTS / MIB) * MIB);
}

// Fetches the file one byte range at a time and pipes each response straight
// into an R2 part. No bytes touch JavaScript, so CPU time stays near zero.
export async function rangedUpload(
	bucket: R2Bucket,
	key: string,
	url: string,
	length: number,
	fetchHeaders: Record<string, string>,
	putOptions: R2MultipartOptions,
	onProgress?: (bytes: number) => void,
	partSize = rangedPartSize(length),
): Promise<number> {
	if (partSize > 5 * 1024 * MIB) {
		throw new HttpError(413, "File is too large for an R2 multipart upload");
	}
	const upload = await bucket.createMultipartUpload(key, putOptions);
	const parts: R2UploadedPart[] = [];
	let retriesLeft = RANGED_RETRIES;

	try {
		for (let start = 0; start < length; start += partSize) {
			const end = Math.min(start + partSize, length) - 1;
			for (let attempt = 1; ; attempt++) {
				try {
					parts.push(await uploadRange(upload, parts.length + 1, url, start, end, fetchHeaders));
					onProgress?.(end + 1);
					break;
				} catch (err) {
					const { final, retryAfter } = err as { final?: boolean; retryAfter?: string | null };
					if (final || retriesLeft-- <= 0) throw err;
					await sleep(backoffMs(attempt, retryAfter));
				}
			}
		}
		await upload.complete(parts);
		return length;
	} catch (err) {
		await upload.abort().catch(() => {});
		throw err;
	}
}

async function uploadRange(
	upload: R2MultipartUpload,
	partNumber: number,
	url: string,
	start: number,
	end: number,
	fetchHeaders: Record<string, string>,
): Promise<R2UploadedPart> {
	const res = await fetch(url, {
		headers: { ...fetchHeaders, range: `bytes=${start}-${end}`, "accept-encoding": "identity" },
	});
	if (res.status !== 206 || !res.body) {
		await res.body?.cancel();
		// Throttling and server errors are worth retrying; anything else is not.
		const retryable = res.status === 429 || res.status >= 500;
		throw Object.assign(new HttpError(502, `Source answered a range request with HTTP ${res.status}`), {
			final: !retryable,
			retryAfter: res.headers.get("retry-after"),
		});
	}
	const { readable, writable } = new FixedLengthStream(end - start + 1);
	const [part] = await Promise.all([upload.uploadPart(partNumber, readable), res.body.pipeTo(writable)]);
	return part;
}

// Exponential backoff (2s, 4s, 8s, ... up to 30s), or the server's Retry-After.
function backoffMs(attempt: number, retryAfter: string | null | undefined): number {
	const seconds = Number(retryAfter);
	if (retryAfter && Number.isFinite(seconds)) return Math.min(Math.max(seconds, 0), 30) * 1000;
	return Math.min(2000 * 2 ** (attempt - 1), 30_000);
}

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

async function multipartUpload(
	bucket: R2Bucket,
	key: string,
	body: ReadableStream<Uint8Array>,
	partSize: number,
	maxBytes: number,
	putOptions: R2MultipartOptions,
	onProgress?: (bytes: number) => void,
): Promise<number> {
	// An IdentityTransformStream gives a byte stream that supports
	// readAtLeast(), which fills a whole part natively in one call. Copying
	// chunk by chunk in JavaScript would blow the CPU-time limit on big files.
	const reader = body.pipeThrough(new IdentityTransformStream()).getReader({ mode: "byob" });
	const upload = await bucket.createMultipartUpload(key, putOptions);
	const pipeline = partSize <= PIPELINE_MAX_PART;
	const parts: R2UploadedPart[] = [];
	let inFlight: Promise<R2UploadedPart> | null = null;
	let total = 0;

	try {
		for (;;) {
			const chunk = await readPart(reader, partSize);
			if (chunk.byteLength === 0) break;
			total += chunk.byteLength;
			if (total > maxBytes) {
				throw new HttpError(413, `File is larger than the ${maxBytes} byte limit`);
			}
			if (inFlight) {
				parts.push(await inFlight);
				onProgress?.(total - chunk.byteLength);
			}
			if (parts.length >= MAX_PARTS) {
				throw new HttpError(413, "File is too large to upload in one request");
			}

			inFlight = upload.uploadPart(parts.length + 1, chunk);
			// Errors surface when it is awaited; don't report them as unhandled meanwhile.
			inFlight.catch(() => {});
			if (!pipeline) {
				parts.push(await inFlight);
				inFlight = null;
				onProgress?.(total);
			}
			if (chunk.byteLength < partSize) break;
		}
		if (inFlight) parts.push(await inFlight);

		if (total === 0) {
			// A multipart upload needs at least one non-empty part.
			await upload.abort();
			await bucket.put(key, new Uint8Array(0), putOptions);
			return 0;
		}
		await upload.complete(parts);
		return total;
	} catch (err) {
		await reader.cancel().catch(() => {});
		await upload.abort().catch(() => {});
		throw err;
	}
}

// Reads exactly `size` bytes, or fewer only at the end of the stream.
async function readPart(reader: ReadableStreamBYOBReader, size: number): Promise<Uint8Array> {
	let buffer = new ArrayBuffer(size);
	let filled = 0;
	while (filled < size) {
		const { value, done } = await reader.readAtLeast(size - filled, new Uint8Array(buffer, filled, size - filled));
		if (value) {
			// The read transfers the buffer; keep using the returned one.
			buffer = value.buffer as ArrayBuffer;
			filled += value.byteLength;
		}
		if (done) break;
	}
	return new Uint8Array(buffer, 0, filled);
}
