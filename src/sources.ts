/**
 * Where Proctor reads rules from when OMP finds no AGENTS.md / CLAUDE.md in the
 * repo: a user-chosen markdown file, remembered in `.omp/proctor/config.json`.
 */
import * as path from "node:path";
import { PROCTOR_DIR } from "./rubric";

export const CONFIG_PATH = path.join(PROCTOR_DIR, "config.json");

/** Repo-relative rules files the user chose; `[]` means "none, stop asking"; undefined means never asked. */
export async function loadRulesFiles(root: string): Promise<string[] | undefined> {
	const file = Bun.file(path.join(root, CONFIG_PATH));
	if (!(await file.exists())) return undefined;
	try {
		const parsed = JSON.parse(await file.text());
		return Array.isArray(parsed?.rulesFiles) ? parsed.rulesFiles.filter((f: unknown) => typeof f === "string") : undefined;
	} catch {
		return undefined;
	}
}

export async function saveRulesFiles(root: string, rulesFiles: string[]): Promise<void> {
	await Bun.write(path.join(root, CONFIG_PATH), `${JSON.stringify({ rulesFiles }, null, "\t")}\n`);
}

const BORING = /^(readme|changelog|license|licence|code_of_conduct|security|notice|authors|history|todo)\b/i;
const HINT = /^(design|rules?|conventions?|style|guidelines?|standards?|architecture|contributing|spec|principles)/i;

/**
 * Markdown files that plausibly hold project rules, from repo-relative `/`-separated paths:
 * every root-level .md, plus the .md of any top-level folder that has exactly one. README-ish
 * files are skipped; names like DESIGN or CONVENTIONS sort first.
 */
export function rulesCandidates(files: readonly string[], max = 8): string[] {
	const byDir = new Map<string, string[]>();
	for (const f of files) {
		const parts = f.split("/");
		const name = parts[parts.length - 1];
		if (parts.length > 2 || !/\.md$/i.test(name) || BORING.test(name)) continue;
		if (parts.some(p => p.startsWith(".") || p === "node_modules")) continue;
		const dir = parts.length === 1 ? "" : parts[0];
		byDir.set(dir, [...(byDir.get(dir) ?? []), f]);
	}
	const out = [...(byDir.get("") ?? [])];
	for (const [dir, list] of byDir) if (dir && list.length === 1) out.push(list[0]);
	const hinted = out.filter(f => HINT.test(path.basename(f)));
	const rest = out.filter(f => !HINT.test(path.basename(f)));
	return [...hinted.sort(), ...rest.sort()].slice(0, max);
}

/** Files other coding agents standardise on for project rules. OMP's context-file discovery loads only some of them. */
const STANDARD_FILES = [
	"AGENTS.md", // Codex, Amp, OpenCode, Jules, Copilot CLI
	"CLAUDE.md", // Claude Code
	"GEMINI.md", // Gemini CLI
	"CONVENTIONS.md", // Aider
	".cursorrules", // Cursor (legacy)
	".windsurfrules", // Windsurf (legacy)
	".clinerules", // Cline (single file)
	".rules", // Zed
	".github/copilot-instructions.md", // GitHub Copilot
];
const STANDARD_DIRS: ReadonlyArray<readonly [dir: string, ext: RegExp]> = [
	[".cursor/rules/", /\.mdc?$/],
	[".windsurf/rules/", /\.md$/],
	[".clinerules/", /\.md$/],
	[".github/instructions/", /\.instructions\.md$/],
];

/** Git pathspecs that cover every candidate: any markdown, plus the standard non-markdown names and folders. */
export const RULE_PATHSPECS = ["*.md", ".cursorrules", ".windsurfrules", ".clinerules", ".rules", ".cursor/rules", ".windsurf/rules", ".github/instructions"];

/** The standard rules files present in `files` (repo-relative, `/`-separated). */
export function standardRuleFiles(files: readonly string[]): string[] {
	return files.filter(f => STANDARD_FILES.includes(f) || STANDARD_DIRS.some(([dir, ext]) => f.startsWith(dir) && ext.test(f))).sort();
}
