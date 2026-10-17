import { Button, Tooltip } from "@heroui/react";
import { CloudDownload, LogOut, Monitor, Moon, Sun } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import { FilesCard } from "@/components/files-card";
import { SaveCard } from "@/components/save-card";
import { TokenGate } from "@/components/token-gate";
import { Toaster } from "@/components/ui/sonner";
import { ApiError, type StoredFile, deleteFile, fileName, listFiles } from "@/lib/api";
import { type ThemePreference, useTheme } from "@/lib/theme";

const TOKEN_KEY = "krs-dl-token";

function readToken() {
	try {
		return localStorage.getItem(TOKEN_KEY) ?? "";
	} catch {
		return "";
	}
}

export function App() {
	const theme = useTheme();
	const [token, setTokenState] = useState(readToken);
	const [files, setFiles] = useState<StoredFile[]>([]);
	const [cursor, setCursor] = useState<string | null>(null);
	const [loading, setLoading] = useState(false);

	const setToken = useCallback((next: string) => {
		try {
			if (next) localStorage.setItem(TOKEN_KEY, next);
			else localStorage.removeItem(TOKEN_KEY);
		} catch {
			// Keep the token in memory only.
		}
		setTokenState(next);
		if (!next) {
			setFiles([]);
			setCursor(null);
		}
	}, []);

	const handleError = useCallback(
		(err: unknown) => {
			if (err instanceof ApiError && err.status === 401) {
				setToken("");
				toast.error("That token was rejected", { description: "Enter the API token again." });
				return;
			}
			toast.error(err instanceof Error ? err.message : "Something went wrong");
		},
		[setToken],
	);

	const load = useCallback(
		async (after: string | null = null) => {
			if (!token) return;
			setLoading(true);
			try {
				const page = await listFiles(token, after);
				setFiles((prev) => (after ? [...prev, ...page.files] : page.files));
				setCursor(page.cursor);
			} catch (err) {
				handleError(err);
			} finally {
				setLoading(false);
			}
		},
		[token, handleError],
	);

	useEffect(() => {
		void load();
	}, [load]);

	async function remove(file: StoredFile) {
		try {
			await deleteFile(token, file.key);
			setFiles((prev) => prev.filter((f) => f.key !== file.key));
			toast.success(`Deleted ${fileName(file.key)}`);
		} catch (err) {
			handleError(err);
		}
	}

	return (
		<div className="min-h-dvh">
			<div className="pointer-events-none fixed inset-x-0 top-0 -z-10 h-72 bg-gradient-to-b from-accent/15 to-transparent" />
			<header className="mx-auto flex max-w-4xl items-center justify-between gap-3 px-4 pt-6 pb-4">
				<div className="flex items-center gap-3">
					<div className="flex size-10 items-center justify-center rounded-xl bg-foreground text-background shadow-surface">
						<CloudDownload className="size-5" />
					</div>
					<div>
						<h1 className="text-base leading-tight font-semibold">KRS Downloader</h1>
						<p className="text-xs text-muted">Direct links → Cloudflare R2</p>
					</div>
				</div>
				<div className="flex items-center gap-1">
					<ThemeButton preference={theme.preference} onChange={theme.setPreference} />
					{token && (
						<Tooltip delay={300}>
							<Button isIconOnly variant="ghost" aria-label="Sign out" onPress={() => setToken("")}>
								<LogOut className="size-4" />
							</Button>
							<Tooltip.Content>Forget token</Tooltip.Content>
						</Tooltip>
					)}
				</div>
			</header>

			<main className="mx-auto flex max-w-4xl flex-col gap-6 px-4 pb-16">
				{token ? (
					<>
						<SaveCard token={token} onSaved={() => void load()} onError={handleError} />
						<FilesCard
							files={files}
							loading={loading}
							hasMore={cursor !== null}
							onRefresh={() => void load()}
							onLoadMore={() => void load(cursor)}
							onDelete={remove}
						/>
					</>
				) : (
					<div className="pt-10">
						<TokenGate onSubmit={setToken} />
					</div>
				)}
			</main>

			<Toaster theme={theme.resolved} position="bottom-right" richColors={false} />
		</div>
	);
}

const NEXT_THEME: Record<ThemePreference, ThemePreference> = { system: "light", light: "dark", dark: "system" };
const THEME_ICON = { system: Monitor, light: Sun, dark: Moon };

function ThemeButton({
	preference,
	onChange,
}: {
	preference: ThemePreference;
	onChange: (next: ThemePreference) => void;
}) {
	const Icon = THEME_ICON[preference];
	const label = `Theme: ${preference}`;
	return (
		<Tooltip delay={300}>
			<Button isIconOnly variant="ghost" aria-label={label} onPress={() => onChange(NEXT_THEME[preference])}>
				<Icon className="size-4" />
			</Button>
			<Tooltip.Content>{label}</Tooltip.Content>
		</Tooltip>
	);
}
