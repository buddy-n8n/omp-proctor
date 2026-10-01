/**
 * `.omp/proctor/events.jsonl`: one line per verdict that fired and one per
 * check that could not run. Local only, gitignored by `/proctor compile`.
 */
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { type Band, EVENTS_PATH, type Phase, type Rubric } from "./rubric";

export type ProctorEvent =
	| { kind: "verdict"; at: string; phase: Phase; rule: string; p: number; band: Exclude<Band, "pass">; file?: string }
	| { kind: "check"; at: string; phase: Phase; rules: number; files: number; ms: number }
	| { kind: "miss"; at: string; phase: Phase; reason: string; file?: string };

export async function appendEvents(root: string, events: readonly ProctorEvent[]): Promise<void> {
	if (events.length === 0) return;
	const file = path.join(root, EVENTS_PATH);
	const dir = path.dirname(file);
	await fs.mkdir(dir, { recursive: true });
	// The rubric is committed; the event log is per machine.
	await fs.writeFile(path.join(dir, ".gitignore"), "events.jsonl\n", { flag: "wx" }).catch(() => undefined);
	await fs.appendFile(file, events.map(e => `${JSON.stringify(e)}\n`).join(""));
}

export async function readEvents(root: string): Promise<ProctorEvent[]> {
	const file = Bun.file(path.join(root, EVENTS_PATH));
	if (!(await file.exists())) return [];
	const out: ProctorEvent[] = [];
	for (const line of (await file.text()).split("\n")) {
		if (!line.trim()) continue;
		try {
			out.push(JSON.parse(line) as ProctorEvent);
		} catch {
			// A torn trailing line from a killed process; skip it.
		}
	}
	return out;
}

export interface RuleStats {
	id: string;
	phase: Phase;
	enabled: boolean;
	repair: number;
	note: number;
}

export interface Report {
	rules: RuleStats[];
	checks: number;
	misses: number;
	missReasons: Record<string, number>;
}

export function summarize(rubric: Rubric, events: readonly ProctorEvent[]): Report {
	const stats = new Map<string, RuleStats>(
		rubric.rules.map(r => [r.id, { id: r.id, phase: r.phase, enabled: r.enabled, repair: 0, note: 0 }]),
	);
	const report: Report = { rules: [], checks: 0, misses: 0, missReasons: {} };
	for (const e of events) {
		if (e.kind === "check") report.checks++;
		else if (e.kind === "miss") {
			report.misses++;
			report.missReasons[e.reason] = (report.missReasons[e.reason] ?? 0) + 1;
		} else {
			const s = stats.get(e.rule);
			if (s) s[e.band]++;
		}
	}
	report.rules = [...stats.values()];
	return report;
}

export function formatReport(report: Report): string {
	const lines = [`Proctor report: ${report.checks} checks, ${report.misses} unchecked (fail-open)`];
	const width = Math.max(4, ...report.rules.map(r => r.id.length));
	lines.push(`${"rule".padEnd(width)}  phase  repair  note`);
	for (const r of report.rules) {
		const flag = r.enabled ? "" : "  (disabled)";
		lines.push(`${r.id.padEnd(width)}  ${r.phase.padEnd(5)}  ${String(r.repair).padStart(6)}  ${String(r.note).padStart(4)}${flag}`);
	}
	const silent = report.rules.filter(r => r.enabled && r.repair === 0 && r.note === 0).map(r => r.id);
	if (silent.length) lines.push(`Never fired: ${silent.join(", ")}`);
	const reasons = Object.entries(report.missReasons);
	if (reasons.length) lines.push(`Unchecked: ${reasons.map(([k, v]) => `${k} x${v}`).join(", ")}`);
	return lines.join("\n");
}
