import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import proctor from "../src/index";
import { loadRulesFiles, rulesCandidates, saveRulesFiles, standardRuleFiles } from "../src/sources";

describe("rulesCandidates", () => {
	test("offers root markdown and single-file folders, hints first, skips boilerplate and nested noise", () => {
		const files = [
			"README.md",
			"CHANGELOG.md",
			"NOTES.md",
			"DESIGN.md",
			"docs/guide.md", // only md in docs/: offered
			"specs/a.md",
			"specs/b.md", // two in specs/: ambiguous, skipped
			"src/deep/inner.md", // too deep
			"node_modules/x/README.md",
			".github/rules.md",
			"src/index.ts",
		];
		expect(rulesCandidates(files)).toEqual(["DESIGN.md", "NOTES.md", "docs/guide.md"]);
	});

	test("no markdown means no candidates", () => {
		expect(rulesCandidates(["src/a.ts", "README.md"])).toEqual([]);
	});
});

describe("standardRuleFiles", () => {
	test("recognises what other coding agents use, at the right locations only", () => {
		const files = [
			"AGENTS.md",
			"GEMINI.md",
			"CONVENTIONS.md",
			".cursorrules",
			".cursor/rules/style.mdc",
			".windsurfrules",
			".clinerules/naming.md",
			".github/copilot-instructions.md",
			".github/instructions/ts.instructions.md",
			".github/instructions/notes.md", // not an instructions file
			"docs/CONVENTIONS.md", // only the root name is the standard
			"README.md",
			"DESIGN.md", // plausible, but not a standard
		];
		expect(standardRuleFiles(files)).toEqual([
			".clinerules/naming.md",
			".cursor/rules/style.mdc",
			".cursorrules",
			".github/copilot-instructions.md",
			".github/instructions/ts.instructions.md",
			".windsurfrules",
			"AGENTS.md",
			"CONVENTIONS.md",
			"GEMINI.md",
		]);
	});
});

describe("rules config", () => {
	test("distinguishes never asked, chose none, and chose files", async () => {
		const dir = await fs.mkdtemp(path.join(os.tmpdir(), "proctor-cfg-"));
		expect(await loadRulesFiles(dir)).toBeUndefined();
		await saveRulesFiles(dir, []);
		expect(await loadRulesFiles(dir)).toEqual([]);
		await saveRulesFiles(dir, ["DESIGN.md"]);
		expect(await loadRulesFiles(dir)).toEqual(["DESIGN.md"]);
		await fs.writeFile(path.join(dir, ".omp/proctor/config.json"), "{ not json");
		expect(await loadRulesFiles(dir)).toBeUndefined();
	});
});

// ---------------------------------------------------------------- extension host

/** Stands in for ~/.claude: instruction files OMP loads from outside the repo. */
const globalDir = path.join(os.tmpdir(), "proctor-global-home");

const sent: string[] = [];

type SelectOpts = { selectionMarker?: string; checkedIndices?: readonly number[]; markableCount?: number; initialIndex?: number };
type Answers = { confirm?: boolean; select?: (options: string[], title: string, opts?: SelectOpts) => string | undefined; inputs?: string[] };

/** Loads the real extension against a fake OMP host and a real temp directory. */
async function host(dir: string, answers: Answers = {}, hasUI = true) {
	const handlers = new Map<string, (event: unknown, ctx: unknown) => Promise<any>>();
	let command: (args: string, ctx: unknown) => Promise<void> = async () => {};
	const notices: string[] = []; // transcript lines: survive on screen
	const state = { idle: true }; // flip to simulate a command typed while the agent streams
	const toasts: string[] = []; // fading toasts: must not carry command output
	const asked = { select: 0, confirm: 0 };
	const prompts: string[] = []; // titles of the path prompts, in order
	const inputs = [...(answers.inputs ?? [])];
	const pi = {
		setLabel() {},
		on: (name: string, fn: (event: unknown, ctx: unknown) => Promise<any>) => handlers.set(name, fn),
		registerCommand: (_name: string, cmd: { handler: typeof command }) => {
			command = cmd.handler;
		},
		sendUserMessage: (m: string) => sent.push(m),
		sendMessage: (m: { content: string; display?: boolean }) => {
			if (m.display) notices.push(m.content);
		},
		logger: { warn() {}, debug() {} },
		pi: {
			settings: {},
			// Like OMP: the repo's AGENTS.md if present, plus a user-global file outside the repo.
			discoverContextFiles: async () => {
				const found = [{ path: path.join(globalDir, "CLAUDE.md"), content: "- Be kind.\n" }];
				const file = path.join(dir, "AGENTS.md");
				const content = await Bun.file(file).text().catch(() => undefined);
				return content === undefined ? found : [...found, { path: file, content }];
			},
		},
	};
	proctor(pi as never);
	const ctx = {
		cwd: dir,
		hasUI,
		isIdle: () => state.idle,
		sessionManager: { getSessionId: () => "s" },
		modelRegistry: { getAvailable: () => [] },
		ui: {
			notify: (text: string) => toasts.push(text),
			confirm: async () => {
				asked.confirm++;
				return answers.confirm ?? false;
			},
			select: async (title: string, options: string[], opts?: SelectOpts) => {
				asked.select++;
				return answers.select?.(options, title, opts);
			},
			input: async (title: string) => {
				prompts.push(title);
				return inputs.shift();
			},
		},
	};
	return {
		notices,
		toasts,
		asked,
		prompts,
		start: () => handlers.get("session_start")!({}, ctx),
		turn: () => handlers.get("before_agent_start")!({}, ctx),
		context: (messages: unknown[]) => handlers.get("context")!({ messages }, ctx),
		state,
		run: (args: string) => command(args, ctx),
	};
}

describe("what the model sees", () => {
	test("user-facing proctor-note lines are dropped from LLM context; the compile prompt stays", async () => {
		const h = await host(await repo({}));
		const messages = [
			{ role: "user", content: "hi" },
			{ role: "custom", customType: "proctor-note", content: "Proctor will read rules from DESIGN.md." },
			{ role: "custom", customType: "proctor", content: "[proctor] Compile the project rubric" },
		];
		const result = await h.context(messages);
		expect(result.messages.map((m: { customType?: string; role: string }) => m.customType ?? m.role)).toEqual(["user", "proctor"]);
	});
});

describe("commands while the agent is streaming", () => {
	test("use a toast: a transcript message would steer the running turn", async () => {
		const h = await host(await repo({}));
		h.state.idle = false;
		await h.run("on");
		expect(h.notices).toEqual([]);
		expect(h.toasts).toEqual(["Proctor on for this session."]);
		h.state.idle = true;
		await h.run("off");
		expect(h.notices).toEqual(["Proctor off for this session."]);
	});
});

const dirs: string[] = [];
async function repo(files: Record<string, string>) {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "proctor-host-"));
	dirs.push(dir);
	Bun.spawnSync(["git", "init", "-q"], { cwd: dir });
	for (const [name, content] of Object.entries(files)) await Bun.write(path.join(dir, name), content);
	return dir;
}
afterEach(async () => {
	for (const d of dirs.splice(0)) await fs.rm(d, { recursive: true, force: true });
});

/** Scripted answers for the rules dialogs: step n answers the nth dialog; the last step repeats. */
type Step = (options: string[], title: string, opts?: SelectOpts) => string | undefined;
const dialog = (...steps: Step[]) => {
	let i = 0;
	return (options: string[], title: string, opts?: SelectOpts) => steps[Math.min(i++, steps.length - 1)](options, title, opts);
};
const choose = (re: RegExp) => (options: string[]) => options.find(o => re.test(o));
const toggle = (file: string) => (options: string[]) => options.find(o => o === file);
/** The files the dialog showed as checked. */
const checkedIn = (options: string[], opts?: SelectOpts) => (opts?.checkedIndices ?? []).map(i => options[i]).sort();
const done = choose(/^Done/);
const compileNow = choose(/compile the rubric now/i);
const compileLater = choose(/compile later/i);
const cancel = choose(/^Cancel/);

describe("the picker", () => {
	test("standard files found are checked already, so accepting takes two steps; other markdown is offered unchecked", async () => {
		const dir = await repo({ ".cursorrules": "- No var.\n", "CONVENTIONS.md": "- Small PRs.\n", "DESIGN.md": "x\n", "README.md": "hi\n" });
		let seen: { options: string[]; opts?: SelectOpts } | undefined;
		const h = await host(dir, { select: dialog((o, _t, opts) => ((seen = { options: o, opts }), done(o)), compileNow) });
		await h.start();
		const result = await h.turn();
		expect(seen?.opts?.selectionMarker).toBe("checkbox");
		expect(checkedIn(seen!.options, seen!.opts)).toEqual([".cursorrules", "CONVENTIONS.md"]);
		expect(seen!.options).toContain("DESIGN.md"); // offered, unchecked
		expect(seen!.options.some(o => /README/.test(o))).toBe(false);
		expect(seen!.opts?.markableCount).toBe(3); // the action rows carry no checkbox
		expect(seen!.opts?.initialIndex).toBe(seen!.options.findIndex(o => /^Done/.test(o))); // Enter accepts the defaults
		expect(await loadRulesFiles(dir)).toEqual([".cursorrules", "CONVENTIONS.md"]);
		expect(result.message.content).toContain(".cursorrules");
		expect(result.message.content).not.toContain("DESIGN.md");
		await h.turn();
		expect(h.asked.select).toBe(2); // not asked again on turn two
	});

	test("toggling adds and removes files and keeps the cursor on the toggled row; Select all takes everything offered", async () => {
		const dir = await repo({ "CONVENTIONS.md": "a\n", "DESIGN.md": "b\n", "NOTES.md": "c\n" });
		const seen: Array<{ checked: string[]; cursor?: number }> = [];
		const record = (next: Step): Step => (o, t, opts) => (seen.push({ checked: checkedIn(o, opts), cursor: opts?.initialIndex }), next(o, t, opts));
		const h = await host(dir, {
			select: dialog(record(toggle("CONVENTIONS.md")), record(toggle("DESIGN.md")), record(done), compileNow),
		});
		await h.start();
		await h.turn();
		expect(seen.map(s => s.checked)).toEqual([["CONVENTIONS.md"], [], ["DESIGN.md"]]); // preselected, removed, then DESIGN.md added
		expect(seen.map(s => s.cursor)).toEqual([5, 0, 1]); // starts on Done (5 = 3 files + Add + Select all), then stays on the toggled row
		expect(await loadRulesFiles(dir)).toEqual(["DESIGN.md"]);

		const all = await repo({ "CONVENTIONS.md": "a\n", "DESIGN.md": "b\n", "NOTES.md": "c\n" });
		const h2 = await host(all, { select: dialog(choose(/^Select all/), done, compileNow) });
		await h2.start();
		await h2.turn();
		expect((await loadRulesFiles(all))?.sort()).toEqual(["CONVENTIONS.md", "DESIGN.md", "NOTES.md"]);
	});

	test("Done with nothing selected asks again instead of saving an empty list", async () => {
		const dir = await repo({ "DESIGN.md": "x\n" });
		const titles: string[] = [];
		const h = await host(dir, { select: dialog(done, (o, t) => (titles.push(t), cancel(o))) });
		await h.start();
		await h.turn();
		expect(titles[0]).toMatch(/at least one file/);
		expect(await loadRulesFiles(dir)).toBeUndefined();
	});

	test("a typed path is checked, bad ones reprompt, and an empty answer backs out with nothing saved", async () => {
		const dir = await repo({ "DESIGN.md": "x\n" });
		const h = await host(dir, { select: dialog(choose(/^Add another/), cancel), inputs: ["nope.md", "../x.md", ""] });
		await h.start();
		await h.turn();
		expect(h.prompts).toHaveLength(3);
		expect(h.prompts[1]).toMatch(/nope\.md does not exist/);
		expect(h.prompts[2]).toMatch(/\.\.\/x\.md is outside the repository/);
		expect(await loadRulesFiles(dir)).toBeUndefined();
	});

	test("a valid typed path joins the selection, whatever it is called", async () => {
		const dir = await repo({ "team-rules.txt": "- No var.\n" });
		const h = await host(dir, { select: dialog(choose(/^Add another/), done, compileNow), inputs: ["team-rules.txt"] });
		await h.start();
		await h.turn();
		expect(await loadRulesFiles(dir)).toEqual(["team-rules.txt"]);
	});

	test("the last step offers to compile now or later, and later is not re-offered on the next prompt", async () => {
		sent.length = 0;
		const dir = await repo({ "DESIGN.md": "- No var.\n" });
		const h = await host(dir, { select: dialog(toggle("DESIGN.md"), done, compileLater) });
		await h.start();
		expect(await h.turn()).toBeUndefined();
		expect(await loadRulesFiles(dir)).toEqual(["DESIGN.md"]);
		expect(sent).toHaveLength(0);
		expect(await h.turn()).toBeUndefined(); // the next prompt neither asks nor compiles
		expect(h.asked.select).toBe(3);
		expect(sent).toHaveLength(0);
		await h.run("compile");
		expect(sent).toHaveLength(1);
		expect(sent[0]).toContain("DESIGN.md");
	});

	test("/proctor use lists the current pick checked, so it can be kept or removed", async () => {
		const dir = await repo({ "DESIGN.md": "x\n", "NOTES.md": "y\n" });
		await saveRulesFiles(dir, ["DESIGN.md"]);
		const seen: Array<{ options: string[]; checked: string[] }> = [];
		const h = await host(dir, { select: dialog((o, _t, opts) => (seen.push({ options: o, checked: checkedIn(o, opts) }), cancel(o))) });
		await h.start();
		await h.run("use");
		expect(seen[0].options).toContain("DESIGN.md");
		expect(seen[0].checked).toEqual(["DESIGN.md"]);
	});

	test("uppercase .MD files are offered too", async () => {
		const dir = await repo({ "RULES.MD": "x\n" });
		let offered: string[] = [];
		const h = await host(dir, { select: dialog(o => ((offered = o), cancel(o))) });
		await h.start();
		await h.turn();
		expect(offered).toContain("RULES.MD");
	});

	test("cancelling at the last step saves nothing", async () => {
		const dir = await repo({ "DESIGN.md": "x\n" });
		const h = await host(dir, { select: dialog(toggle("DESIGN.md"), done, cancel) });
		await h.start();
		await h.turn();
		expect(await loadRulesFiles(dir)).toBeUndefined();
		expect(h.notices.some(n => /will read rules from/.test(n))).toBe(false);
	});

	test("None is remembered across sessions", async () => {
		const dir = await repo({ "DESIGN.md": "- No var.\n" });
		const first = await host(dir, { select: dialog(choose(/^None/)) });
		await first.start();
		expect((await first.turn()).message.content).not.toContain("DESIGN.md");
		expect(await loadRulesFiles(dir)).toEqual([]);
		const second = await host(dir, { select: dialog(done) });
		await second.start();
		await second.turn();
		expect(second.asked.select).toBe(0);
	});

	test("dismissing saves nothing, so the next session asks again", async () => {
		const dir = await repo({ "DESIGN.md": "- No var.\n" });
		const h = await host(dir, { select: () => undefined });
		await h.start();
		await h.turn();
		expect(await loadRulesFiles(dir)).toBeUndefined();
		const next = await host(dir, { select: () => undefined });
		await next.start();
		await next.turn();
		expect(next.asked.select).toBe(1);
	});

	test("an existing AGENTS.md means no prompt at all", async () => {
		const dir = await repo({ "AGENTS.md": "- No var.\n", "DESIGN.md": "x\n" });
		const h = await host(dir, { select: done });
		await h.start();
		const result = await h.turn();
		expect(h.asked.select).toBe(0);
		expect(result.message.content).toContain("AGENTS.md");
	});

	test("user-global instruction files do not count: the picker still appears and the pick compiles beside them", async () => {
		const dir = await repo({ "DESIGN.md": "- No var.\n" });
		const h = await host(dir, { select: dialog(toggle("DESIGN.md"), done, compileNow) });
		await h.start();
		const result = await h.turn();
		expect(result.message.content).toContain("DESIGN.md");
		expect(result.message.content).toContain(path.join(globalDir, "CLAUDE.md"));
	});

	test("headless sessions get a stderr notice naming the candidates, never a prompt", async () => {
		const dir = await repo({ "DESIGN.md": "x\n" });
		const h = await host(dir, {}, false);
		const written: string[] = [];
		const realWrite = process.stderr.write.bind(process.stderr);
		process.stderr.write = ((chunk: string) => (written.push(String(chunk)), true)) as typeof process.stderr.write;
		try {
			await h.start();
			await h.turn();
		} finally {
			process.stderr.write = realWrite;
		}
		expect(h.asked.select).toBe(0);
		expect(written.join("")).toMatch(/DESIGN\.md/);
		expect(await loadRulesFiles(dir)).toBeUndefined();
	});
});

describe("/proctor use", () => {
	test("checks paths, confirms before saving, and compiles once on yes", async () => {
		sent.length = 0;
		const dir = await repo({ "DESIGN.md": "x\n" });
		const h = await host(dir, { select: dialog(() => undefined, compileNow) });
		await h.start();
		await h.turn(); // dismiss the picker; only the global file gets compiled this turn
		await h.run("use ../outside.md");
		await h.run("use nope.md");
		expect(await loadRulesFiles(dir)).toBeUndefined();
		expect(h.notices.filter(n => /outside the repository|does not exist/.test(n))).toHaveLength(2);
		await h.run("use DESIGN.md");
		expect(await loadRulesFiles(dir)).toEqual(["DESIGN.md"]);
		expect(h.notices.some(n => /will read rules from DESIGN\.md/.test(n))).toBe(true);
		expect(h.toasts).toEqual([]);
		expect(sent).toHaveLength(1);
		expect(sent[0]).toContain("DESIGN.md");
		expect(await h.turn()).toBeUndefined();
	});

	test("declining the confirmation changes nothing", async () => {
		sent.length = 0;
		const dir = await repo({ "DESIGN.md": "x\n" });
		const h = await host(dir, { select: dialog(() => undefined, cancel) });
		await h.start();
		await h.turn();
		await h.run("use DESIGN.md");
		expect(await loadRulesFiles(dir)).toBeUndefined();
		expect(sent).toHaveLength(0);
	});
});

describe("/proctor outside a git repository", () => {
	test("declining leaves the directory alone; accepting runs git init and carries on", async () => {
		const dir = await fs.mkdtemp(path.join(os.tmpdir(), "proctor-norepo-"));
		dirs.push(dir);
		const declined = await host(dir, { confirm: false });
		await declined.start();
		await declined.run("on");
		expect(declined.notices.at(-1)).toMatch(/needs a git repository/);
		expect(await Bun.file(path.join(dir, ".git/HEAD")).exists()).toBe(false);

		const accepted = await host(dir, { confirm: true });
		await accepted.start();
		await accepted.run("on");
		expect(await Bun.file(path.join(dir, ".git/HEAD")).exists()).toBe(true);
		expect(accepted.notices.some(n => /^Proctor on for this session/.test(n))).toBe(true);
	});

	test("a repo created by hand mid-session is picked up without a restart or a prompt", async () => {
		const dir = await fs.mkdtemp(path.join(os.tmpdir(), "proctor-norepo-"));
		dirs.push(dir);
		const h = await host(dir, { confirm: true });
		await h.start();
		Bun.spawnSync(["git", "init", "-q"], { cwd: dir });
		await h.run("on");
		expect(h.asked.confirm).toBe(0);
		expect(h.notices.some(n => /^Proctor on for this session/.test(n))).toBe(true);
	});
});
