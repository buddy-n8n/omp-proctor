/**
 * Working-tree snapshots as git tree objects, built in a throwaway index so the
 * user's real index and stash are never touched. Diffing two snapshots gives
 * exactly what changed between them, whichever tool (or shell command) did it.
 */
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { PROCTOR_DIR } from "./rubric";

async function git(cwd: string, args: string[], env?: Record<string, string>): Promise<string> {
	const proc = Bun.spawn(["git", ...args], {
		cwd,
		env: { ...process.env, ...env },
		stdout: "pipe",
		stderr: "pipe",
	});
	const [out, err, code] = await Promise.all([
		new Response(proc.stdout).text(),
		new Response(proc.stderr).text(),
		proc.exited,
	]);
	if (code !== 0) throw new Error(`git ${args[0]} failed: ${err.trim() || `exit ${code}`}`);
	return out;
}

/** Repo root for `cwd`, or undefined outside a git work tree. */
export async function repoRoot(cwd: string): Promise<string | undefined> {
	try {
		return (await git(cwd, ["rev-parse", "--show-toplevel"])).trim();
	} catch {
		return undefined;
	}
}

/** `git init` in `cwd`. */
export async function initRepo(cwd: string): Promise<void> {
	await git(cwd, ["init"]);
}

/** Tree hash of the current working tree (tracked + untracked, honouring .gitignore). */
export async function snapshot(root: string): Promise<string> {
	const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "proctor-"));
	const index = path.join(tmp, "index");
	try {
		// Seed from the real index so `add -A` reuses its stat cache instead of hashing every file.
		const realIndex = (await git(root, ["rev-parse", "--path-format=absolute", "--git-path", "index"])).trim();
		await fs.copyFile(realIndex, index).catch(() => undefined);
		const env = { GIT_INDEX_FILE: index };
		await git(root, ["add", "-A", "--", "."], env);
		return (await git(root, ["write-tree"], env)).trim();
	} finally {
		await fs.rm(tmp, { recursive: true, force: true });
	}
}

export interface FileDiff {
	/** Repo-root-relative path after the change. */
	path: string;
	/** Unified diff text for this file. */
	diff: string;
}

/** Split `git diff` output into per-file chunks. */
export function splitDiff(text: string): FileDiff[] {
	const out: FileDiff[] = [];
	for (const chunk of text.split(/^(?=diff --git )/m)) {
		if (!chunk.startsWith("diff --git ")) continue;
		const plus = /^\+\+\+ b\/(.+)$/m.exec(chunk);
		const header = /^diff --git a\/(.+?) b\/(.+)$/m.exec(chunk);
		const file = plus?.[1] ?? header?.[2];
		if (!file) continue;
		// Deleted files have no rule-relevant added lines.
		if (/^\+\+\+ \/dev\/null$/m.test(chunk)) continue;
		if (/^Binary files /m.test(chunk)) continue;
		out.push({ path: file, diff: chunk.trimEnd() });
	}
	return out;
}

/** Per-file diffs between two snapshots, excluding proctor's own state. */
export async function diffTrees(root: string, from: string, to: string): Promise<FileDiff[]> {
	if (from === to) return [];
	const text = await git(root, [
		"diff",
		"--no-color",
		"--no-ext-diff",
		"--unified=3",
		from,
		to,
		"--",
		".",
		`:(exclude)${PROCTOR_DIR}`,
	]);
	return splitDiff(text);
}

/** Recent commit hunks for calibration: one entry per file per commit. */
export async function recentHunks(root: string, commits: number): Promise<FileDiff[]> {
	const text = await git(root, [
		"log",
		"--no-color",
		"--no-ext-diff",
		"--no-merges",
		"-p",
		"--unified=3",
		"--format=",
		`-n${commits}`,
		"--",
		".",
		`:(exclude)${PROCTOR_DIR}`,
	]);
	return splitDiff(text);
}

/** Tracked files under `targets` (repo-root-relative), excluding proctor's own state. */
export async function trackedFiles(root: string, targets: readonly string[]): Promise<string[]> {
	const text = await git(root, ["ls-files", "-z", "--", ...(targets.length ? targets : ["."]), `:(exclude)${PROCTOR_DIR}`]);
	return text.split("\0").filter(Boolean);
}

/** Tracked and untracked-but-not-ignored files matching `pathspecs`, repo-root-relative. */
export async function candidateFiles(root: string, pathspecs: readonly string[]): Promise<string[]> {
	const text = await git(root, ["ls-files", "-z", "-co", "--exclude-standard", "--", ...pathspecs]);
	return text.split("\0").filter(Boolean);
}
