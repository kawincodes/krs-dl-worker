# krs-dl-worker

A Cloudflare Worker that takes a direct download link, downloads the file and
saves it to an R2 bucket. The file is streamed straight into R2, so it never
has to fit in the Worker's memory.

- `GET /` – a small web page: paste a link, save it, see and delete saved files.
- `POST /api/download` – save a link to the bucket (needs the token).
- `GET /api/files` – list saved files (needs the token).
- `DELETE /api/files/<key>` – delete a file (needs the token).
- `GET /files/<key>` – download a saved file (supports `Range` and `HEAD`).

## Setup

```sh
npm install
npx wrangler r2 bucket create krs-dl     # or change bucket_name in wrangler.jsonc
npx wrangler secret put API_TOKEN        # pick a long random string
npm run deploy
```

For local development, copy `.dev.vars.example` to `.dev.vars`, set a token,
and run `npm run dev`. Local runs use a simulated R2 bucket.

## API

All `/api/*` routes need `Authorization: Bearer <API_TOKEN>`.

```sh
curl -X POST https://<your-worker>/api/download \
  -H "Authorization: Bearer $API_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"url": "https://example.com/file.zip", "filename": "optional-name.zip"}'
```

Response (`201`):

```json
{
  "key": "6f1c…/file.zip",
  "filename": "file.zip",
  "size": 1048576,
  "contentType": "application/zip",
  "sourceUrl": "https://example.com/file.zip",
  "downloadUrl": "https://<your-worker>/files/6f1c…/file.zip"
}
```

The file name comes from `filename` in the request, else the source's
`Content-Disposition` header, else the last part of the URL. Each key starts
with a random UUID, so saving the same file twice never overwrites anything.

Errors come back as `{"error": "..."}` with `400` (bad input), `401` (bad
token), `413` (file too large) or `502` (the source failed or returned a
non-2xx status).

## Configuration

| Name | Where | Default | Meaning |
| --- | --- | --- | --- |
| `API_TOKEN` | secret | – | Required. Requests without it are refused. |
| `MAX_FILE_BYTES` | `vars` | `5368709120` (5 GiB) | Largest file accepted. |
| `PUBLIC_DOWNLOADS` | `vars` | `"true"` | `"true"`: anyone with a `/files/…` link can download it (links contain a random UUID). `"false"`: downloads need the token too. |

## How large files are handled

- If the source sends a `Content-Length` (and no compression), the body is
  piped into a single R2 `put`.
- Otherwise, or above 4 GiB, the Worker uses an R2 multipart upload with
  10 MiB parts, up to roughly 97 GiB.

The download runs while the `POST` request is open, so the caller has to wait
until the file is stored. Very large files can run into the Workers CPU-time
limit, especially on the multipart path, which copies bytes in JavaScript.
On the Workers Paid plan you can raise it with `limits.cpu_ms` in
`wrangler.jsonc`.

## Development

```sh
npm test            # vitest inside the Workers runtime (Miniflare)
npm run typecheck
npm run cf-typegen  # regenerate worker-configuration.d.ts after editing wrangler.jsonc
```
