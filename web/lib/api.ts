export interface SavedFile {
	key: string;
	filename: string;
	size: number;
	contentType: string;
	sourceUrl: string;
	downloadUrl: string;
}

export interface StoredFile {
	key: string;
	size: number;
	uploaded: string;
	contentType: string | null;
	sourceUrl: string | null;
	downloadUrl: string;
}

export class ApiError extends Error {
	constructor(
		readonly status: number,
		message: string,
	) {
		super(message);
	}
}

async function request<T>(token: string, path: string, init: RequestInit = {}): Promise<T> {
	const headers = new Headers(init.headers);
	headers.set("authorization", `Bearer ${token}`);
	const res = await fetch(path, { ...init, headers });
	if (res.status === 204) return undefined as T;
	const data = await res.json().catch(() => ({}));
	if (!res.ok) throw new ApiError(res.status, data.error || `HTTP ${res.status}`);
	return data as T;
}

export function saveLink(token: string, url: string, filename?: string) {
	return request<SavedFile>(token, "/api/download", {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify(filename ? { url, filename } : { url }),
	});
}

export function listFiles(token: string, cursor?: string | null) {
	const query = cursor ? `?cursor=${encodeURIComponent(cursor)}` : "";
	return request<{ files: StoredFile[]; cursor: string | null }>(token, `/api/files${query}`);
}

export function deleteFile(token: string, key: string) {
	return request<void>(token, `/api/files/${key.split("/").map(encodeURIComponent).join("/")}`, {
		method: "DELETE",
	});
}

export function fileName(key: string) {
	return key.slice(key.indexOf("/") + 1) || key;
}

export function formatBytes(bytes: number) {
	const units = ["B", "KB", "MB", "GB", "TB"];
	let value = bytes;
	let unit = 0;
	while (value >= 1024 && unit < units.length - 1) {
		value /= 1024;
		unit++;
	}
	return `${value.toFixed(unit === 0 || value >= 100 ? 0 : 1)} ${units[unit]}`;
}

const relative = new Intl.RelativeTimeFormat(undefined, { numeric: "auto" });

export function timeAgo(iso: string) {
	const seconds = (new Date(iso).getTime() - Date.now()) / 1000;
	const steps: [Intl.RelativeTimeFormatUnit, number][] = [
		["year", 31_536_000],
		["month", 2_592_000],
		["day", 86_400],
		["hour", 3_600],
		["minute", 60],
	];
	for (const [unit, size] of steps) {
		if (Math.abs(seconds) >= size) return relative.format(Math.round(seconds / size), unit);
	}
	return "just now";
}

export function hostOf(url: string | null) {
	if (!url) return null;
	try {
		return new URL(url).host;
	} catch {
		return null;
	}
}
