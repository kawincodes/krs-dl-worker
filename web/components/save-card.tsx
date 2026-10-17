import { Button, Card, Description, InputGroup, Label, ProgressBar, Spinner, TextField, Tooltip } from "@heroui/react";
import { Check, ClipboardPaste, CloudUpload, Copy, Download, FileText, Link2, PartyPopper } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { type SaveProgress, type SavedFile, formatBytes, saveLink } from "@/lib/api";
import { FileIcon } from "./file-icon";

interface Props {
	token: string;
	onSaved: (file: SavedFile) => void;
	onError: (error: unknown) => void;
}

export function SaveCard({ token, onSaved, onError }: Props) {
	const [url, setUrl] = useState("");
	const [filename, setFilename] = useState("");
	const [saving, setSaving] = useState(false);
	const [progress, setProgress] = useState<SaveProgress | null>(null);
	const [result, setResult] = useState<SavedFile | null>(null);

	async function submit(e: React.FormEvent) {
		e.preventDefault();
		setSaving(true);
		setResult(null);
		setProgress(null);
		try {
			const saved = await saveLink(token, url.trim(), filename.trim() || undefined, setProgress);
			setResult(saved);
			setUrl("");
			setFilename("");
			toast.success(`Saved ${saved.filename}`, { description: formatBytes(saved.size) });
			onSaved(saved);
		} catch (err) {
			onError(err);
		} finally {
			setSaving(false);
		}
	}

	async function paste() {
		try {
			setUrl((await navigator.clipboard.readText()).trim());
		} catch {
			toast.error("Clipboard access was blocked by the browser");
		}
	}

	return (
		<Card className="overflow-hidden">
			<Card.Header>
				<div className="flex items-center gap-3">
					<div className="flex size-10 shrink-0 items-center justify-center rounded-xl bg-accent text-accent-foreground">
						<CloudUpload className="size-5" />
					</div>
					<div>
						<Card.Title>Save a direct link</Card.Title>
						<Card.Description>The file is downloaded by the Worker and streamed into R2.</Card.Description>
					</div>
				</div>
			</Card.Header>
			<Card.Content>
				<form className="flex flex-col gap-4" onSubmit={submit}>
					<TextField type="url" value={url} onChange={setUrl} isRequired isDisabled={saving}>
						<Label>Download link</Label>
						<InputGroup variant="secondary">
							<InputGroup.Prefix>
								<Link2 className="size-4 text-muted" />
							</InputGroup.Prefix>
							<InputGroup.Input placeholder="https://example.com/file.zip" />
							<InputGroup.Suffix>
								<Tooltip delay={300}>
									<Button isIconOnly size="sm" variant="ghost" aria-label="Paste link" onPress={paste} isDisabled={saving}>
										<ClipboardPaste className="size-4" />
									</Button>
									<Tooltip.Content>Paste from clipboard</Tooltip.Content>
								</Tooltip>
							</InputGroup.Suffix>
						</InputGroup>
					</TextField>

					<TextField value={filename} onChange={setFilename} isDisabled={saving}>
						<Label>File name</Label>
						<InputGroup variant="secondary">
							<InputGroup.Prefix>
								<FileText className="size-4 text-muted" />
							</InputGroup.Prefix>
							<InputGroup.Input placeholder="Optional" />
						</InputGroup>
						<Description>Leave empty to use the name from the link.</Description>
					</TextField>

					<Button type="submit" variant="primary" size="lg" fullWidth isPending={saving} isDisabled={!url.trim()}>
						{saving ? <Spinner size="sm" color="current" /> : <CloudUpload className="size-4" />}
						{saving ? "Saving to R2…" : "Save to R2"}
					</Button>
				</form>

				{saving && <SaveStatus progress={progress} />}

				{result && !saving && <SavedPanel file={result} />}
			</Card.Content>
		</Card>
	);
}

function SaveStatus({ progress }: { progress: SaveProgress | null }) {
	const total = progress?.total ?? null;
	const bytes = progress?.bytes ?? 0;
	const percent = total ? Math.min(100, (bytes / total) * 100) : null;
	const elapsed = progress?.elapsed ?? 0;

	return (
		<div className="mt-4 flex flex-col gap-2">
			<ProgressBar
				aria-label="Saving to R2"
				size="sm"
				isIndeterminate={percent === null || bytes === 0}
				value={percent ?? undefined}
			>
				<ProgressBar.Track>
					<ProgressBar.Fill />
				</ProgressBar.Track>
			</ProgressBar>
			<div className="flex flex-wrap justify-between gap-x-4 gap-y-1 text-xs text-muted tabular-nums">
				<span>
					{total ? `${formatBytes(bytes)} of ${formatBytes(total)}` : bytes ? `${formatBytes(bytes)} saved` : "Starting…"}
					{percent !== null && bytes > 0 && ` · ${Math.floor(percent)}%`}
				</span>
				<span>
					{formatDuration(elapsed)}
					{elapsed > 0 && bytes > 0 && ` · ${formatBytes(bytes / elapsed)}/s`}
				</span>
			</div>
			<p className="text-xs text-muted">Large files can take several minutes. Keep this tab open.</p>
		</div>
	);
}

function formatDuration(seconds: number) {
	const m = Math.floor(seconds / 60);
	const s = seconds % 60;
	return m ? `${m}m ${String(s).padStart(2, "0")}s` : `${s}s`;
}

function SavedPanel({ file }: { file: SavedFile }) {
	const [copied, setCopied] = useState(false);

	async function copy() {
		await navigator.clipboard.writeText(file.downloadUrl);
		setCopied(true);
		toast.success("Link copied");
		setTimeout(() => setCopied(false), 1500);
	}

	return (
		<div className="mt-4 rounded-xl border border-success/30 bg-success/10 p-3">
			<div className="flex items-center gap-2 text-sm font-medium">
				<PartyPopper className="size-4 text-success" />
				Saved to your bucket
			</div>
			<div className="mt-3 flex items-center gap-3">
				<div className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-surface">
					<FileIcon name={file.filename} contentType={file.contentType} className="size-4" />
				</div>
				<div className="min-w-0 flex-1">
					<div className="truncate text-sm font-medium">{file.filename}</div>
					<div className="text-xs text-muted">{formatBytes(file.size)} · {file.contentType}</div>
				</div>
				<Button size="sm" variant="secondary" onPress={copy}>
					{copied ? <Check className="size-4" /> : <Copy className="size-4" />}
					<span className="hidden sm:inline">{copied ? "Copied" : "Copy link"}</span>
				</Button>
				<Button size="sm" variant="primary" onPress={() => (window.location.href = file.downloadUrl)}>
					<Download className="size-4" />
					<span className="hidden sm:inline">Download</span>
				</Button>
			</div>
		</div>
	);
}
