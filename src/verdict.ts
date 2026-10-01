/**
 * One judgment call per change: every applicable rule becomes one yes/no
 * question over the same diff. The judge sees the rule and the diff only,
 * never the conversation, so edit 200 is judged exactly like edit 1.
 */
import type { Judge, NoulQuestion } from "@oh-my-pi/pi-ai";
import { type Band, band, type Rubric, type Rule } from "./rubric";

/** Diffs beyond this are truncated; a rule a diff this large breaks is visible in its head. */
export const MAX_DIFF_CHARS = 16_000;

export interface Verdict {
	rule: Rule;
	/** Probability the rule is broken. */
	p: number;
	band: Band;
	file?: string;
}

export interface ChangeState {
	/** Repo-root-relative path, absent for whole-turn checks. */
	file?: string;
	diff: string;
}

export async function judgeChange(
	judge: Pick<Judge, "judge">,
	rubric: Rubric,
	rules: readonly Rule[],
	change: ChangeState,
	signal?: AbortSignal,
): Promise<Verdict[]> {
	if (rules.length === 0 || !change.diff.trim()) return [];
	const questions: Record<string, NoulQuestion> = {};
	for (const rule of rules) {
		questions[rule.id] = {
			type: "noul",
			instructions: `Project rule: "${rule.source.quote}"\n${rule.question}\nAnswer about the added lines (+) of the diff only.`,
			criteria: { true: "the change breaks the rule", false: "the change follows the rule or is unrelated to it" },
		};
	}
	const diff =
		change.diff.length > MAX_DIFF_CHARS ? `${change.diff.slice(0, MAX_DIFF_CHARS)}\n[diff truncated]` : change.diff;
	const deadline = AbortSignal.timeout(rubric.timeoutMs);
	const result = await judge.judge(
		{ state: change.file ? { file: change.file, diff } : { diff }, questions },
		{ signal: signal ? AbortSignal.any([signal, deadline]) : deadline },
	);
	return rules.map(rule => {
		const answer = result.answers[rule.id];
		const p = answer?.type === "noul" ? answer.noul : 0;
		return { rule, p, band: band(p, rubric), file: change.file };
	});
}

function cite(v: Verdict): string {
	const where = v.rule.source.line ? `${v.rule.source.file} line ${v.rule.source.line}` : v.rule.source.file;
	return `- Rule "${v.rule.id}" from ${where}: "${v.rule.source.quote}" (${v.p.toFixed(2)})`;
}

/** Model-visible repair request for verdicts in the repair band. */
export function repairMessage(verdicts: readonly Verdict[], scope: "edit" | "turn"): string | undefined {
	const repair = verdicts.filter(v => v.band === "repair");
	if (repair.length === 0) return undefined;
	const files = [...new Set(repair.map(v => v.file).filter((f): f is string => !!f))];
	const lead =
		scope === "edit"
			? "Proctor: this edit appears to break a rule from this repository's instructions."
			: "Proctor: the changes in this turn appear to break a rule from this repository's instructions.";
	const tail =
		scope === "edit"
			? `Repair ${files.join(", ") || "the edited file"} now, then continue with the task.`
			: `Repair ${files.length ? files.join(", ") : "the change set"} now before finishing. If a verdict is wrong, say which and why instead of changing code.`;
	return [lead, ...repair.map(cite), tail].join("\n");
}

/** User-only note for verdicts in the note band. */
export function noteMessage(verdicts: readonly Verdict[]): string | undefined {
	const notes = verdicts.filter(v => v.band === "note");
	if (notes.length === 0) return undefined;
	return ["Proctor (note only, agent not told):", ...notes.map(v => `${cite(v)}${v.file ? ` in ${v.file}` : ""}`)].join(
		"\n",
	);
}
