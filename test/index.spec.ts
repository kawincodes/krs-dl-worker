import { env } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";
import worker, { filenameFromDisposition, sanitizeFilename } from "../src/index";
import { PART_SIZE } from "../src/storage";

const AUTH = { authorization: "Bearer test-token" };
const realFetch = globalThis.fetch;

// The worker never reads request.cf, so the test request needs none.
type IncomingRequest = Request<unknown, IncomingRequestCfProperties>;

async function call(path: string, init: RequestInit = {}): Promise<Response> {
	return worker.fetch(new Request(`https://dl.example${path}`, init) as IncomingRequest, env);
}

// Routes the worker's outbound fetch to `handler` instead of the network.
function mockUpstream(handler: (url: string) => Response) {
	return vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
		const url = input instanceof Request ? input.url : String(input);
		return handler(url);
	});
}

function save(body: unknown) {
	return call("/api/download", {
		method: "POST",
		headers: { ...AUTH, "content-type": "application/json" },
		body: JSON.stringify(body),
	});
}

// A stream with no declared length, so the worker must use a multipart upload.
function chunkedStream(totalBytes: number, chunkBytes = 1024 * 1024): ReadableStream<Uint8Array> {
	let sent = 0;
	return new ReadableStream({
		pull(controller) {
			if (sent >= totalBytes) return controller.close();
			const n = Math.min(chunkBytes, totalBytes - sent);
			const chunk = new Uint8Array(n);
			for (let i = 0; i < n; i++) chunk[i] = (sent + i) % 251;
			sent += n;
			controller.enqueue(chunk);
		},
	});
}

afterEach(() => {
	vi.restoreAllMocks();
	globalThis.fetch = realFetch;
});

describe("auth", () => {
	it("rejects requests without the token", async () => {
		const res = await call("/api/download", { method: "POST", body: "{}" });
		expect(res.status).toBe(401);
	});

	it("rejects a wrong token", async () => {
		const res = await call("/api/files", { headers: { authorization: "Bearer nope" } });
		expect(res.status).toBe(401);
	});
});

describe("POST /api/download", () => {
	it("stores a file with a known length and serves it back", async () => {
		mockUpstream(
			() =>
				new Response("hello world", {
					headers: { "content-type": "text/plain", "content-length": "11" },
				}),
		);
		const res = await save({ url: "https://files.example/docs/readme.txt" });
		expect(res.status).toBe(201);
		const saved = await res.json<{ key: string; filename: string; size: number; downloadUrl: string }>();
		expect(saved.filename).toBe("readme.txt");
		expect(saved.size).toBe(11);
		expect(saved.key).toMatch(/^[0-9a-f-]{36}\/readme\.txt$/);

		const object = await env.BUCKET.get(saved.key);
		expect(await object!.text()).toBe("hello world");
		expect(object!.customMetadata?.sourceUrl).toBe("https://files.example/docs/readme.txt");

		const download = await call(new URL(saved.downloadUrl).pathname);
		expect(download.status).toBe(200);
		expect(download.headers.get("content-type")).toBe("text/plain");
		expect(download.headers.get("content-disposition")).toContain("readme.txt");
		expect(await download.text()).toBe("hello world");
	});

	it("uses multipart upload when the length is unknown", async () => {
		const total = PART_SIZE * 2 + 12345;
		mockUpstream(() => new Response(chunkedStream(total)));
		const res = await save({ url: "https://files.example/big.bin" });
		expect(res.status).toBe(201);
		const saved = await res.json<{ key: string; size: number }>();
		expect(saved.size).toBe(total);

		const object = await env.BUCKET.get(saved.key);
		const bytes = new Uint8Array(await object!.arrayBuffer());
		expect(bytes.length).toBe(total);
		expect(bytes[PART_SIZE + 7]).toBe((PART_SIZE + 7) % 251);
		expect(bytes[total - 1]).toBe((total - 1) % 251);
	});

	it("prefers the filename from the request, then Content-Disposition", async () => {
		mockUpstream(
			() =>
				new Response("x", {
					headers: { "content-disposition": "attachment; filename=\"report 2026.pdf\"" },
				}),
		);
		const fromHeader = await (await save({ url: "https://files.example/get?id=1" })).json<{ filename: string }>();
		expect(fromHeader.filename).toBe("report 2026.pdf");

		const fromRequest = await (
			await save({ url: "https://files.example/get?id=1", filename: "../custom.pdf" })
		).json<{ filename: string }>();
		expect(fromRequest.filename).toBe("_custom.pdf");
	});

	it("refuses files above MAX_FILE_BYTES", async () => {
		mockUpstream(() => new Response("x", { headers: { "content-length": String(10 * 1024 ** 4) } }));
		const res = await save({ url: "https://files.example/huge.iso" });
		expect(res.status).toBe(413);
	});

	it("reports upstream errors", async () => {
		mockUpstream(() => new Response("gone", { status: 404 }));
		const res = await save({ url: "https://files.example/missing" });
		expect(res.status).toBe(502);
		expect(await res.json()).toEqual({ error: "Source responded with HTTP 404" });
	});

	it("rejects non-http links", async () => {
		expect((await save({ url: "ftp://files.example/a" })).status).toBe(400);
		expect((await save({ url: "not a url" })).status).toBe(400);
		expect((await save({})).status).toBe(400);
	});
});

describe("files", () => {
	it("lists, serves ranges, and deletes", async () => {
		await env.BUCKET.put("abc/data.txt", "0123456789", {
			httpMetadata: { contentType: "text/plain" },
			customMetadata: { sourceUrl: "https://files.example/data.txt" },
		});

		const list = await (await call("/api/files", { headers: AUTH })).json<{ files: { key: string }[] }>();
		expect(list.files.map((f) => f.key)).toContain("abc/data.txt");

		const partial = await call("/files/abc/data.txt", { headers: { range: "bytes=2-5" } });
		expect(partial.status).toBe(206);
		expect(partial.headers.get("content-range")).toBe("bytes 2-5/10");
		expect(await partial.text()).toBe("2345");

		const head = await call("/files/abc/data.txt", { method: "HEAD" });
		expect(head.headers.get("content-length")).toBe("10");

		expect((await call("/api/files/abc/data.txt", { method: "DELETE", headers: AUTH })).status).toBe(204);
		expect((await call("/files/abc/data.txt")).status).toBe(404);
	});
});

describe("filename helpers", () => {
	it("parses Content-Disposition", () => {
		expect(filenameFromDisposition("attachment; filename*=UTF-8''na%C3%AFve.txt")).toBe("naïve.txt");
		expect(filenameFromDisposition("inline; filename=plain.bin")).toBe("plain.bin");
		expect(filenameFromDisposition(null)).toBeNull();
	});

	it("sanitizes names", () => {
		expect(sanitizeFilename("a/b\\c.txt")).toBe("a_b_c.txt");
		expect(sanitizeFilename("...")).toBe("download");
		expect(sanitizeFilename(null)).toBe("download");
	});
});
