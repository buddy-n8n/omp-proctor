import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import proctor from "../src/index";
import { loadRulesFiles, rulesCandidates, saveRulesFiles } from "../src/sources";

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

type Answers = { confirm?: boolean; select?: (options: string[]) => string | undefined; input?: string };

/** Loads the real extension against a fake OMP host and a real temp directory. */
async function host(dir: string, answers: Answers = {}, hasUI = true) {
	const handlers = new Map<string, (event: unknown, ctx: unknown) => Promise<any>>();
	let command: (args: string, ctx: unknown) => Promise<void> = async () => {};
	const notices: string[] = []; // transcript lines: survive on screen
	const toasts: string[] = []; // fading toasts: must not carry command output
	const asked = { select: 0, confirm: 0 };
	const pi = {
		setLabel() {},
		on: (name: string, fn: (event: unknown, ctx: unknown) => Promise<any>) => handlers.set(name, fn),
		registerCommand: (_name: string, cmd: { handler: typeof command }) => {
			command = cmd.handler;
		},
		sendUserMessage() {},
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
		sessionManager: { getSessionId: () => "s" },
		modelRegistry: { getAvailable: () => [] },
		ui: {
			notify: (text: string) => toasts.push(text),
			confirm: async () => {
				asked.confirm++;
				return answers.confirm ?? false;
			},
			select: async (_title: string, options: string[]) => {
				asked.select++;
				return answers.select?.(options);
			},
			input: async () => answers.input,
		},
	};
	return {
		notices,
		toasts,
		asked,
		start: () => handlers.get("session_start")!({}, ctx),
		turn: () => handlers.get("before_agent_start")!({}, ctx),
		run: (args: string) => command(args, ctx),
		context: (messages: unknown[]) => handlers.get("context")!({ messages }, ctx),
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

describe("user-global instruction files", () => {
	test("do not count as project rules: DESIGN.md is still offered and compiled alongside them", async () => {
		const dir = await repo({ "DESIGN.md": "- No var.\n" });
		const h = await host(dir, { select: () => "DESIGN.md" });
		await h.start();
		const result = await h.turn();
		expect(h.asked.select).toBe(1);
		expect(result.message.content).toContain("DESIGN.md");
		expect(result.message.content).toContain(path.join(globalDir, "CLAUDE.md"));
	});
});

describe("no AGENTS.md: choosing a rules file", () => {
	test("first turn offers candidates, remembers the pick, and compiles from it", async () => {
		const dir = await repo({ "DESIGN.md": "- No var.\n", "README.md": "hi\n" });
		let offered: string[] = [];
		const h = await host(dir, { select: o => ((offered = o), "DESIGN.md") });
		await h.start();
		const result = await h.turn();
		expect(offered[0]).toBe("DESIGN.md");
		expect(offered).not.toContain("README.md");
		expect(await loadRulesFiles(dir)).toEqual(["DESIGN.md"]);
		expect(result.message.content).toContain("DESIGN.md");
		await h.turn();
		expect(h.asked.select).toBe(1); // not asked again on turn two
	});

	test("choosing none is remembered across sessions", async () => {
		const dir = await repo({ "DESIGN.md": "- No var.\n" });
		const first = await host(dir, { select: o => o[o.length - 1] });
		await first.start();
		expect((await first.turn()).message.content).not.toContain("DESIGN.md");
		expect(await loadRulesFiles(dir)).toEqual([]);
		const second = await host(dir, { select: o => o[0] });
		await second.start();
		await second.turn();
		expect(second.asked.select).toBe(0);
	});

	test("dismissing the prompt saves nothing, so the next session asks again", async () => {
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
		const h = await host(dir, { select: o => o[0] });
		await h.start();
		const result = await h.turn();
		expect(h.asked.select).toBe(0);
		expect(result.message.content).toContain("AGENTS.md");
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
	test("accepts a repo file, rejects paths outside the repo and missing files", async () => {
		const dir = await repo({ "DESIGN.md": "x\n" });
		const h = await host(dir);
		await h.start();
		await h.run("use ../outside.md");
		await h.run("use nope.md");
		expect(await loadRulesFiles(dir)).toBeUndefined();
		expect(h.notices.filter(n => /outside the repository|does not exist/.test(n))).toHaveLength(2);
		expect(h.toasts).toEqual([]); // command output never goes to a toast that fades
		await h.run("use DESIGN.md");
		expect(await loadRulesFiles(dir)).toEqual(["DESIGN.md"]);
		const result = await h.turn();
		expect(result.message.content).toContain("DESIGN.md");
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
