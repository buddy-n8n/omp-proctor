# omp-proctor

Proctor makes an [oh-my-pi](https://github.com/can1357/oh-my-pi) agent abide by your project rules. Every edit, and every finished turn, is judged against the rules in your instruction files (AGENTS.md, CLAUDE.md, and the rest OMP already loads). A confident violation sends the agent a repair request in the same turn.

It is the OMP counterpart of [abide](https://github.com/coldteadotai/abide), built on OMP's own judgment chain instead of an external hook process.

Proctor vs. Advisor: the advisor is a second model that reads the conversation and offers open-ended notes ("weigh, don't blindly obey"). The proctor never sees the conversation. It sees one diff and a fixed list of quoted rules, answers one yes/no question per rule with a probability, and asks for a repair only above a threshold.

## Install

```
omp plugin install github:buddy-n8n/omp-proctor   # once published
omp -e /path/to/omp-proctor/src/index.ts           # or load it for one run
```

Requires OMP 18.4.4 or later and a git repository.

Judgments go through OMP's `judge` model role. With `TYPESAFE_API_KEY` set that is TypeSafe System One (Jev), about 300 ms per check. Without it, OMP falls back to your small chat model (Haiku here), which works but is slower.

## How it works

0. **Find the rules.** Proctor reads AGENTS.md, CLAUDE.md and the other instruction files OMP loads. If the repo has none, the first prompt opens a checklist. Rules files other coding agents use are found and checked for you (`GEMINI.md`, `CONVENTIONS.md`, `.cursorrules`, `.windsurfrules`, `.clinerules`, `.rules`, `.cursor/rules/*`, `.windsurf/rules/*`, `.github/copilot-instructions.md`, `.github/instructions/*`). Other likely markdown (such as `DESIGN.md`) is listed unchecked. Toggle files, "Select all", or "Add another file..." (a typed path is validated and reprompts until valid; leave it empty to go back). Then Done, and choose to save and compile now, save and compile later, or cancel and change nothing. "None, stop asking" silences it. When files are already checked the cursor starts on Done, so accepting the defaults is two Enters (Done, then compile now). The choice is saved in `.omp/proctor/config.json` (commit it) and not asked again; change it with `/proctor use`, which lists your current pick checked. Headless runs only print a notice.
1. **Compile.** On the first prompt of a session, if the instruction files changed since the rubric was compiled (or there is no rubric), Proctor asks the agent to compile `.omp/proctor/rubric.json`. Commit that file. `/proctor compile` reruns it.
2. **Edit phase.** Before each `edit`, `write` or `ast_edit`, Proctor snapshots the working tree into a throwaway git index. Afterwards it diffs the two trees and judges each changed file against the `edit` rules in scope. The judge sees only `{file, diff}` and the rules.
3. **Turn phase.** When the agent is about to stop, Proctor diffs the whole turn against the snapshot taken when the prompt arrived. It runs `turn` rules (scope creep, duplication, single-use abstractions) and the `edit` rules for files that no edit tool touched, such as files written by `bash`. A violation asks for one continuation; a second failing pass is reported to you instead of looping.
4. **Bands.** At or above `repairThreshold` (0.8) the agent is told to repair and names the rule, its source line and quote. Between `noteThreshold` (0.5) and repair you get a note and the agent does not. Below that nothing happens.
5. **Fail open.** No judge model, no credentials, a timeout (`timeoutMs`, default 10 s) or any error: the edit goes through and a miss is logged to `.omp/proctor/events.jsonl` (gitignored).

Example repair request, as the agent receives it:

```
Proctor: this edit appears to break a rule from this repository's instructions.
- Rule "no-var-declarations" from AGENTS.md line 3: "In JavaScript, never declare variables with `var`; use `const` or `let`." (1.00)
Repair src/legacy.js now, then continue with the task.
```

## Commands

| Command | What it does |
|---|---|
| `/proctor` or `/proctor status` | on/off, rubric state (stale if instruction files changed), which judge model answers |
| `/proctor on` / `off` | toggle for this session |
| `/proctor compile` | have the agent (re)compile the rubric |
| `/proctor use [files...]` | choose the rules files: with paths, validate them, confirm, save and (optionally) compile; with none, open the checklist. Saved to `.omp/proctor/config.json` |
| `/proctor report` | per rule: repairs and notes fired, rules that never fired, unchecked counts by reason |
| `/proctor audit [paths...]` | judge existing tracked files as if just written |
| `/proctor calibrate [commits]` | score rules against recent commit hunks (default 20); disable rules whose scores barely move and never reach the note band |

## The rubric

```json
{
  "version": 1,
  "sourceHash": "e9195622ae7dc612",
  "repairThreshold": 0.8,
  "noteThreshold": 0.5,
  "timeoutMs": 10000,
  "rules": [
    {
      "id": "no-var-declarations",
      "source": { "file": "AGENTS.md", "line": 3, "quote": "In JavaScript, never declare variables with `var`; use `const` or `let`." },
      "question": "Does this change declare any JavaScript variable with `var` instead of `const` or `let`?",
      "phase": "edit",
      "scope": ["**/*.js"],
      "linterCheckable": false,
      "enabled": true
    }
  ]
}
```

- `question` is phrased so YES means the rule is broken.
- `phase`: `edit` after each edit, `turn` once over the whole change set.
- `scope`: repo-root-relative globs; omit for every file.
- `linterCheckable: true` hands the rule to your configured linter; Proctor skips it.
- A wrong verdict is a rule you can rewrite. Edit the file; Proctor reloads it on the next check.

## Limits

- Git repositories only. Outside one, `/proctor` offers to run `git init`; if you decline, Proctor stays inactive.
- `sourceHash` covers every instruction file OMP loads, including user-global ones such as `~/.claude/CLAUDE.md`, so teammates with different global files see the rubric as stale.
- Edit tool calls that run in parallel can see each other's changes in their before/after diffs, so a file changed by a sibling call may be judged twice.

## Development

```
bun test        # includes a fake-host matrix: repo or not, AGENTS.md or not, each prompt answer, headless
```
