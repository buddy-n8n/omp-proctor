import { describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { assessCalibration } from "../src/batch";
import { summarize } from "../src/events";
import { diffTrees, snapshot, splitDiff } from "../src/git";
import { activeRules, band, hashSources, parseRubric, type Rubric, RubricError, type Rule } from "../src/rubric";
import { judgeChange, repairMessage } from "../src/verdict";

const rule = (over: Partial<Rule> = {}): Rule => ({
	id: "no-var",
	source: { file: "AGENTS.md", line: 3, quote: "Never use var." },
	question: "Does this change declare a variable with var?",
	phase: "edit",
	enabled: true,
	...over,
});

const rubricWith = (rules: Rule[]): Rubric =>
	parseRubric(JSON.stringify({ version: 1, sourceHash: "h", rules }));

describe("rubric", () => {
	test("applies default thresholds and rejects inverted ones", () => {
		const r = rubricWith([rule()]);
		expect([r.repairThreshold, r.noteThreshold, r.timeoutMs]).toEqual([0.8, 0.5, 10_000]);
		expect(() => parseRubric(JSON.stringify({ rules: [], repairThreshold: 0.4, noteThreshold: 0.6 }))).toThrow(
			RubricError,
		);
	});

	test("rejects duplicate ids and bad phases", () => {
		expect(() => rubricWith([rule(), rule()])).toThrow(/duplicate/);
		expect(() => rubricWith([rule({ phase: "commit" as Rule["phase"] })])).toThrow(/phase/);
	});

	test("bands are inclusive at each threshold", () => {
		const t = { repairThreshold: 0.8, noteThreshold: 0.5 };
		expect([band(0.8, t), band(0.7999, t), band(0.5, t), band(0.4999, t)]).toEqual(["repair", "note", "note", "pass"]);
	});

	test("activeRules honours phase, scope, enabled and linterCheckable", () => {
		const r = rubricWith([
			rule({ id: "api", scope: ["src/api/**"] }),
			rule({ id: "all" }),
			rule({ id: "off", enabled: false }),
			rule({ id: "lint", linterCheckable: true }),
			rule({ id: "turn", phase: "turn" }),
		]);
		expect(activeRules(r, "edit", "src/api/user.ts").map(x => x.id)).toEqual(["api", "all"]);
		expect(activeRules(r, "edit", "src/ui/button.ts").map(x => x.id)).toEqual(["all"]);
		expect(activeRules(r, "turn").map(x => x.id)).toEqual(["turn"]);
	});

	test("source hash ignores order and tracks content", () => {
		const a = { path: "/a/AGENTS.md", content: "x" };
		const b = { path: "/b/CLAUDE.md", content: "y" };
		expect(hashSources([a, b])).toBe(hashSources([b, a]));
		expect(hashSources([a, b])).not.toBe(hashSources([a, { ...b, content: "y2" }]));
	});
});

describe("splitDiff", () => {
	test("keeps added and modified files, drops deletions and binaries", () => {
		const text = [
			"diff --git a/keep.ts b/keep.ts",
			"--- a/keep.ts",
			"+++ b/keep.ts",
			"@@ -1 +1 @@",
			"-a",
			"+b",
			"diff --git a/gone.ts b/gone.ts",
			"--- a/gone.ts",
			"+++ /dev/null",
			"@@ -1 +0,0 @@",
			"-a",
			"diff --git a/img.png b/img.png",
			"Binary files a/img.png and b/img.png differ",
		].join("\n");
		expect(splitDiff(text).map(d => d.path)).toEqual(["keep.ts"]);
	});
});

describe("git snapshots", () => {
	test("capture untracked edits, skip proctor state, leave the real index alone", async () => {
		const dir = await fs.mkdtemp(path.join(os.tmpdir(), "proctor-test-"));
		const run = (...args: string[]) => Bun.spawnSync(["git", ...args], { cwd: dir });
		run("init", "-q");
		run("-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "--allow-empty", "-m", "init");
		const before = await snapshot(dir);
		await Bun.write(path.join(dir, "new.ts"), "var x = 1;\n");
		await Bun.write(path.join(dir, ".omp/proctor/events.jsonl"), "{}\n");
		const diffs = await diffTrees(dir, before, await snapshot(dir));
		expect(diffs.map(d => d.path)).toEqual(["new.ts"]);
		expect(diffs[0].diff).toContain("+var x = 1;");
		expect(Bun.spawnSync(["git", "diff", "--cached", "--name-only"], { cwd: dir }).stdout.toString()).toBe("");
		await fs.rm(dir, { recursive: true, force: true });
	});
});

describe("judgeChange", () => {
	test("asks one question per rule and bands the answers", async () => {
		const r = rubricWith([rule(), rule({ id: "no-any" })]);
		let asked: string[] = [];
		const judge = {
			judge: async (req: { questions: Record<string, unknown> }) => {
				asked = Object.keys(req.questions);
				return { answers: { "no-var": { type: "noul", noul: 0.93 }, "no-any": { type: "noul", noul: 0.1 } } };
			},
		} as unknown as Parameters<typeof judgeChange>[0];
		const vs = await judgeChange(judge, r, r.rules, { file: "a.ts", diff: "+var x" });
		expect(asked).toEqual(["no-var", "no-any"]);
		expect(vs.map(v => v.band)).toEqual(["repair", "pass"]);
		const msg = repairMessage(vs, "edit");
		expect(msg).toContain('Rule "no-var" from AGENTS.md line 3');
		expect(msg).not.toContain("no-any");
	});

	test("a slow judge is cut off at the rubric deadline", async () => {
		const r = parseRubric(JSON.stringify({ timeoutMs: 20, rules: [rule()] }));
		const judge = {
			judge: (_req: unknown, opts: { signal: AbortSignal }) => {
				const { promise, reject } = Promise.withResolvers<never>();
				opts.signal.addEventListener("abort", () => reject(opts.signal.reason));
				return promise;
			},
		} as unknown as Parameters<typeof judgeChange>[0];
		await expect(judgeChange(judge, r, r.rules, { diff: "+x" })).rejects.toThrow();
	});
});

describe("calibration and report", () => {
	test("only a narrow, low-scoring rule is flagged flat", () => {
		expect(assessCalibration(rule(), [0.4, 0.42, 0.41], 0.5).flat).toBe(true);
		expect(assessCalibration(rule(), [0.05, 0.9, 0.1], 0.5).flat).toBe(false);
		expect(assessCalibration(rule(), [0.85, 0.86, 0.9], 0.5).flat).toBe(false);
		expect(assessCalibration(rule(), [0.4, 0.4], 0.5).flat).toBe(false);
	});

	test("summarize counts verdicts per rule and misses by reason", () => {
		const r = rubricWith([rule(), rule({ id: "quiet" })]);
		const at = "t";
		const report = summarize(r, [
			{ kind: "verdict", at, phase: "edit", rule: "no-var", p: 0.9, band: "repair" },
			{ kind: "verdict", at, phase: "edit", rule: "no-var", p: 0.6, band: "note" },
			{ kind: "miss", at, phase: "edit", reason: "timeout" },
			{ kind: "check", at, phase: "edit", rules: 2, files: 1, ms: 5 },
		]);
		expect(report.rules.find(x => x.id === "no-var")).toMatchObject({ repair: 1, note: 1 });
		expect(report.rules.find(x => x.id === "quiet")).toMatchObject({ repair: 0, note: 0 });
		expect([report.checks, report.misses, report.missReasons.timeout]).toEqual([1, 1, 1]);
	});
});
