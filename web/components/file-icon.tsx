import { File, FileArchive, FileAudio, FileCode, FileImage, FileText, FileVideo, type LucideProps } from "lucide-react";

const ARCHIVE = /\.(zip|rar|7z|tar|gz|tgz|bz2|xz|iso|dmg|apk)$/i;
const CODE = /\.(js|ts|json|html|css|py|sh|xml|ya?ml)$/i;

export function FileIcon({ name, contentType, ...props }: { name: string; contentType: string | null } & LucideProps) {
	const t = contentType ?? "";
	if (t.startsWith("image/")) return <FileImage {...props} />;
	if (t.startsWith("video/")) return <FileVideo {...props} />;
	if (t.startsWith("audio/")) return <FileAudio {...props} />;
	if (ARCHIVE.test(name) || t.includes("zip") || t.includes("compressed")) return <FileArchive {...props} />;
	if (CODE.test(name)) return <FileCode {...props} />;
	if (t.startsWith("text/") || t === "application/pdf") return <FileText {...props} />;
	return <File {...props} />;
}
