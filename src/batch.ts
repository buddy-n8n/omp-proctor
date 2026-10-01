/**
 * Bulk judgments: `/proctor audit` (existing files judged as if just written)
 * and `/proctor calibrate` (rules scored against recent commit hunks).
 */
import * as path from "node:path";
import type { Judge } from "@oh-my-pi/pi-ai";
import type { FileDiff } from "./git";
import { activeRules, inScope, type Rubric, type Rule } from "./rubric";
import { judgeChange, type Verdict } from "./verdict";

const CONCURRENCY = 8;

async function pool<T, R>(items: readonly T[], run: (item: T) => Promise<R>): Promise<R[]> {
	const out = new Array<R>(items.length);
	let next = 0;
	const worker = async () => {
		while (next < items.length) {
			const i = next++;
			out[i] = await run(items[i]);
		}
	};
	await Promise.all(Array.from({ length: Math.min(CONCURRENCY, items.length) }, worker));
	return out;
}

/** A whole file rendered as an all-added diff. */
export function asAddedDiff(relPath: string, content: string): string {
	const lines = content.replace(/\n$/, "").split("\n");
	return [`--- /dev/null`, `+++ b/${relPath}`, `@@ -0,0 +1,${lines.length} @@`, ...lines.map(l => `+${l}`)].join("\n");
}

export interface AuditResult {
	verdicts: Verdict[];
	files: number;
	failed: Array<{ file: string; error: string }>;
}

/** Judge each file (repo-root-relative) as if it had just been written, against the edit-phase rules. */
export async function audit(
	judge: Pick<Judge, "judge">,
	rubric: Rubric,
	root: string,
	files: readonly string[],
	signal?: AbortSignal,
): Promise<AuditResult> {
	const failed: AuditResult["failed"] = [];
	const results = await pool(files, async file => {
		const rules = activeRules(rubric, "edit", file);
		if (rules.length === 0) return [];
		try {
			const content = await Bun.file(path.join(root, file)).text();
			return await judgeChange(judge, rubric, rules, { file, diff: asAddedDiff(file, content) }, signal);
		} catch (err) {
			failed.push({ file, error: err instanceof Error ? err.message : String(err) });
			return [];
		}
	});
	return { verdicts: results.flat().filter(v => v.band !== "pass"), files: files.length, failed };
}

/** Spread below which a rule is treated as not discriminating between hunks. */
export const FLAT_SPREAD = 0.15;

/** Fewer samples than this never disable a rule. */
export const MIN_CALIBRATION_SAMPLES = 3;

export interface CalibrationRow {
	id: string;
	samples: number;
	min: number;
	max: number;
	flat: boolean;
}

/**
 * A rule whose verdicts barely move across real, unrelated hunks and never
 * reach the note band is answering its own wording, not the code. Those rules
 * are disabled; everything else is left as is.
 */
export function assessCalibration(rule: Rule, scores: readonly number[], noteThreshold: number): CalibrationRow {
	if (scores.length === 0) return { id: rule.id, samples: 0, min: 0, max: 0, flat: false };
	const min = Math.min(...scores);
	const max = Math.max(...scores);
	const flat = scores.length >= MIN_CALIBRATION_SAMPLES && max - min < FLAT_SPREAD && max < noteThreshold;
	return { id: rule.id, samples: scores.length, min, max, flat };
}

export async function calibrate(
	judge: Pick<Judge, "judge">,
	rubric: Rubric,
	hunks: readonly FileDiff[],
	signal?: AbortSignal,
): Promise<{ rubric: Rubric; rows: CalibrationRow[] }> {
	const rules = rubric.rules.filter(r => r.enabled && !r.linterCheckable);
	const scores = new Map<string, number[]>(rules.map(r => [r.id, []]));
	await pool(hunks, async hunk => {
		const applicable = rules.filter(r => r.phase === "turn" || inScope(r, hunk.path));
		try {
			for (const v of await judgeChange(judge, rubric, applicable, { file: hunk.path, diff: hunk.diff }, signal)) {
				scores.get(v.rule.id)?.push(v.p);
			}
		} catch {
			// A failed hunk only reduces the sample count.
		}
	});
	const at = new Date().toISOString();
	const rows = rules.map(r => assessCalibration(r, scores.get(r.id) ?? [], rubric.noteThreshold));
	const byId = new Map(rows.map(row => [row.id, row]));
	const next: Rubric = {
		...rubric,
		rules: rubric.rules.map(r => {
			const row = byId.get(r.id);
			if (!row || row.samples < MIN_CALIBRATION_SAMPLES) return r;
			return {
				...r,
				enabled: r.enabled && !row.flat,
				calibration: { flat: row.flat, min: row.min, max: row.max, samples: row.samples, at },
			};
		}),
	};
	return { rubric: next, rows };
}
