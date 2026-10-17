# krs-dl-worker

A Cloudflare Worker that takes a direct download link, downloads the file and
saves it to an R2 bucket. The file is streamed straight into R2, so it never
has to fit in the Worker's memory.

- `/` – a web app (React + HeroUI + shadcn/ui + Lucide icons): paste a link,
  save it, then filter, copy, download or delete saved files. Light and dark themes.
- `POST /api/download` – save a link to the bucket (needs the token).
- `GET /api/files` – list saved files (needs the token).
- `DELETE /api/files/<key>` – delete a file (needs the token).
- `GET /files/<key>` – download a saved file (supports `Range` and `HEAD`).

## Setup

```sh
npm install
npx wrangler r2 bucket create krs-dl     # or change bucket_name in wrangler.jsonc
npx wrangler secret put API_TOKEN        # pick a long random string
npm run deploy                           # builds the UI, then deploys
```

For local development, copy `.dev.vars.example` to `.dev.vars`, set a token,
and run `npm run dev`. Vite serves the UI and runs the Worker in the same
process (via `@cloudflare/vite-plugin`), with a simulated R2 bucket.

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
| `MAX_FILE_BYTES` | `vars` | `53687091200` (50 GiB) | Largest file accepted. |
| `PUBLIC_DOWNLOADS` | `vars` | `"true"` | `"true"`: anyone with a `/files/…` link can download it (links contain a random UUID). `"false"`: downloads need the token too. |

## How large files are handled

The Workers Free plan allows only 10 ms of CPU time per request, so the Worker
avoids touching file bytes in JavaScript wherever it can:

- **Up to 4 GiB with a known size:** the download is piped straight into a
  single R2 `put`.
- **Over 4 GiB:** if the source supports range requests (`Accept-Ranges:
  bytes`, which most download servers do), the file is fetched one range at a
  time, at most 40 ranges, and each response is piped straight into an R2
  multipart part. Throttled (429) or failed (5xx) ranges are retried with
  backoff.
- **Unknown size, or over 4 GiB without range support:** bytes are buffered
  into 16 MiB+ parts. This costs CPU time, so on the Free plan it only works
  for files up to a few hundred MB. The Workers Paid plan raises the limit.

Downloads use one connection at a time, like a browser. The `POST` request stays
open until the file is stored, so the caller has to wait. Speed depends on the
source: a 1 GiB file from Hetzner took about a minute.

## Project layout

| Path | What |
| --- | --- |
| `src/` | The Worker: API, R2 storage, file serving. |
| `web/` | The React UI. Vite builds it into static assets served by the Worker. |
| `web/components/ui/` | shadcn/ui components (table, alert dialog, skeleton, toasts). |
| `test/` | Worker tests. |

The UI mixes three libraries:

- **HeroUI v3** – cards, buttons, text fields, search field, chips, tooltips, spinner, progress bar.
- **shadcn/ui** – the files table, delete confirmation dialog, loading skeletons and Sonner toasts.
- **Lucide** – all icons.

HeroUI owns the colors. `web/index.css` maps the token names shadcn/ui
expects (`primary`, `popover`, `muted-foreground`, …) onto HeroUI's palette,
so both libraries follow the same light and dark theme. Add more shadcn
components with `npx shadcn@latest add <name>`; if a new one uses `bg-muted`
or `bg-accent` as a background, switch it to `bg-default`, since those names
mean different things in HeroUI.

## Development

```sh
npm run dev         # UI + Worker on http://localhost:5173
npm test            # Worker tests inside the Workers runtime (Miniflare)
npm run typecheck
npm run cf-typegen  # regenerate worker-configuration.d.ts after editing wrangler.jsonc
```
