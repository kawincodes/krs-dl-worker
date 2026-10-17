import { HttpError, saveStream } from "./storage";

const DEFAULT_MAX_BYTES = 5 * 1024 * 1024 * 1024;

export default {
	async fetch(request, env): Promise<Response> {
		try {
			return await route(request, env);
		} catch (err) {
			if (err instanceof HttpError) {
				return json({ error: err.message }, err.status);
			}
			console.error(err);
			return json({ error: "Internal error" }, 500);
		}
	},
} satisfies ExportedHandler<Env>;

async function route(request: Request, env: Env): Promise<Response> {
	const url = new URL(request.url);
	const { pathname } = url;
	const method = request.method;

	if (pathname === "/api/download" && method === "POST") {
		await requireAuth(request, env);
		return handleDownload(request, env, url.origin);
	}

	if (pathname === "/api/files" && method === "GET") {
		await requireAuth(request, env);
		return handleList(env, url);
	}

	if (pathname.startsWith("/api/files/") && method === "DELETE") {
		await requireAuth(request, env);
		const key = decodeKey(pathname.slice("/api/files/".length));
		await env.BUCKET.delete(key);
		return new Response(null, { status: 204 });
	}

	if (pathname.startsWith("/files/") && (method === "GET" || method === "HEAD")) {
		if (String(env.PUBLIC_DOWNLOADS) !== "true") {
			await requireAuth(request, env);
		}
		return handleServe(request, env, decodeKey(pathname.slice("/files/".length)));
	}

	throw new HttpError(404, "Not found");
}

async function handleDownload(request: Request, env: Env, origin: string): Promise<Response> {
	let input: { url?: unknown; filename?: unknown };
	try {
		input = await request.json();
	} catch {
		throw new HttpError(400, "Body must be JSON: {\"url\": \"https://...\"}");
	}
	if (typeof input.url !== "string") {
		throw new HttpError(400, "\"url\" is required");
	}
	let source: URL;
	try {
		source = new URL(input.url);
	} catch {
		throw new HttpError(400, "\"url\" is not a valid URL");
	}
	if (source.protocol !== "http:" && source.protocol !== "https:") {
		throw new HttpError(400, "Only http and https links are supported");
	}

	const fetchHeaders = { "user-agent": "krs-dl-worker/1.0" };
	let upstream: Response;
	try {
		upstream = await fetch(source.toString(), { redirect: "follow", headers: fetchHeaders });
	} catch (err) {
		throw new HttpError(502, `Could not reach ${source.host}: ${String(err)}`);
	}
	if (!upstream.ok || !upstream.body) {
		await upstream.body?.cancel();
		throw new HttpError(502, `Source responded with HTTP ${upstream.status}`);
	}

	const filename = sanitizeFilename(
		(typeof input.filename === "string" && input.filename) ||
			filenameFromDisposition(upstream.headers.get("content-disposition")) ||
			filenameFromUrl(new URL(upstream.url || source.toString())),
	);
	const key = `${crypto.randomUUID()}/${filename}`;
	const contentType = upstream.headers.get("content-type") || "application/octet-stream";

	const size = await saveStream(env.BUCKET, {
		key,
		body: upstream.body,
		length: knownLength(upstream.headers),
		maxBytes: maxBytes(env),
		rangeUrl: acceptsRanges(upstream.headers) ? upstream.url || source.toString() : null,
		fetchHeaders,
		httpMetadata: {
			contentType,
			contentDisposition: `attachment; filename*=UTF-8''${encodeURIComponent(filename)}`,
		},
		customMetadata: { sourceUrl: source.toString() },
	});

	return json(
		{
			key,
			filename,
			size,
			contentType,
			sourceUrl: source.toString(),
			downloadUrl: fileUrl(origin, key),
		},
		201,
	);
}

async function handleList(env: Env, url: URL): Promise<Response> {
	const listed = await env.BUCKET.list({
		cursor: url.searchParams.get("cursor") || undefined,
		limit: 100,
		include: ["httpMetadata", "customMetadata"],
	});
	return json({
		files: listed.objects.map((obj) => ({
			key: obj.key,
			size: obj.size,
			uploaded: obj.uploaded.toISOString(),
			contentType: obj.httpMetadata?.contentType ?? null,
			sourceUrl: obj.customMetadata?.sourceUrl ?? null,
			downloadUrl: fileUrl(url.origin, obj.key),
		})),
		cursor: listed.truncated ? listed.cursor : null,
	});
}

async function handleServe(request: Request, env: Env, key: string): Promise<Response> {
	if (request.method === "HEAD") {
		const head = await env.BUCKET.head(key);
		if (!head) throw new HttpError(404, "File not found");
		const headers = objectHeaders(head);
		headers.set("content-length", String(head.size));
		return new Response(null, { headers });
	}

	const object = await env.BUCKET.get(key, {
		range: request.headers,
		onlyIf: request.headers,
	});
	if (!object) throw new HttpError(404, "File not found");

	const headers = objectHeaders(object);
	if (!("body" in object)) {
		// A conditional header (If-None-Match, If-Modified-Since, ...) did not match.
		const notModified = request.headers.has("if-none-match") || request.headers.has("if-modified-since");
		return new Response(null, { status: notModified ? 304 : 412, headers });
	}

	const range = resolveRange(object.range, object.size);
	if (range && request.headers.has("range")) {
		headers.set("content-range", `bytes ${range.start}-${range.end}/${object.size}`);
		headers.set("content-length", String(range.end - range.start + 1));
		return new Response(object.body, { status: 206, headers });
	}
	headers.set("content-length", String(object.size));
	return new Response(object.body, { headers });
}

function objectHeaders(object: R2Object): Headers {
	const headers = new Headers();
	object.writeHttpMetadata(headers);
	headers.set("etag", object.httpEtag);
	headers.set("accept-ranges", "bytes");
	headers.set("last-modified", object.uploaded.toUTCString());
	return headers;
}

function resolveRange(range: R2Range | undefined, size: number): { start: number; end: number } | null {
	if (!range) return null;
	if ("suffix" in range && range.suffix !== undefined) {
		return { start: Math.max(0, size - range.suffix), end: size - 1 };
	}
	const start = ("offset" in range ? range.offset : undefined) ?? 0;
	const length = ("length" in range ? range.length : undefined) ?? size - start;
	return { start, end: Math.min(size, start + length) - 1 };
}

async function requireAuth(request: Request, env: Env): Promise<void> {
	if (!env.API_TOKEN) {
		throw new HttpError(500, "API_TOKEN secret is not configured");
	}
	const header = request.headers.get("authorization") ?? "";
	const provided = header.startsWith("Bearer ") ? header.slice("Bearer ".length) : "";
	if (!(await tokensMatch(provided, env.API_TOKEN))) {
		throw new HttpError(401, "Missing or invalid API token");
	}
}

// Compares hashes so the comparison takes the same time whatever the input length.
async function tokensMatch(a: string, b: string): Promise<boolean> {
	const encoder = new TextEncoder();
	const [ha, hb] = await Promise.all([
		crypto.subtle.digest("SHA-256", encoder.encode(a)),
		crypto.subtle.digest("SHA-256", encoder.encode(b)),
	]);
	return crypto.subtle.timingSafeEqual(ha, hb);
}

function knownLength(headers: Headers): number | null {
	// fetch() transparently decompresses, so Content-Length would describe
	// the compressed bytes, not the ones we receive.
	const encoding = headers.get("content-encoding");
	if (encoding && encoding !== "identity") return null;
	const value = headers.get("content-length");
	if (value === null || !/^\d+$/.test(value)) return null;
	return Number(value);
}

function acceptsRanges(headers: Headers): boolean {
	return headers.get("accept-ranges")?.toLowerCase() === "bytes";
}

function maxBytes(env: Env): number {
	const value = Number(env.MAX_FILE_BYTES);
	return Number.isFinite(value) && value > 0 ? value : DEFAULT_MAX_BYTES;
}

export function filenameFromDisposition(header: string | null): string | null {
	if (!header) return null;
	const extended = /filename\*\s*=\s*(?:UTF-8|utf-8)?''([^;]+)/i.exec(header);
	if (extended) {
		try {
			return decodeURIComponent(extended[1].trim().replace(/^"|"$/g, ""));
		} catch {
			// Fall through to the plain filename parameter.
		}
	}
	const plain = /filename\s*=\s*("([^"]*)"|[^;]+)/i.exec(header);
	if (plain) return (plain[2] ?? plain[1]).trim();
	return null;
}

export function filenameFromUrl(url: URL): string | null {
	const last = url.pathname.split("/").filter(Boolean).pop();
	if (!last) return null;
	try {
		return decodeURIComponent(last);
	} catch {
		return last;
	}
}

export function sanitizeFilename(name: string | null): string {
	const cleaned = (name ?? "")
		.replace(/[\u0000-\u001f\u007f/\\]/g, "_")
		.replace(/^\.+/, "")
		.trim()
		.slice(0, 200);
	return cleaned || "download";
}

function decodeKey(encoded: string): string {
	let key: string;
	try {
		key = encoded.split("/").map(decodeURIComponent).join("/");
	} catch {
		throw new HttpError(400, "Invalid file path");
	}
	if (!key) throw new HttpError(404, "Not found");
	return key;
}

function fileUrl(origin: string, key: string): string {
	return `${origin}/files/${key.split("/").map(encodeURIComponent).join("/")}`;
}

function json(data: unknown, status = 200): Response {
	return Response.json(data, { status });
}
