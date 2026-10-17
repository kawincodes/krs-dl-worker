// Streams a remote file into R2 without holding the whole file in memory.

// R2 requires every multipart part except the last to be the same size,
// and at least 5 MiB.
export const PART_SIZE = 10 * 1024 * 1024;
const MAX_PARTS = 10_000;
// Files with a known length up to this size go up in a single streamed put.
// R2's single-put limit is just under 5 GiB.
const SINGLE_PUT_MAX = 4 * 1024 * 1024 * 1024;

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
}

export async function saveStream(bucket: R2Bucket, opts: SaveOptions): Promise<number> {
	if (opts.length !== null && opts.length > opts.maxBytes) {
		await opts.body.cancel();
		throw new HttpError(413, `File is ${opts.length} bytes; the limit is ${opts.maxBytes}`);
	}
	const putOptions = { httpMetadata: opts.httpMetadata, customMetadata: opts.customMetadata };

	if (opts.length !== null && opts.length <= SINGLE_PUT_MAX) {
		// R2 needs to know the length of a streamed body up front.
		const { readable, writable } = new FixedLengthStream(opts.length);
		const [object] = await Promise.all([
			bucket.put(opts.key, readable, putOptions),
			opts.body.pipeTo(writable),
		]);
		return object.size;
	}
	return multipartUpload(bucket, opts.key, opts.body, opts.maxBytes, putOptions);
}

async function multipartUpload(
	bucket: R2Bucket,
	key: string,
	body: ReadableStream<Uint8Array>,
	maxBytes: number,
	putOptions: R2MultipartOptions,
): Promise<number> {
	const reader = body.getReader();
	const upload = await bucket.createMultipartUpload(key, putOptions);
	const parts: R2UploadedPart[] = [];
	let buffer = new Uint8Array(PART_SIZE);
	let filled = 0;
	let total = 0;

	try {
		for (;;) {
			const { done, value } = await reader.read();
			if (done) break;
			total += value.byteLength;
			if (total > maxBytes) {
				throw new HttpError(413, `File is larger than the ${maxBytes} byte limit`);
			}
			let offset = 0;
			while (offset < value.byteLength) {
				const n = Math.min(PART_SIZE - filled, value.byteLength - offset);
				buffer.set(value.subarray(offset, offset + n), filled);
				filled += n;
				offset += n;
				if (filled === PART_SIZE) {
					if (parts.length + 1 >= MAX_PARTS) {
						throw new HttpError(413, "File has too many parts for an R2 multipart upload");
					}
					parts.push(await upload.uploadPart(parts.length + 1, buffer));
					buffer = new Uint8Array(PART_SIZE);
					filled = 0;
				}
			}
		}

		if (total === 0) {
			// A multipart upload needs at least one non-empty part.
			await upload.abort();
			await bucket.put(key, new Uint8Array(0), putOptions);
			return 0;
		}
		if (filled > 0) {
			parts.push(await upload.uploadPart(parts.length + 1, buffer.subarray(0, filled)));
		}
		await upload.complete(parts);
		return total;
	} catch (err) {
		await reader.cancel().catch(() => {});
		await upload.abort().catch(() => {});
		throw err;
	}
}
