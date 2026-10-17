import { Button, Card, Chip, SearchField, Tooltip } from "@heroui/react";
import { Check, Copy, Download, FolderOpen, Globe, RefreshCw, Trash2 } from "lucide-react";
import { useMemo, useState } from "react";
import { toast } from "sonner";
import {
	AlertDialog,
	AlertDialogAction,
	AlertDialogCancel,
	AlertDialogContent,
	AlertDialogDescription,
	AlertDialogFooter,
	AlertDialogHeader,
	AlertDialogMedia,
	AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Skeleton } from "@/components/ui/skeleton";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { type StoredFile, fileName, formatBytes, hostOf, timeAgo } from "@/lib/api";
import { FileIcon } from "./file-icon";

interface Props {
	files: StoredFile[];
	loading: boolean;
	hasMore: boolean;
	onRefresh: () => void;
	onLoadMore: () => void;
	onDelete: (file: StoredFile) => Promise<void>;
}

export function FilesCard({ files, loading, hasMore, onRefresh, onLoadMore, onDelete }: Props) {
	const [query, setQuery] = useState("");
	const [pendingDelete, setPendingDelete] = useState<StoredFile | null>(null);

	const visible = useMemo(() => {
		const q = query.trim().toLowerCase();
		const sorted = [...files].sort((a, b) => b.uploaded.localeCompare(a.uploaded));
		return q ? sorted.filter((f) => fileName(f.key).toLowerCase().includes(q)) : sorted;
	}, [files, query]);
	const totalBytes = files.reduce((sum, f) => sum + f.size, 0);

	return (
		<Card>
			<Card.Header className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
				<div className="flex items-center gap-2">
					<Card.Title>Saved files</Card.Title>
					<Chip size="sm" variant="soft">
						{files.length}
						{hasMore ? "+" : ""} · {formatBytes(totalBytes)}
					</Chip>
				</div>
				<div className="flex w-full items-center gap-2 sm:w-auto">
					<SearchField
						value={query}
						onChange={setQuery}
						aria-label="Filter files"
						variant="secondary"
						className="min-w-0 flex-1 sm:w-56 sm:flex-none"
					>
						<SearchField.Group>
							<SearchField.SearchIcon />
							<SearchField.Input placeholder="Filter by name" />
							<SearchField.ClearButton />
						</SearchField.Group>
					</SearchField>
					<Tooltip delay={300}>
						<Button isIconOnly variant="secondary" aria-label="Refresh" onPress={onRefresh} isDisabled={loading}>
							<RefreshCw className={loading ? "size-4 animate-spin" : "size-4"} />
						</Button>
						<Tooltip.Content>Refresh</Tooltip.Content>
					</Tooltip>
				</div>
			</Card.Header>

			<Card.Content className="px-0 pb-0">
				{loading && files.length === 0 ? (
					<LoadingRows />
				) : visible.length === 0 ? (
					<EmptyFiles filtered={files.length > 0} />
				) : (
					<Table>
						<TableHeader>
							<TableRow className="hover:bg-transparent">
								<TableHead className="pl-4">Name</TableHead>
								<TableHead className="hidden md:table-cell">Source</TableHead>
								<TableHead className="hidden text-right sm:table-cell">Size</TableHead>
								<TableHead className="hidden sm:table-cell">Saved</TableHead>
								<TableHead className="pr-4 text-right">
									<span className="sr-only">Actions</span>
								</TableHead>
							</TableRow>
						</TableHeader>
						<TableBody>
							{visible.map((file) => (
								<FileRow key={file.key} file={file} onDelete={() => setPendingDelete(file)} />
							))}
						</TableBody>
					</Table>
				)}
				{hasMore && (
					<div className="flex justify-center border-t p-3">
						<Button variant="ghost" size="sm" onPress={onLoadMore} isDisabled={loading}>
							Load more
						</Button>
					</div>
				)}
			</Card.Content>

			<AlertDialog open={pendingDelete !== null} onOpenChange={(open) => !open && setPendingDelete(null)}>
				<AlertDialogContent size="sm">
					<AlertDialogHeader>
						<AlertDialogMedia className="bg-danger/10 text-danger">
							<Trash2 />
						</AlertDialogMedia>
						<AlertDialogTitle>Delete this file?</AlertDialogTitle>
						<AlertDialogDescription>
							<span className="font-medium break-all text-foreground">
								{pendingDelete && fileName(pendingDelete.key)}
							</span>{" "}
							will be removed from the bucket and its link will stop working.
						</AlertDialogDescription>
					</AlertDialogHeader>
					<AlertDialogFooter>
						<AlertDialogCancel>Cancel</AlertDialogCancel>
						<AlertDialogAction
							variant="destructive"
							onClick={() => {
								if (pendingDelete) void onDelete(pendingDelete);
							}}
						>
							Delete
						</AlertDialogAction>
					</AlertDialogFooter>
				</AlertDialogContent>
			</AlertDialog>
		</Card>
	);
}

function FileRow({ file, onDelete }: { file: StoredFile; onDelete: () => void }) {
	const [copied, setCopied] = useState(false);
	const name = fileName(file.key);
	const host = hostOf(file.sourceUrl);

	async function copy() {
		await navigator.clipboard.writeText(file.downloadUrl);
		setCopied(true);
		toast.success("Link copied");
		setTimeout(() => setCopied(false), 1500);
	}

	return (
		<TableRow>
			<TableCell className="w-full max-w-0 pl-4">
				<div className="flex min-w-0 items-center gap-3">
					<div className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-default text-default-foreground">
						<FileIcon name={name} contentType={file.contentType} className="size-4" />
					</div>
					<div className="min-w-0">
						<div className="truncate font-medium" title={name}>
							{name}
						</div>
						<div className="text-xs text-muted tabular-nums sm:hidden">
							{formatBytes(file.size)} · {timeAgo(file.uploaded)}
						</div>
					</div>
				</div>
			</TableCell>
			<TableCell className="hidden md:table-cell">
				{host ? (
					<Chip size="sm" variant="tertiary" title={file.sourceUrl ?? undefined}>
						<Globe className="size-3" />
						<Chip.Label className="max-w-[10rem] truncate">{host}</Chip.Label>
					</Chip>
				) : (
					<span className="text-muted">—</span>
				)}
			</TableCell>
			<TableCell className="hidden text-right tabular-nums sm:table-cell">{formatBytes(file.size)}</TableCell>
			<TableCell className="hidden whitespace-nowrap text-muted sm:table-cell" title={new Date(file.uploaded).toLocaleString()}>
				{timeAgo(file.uploaded)}
			</TableCell>
			<TableCell className="pr-4">
				<div className="flex justify-end gap-1">
					<IconAction label={copied ? "Copied" : "Copy link"} onPress={copy}>
						{copied ? <Check className="size-4 text-success" /> : <Copy className="size-4" />}
					</IconAction>
					<IconAction label="Download" onPress={() => (window.location.href = file.downloadUrl)}>
						<Download className="size-4" />
					</IconAction>
					<IconAction label="Delete" onPress={onDelete} danger>
						<Trash2 className="size-4" />
					</IconAction>
				</div>
			</TableCell>
		</TableRow>
	);
}

function IconAction({
	label,
	onPress,
	danger,
	children,
}: {
	label: string;
	onPress: () => void;
	danger?: boolean;
	children: React.ReactNode;
}) {
	return (
		<Tooltip delay={300}>
			<Button
				isIconOnly
				size="sm"
				variant="ghost"
				aria-label={label}
				onPress={onPress}
				className={danger ? "text-danger" : undefined}
			>
				{children}
			</Button>
			<Tooltip.Content>{label}</Tooltip.Content>
		</Tooltip>
	);
}

function LoadingRows() {
	return (
		<div className="flex flex-col gap-3 px-4 pb-4">
			{Array.from({ length: 4 }, (_, i) => (
				<div key={i} className="flex items-center gap-3">
					<Skeleton className="size-8 rounded-lg" />
					<Skeleton className="h-4 flex-1" />
					<Skeleton className="h-4 w-16" />
				</div>
			))}
		</div>
	);
}

function EmptyFiles({ filtered }: { filtered: boolean }) {
	return (
		<div className="flex flex-col items-center gap-2 px-4 pt-6 pb-10 text-center">
			<div className="flex size-12 items-center justify-center rounded-2xl bg-default text-muted">
				<FolderOpen className="size-6" />
			</div>
			<p className="font-medium">{filtered ? "No files match your filter" : "No files yet"}</p>
			<p className="text-sm text-muted">
				{filtered ? "Try a different name." : "Paste a direct link above to save your first file."}
			</p>
		</div>
	);
}
