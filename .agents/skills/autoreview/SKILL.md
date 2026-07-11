---
name: autoreview
description: "Pre-commit/ship code review: Codex default; optional Claude, Pi, Droid, Copilot, Cursor, or OpenCode."
---

# Auto Review

Run the bundled structured review helper as a closeout check. This is code review, not Guardian `auto_review` approval routing.

Codex review is the default when no engine is set. It uses `gpt-5.5` by default, usually delivers the best review results, and should remain the normal final closeout engine. Claude review is optional and uses `claude-fable-5` by default.

For user-visible behavior, pair autoreview with `behavior-validator`. Autoreview is source-aware and judges the change bundle; behavior validation is source-blind and judges the running product or tool against a behavior contract. A clean autoreview is not proof that a UI, CLI, API, or generated artifact works from the user's perspective.

Use when:

- user asks for Codex review / Claude review / Pi review / Droid review / Cursor review / OpenCode review / autoreview / second-model review
- after non-trivial code edits, before final/commit/ship
- reviewing a local branch or PR branch after fixes

## Contract

- Treat review output as advisory. Never blindly apply it.
- Verify every finding by reading the real code path and adjacent files.
- Read dependency docs/source/types when the finding depends on external behavior.
- Reject unrealistic edge cases, speculative risks, broad rewrites, and fixes that over-complicate the codebase.
- Prefer small fixes at the right ownership boundary; no refactor unless it clearly improves the bug class.
- When an accepted finding shows a bug class or repeated pattern, inspect the current PR scope for sibling instances before fixing.
- Fix the scoped bug class at once when practical; stop at touched surfaces, owner boundaries, and clear follow-up territory.
- Keep going until structured review returns no accepted/actionable findings only while the work remains inside the original task scope.
- If a review-triggered fix changes code, rerun focused tests and rerun the structured review helper.
- For security-audit suppression changes, verify accepted findings remain auditable: suppressed findings stay in structured output, active output keeps an unsuppressible suppression notice, and aggregate findings cannot hide unrelated active risk.
- Never switch or override the requested review engine/model. If the review hits model capacity, retry the same command a few times with the same engine/model.
- Be patient with large bundles. Structured review can take up to 30 minutes while the model call is active, especially with Codex tools or web search.
- Treat heartbeat lines like `review still running: ... elapsed=... pid=...` as healthy progress, not a hang. Let the helper continue while heartbeats are advancing. Pass `--stream-engine-output` when live engine text is useful; Codex, Claude, and Cursor filter tool/file chatter, other engines pass raw output through.
- Do not kill a review just because it has been quiet for 2-5 minutes, or because it is still running under the 30-minute window. Inspect the process only after missing multiple expected heartbeats, after 30 minutes, or after an obviously failed subprocess; prefer letting the same helper command finish.
- Tools are useful in review mode. The helper allows read-only inspection tools and web search by default so reviewers can check dependency contracts, upstream docs, and current behavior.
- Security perspective is always included, but it should not cripple legitimate functionality. Report security findings only when the change creates a concrete, actionable risk or removes an important safety check.
- For regression provenance, keep roles separate: blamed code author, blamed PR author, PR merger/committer, current PR author, and PR/date. If no blamed PR is traceable, use the blamed commit as the provenance: commit SHA, date, and author username. Do not guess a merger or frame missing PR metadata as a separate finding.
- If the blamed PR was merged by `clawsweeper[bot]` or another automation, identify the human trigger when practical. Check timeline/comments first; if rate-limited, use gitcrawl/cache or public PR HTML. Look for maintainer commands such as `@clawsweeper automerge`, `/landpr`, or labels/status comments that armed automerge. Report `automerge triggered by @login`; if not found, say trigger unknown.
- Do not invoke built-in `codex review`, nested reviewers, or reviewer panels from inside the review. The helper builds one bundle, calls one selected engine, validates one structured result, and stops.
- Stop as soon as the helper exits 0 with no accepted/actionable findings. Do not run an extra review just to get a nicer "clean" line, a second opinion, or clearer closeout wording.
- Treat the helper's successful exit plus absence of actionable findings as the clean review result, even if the underlying Codex CLI output is terse.
- Multi-reviewer panels are opt-in only. Use them when explicitly requested or when risk justifies the extra spend; the main agent still verifies every accepted finding before fixing.
- If rejecting a finding as intentional/not worth fixing, add a brief inline code comment only when it explains a real invariant or ownership decision that future reviewers should know.
- If `gh`/Gitcrawl reports `database disk image is malformed`, run `gitcrawl doctor --json` once to let the portable cache repair before retrying review; do not bypass the shim unless repair fails and freshness requires live GitHub.
- If Gitcrawl reports a portable manifest mismatch, source/runtime DB health error, or stale portable-store checkout, run `gitcrawl doctor --json` and inspect `source_db_health`, `runtime_db_health`, and `portable_store_status` before falling back to live GitHub.
- Do not push just to review. Push only when the user requested push/ship/PR update.

## Scope Governor

Autoreview is a closeout gate, not permission to rewrite the task.

Before the first review, freeze a scope baseline: original request or issue, target branch, intended behavior, owner boundary, changed files, and non-test LOC. For inherited or already-bloated branches, use the intended PR diff as the baseline rather than accepting all existing branch drift.

Before patching a finding, classify it:

- **In-scope blocker**: the finding is introduced by the current diff, affects the same owner boundary, and can be fixed without changing the task's contract.
- **Follow-up**: the finding is real but belongs to an adjacent bug class, sibling surface, cleanup, or broader hardening track.
- **Stop-and-escalate**: the finding requires a new protocol/config/storage/public API contract, a different owner boundary, a release-process change, or a design choice outside the original request.

Stop patching and report the scope break instead of continuing when:

- a narrow PR turns into an architecture change, protocol change, migration, or release-process change;
- the diff grows past 2x the original files or non-test LOC without explicit approval to expand scope;
- two review-triggered patch cycles have not converged; pause and reclassify every remaining finding before another edit;
- the best fix is "define the canonical contract first" rather than another local inference layer;
- fixing the accepted finding would make the PR no longer describe the same behavior, issue, or owner boundary.

After the two-cycle pause, continue only when every remaining accepted finding is still an in-scope blocker. Otherwise preserve the useful analysis, identify the smallest safe landed subset if one exists, and open or request a follow-up for the larger fix. Do not keep committing speculative fixes just to satisfy the reviewer.

Do not stack or push review-triggered fix commits while scope classification or focused proof is unresolved. Keep exploratory edits local until the cycle is proven in scope; if scope breaks, remove them from the landing lane instead of preserving them as branch history.

Critical exceptions must be explicit: active data loss, crash, broken install/upgrade, release blocker, or concrete security exposure. If the exception is not one of those, it is not critical enough to blow up scope.

## Release Branches And Release Process

On release, beta, stable, hotfix, signing, notarization, appcast, package-publish, or release-check work, use freeze discipline even when the branch name is not release-like:

- Fix only release blockers, failed release infrastructure, exact backports, install/upgrade breakage, data loss, crashes, or concrete security exposure.
- Treat non-blocking autoreview findings as follow-ups for `main`, not reasons to broaden the release branch.
- Do not introduce new product behavior, config surface, protocol shape, migration, plugin ownership, docs narrative, or process policy unless it directly unblocks the release.
- Keep proof tied to the release target: exact branch/ref, failing check or shipped-risk reason, smallest command/proof, and whether the fix must also forward-port to `main`.
- If review discovers a real but non-critical design problem during release closeout, stop with a follow-up issue/PR plan; do not use the release branch as the refactor lane.

## Skill Path (set once)

Set the skill script paths once, then use `"$AUTOREVIEW"` and `"$AUTOREVIEW_HARNESS"` in the examples below.

Choose one:

```bash
# Project-local skill in the current repo:
export AUTOREVIEW=".agents/skills/autoreview/scripts/autoreview"
export AUTOREVIEW_HARNESS=".agents/skills/autoreview/scripts/test-review-harness"
```

```bash
# Source checkout of openclaw/agent-skills:
export AUTOREVIEW="skills/autoreview/scripts/autoreview"
export AUTOREVIEW_HARNESS="skills/autoreview/scripts/test-review-harness"
```

```bash
# Global skill:
export AGENTS_HOME="${AGENTS_HOME:-$HOME/.agents}"
export AUTOREVIEW="$AGENTS_HOME/skills/autoreview/scripts/autoreview"
export AUTOREVIEW_HARNESS="$AGENTS_HOME/skills/autoreview/scripts/test-review-harness"
```

When using Claude Code, set `AGENTS_HOME="$HOME/.claude"` for global skills. Project-local skills live under `.claude/skills/` in the current repo.

## Pick Target

Dirty local work:

```bash
"$AUTOREVIEW" --mode local
```

Use this only when the patch is actually unstaged/staged/untracked in the
current checkout. `--mode uncommitted` is accepted as an alias for `--mode local`.
For committed, pushed, or PR work, point the helper at the commit
or branch diff instead; do not force dirty modes just
because the helper docs mention dirty work first. A clean local review
only proves there is no local patch.

Branch/PR work:

```bash
"$AUTOREVIEW" --mode branch --base origin/main
```

Optional review context is first-class. Prompt files and datasets must be repo-relative so review bundles cannot pull arbitrary host files:

```bash
"$AUTOREVIEW" --mode branch --base origin/main --prompt-file review-notes.md --dataset evidence.json
```

If an open PR exists, use its actual base:

```bash
base=$(gh pr view --json baseRefName --jq .baseRefName)
"$AUTOREVIEW" --mode branch --base "origin/$base"
```

Committed single change:

```bash
"$AUTOREVIEW" --mode commit --commit HEAD
```

Use commit review for already-landed or already-pushed work on `main`. Reviewing
clean `main` against `origin/main` is usually an empty diff after push. For a
small stack, review each commit explicitly or review the branch before merging
with `--base`.

## Parallel Closeout

Format first if formatting can change line locations. Then it is OK to run tests and review in parallel:

```bash
"$AUTOREVIEW" --parallel-tests "<focused test command>"
```

On Windows, the default `--parallel-tests` shell preserves the platform `cmd.exe`
semantics used by Python `shell=True`. Use `--parallel-tests-shell powershell`
or `--parallel-tests-shell pwsh` when the focused test command is PowerShell-specific.

Tradeoff: tests may force code changes that stale the review. If tests or review lead to code edits, rerun the affected tests and rerun review until no accepted/actionable findings remain. Once that rerun exits cleanly, stop; do not spend another long review cycle on redundant confirmation.

## Review Panels

Run multiple reviewers against one frozen bundle:

```bash
"$AUTOREVIEW" --reviewers codex,claude,pi,opencode
```

`--panel` is shorthand for Codex plus Claude unless `--engine` changes the first reviewer:

```bash
"$AUTOREVIEW" --panel
```

Set reviewer models and thinking/effort explicitly:

```bash
"$AUTOREVIEW" --reviewers codex,claude --model codex=gpt-5.5 --thinking codex=high --model claude=claude-fable-5 --thinking claude=max
```

Inline syntax is also supported for simple model IDs:

```bash
"$AUTOREVIEW" --reviewers codex:gpt-5.5:high,claude:claude-fable-5:max
```

For models with slashes or extra colons, prefer keyed form:

```bash
"$AUTOREVIEW" --engine pi --model anthropic/claude-sonnet-4 --thinking high
"$AUTOREVIEW" --engine opencode --model opencode/north-mini-code-free --thinking high
"$AUTOREVIEW" --engine cursor --model auto --cursor-allow-workspace-instructions
"$AUTOREVIEW" --reviewers codex,pi --model codex=gpt-5.5 --model pi=anthropic/claude-sonnet-4
"$AUTOREVIEW" --reviewers codex,opencode --model codex=gpt-5.5 --model opencode=opencode/north-mini-code-free
"$AUTOREVIEW" --reviewers codex,cursor --model codex=gpt-5.5 --model cursor=auto --cursor-allow-workspace-instructions
```

`--reviewers all` covers Codex, Claude, Copilot, Pi, and OpenCode. Cursor requires both explicit selection (`--engine cursor` or named in `--reviewers`) and `--cursor-allow-workspace-instructions` because the current Cursor CLI does not document a per-run flag that ignores project-local instructions/config. Droid selection currently fails closed because its CLI cannot disable both project instructions and all tools.

## Models and thinking

The helper accepts `--model` globally or per engine (`engine=model`) and `--thinking` globally or per engine (`engine=level`). Repeat either flag for multiple reviewers.

Recommended model defaults:

| Engine              | Default model    | Source note                                           |
| ------------------- | ---------------- | ----------------------------------------------------- |
| **codex** (default) | `gpt-5.5`        | OpenAI's current GPT-5.5 alias                        |
| **claude**          | `claude-fable-5` | Anthropic's most capable widely released Claude model |

CLI flags and environment variables override these defaults. Droid, Copilot, Pi, Cursor, and OpenCode do not get built-in model defaults here because their provider catalogs are external to the Codex/Claude closeout path and may vary by installation.

| Engine              | Model flag                 | Example model IDs                                                            | Thinking flag                 | Accepted levels                                        |
| ------------------- | -------------------------- | ---------------------------------------------------------------------------- | ----------------------------- | ------------------------------------------------------ |
| **codex** (default) | `codex --model X exec ...` | `gpt-5.5`, `gpt-5.5-2026-04-23`                                              | `-c model_reasoning_effort=Y` | `none`, `minimal`, `low`, `medium`, `high`, `xhigh`    |
| **claude**          | `claude --model X`         | `claude-fable-5`, `claude-opus-4-8`, `claude-sonnet-4-6`, `claude-haiku-4-5` | `--effort Y`                  | `low`, `medium`, `high`, `xhigh`, `max`                |
| **droid**           | currently refused          | Factory model IDs                                                            | `-r, --reasoning-effort Y`    | `off`, `none`, `low`, `medium`, `high`, `xhigh`, `max` |
| **copilot**         | `copilot --model X`        | `gpt-5.2`, Copilot model aliases                                             | not supported                 | n/a                                                    |
| **pi**              | `pi --model X`             | `anthropic/claude-sonnet-4`, `openai/gpt-4o`                                 | `--thinking Y`                | `off`, `minimal`, `low`, `medium`, `high`, `xhigh`     |
| **cursor**          | `cursor-agent --model X`   | `auto`, Cursor model aliases                                                 | not supported                 | n/a                                                    |
| **opencode**        | `opencode run -m X`        | `opencode/north-mini-code-free`, OpenCode provider/model IDs                 | `--variant Y`                 | `minimal`, `low`, `medium`, `high`, `max`              |

Claude also supports `--fallback-model a,b` for availability-based fallback chains ([model-config](https://code.claude.com/docs/en/model-config)). Current Claude docs note that auth, billing, rate-limit, request-size, and transport errors do not trigger fallback, and the changelog documents interactive-session support in `v2.1.166`.

Examples matching current `main` behavior:

```bash
# Codex with explicit model and reasoning
"$AUTOREVIEW" --engine codex --model gpt-5.5 --thinking high

# Codex fast mode (priority service tier); needs a model whose catalog lists the tier, silently standard otherwise
"$AUTOREVIEW" --engine codex --codex-speed fast

# Arbitrary Codex config overrides (isolation flags still win; --codex-speed wins over a service_tier here)
"$AUTOREVIEW" --engine codex --codex-config 'service_tier="fast"'

# Claude Code aliases or full model names, with optional availability fallback
"$AUTOREVIEW" --engine claude --model claude-fable-5 --thinking max
"$AUTOREVIEW" --engine claude --model claude-fable-5 --fallback-model claude-opus-4-8,claude-sonnet-4-6

# GitHub Copilot (model only; no thinking knob)
"$AUTOREVIEW" --engine copilot --model gpt-5.2

# Pi with explicit model and thinking level
"$AUTOREVIEW" --engine pi --model anthropic/claude-sonnet-4 --thinking high --pi-bin pi

# Cursor print-mode review (`cursor-agent` remains a compatibility alias)
"$AUTOREVIEW" --engine cursor --model auto --cursor-bin cursor-agent --cursor-allow-workspace-instructions

# OpenCode with explicit provider/model and variant
"$AUTOREVIEW" --engine opencode --model opencode/north-mini-code-free --thinking high
```

`--cursor-agent-bin` and `CURSOR_AGENT_BIN` remain compatibility aliases for
`--cursor-bin` and `CURSOR_BIN`.

### Environment defaults

CLI flags take precedence over environment variables.

Store persistent personal defaults in your shell startup file or launcher
environment. For repository-local defaults, use an existing local environment
loader such as an untracked `.envrc`; the helper does not write a config file.

| Variable                                         | Purpose                                                                                                                      |
| ------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------- |
| `AUTOREVIEW_MODEL`                               | Override the built-in default `--model` for all engines                                                                      |
| `AUTOREVIEW_THINKING`                            | Default `--thinking` for all engines                                                                                         |
| `AUTOREVIEW_FALLBACK_MODEL`                      | Default Claude `--fallback-model` chain                                                                                      |
| `AUTOREVIEW_<ENGINE>_MODEL`                      | Per-engine model override, for example `AUTOREVIEW_CODEX_MODEL=gpt-5.5`                                                      |
| `AUTOREVIEW_<ENGINE>_THINKING`                   | Per-engine thinking override                                                                                                 |
| `AUTOREVIEW_CODEX_CONFIG`                        | Default Codex `-c key=value` overrides, semicolon-separated, e.g. `service_tier="fast"`; isolation flags still win           |
| `AUTOREVIEW_CODEX_SPEED`                         | Default Codex service tier: `fast` (priority), `flex`, or `default`; silently standard when the model does not list the tier |
| `AUTOREVIEW_CLAUDE_FALLBACK_MODEL`               | Claude-only fallback chain                                                                                                   |
| `AUTOREVIEW_CURSOR_ALLOW_WORKSPACE_INSTRUCTIONS` | Required `1`/true opt-in for Cursor reviews of trusted repositories                                                          |

Codex maps thinking to `model_reasoning_effort`. Claude maps thinking to `--effort`. Droid maps thinking to `-r, --reasoning-effort`. Pi maps thinking to `--thinking`. OpenCode maps thinking to `--variant`. Copilot and Cursor reject `--thinking`. Only Claude accepts `--fallback-model`; global CLI/env fallback requires at least one Claude reviewer, and engine-specific fallback overrides require that reviewer to be selected. Non-Claude fallback overrides, including `AUTOREVIEW_<NONCLAUDE>_FALLBACK_MODEL`, fail closed instead of being silently ignored.

## Review engine isolation

When autoreview runs inside the repository under review, external reviewer CLIs must not load project-local trust or configuration that the branch controls.

| Engine       | Isolation flags                                                                                                                                                                                                     | Reference                                                                                                                                                                                                                                                                      |
| ------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **codex**    | Auth-only config overrides, `-c project_doc_max_bytes=0`, repo `trust_level="untrusted"`, `exec --ignore-user-config --ignore-rules`, plus read-only sandbox                                                        | Codex CLI `exec --help`                                                                                                                                                                                                                                                        |
| **claude**   | `--safe-mode --setting-sources user --strict-mcp-config --disallowedTools mcp__*` plus explicit `--allowedTools` (`--safe-mode` requires Claude Code `v2.1.169+`)                                                   | Claude Code [CLI reference](https://code.claude.com/docs/en/cli-reference)                                                                                                                                                                                                     |
| **droid**    | Fails closed: current CLI cannot disable both project instructions and all tools                                                                                                                                    | Droid CLI `exec --help` and `--list-tools`                                                                                                                                                                                                                                     |
| **pi**       | `--no-approve --no-session --no-context-files --no-extensions --no-skills --no-prompt-templates --no-themes --no-tools`                                                                                             | Pi CLI `--help`; requires Pi `v0.79.0+`                                                                                                                                                                                                                                        |
| **opencode** | `opencode run --dir <repo> --pure --format json`, prompt over stdin, neutral subprocess cwd, injected deny-by-default permissions, project config disabled                                                          | OpenCode CLI `--help`                                                                                                                                                                                                                                                          |
| **cursor**   | `cursor-agent --print --mode ask --sandbox enabled --output-format json\|stream-json`, prompt over stdin, temporary read-only permission config, help-probed flags, and mandatory explicit trusted-workspace opt-in | Cursor CLI [headless mode](https://cursor.com/docs/cli/headless), [output format](https://cursor.com/docs/cli/reference/output-format), [permissions](https://cursor.com/docs/cli/reference/permissions), [configuration](https://cursor.com/docs/cli/reference/configuration) |

Codex `--ignore-user-config` skips config loading for the exec run. Autoreview reconstructs only the documented `cli_auth_credentials_store`, `forced_login_method`, and `forced_chatgpt_workspace_id` settings from `CODEX_HOME/config.toml`, keeping authentication and workspace restrictions usable without forwarding unrelated user configuration. The explicit repo trust override and zero project-doc budget keep reviewed-repo `AGENTS.md` and `.codex/` trust surfaces out of the review prompt. `--ignore-rules` skips user/project execpolicy rules. Claude `--safe-mode` disables project hooks, skills, plugins, MCP servers, and CLAUDE.md while preserving normal authentication, model selection, built-in tools, and permissions; managed settings policy can still apply. `--setting-sources user` avoids project/local settings from the reviewed checkout, and current Claude Code docs note the project-skill blocking behavior was fixed in `v2.1.69`. `--strict-mcp-config` and `--disallowedTools mcp__*` keep MCP unavailable to the review run. `--bare` is not used here because Claude's headless docs say it skips OAuth and keychain reads. Droid fails closed because its CLI cannot disable reviewed-repository `AGENTS.md` loading and all tools in the same run. Pi `--no-approve` ignores project-local files for one run; the helper requires Pi `v0.79.0+` plus help output that advertises every required isolation flag because older legacy binaries can ignore unknown flags. The current package is `@earendil-works/pi-coding-agent`; deprecated `@mariozechner/pi-coding-agent` `0.73.x` is intentionally rejected. Pi version/help probes and the review command run from neutral temporary directories, not the reviewed repo. Pi `--no-context-files` removes `AGENTS.md`/`CLAUDE.md`, the resource-disable flags keep `.pi` extensions, skills, prompts, and themes out of the run, `--no-session` avoids writing review sessions, and `--no-tools` prevents built-in read tools from escaping the repository through absolute paths. OpenCode starts from a neutral temporary directory, points at the reviewed repo with `--dir`, disables project config through `OPENCODE_DISABLE_PROJECT_CONFIG=1`, and injects `OPENCODE_CONFIG_CONTENT`; permissions default to deny, allow read/grep/glob, preserve OpenCode's `.env` ask rules, and gate `websearch`/`webfetch` with `--no-web-search`. The injected config also clears command/instruction/plugin arrays and disables write/edit/bash/task/skill/todowrite tools without changing user auth storage. Cursor's documented headless path is print mode with JSON output and workspace-relative project-resource discovery. Because the CLI exposes no per-run flag that disables every current and future project instruction surface, autoreview requires `--cursor-allow-workspace-instructions` (or its environment equivalent) for every Cursor run. Project-local Cursor/Claude hook settings, project MCP config, and global Cursor MCP config remain hard refusals because hooks execute host commands and MCP tools cannot be constrained to read-only review access. Cursor capability probes run from neutral temporary directories with the sanitized engine environment. Review runs set documented `CURSOR_CONFIG_DIR` to an ephemeral configuration that allows workspace reads while denying shell commands and relative or absolute writes. The helper sends review prompts to OpenCode and Cursor over stdin rather than argv and extracts final structured JSON from terminal result/text events. OpenCode and Cursor reject `--no-tools`; Cursor also rejects `--no-web-search` because the CLI does not expose a documented per-run web-search disable flag.

## Context Efficiency

Run the helper directly so target selection, engine choice, structured validation, and exit status all stay in one path. If output is noisy, summarize the completed helper output after it returns; do not ask another agent or reviewer to rerun the review.

## Helper

After setting `AUTOREVIEW` and `AUTOREVIEW_HARNESS` above:

```bash
"$AUTOREVIEW" --help
```

The smoke harness has thin shell wrappers over a shared Python implementation:

```bash
"$AUTOREVIEW_HARNESS" --fixture benign --engine codex
```

On native Windows, invoke the extensionless Python helper through Python:

```powershell
python skills\autoreview\scripts\autoreview --help
```

and the smoke harness:

```powershell
skills\autoreview\scripts\test-review-harness.ps1 -Fixture benign -Engine codex
```

The helper:

- chooses dirty local changes first
- accepts `--mode uncommitted` as an alias for `--mode local`
- otherwise uses current PR base if `gh pr view` works
- otherwise uses `origin/main` for non-main branches
- does not fetch automatically during branch review; the selected base ref must already resolve locally
- recognizes `--engine droid` only to fail closed with an isolation error; runnable engines are `codex`, `claude`, `copilot`, `pi`, `opencode`, and `cursor`; default is `AUTOREVIEW_ENGINE` or `codex`
- resolves bare `git`, `gh`, reviewer, and PowerShell shell commands from absolute `PATH` entries only, never from the reviewed checkout; explicit relative `--*-bin` paths are resolved from the reviewed repository root
- use `--mode commit --commit <ref>` for already-committed work, especially clean `main` after landing
- should be left in `--mode auto` or forced to `--mode branch` for PR/branch work; do not force `--mode local` after committing
- writes only to stdout unless `--output`, `--json-output`, or live streamed engine stderr is set
- supports `--dry-run`, `--parallel-tests`, `--parallel-tests-shell`, `--prompt`, repo-relative `--prompt-file`, repo-relative `--dataset`, `--no-tools`, `--no-web-search`, repeatable Codex-only `--codex-config key=value`, Codex-only `--codex-speed fast|flex|default`, and commit refs
- supports `--stream-engine-output` or `AUTOREVIEW_STREAM_ENGINE_OUTPUT=1` for live engine text while preserving structured validation; Codex, Claude, and Cursor hide tool/file event details, emit compact activity summaries, and report usage at turn completion
- supports opt-in review panels with `--panel` / `--reviewers`, plus per-engine `--model`, `--thinking`, and Claude `--fallback-model`
- uses built-in model defaults `codex=gpt-5.5` and `claude=claude-fable-5`; honors `AUTOREVIEW_MODEL`, `AUTOREVIEW_THINKING`, `AUTOREVIEW_FALLBACK_MODEL`, and per-engine `AUTOREVIEW_<ENGINE>_MODEL` / `AUTOREVIEW_<ENGINE>_THINKING` environment overrides when CLI flags are omitted
- allows read-only tools and web search by default where the selected CLI supports them; forbids nested review in the prompt; Codex is run through `codex exec` with auth-only user settings, read-only sandbox, reviewed-repo instruction/config/rule isolation flags, and structured output
- runs Claude with `--safe-mode` (`v2.1.169+`), `--setting-sources user`, MCP disabled, explicit allowed tools, and `--fallback-model` when set, so reviewed-repo hooks/skills/MCP do not affect the review run while normal auth still works; managed settings policy can still apply
- refuses Droid reviews until the CLI exposes a complete project-instruction and tool-isolation contract
- runs Pi `v0.79.0+` from neutral temporary directories with `--no-approve`, `--no-session`, disabled Pi context/resource loading, and `--no-tools` because its built-in read tools are not repository-confined
- runs OpenCode with `opencode run --dir <repo> --pure --format json` from a neutral temporary directory, forwards `--model` and `--variant`, injects deny-by-default permissions, disables project config loading, and passes the review prompt over stdin
- runs Cursor only with mandatory trusted-workspace opt-in, uses `cursor-agent --print --mode ask --sandbox enabled --output-format json`, forwards `--model`, passes the review prompt over stdin, and always refuses project-local hooks/MCP
- prints `review still running: <engine> elapsed=<seconds>s pid=<pid>` to stderr at long-running intervals while waiting for the selected review engine, unless streamed output or compact Codex activity has been visible recently
- prints `autoreview clean: no accepted/actionable findings reported` when the selected review command exits 0
- exits nonzero when accepted/actionable findings are present

## Final Report

Include:

- review command used
- tests/proof run
- findings accepted/rejected, briefly why
- the clean review result from the final helper/review run, or why a remaining finding was consciously rejected

Do not run another review solely to improve the final report wording. If the final helper run exited 0 and produced no accepted/actionable findings, report that exact run as clean.
