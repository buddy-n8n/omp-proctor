/**
 * The rubric: rules compiled from the project's instruction files, stored at
 * `.omp/proctor/rubric.json` and committed with the repo.
 */
import * as os from "node:os";
import * as path from "node:path";

export type Phase = "edit" | "turn";

export interface RuleSource {
	file: string;
	line: number;
	quote: string;
}

export interface Rule {
	id: string;
	source: RuleSource;
	/** Yes/no question: "Does this change ...?" where yes means the rule is broken. */
	question: string;
	phase: Phase;
	/** Repo-root-relative globs; empty or absent means every file. */
	scope?: string[];
	/** A linter can enforce this rule; proctor never judges it. */
	linterCheckable?: boolean;
	enabled: boolean;
	/** Set by `/proctor calibrate`. */
	calibration?: { flat: boolean; min: number; max: number; samples: number; at: string };
}

export interface Rubric {
	version: 1;
	/** Hash of the instruction files this rubric was compiled from. */
	sourceHash: string;
	/** Verdict at or above this asks the agent to repair. */
	repairThreshold: number;
	/** Verdict at or above this (and below repair) shows the user a note. */
	noteThreshold: number;
	/** Hard deadline for one judgment call. */
	timeoutMs: number;
	rules: Rule[];
}

export const PROCTOR_DIR = path.join(".omp", "proctor");
export const RUBRIC_PATH = path.join(PROCTOR_DIR, "rubric.json");
export const EVENTS_PATH = path.join(PROCTOR_DIR, "events.jsonl");

export const DEFAULTS = { repairThreshold: 0.8, noteThreshold: 0.5, timeoutMs: 10_000 } as const;

export class RubricError extends Error {}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function num(value: unknown, fallback: number, field: string): number {
	if (value === undefined) return fallback;
	if (typeof value !== "number" || !Number.isFinite(value)) throw new RubricError(`${field} must be a number`);
	return value;
}

function parseRule(value: unknown, index: number): Rule {
	const at = `rules[${index}]`;
	if (!isRecord(value)) throw new RubricError(`${at} must be an object`);
	const { id, source, question, phase, scope, linterCheckable, enabled, calibration } = value;
	if (typeof id !== "string" || !id) throw new RubricError(`${at}.id must be a non-empty string`);
	if (typeof question !== "string" || !question.trim()) throw new RubricError(`${at}.question is required`);
	if (phase !== "edit" && phase !== "turn") throw new RubricError(`${at}.phase must be "edit" or "turn"`);
	if (!isRecord(source) || typeof source.file !== "string" || typeof source.quote !== "string") {
		throw new RubricError(`${at}.source needs file and quote`);
	}
	if (scope !== undefined && (!Array.isArray(scope) || !scope.every(s => typeof s === "string"))) {
		throw new RubricError(`${at}.scope must be an array of globs`);
	}
	const rule: Rule = {
		id,
		source: { file: source.file, line: typeof source.line === "number" ? source.line : 0, quote: source.quote },
		question,
		phase,
		enabled: enabled !== false,
	};
	if (scope?.length) rule.scope = scope as string[];
	if (linterCheckable === true) rule.linterCheckable = true;
	if (isRecord(calibration)) rule.calibration = calibration as Rule["calibration"];
	return rule;
}

export function parseRubric(text: string): Rubric {
	let raw: unknown;
	try {
		raw = JSON.parse(text);
	} catch (err) {
		throw new RubricError(`rubric is not valid JSON: ${(err as Error).message}`);
	}
	if (!isRecord(raw)) throw new RubricError("rubric must be an object");
	if (!Array.isArray(raw.rules)) throw new RubricError("rubric.rules must be an array");
	const ids = new Set<string>();
	const rules = raw.rules.map((r, i) => {
		const rule = parseRule(r, i);
		if (ids.has(rule.id)) throw new RubricError(`duplicate rule id "${rule.id}"`);
		ids.add(rule.id);
		return rule;
	});
	const rubric: Rubric = {
		version: 1,
		sourceHash: typeof raw.sourceHash === "string" ? raw.sourceHash : "",
		repairThreshold: num(raw.repairThreshold, DEFAULTS.repairThreshold, "repairThreshold"),
		noteThreshold: num(raw.noteThreshold, DEFAULTS.noteThreshold, "noteThreshold"),
		timeoutMs: num(raw.timeoutMs, DEFAULTS.timeoutMs, "timeoutMs"),
		rules,
	};
	if (!(rubric.noteThreshold <= rubric.repairThreshold)) {
		throw new RubricError("noteThreshold must not exceed repairThreshold");
	}
	return rubric;
}

export async function loadRubric(root: string): Promise<Rubric | undefined> {
	const file = Bun.file(path.join(root, RUBRIC_PATH));
	if (!(await file.exists())) return undefined;
	return parseRubric(await file.text());
}

export async function saveRubric(root: string, rubric: Rubric): Promise<void> {
	await Bun.write(path.join(root, RUBRIC_PATH), `${JSON.stringify(rubric, null, "\t")}\n`);
}

/** Stable hash over instruction file paths and contents, order-independent. */
export function hashSources(files: ReadonlyArray<{ path: string; content: string }>): string {
	const hasher = new Bun.CryptoHasher("sha256");
	for (const f of [...files].sort((a, b) => a.path.localeCompare(b.path))) {
		hasher.update(f.path);
		hasher.update("\0");
		hasher.update(f.content);
		hasher.update("\0");
	}
	return hasher.digest("hex").slice(0, 16);
}

const globCache = new Map<string, Bun.Glob>();

/** Whether `relPath` (repo-root-relative, `/`-separated) is in the rule's scope. */
export function inScope(rule: Rule, relPath: string): boolean {
	if (!rule.scope?.length) return true;
	return rule.scope.some(pattern => {
		let glob = globCache.get(pattern);
		if (!glob) {
			glob = new Bun.Glob(pattern);
			globCache.set(pattern, glob);
		}
		return glob.match(relPath);
	});
}

/** Rules that should be judged for this phase and file. */
export function activeRules(rubric: Rubric, phase: Phase, relPath?: string): Rule[] {
	return rubric.rules.filter(
		r => r.enabled && !r.linterCheckable && r.phase === phase && (relPath === undefined || inScope(r, relPath)),
	);
}

export type Band = "repair" | "note" | "pass";

export function band(p: number, rubric: Pick<Rubric, "repairThreshold" | "noteThreshold">): Band {
	if (p >= rubric.repairThreshold) return "repair";
	if (p >= rubric.noteThreshold) return "note";
	return "pass";
}

/** Instructions handed to the main agent to compile (or recompile) the rubric. */
export function compilePrompt(opts: {
	files: ReadonlyArray<{ path: string; content: string }>;
	sourceHash: string;
	/** Repo root; source paths inside it are written repo-relative. */
	root: string;
	existing?: Rubric;
}): string {
	const home = os.homedir();
	const display = (p: string) => {
		const rel = path.relative(opts.root, p);
		if (!rel.startsWith("..") && !path.isAbsolute(rel)) return rel;
		return p.startsWith(`${home}${path.sep}`) ? `~${p.slice(home.length)}` : p;
	};
	const listing = opts.files.map(f => `- ${display(f.path)} (read it at ${f.path})`).join("\n");
	const keep = opts.existing
		? `\nA rubric already exists at ${RUBRIC_PATH}. Keep the ids, thresholds and \`enabled\`/\`calibration\` fields of rules whose source text is unchanged; add, rewrite or drop the rest.`
		: "";
	return `[proctor] Compile the project rubric before continuing.

Read these instruction files:
${listing}

Write ${RUBRIC_PATH} as JSON:
{
  "version": 1,
  "sourceHash": "${opts.sourceHash}",
  "repairThreshold": ${opts.existing?.repairThreshold ?? DEFAULTS.repairThreshold},
  "noteThreshold": ${opts.existing?.noteThreshold ?? DEFAULTS.noteThreshold},
  "timeoutMs": ${opts.existing?.timeoutMs ?? DEFAULTS.timeoutMs},
  "rules": [ { "id", "source": { "file", "line", "quote" }, "question", "phase", "scope"?, "linterCheckable"?, "enabled": true } ]
}

One rule per enforceable instruction about code or changes. Skip instructions about chat style, tool usage, git workflow, or anything not visible in a diff.
- id: short kebab-case, unique.
- source.file: exactly the short path shown in the list above (repo-relative or ~/...), never an absolute path. source.quote: the instruction verbatim; source.line: its 1-based line.
- question: a yes/no question about a diff where YES means the rule is BROKEN, e.g. "Does this change validate API input by hand instead of using Yup?". It must be answerable from the diff alone.
- phase: "edit" if one edit can break it; "turn" if it needs the whole change set (scope creep, duplicated logic across files, single-use abstractions, missing tests or docs).
- scope: repo-root-relative globs when the rule applies only to some files (e.g. ["src/api/**"]).
- linterCheckable: true ONLY when a linter or formatter configured in THIS repository already enforces it (check for its config file). If no such config exists, leave it false so proctor judges the rule.
${keep}
Then report how many rules you wrote, by phase, and which instructions you skipped.`;
}
