/**
 * Proctor: checks every edit, and every finished turn, against the rules in
 * the project's instruction files and makes the agent repair what it breaks.
 *
 * - edit phase: `tool_call` snapshots the tree, `tool_result` diffs it and
 *   judges the hunk; a repair request rides back as tool-result context.
 * - turn phase: `before_agent_start` snapshots, `session_stop` diffs the whole
 *   turn, judges turn rules plus edit rules for files no edit tool touched
 *   (shell writes), and requests at most one continuation.
 * Every failure path lets the work through and logs a miss.
 */
import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import {
	type ChainJudge,
	journalJudgmentUsage,
	resolveJudge,
	sharedJudgmentCache,
} from "@oh-my-pi/pi-coding-agent/judgment";
import { audit, calibrate, MIN_CALIBRATION_SAMPLES } from "./batch";
import { appendEvents, formatReport, type ProctorEvent, readEvents, summarize } from "./events";
import { diffTrees, type FileDiff, initRepo, markdownFiles, recentHunks, repoRoot, snapshot, trackedFiles } from "./git";
import {
	activeRules,
	compilePrompt,
	hashSources,
	inScope,
	loadRubric,
	type Phase,
	PROCTOR_DIR,
	RUBRIC_PATH,
	type Rubric,
	RubricError,
	type Rule,
	saveRubric,
} from "./rubric";
import { loadRulesFiles, rulesCandidates, saveRulesFiles } from "./sources";
import { judgeChange, noteMessage, repairMessage, type Verdict } from "./verdict";

/** Tools whose results are checked per edit. Anything else that writes is caught at turn end. */
const EDIT_TOOLS: Record<string, true> = { edit: true, write: true, ast_edit: true };

function missReason(err: unknown): string {
	const message = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
	if (/TimeoutError|timed out|aborted/i.test(message)) return "timeout";
	if (/no judge model|no API key|every judge candidate failed/i.test(message)) return "no-judge";
	return "error";
}

export default function proctor(pi: ExtensionAPI) {
	pi.setLabel("Proctor");

	let root: string | undefined;
	let enabled = true;
	let rubric: Rubric | undefined;
	let rubricMtime = 0;
	let rubricError: string | undefined;
	let sources: Array<{ path: string; content: string }> = [];
	let sourceHash = "";
	let compileOffered = false;
	/** Repo-relative markdown files the user chose as rules (config.json); empty when none. */
	let rulesFiles: string[] = [];
	/** config.json exists: the user already answered, so never prompt again. */
	let rulesConfigured = false;
	/** Asked this session (a dismissed prompt returns next session, not next turn). */
	let rulesAsked = false;
	let judge: ChainJudge | undefined;
	/** Tree at the start of the current user turn. */
	let baseline: string | undefined;
	/** Files already judged per edit this turn; the turn check skips their edit rules. */
	const editedThisTurn = new Set<string>();
	/** Tree before each in-flight edit tool call; undefined when the snapshot failed. */
	const preEdit = new Map<string, string | undefined>();

	const now = () => new Date().toISOString();

	const log = (events: ProctorEvent[]) => {
		if (!root) return;
		appendEvents(root, events).catch(err => pi.logger.warn("proctor: event log write failed", { error: String(err) }));
	};

	const getJudge = (ctx: ExtensionContext): ChainJudge => {
		judge ??= resolveJudge({
			settings: pi.pi.settings,
			registry: ctx.modelRegistry,
			sessionId: ctx.sessionManager.getSessionId(),
			purpose: "proctor",
			cache: sharedJudgmentCache(),
			onUsage: journalJudgmentUsage(ctx.sessionManager),
		});
		return judge;
	};

	/** Re-read the rubric when the file changed (the agent may have just compiled it). */
	const currentRubric = async (): Promise<Rubric | undefined> => {
		if (!root) return undefined;
		const stat = await fs.stat(path.join(root, RUBRIC_PATH)).catch(() => undefined);
		if (!stat) {
			rubric = undefined;
			rubricMtime = 0;
			return undefined;
		}
		if (stat.mtimeMs === rubricMtime) return rubric;
		rubricMtime = stat.mtimeMs;
		try {
			rubric = await loadRubric(root);
			rubricError = undefined;
		} catch (err) {
			rubric = undefined;
			rubricError = err instanceof RubricError ? err.message : String(err);
		}
		return rubric;
	};

	/** Fading toast (or stderr when headless). Only for mid-turn notes: `notify` mid-turn would steer the model. */
	const toast = (ctx: ExtensionContext, text: string, level: "info" | "warning" | "error" = "info") => {
		if (ctx.hasUI) ctx.ui.notify(text, level);
		else process.stderr.write(`${text}\n`);
	};

	/**
	 * Output the user must not miss: a transcript line instead of a toast that fades; stderr when headless.
	 * While the agent streams, `sendMessage` would steer the running turn, so fall back to a toast then.
	 */
	const notify = (ctx: ExtensionContext, text: string, level: "info" | "warning" | "error" = "info") => {
		if (ctx.hasUI && !ctx.isIdle()) return toast(ctx, text, level);
		const line = level === "info" ? text : `${level === "error" ? "Error" : "Warning"}: ${text}`;
		if (ctx.hasUI) pi.sendMessage({ customType: "proctor-note", content: line, display: true });
		else process.stderr.write(`${line}\n`);
	};

	const record = (phase: Phase, verdicts: readonly Verdict[]): ProctorEvent[] =>
		verdicts.flatMap(v =>
			v.band === "pass"
				? []
				: [{ kind: "verdict", at: now(), phase, rule: v.rule.id, p: v.p, band: v.band, file: v.file } as const],
		);

	const refreshSources = async (ctx: ExtensionContext) => {
		// git reports the real path; OMP may report the symlinked cwd (/tmp, /var on macOS). Compare like with like.
		const found = await Promise.all(
			(await pi.pi.discoverContextFiles(ctx.cwd)).map(async f => ({
				path: await fs.realpath(f.path).catch(() => f.path),
				content: f.content,
			})),
		);
		for (const rel of rulesFiles) {
			const abs = path.join(root ?? ctx.cwd, rel);
			const content = await Bun.file(abs).text().catch(() => undefined);
			if (content !== undefined && !found.some(f => f.path === abs)) found.push({ path: abs, content });
		}
		sources = found;
		sourceHash = hashSources(sources);
	};

	/** Repo-relative paths of instruction files inside the repo (user-global ones excluded). */
	const projectRules = (): string[] =>
		sources.map(s => path.relative(root ?? "", s.path)).filter(rel => !rel.startsWith(".."));

	/** Make `inputs` the rules files. Returns an error message, or undefined on success. */
	const useRulesFiles = async (ctx: ExtensionContext, inputs: string[]): Promise<string | undefined> => {
		if (!root) return "not in a git repository";
		const rels: string[] = [];
		for (const input of inputs) {
			const rel = path.relative(root, path.resolve(root, input));
			if (rel.startsWith("..") || path.isAbsolute(rel)) return `${input} is outside the repository`;
			if (!(await Bun.file(path.join(root, rel)).exists())) return `${input} does not exist`;
			rels.push(rel);
		}
		rulesFiles = rels;
		rulesConfigured = true;
		await saveRulesFiles(root, rels);
		await refreshSources(ctx);
		return undefined;
	};

	/** No AGENTS.md / CLAUDE.md: tell the user and let them pick the file that holds the rules. */
	const offerRulesFile = async (ctx: ExtensionContext, force = false) => {
		if (!root || (!force && (rulesAsked || rulesConfigured || projectRules().length > 0))) return;
		rulesAsked = true;
		const candidates = rulesCandidates(await markdownFiles(root));
		if (!ctx.hasUI) {
			const hint = candidates.length ? ` Candidates: ${candidates.join(", ")}.` : "";
			notify(ctx, `Proctor: no AGENTS.md or CLAUDE.md in this repo, so there are no rules to enforce.${hint} Run /proctor use <file> to choose the rules file.`, "warning");
			return;
		}
		const other = "Another file...";
		const none = "None, stop asking";
		const title = projectRules().length
			? "Which file holds extra project rules for Proctor?"
			: "Proctor found no AGENTS.md or CLAUDE.md. Which file holds this project's rules?";
		const picked = await ctx.ui.select(title, [...candidates, other, none]);
		if (!picked) return; // dismissed: ask again next session
		if (picked === none) {
			rulesFiles = [];
			rulesConfigured = true;
			await saveRulesFiles(root, []);
			notify(ctx, "Proctor has no rules file and stays idle here. Run /proctor use <file> any time to pick one.");
			return;
		}
		const file = picked === other ? await ctx.ui.input("Rules file path, relative to the repo root", "DESIGN.md") : picked;
		if (!file) return;
		const err = await useRulesFiles(ctx, [file]);
		notify(ctx, err ? `Proctor: ${err}.` : `Proctor will read rules from ${file}.`, err ? "warning" : "info");
	};

	const activate = async (ctx: ExtensionContext) => {
		root = await repoRoot(ctx.cwd);
		judge = undefined;
		compileOffered = false;
		baseline = undefined;
		editedThisTurn.clear();
		preEdit.clear();
		rubricMtime = 0;
		if (!root) return;
		const chosen = await loadRulesFiles(root);
		rulesFiles = chosen ?? [];
		rulesConfigured = chosen !== undefined;
		rulesAsked = false;
		await refreshSources(ctx);
		await currentRubric();
		if (rubricError) toast(ctx, `Proctor: ${RUBRIC_PATH} is invalid (${rubricError}); checks are off until it is fixed.`, "error");
	};

	const needsCompile = () => sources.length > 0 && (!rubric || rubric.sourceHash !== sourceHash);

	// ---------------------------------------------------------------- lifecycle

	pi.on("session_start", async (_event, ctx) => {
		await activate(ctx);
	});
	pi.on("session_switch", async (_event, ctx) => {
		await activate(ctx);
	});

	// proctor-note lines are for the user; the model only needs the compile prompt (customType "proctor").
	pi.on("context", async event => ({
		messages: event.messages.filter(m => !(m.role === "custom" && m.customType === "proctor-note")),
	}));

	pi.on("before_agent_start", async (_event, ctx) => {
		if (!root) await activate(ctx); // repo may have been created mid-session
		if (!root || !enabled) return;
		await offerRulesFile(ctx);
		editedThisTurn.clear();
		try {
			baseline = await snapshot(root);
		} catch (err) {
			baseline = undefined;
			log([{ kind: "miss", at: now(), phase: "turn", reason: `snapshot: ${missReason(err)}` }]);
		}
		await currentRubric();
		if (!needsCompile() || compileOffered) return;
		compileOffered = true;
		return {
			message: {
				customType: "proctor",
				display: true,
				content: compilePrompt({ files: sources, sourceHash, root, existing: rubric }),
			},
		};
	});

	// ---------------------------------------------------------------- edit phase

	pi.on("tool_call", async event => {
		if (!root || !enabled || !EDIT_TOOLS[event.toolName] || !(await currentRubric())) return;
		// Awaited: the tool must not run until the "before" tree is written, or a fast write races it.
		try {
			preEdit.set(event.toolCallId, await snapshot(root));
		} catch (err) {
			preEdit.set(event.toolCallId, undefined);
			log([{ kind: "miss", at: now(), phase: "edit", reason: `snapshot: ${missReason(err)}` }]);
		}
	});

	pi.on("tool_result", async (event, ctx) => {
		if (!preEdit.has(event.toolCallId)) return;
		const before = preEdit.get(event.toolCallId);
		preEdit.delete(event.toolCallId);
		if (!root || !enabled || event.isError) return;
		const current = await currentRubric();
		if (!before || !current) return;
		const started = Date.now();
		let diffs: FileDiff[];
		try {
			diffs = await diffTrees(root, before, await snapshot(root));
		} catch (err) {
			log([{ kind: "miss", at: now(), phase: "edit", reason: `diff: ${missReason(err)}` }]);
			return;
		}
		const verdicts: Verdict[] = [];
		const events: ProctorEvent[] = [];
		let rulesRun = 0;
		await Promise.all(
			diffs.map(async d => {
				editedThisTurn.add(d.path);
				const rules = activeRules(current, "edit", d.path);
				rulesRun += rules.length;
				try {
					verdicts.push(...(await judgeChange(getJudge(ctx), current, rules, { file: d.path, diff: d.diff })));
				} catch (err) {
					events.push({ kind: "miss", at: now(), phase: "edit", reason: missReason(err), file: d.path });
				}
			}),
		);
		if (rulesRun === 0) return;
		events.push({ kind: "check", at: now(), phase: "edit", rules: rulesRun, files: diffs.length, ms: Date.now() - started });
		log([...events, ...record("edit", verdicts)]);
		const note = noteMessage(verdicts);
		if (note) toast(ctx, note, "warning");
		const repair = repairMessage(verdicts, "edit");
		return repair ? { additionalContext: repair } : undefined;
	});

	// ---------------------------------------------------------------- turn phase

	/** Turn rules grouped by identical scope, each over the concatenated in-scope diffs. */
	const turnGroups = (current: Rubric, diffs: readonly FileDiff[]) => {
		const groups = new Map<string, { rules: Rule[]; diffs: FileDiff[] }>();
		for (const rule of activeRules(current, "turn")) {
			const inRule = diffs.filter(d => inScope(rule, d.path));
			if (inRule.length === 0) continue;
			const key = JSON.stringify(rule.scope ?? []);
			const group = groups.get(key) ?? { rules: [], diffs: inRule };
			group.rules.push(rule);
			groups.set(key, group);
		}
		return [...groups.values()];
	};

	pi.on("session_stop", async (event, ctx) => {
		if (!root || !enabled || !baseline) return;
		const current = await currentRubric();
		if (!current) return;
		const started = Date.now();
		let diffs: FileDiff[];
		try {
			diffs = await diffTrees(root, baseline, await snapshot(root));
		} catch (err) {
			log([{ kind: "miss", at: now(), phase: "turn", reason: `diff: ${missReason(err)}` }]);
			return;
		}
		if (diffs.length === 0) return;

		const jobs: Array<{ rules: Rule[]; file?: string; diff: string; phase: Phase }> = [];
		for (const group of turnGroups(current, diffs)) {
			jobs.push({ rules: group.rules, diff: group.diffs.map(d => d.diff).join("\n"), phase: "turn" });
		}
		// Files no edit tool touched (bash, eval, external writes) never got their edit rules.
		for (const d of diffs) {
			if (editedThisTurn.has(d.path)) continue;
			const rules = activeRules(current, "edit", d.path);
			if (rules.length) jobs.push({ rules, file: d.path, diff: d.diff, phase: "edit" });
		}
		if (jobs.length === 0) return;

		const verdicts: Verdict[] = [];
		const events: ProctorEvent[] = [];
		await Promise.all(
			jobs.map(async job => {
				try {
					const vs = await judgeChange(getJudge(ctx), current, job.rules, { file: job.file, diff: job.diff }, event.signal);
					verdicts.push(...vs);
					events.push(...record(job.phase, vs));
				} catch (err) {
					events.push({ kind: "miss", at: now(), phase: job.phase, reason: missReason(err), file: job.file });
				}
			}),
		);
		events.push({
			kind: "check",
			at: now(),
			phase: "turn",
			rules: jobs.reduce((n, j) => n + j.rules.length, 0),
			files: diffs.length,
			ms: Date.now() - started,
		});
		log(events);

		const note = noteMessage(verdicts);
		if (note) toast(ctx, note, "warning");
		const repair = repairMessage(verdicts, "turn");
		if (!repair) return;
		// One continuation per turn: a second failing pass goes to the user instead of looping.
		if (event.stop_hook_active) {
			toast(ctx, `${repair}\n(Not sent: the agent already had one repair pass this turn.)`, "warning");
			return;
		}
		return { continue: true, additionalContext: repair };
	});

	// ---------------------------------------------------------------- /proctor

	const USAGE =
		"Usage: /proctor [status|on|off|compile|use [files...]|report|audit [paths...]|calibrate [commits]]";

	pi.registerCommand("proctor", {
		description: "Rule enforcement: status, on, off, compile, use, report, audit, calibrate",
		handler: async (args, ctx) => {
			const [sub = "status", ...rest] = args.trim().split(/\s+/).filter(Boolean);
			if (!root) await activate(ctx); // repo may have been created mid-session
			if (!root) {
				const offer = ctx.hasUI && (await ctx.ui.confirm("Proctor needs a git repository", `Run \`git init\` in ${ctx.cwd}?`));
				if (!offer) {
					notify(ctx, "Proctor needs a git repository; it is inactive here.", "warning");
					return;
				}
				try {
					await initRepo(ctx.cwd);
				} catch (err) {
					notify(ctx, `git init failed: ${err instanceof Error ? err.message : String(err)}`, "error");
					return;
				}
				await activate(ctx);
				if (!root) return;
				notify(ctx, `Initialized a git repository in ${root}.`);
			}
			const current = await currentRubric();
			switch (sub) {
				case "status": {
					await refreshSources(ctx);
					const state = enabled ? "on" : "off";
					const rubricState = rubricError
						? `invalid: ${rubricError}`
						: current
							? `${current.rules.filter(r => r.enabled).length}/${current.rules.length} rules enabled${needsCompile() ? ", stale (instruction files changed)" : ""}`
							: "no rubric yet";
					const model = getJudge(ctx).primaryModel();
					notify(
						ctx,
						`Proctor ${state}. Rules from: ${projectRules().join(", ") || "none (run /proctor use <file>)"}. ${RUBRIC_PATH}: ${rubricState}. Judge: ${model ? `${model.provider}/${model.id}` : "none available"}.`,
					);
					return;
				}
				case "on":
				case "off":
					enabled = sub === "on";
					notify(ctx, `Proctor ${sub} for this session.`);
					return;
				case "compile":
					await refreshSources(ctx);
					if (sources.length === 0) {
						notify(ctx, "Proctor: no rules to compile. No AGENTS.md or CLAUDE.md found; run /proctor use <file> to choose one.", "warning");
						return;
					}
					compileOffered = true;
					pi.sendUserMessage(compilePrompt({ files: sources, sourceHash, root, existing: current }));
					return;
				case "use": {
					if (rest.length === 0) {
						await offerRulesFile(ctx, true);
					} else {
						const err = await useRulesFiles(ctx, rest);
						notify(ctx, err ? `Proctor: ${err}.` : `Proctor will read rules from ${rest.join(", ")}. Run /proctor compile to rebuild the rubric.`, err ? "warning" : "info");
					}
					return;
				}
				case "report":
					if (!current) break;
					notify(ctx, formatReport(summarize(current, await readEvents(root))));
					return;
				case "audit": {
					if (!current) break;
					const files = await trackedFiles(root, rest);
					notify(ctx, `Proctor: auditing ${files.length} files...`);
					const result = await audit(getJudge(ctx), current, root, files);
					const lines = [`Proctor audit: ${result.files} files, ${result.verdicts.length} findings`];
					const sorted = [...result.verdicts].sort((a, b) => b.p - a.p);
					for (const v of sorted) lines.push(`${v.band === "repair" ? "!" : "?"} ${v.p.toFixed(2)} ${v.rule.id}  ${v.file}`);
					if (result.failed.length) lines.push(`Unchecked: ${result.failed.map(f => f.file).join(", ")}`);
					notify(ctx, lines.join("\n"), result.verdicts.some(v => v.band === "repair") ? "warning" : "info");
					return;
				}
				case "calibrate": {
					if (!current) break;
					const commits = Number.parseInt(rest[0] ?? "20", 10) || 20;
					const hunks = await recentHunks(root, commits);
					if (hunks.length === 0) {
						notify(ctx, "Proctor: no commit history to calibrate against.", "warning");
						return;
					}
					notify(ctx, `Proctor: calibrating against ${hunks.length} hunks from ${commits} commits...`);
					const result = await calibrate(getJudge(ctx), current, hunks);
					// Rules with too few samples are returned untouched; skip the write so a committed file does not churn.
					if (JSON.stringify(result.rubric) !== JSON.stringify(current)) await saveRubric(root, result.rubric);
					const flat = result.rows.filter(r => r.flat);
					const lines = [`Proctor calibrate: ${result.rows.length} rules scored, ${flat.length} disabled as non-discriminating`];
					for (const r of result.rows) {
						const stats = r.samples ? `min ${r.min.toFixed(2)} max ${r.max.toFixed(2)}` : "no matching hunks";
						const few = r.samples > 0 && r.samples < MIN_CALIBRATION_SAMPLES ? ", too few to judge" : "";
						lines.push(`${r.flat ? "x" : " "} ${r.id}  ${stats} (${r.samples} samples${few})`);
					}
					if (flat.length) lines.push("Rewrite the disabled rules' questions, then set enabled back to true.");
					notify(ctx, lines.join("\n"));
					return;
				}
				default:
					notify(ctx, USAGE, "warning");
					return;
			}
			notify(ctx, `Proctor: no rubric at ${RUBRIC_PATH} yet. Run /proctor compile.`, "warning");
		},
	});

	pi.logger.debug("proctor loaded", { dir: PROCTOR_DIR });
}
