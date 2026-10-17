// Single-page UI served at "/". All API calls send the token as a bearer header.
export const UI_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>KRS Downloader</title>
<style>
  :root { --bg:#f6f7f9; --card:#fff; --text:#1c1f24; --muted:#636b76; --border:#d9dde3; --accent:#f38020; --err:#c62828; --ok:#2e7d32; }
  @media (prefers-color-scheme: dark) {
    :root { --bg:#14161a; --card:#1d2026; --text:#e8eaed; --muted:#9aa1ab; --border:#30343c; --err:#ef5350; --ok:#66bb6a; }
  }
  * { box-sizing: border-box; }
  body { margin:0; background:var(--bg); color:var(--text); font:15px/1.5 system-ui, sans-serif; }
  main { max-width:760px; margin:0 auto; padding:24px 16px; }
  h1 { font-size:22px; margin:0 0 16px; }
  section { background:var(--card); border:1px solid var(--border); border-radius:10px; padding:16px; margin-bottom:16px; }
  label { display:block; font-size:13px; color:var(--muted); margin:10px 0 4px; }
  input { width:100%; padding:9px 10px; border:1px solid var(--border); border-radius:6px; background:var(--bg); color:var(--text); font:inherit; }
  button { margin-top:12px; padding:9px 16px; border:0; border-radius:6px; background:var(--accent); color:#fff; font:inherit; font-weight:600; cursor:pointer; }
  button:disabled { opacity:.6; cursor:wait; }
  button.link { background:none; color:var(--err); padding:0; margin:0; font-weight:400; }
  #status { margin-top:12px; min-height:1.5em; word-break:break-all; }
  .err { color:var(--err); } .ok { color:var(--ok); }
  table { width:100%; border-collapse:collapse; font-size:14px; }
  td, th { text-align:left; padding:6px 4px; border-bottom:1px solid var(--border); vertical-align:top; }
  td.name { word-break:break-all; }
  a { color:var(--accent); }
  .muted { color:var(--muted); }
</style>
</head>
<body>
<main>
  <h1>Save a link to R2</h1>
  <section>
    <label for="token">API token</label>
    <input id="token" type="password" autocomplete="off" placeholder="Bearer token">
    <form id="form">
      <label for="url">Direct download link</label>
      <input id="url" type="url" required placeholder="https://example.com/file.zip">
      <label for="filename">File name (optional)</label>
      <input id="filename" type="text" placeholder="Taken from the link if left empty">
      <button id="submit" type="submit">Save to bucket</button>
    </form>
    <div id="status"></div>
  </section>
  <section>
    <table>
      <thead><tr><th>File</th><th>Size</th><th>Saved</th><th></th></tr></thead>
      <tbody id="files"><tr><td colspan="4" class="muted">Enter your token to see saved files.</td></tr></tbody>
    </table>
  </section>
</main>
<script>
const $ = (id) => document.getElementById(id);
const tokenInput = $("token");
try { tokenInput.value = localStorage.getItem("krs-dl-token") || ""; } catch {}
tokenInput.addEventListener("change", () => {
  try { localStorage.setItem("krs-dl-token", tokenInput.value); } catch {}
  loadFiles();
});

async function api(path, init = {}) {
  const res = await fetch(path, {
    ...init,
    headers: { ...(init.headers || {}), authorization: "Bearer " + tokenInput.value },
  });
  if (res.status === 204) return null;
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || "HTTP " + res.status);
  return data;
}

function formatSize(n) {
  const units = ["B", "KB", "MB", "GB", "TB"];
  let i = 0;
  while (n >= 1024 && i < units.length - 1) { n /= 1024; i++; }
  return n.toFixed(i ? 1 : 0) + " " + units[i];
}

function setStatus(text, cls) {
  const el = $("status");
  el.textContent = text;
  el.className = cls || "";
}

$("form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const button = $("submit");
  button.disabled = true;
  setStatus("Downloading… large files can take a while.");
  try {
    const body = { url: $("url").value };
    if ($("filename").value.trim()) body.filename = $("filename").value.trim();
    const file = await api("/api/download", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    const el = $("status");
    el.className = "ok";
    el.textContent = "Saved " + file.filename + " (" + formatSize(file.size) + "): ";
    const a = document.createElement("a");
    a.href = file.downloadUrl;
    a.textContent = file.downloadUrl;
    el.appendChild(a);
    $("url").value = "";
    $("filename").value = "";
    loadFiles();
  } catch (err) {
    setStatus(err.message, "err");
  } finally {
    button.disabled = false;
  }
});

async function loadFiles() {
  const tbody = $("files");
  if (!tokenInput.value) return;
  try {
    const { files } = await api("/api/files");
    tbody.replaceChildren();
    if (!files.length) {
      tbody.innerHTML = '<tr><td colspan="4" class="muted">No files yet.</td></tr>';
      return;
    }
    for (const f of files) {
      const tr = document.createElement("tr");
      const name = document.createElement("td");
      name.className = "name";
      const a = document.createElement("a");
      a.href = f.downloadUrl;
      a.textContent = f.key.split("/").pop();
      name.appendChild(a);
      const size = document.createElement("td");
      size.textContent = formatSize(f.size);
      const when = document.createElement("td");
      when.textContent = new Date(f.uploaded).toLocaleString();
      const actions = document.createElement("td");
      const del = document.createElement("button");
      del.className = "link";
      del.textContent = "Delete";
      del.onclick = async () => {
        if (!confirm("Delete " + a.textContent + "?")) return;
        try {
          await api("/api/files/" + f.key.split("/").map(encodeURIComponent).join("/"), { method: "DELETE" });
          loadFiles();
        } catch (err) { setStatus(err.message, "err"); }
      };
      actions.appendChild(del);
      tr.append(name, size, when, actions);
      tbody.appendChild(tr);
    }
  } catch (err) {
    tbody.innerHTML = "";
    const tr = document.createElement("tr");
    const td = document.createElement("td");
    td.colSpan = 4;
    td.className = "err";
    td.textContent = err.message;
    tr.appendChild(td);
    tbody.appendChild(tr);
  }
}
loadFiles();
</script>
</body>
</html>`;
