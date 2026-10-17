import { useCallback, useEffect, useState } from "react";

export type ThemePreference = "light" | "dark" | "system";

const STORAGE_KEY = "krs-dl-theme";
const darkQuery = () => window.matchMedia("(prefers-color-scheme: dark)");

function readPreference(): ThemePreference {
	try {
		const stored = localStorage.getItem(STORAGE_KEY);
		if (stored === "light" || stored === "dark") return stored;
	} catch {
		// Storage can be blocked; fall back to the system theme.
	}
	return "system";
}

function resolve(preference: ThemePreference): "light" | "dark" {
	if (preference !== "system") return preference;
	return darkQuery().matches ? "dark" : "light";
}

// HeroUI switches themes with a `dark` class and `data-theme` on <html>.
function apply(theme: "light" | "dark") {
	const root = document.documentElement;
	root.classList.toggle("dark", theme === "dark");
	root.classList.toggle("light", theme === "light");
	root.dataset.theme = theme;
}

export function useTheme() {
	const [preference, setPreferenceState] = useState<ThemePreference>(readPreference);
	const [resolved, setResolved] = useState(() => resolve(preference));

	useEffect(() => {
		const update = () => {
			const next = resolve(preference);
			setResolved(next);
			apply(next);
		};
		update();
		if (preference !== "system") return;
		const query = darkQuery();
		query.addEventListener("change", update);
		return () => query.removeEventListener("change", update);
	}, [preference]);

	const setPreference = useCallback((next: ThemePreference) => {
		try {
			if (next === "system") localStorage.removeItem(STORAGE_KEY);
			else localStorage.setItem(STORAGE_KEY, next);
		} catch {
			// Ignore; the choice still applies for this visit.
		}
		setPreferenceState(next);
	}, []);

	return { preference, resolved, setPreference };
}
