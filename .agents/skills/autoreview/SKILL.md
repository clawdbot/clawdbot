---
name: autoreview
description: "Pre-commit/ship code review: Codex default; optional Claude or Pi."
---

# Auto Review

Run the bundled structured review helper as a closeout check. This is code review, not Guardian `auto_review` approval routing.

Codex review is the default when no engine is set. It uses `gpt-5.6-sol` with `high` reasoning by default, then retries once with `gpt-5.6-terra` only when the account cannot access Sol. Claude review is optional and uses `claude-fable-5` by default.

For user-visible behavior, pair autoreview with `behavior-validator`. Autoreview is source-aware and judges the change bundle; behavior validation is source-blind and judges the running product or tool against a behavior contract. A clean autoreview is not proof that a UI, CLI, API, or generated artifact works from the user's perspective.

Use when:

- user asks for Codex review / Claude review / Pi review / autoreview / second-model review
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
- Never switch or override the requested review engine/model except for the documented Codex Sol-to-Terra account-access fallback. Capacity, rate-limit, and unrelated failures keep the same engine/model.
- Be patient with large bundles. Structured review can take up to 30 minutes while the model call is active, especially with Codex tools or web search.
- Treat heartbeat lines like `review still running: ... elapsed=... pid=...` as healthy progress, not a hang. Let the helper continue while heartbeats are advancing. Pass `--stream-engine-output` when live engine text is useful; Codex and Claude filter tool/file chatter, other runnable engines pass raw output through.
- Do not kill a review just because it has been quiet for 2-5 minutes, or because it is still running under the 30-minute window. Inspect the process only after missing multiple expected heartbeats, after 30 minutes, or after an obviously failed subprocess; prefer letting the same helper command finish.
- Tools are useful in review mode. Codex receives the validated bundle in an empty workspace so ignored files and linked-worktree metadata remain unreadable; web search stays available for dependency contracts and upstream docs.
- Security perspective is always included, but it should not cripple legitimate functionality. Report security findings only when the change creates a concrete, actionable risk or removes an important safety check.
- Reviewer subprocesses preserve engine authentication and non-credentialed proxy variables needed by headless or restricted-network environments while stripping process-injection, Git override, and credentialed proxy values.
- Review bundles fail closed before engine invocation when tracked or untracked paths look sensitive or patch text looks secret-like. Obvious synthetic values shaped like `<fixture-prefix>-<credential-field>` remain reviewable, such as `token: "test-token"`, without one-off allowlists. Safe large diffs are scanned in full, sent as one pass while they fit the aggregate prompt limit, then partitioned into complete bounded passes without truncation.
- For regression provenance, keep roles separate: blamed code author, blamed PR author, PR merger/committer, current PR author, and PR/date. If no blamed PR is traceable, use the blamed commit as the provenance: commit SHA, date, and author username. Do not guess a merger or frame missing PR metadata as a separate finding.
- If the blamed PR was merged by `clawsweeper[bot]` or another automation, identify the human trigger when practical. Check timeline/comments first; if rate-limited, use gitcrawl/cache or public PR HTML. Look for maintainer commands such as `@clawsweeper automerge`, `/landpr`, or labels/status comments that armed automerge. Report `automerge triggered by @login`; if not found, say trigger unknown.
- Do not invoke built-in `codex review`, nested reviewers, or reviewer panels from inside the review. The helper builds one validated bundle, calls the selected engine once for normal inputs or once per complete bounded chunk for oversized inputs, validates the structured results, and stops.
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
# Project-local skill in the current repo for Codex and other agents:
export AUTOREVIEW=".agents/skills/autoreview/scripts/autoreview"
export AUTOREVIEW_HARNESS=".agents/skills/autoreview/scripts/test-review-harness"
```

```bash
# Claude Code project-local skill in the current repo:
export AUTOREVIEW=".claude/skills/autoreview/scripts/autoreview"
export AUTOREVIEW_HARNESS=".claude/skills/autoreview/scripts/test-review-harness"
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

When using Claude Code, set `AGENTS_HOME="$HOME/.claude"` for global skills.

On native Windows, choose the matching pair:

```powershell
# Project-local skill in the current repo for Codex and other agents:
$AUTOREVIEW = ".agents\skills\autoreview\scripts\autoreview"
$AUTOREVIEW_HARNESS = ".agents\skills\autoreview\scripts\test-review-harness.ps1"
```

```powershell
# Claude Code project-local skill in the current repo:
$AUTOREVIEW = ".claude\skills\autoreview\scripts\autoreview"
$AUTOREVIEW_HARNESS = ".claude\skills\autoreview\scripts\test-review-harness.ps1"
```

```powershell
# Source checkout of openclaw/agent-skills:
$AUTOREVIEW = "skills\autoreview\scripts\autoreview"
$AUTOREVIEW_HARNESS = "skills\autoreview\scripts\test-review-harness.ps1"
```

```powershell
# Global skill:
$AgentsHome = if ($env:AGENTS_HOME) { $env:AGENTS_HOME } else { Join-Path $HOME ".agents" }
$AUTOREVIEW = Join-Path $AgentsHome "skills\autoreview\scripts\autoreview"
$AUTOREVIEW_HARNESS = Join-Path $AgentsHome "skills\autoreview\scripts\test-review-harness.ps1"
```

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

## Oversized Bundles

The helper scans the full patch before partitioning it. A safe bundle that fits
the aggregate prompt limit remains one integrated review pass. Larger bundles
are split at bundle sections and file boundaries where possible; an oversized
single-file block is split at line boundaries with repeated file/hunk context
and an absolute new- or old-file line offset. Untracked snapshots use
injection-safe source-line records so continuation passes retain reportable
locations. A single physical diff line split across passes also retains its
original addition, deletion, or context marker.
Every original bundle byte appears exactly once across the pass sequence, and
all validated reports are merged before required-finding and exit-status checks.
The helper caps one run at eight bounded passes so an unexpectedly huge branch
cannot create unbounded model calls; split still-larger work into coherent review
targets.

Chunking makes large-diff review usable, but it cannot give one model call every
cross-file implementation detail. For architecture-heavy changes, still prefer
a coherent branch or PR shape whose semantic decision surface fits one pass.
Removing verified non-authoritative generated noise remains useful, but never
drop lockfiles, generated clients, policies, manifests, schemas, or other
independently semantic artifacts merely to shrink the review.

## Parallel Closeout

Format first if formatting can change line locations. Then it is OK to run tests and review in parallel:

```bash
"$AUTOREVIEW" --parallel-tests "<focused test command>"
```

On Windows, the default `--parallel-tests` shell preserves the platform `cmd.exe`
semantics used by Python `shell=True`. Use `--parallel-tests-shell powershell`
or `--parallel-tests-shell pwsh` when the focused test command is PowerShell-specific.
Parallel tests inherit only a small allowlist of ordinary OS, CI, and toolchain
variables. Put additional non-secret project controls directly in the test command.
Home and standard config directories point to a temporary isolated root that is
removed after the command exits. Do not put secrets in the command because it is
printed before execution. Set `OPENCLAW_TESTBOX=1` on the autoreview process, not
inside the test command, because the environment snapshot and credential staging
happen before the test shell starts:

```bash
OPENCLAW_TESTBOX=1 "$AUTOREVIEW" --parallel-tests "pnpm check:changed"
```

On POSIX, the helper puts this isolated Testbox home under the short, sticky
system `/tmp`; Blacksmith creates an SSH control socket below that home, and a
long macOS `TMPDIR` can exceed the Unix-socket path limit. With an older helper,
prefix the outer autoreview process with `TMPDIR=/tmp`. Setting `TMPDIR` inside
the quoted test command is too late because the isolated home already exists.

This is the narrow trusted-maintainer-code exception: it stages only the Blacksmith
credential file into the temporary home so the command can delegate remotely. Never
use this credential-hydrated path for untrusted contributor or fork code. Run other
secret-bearing or credentialed tests separately in an appropriately isolated remote
runner.

Tradeoff: tests may force code changes that stale the review. If tests or review lead to code edits, rerun the affected tests and rerun review until no accepted/actionable findings remain. Once that rerun exits cleanly, stop; do not spend another long review cycle on redundant confirmation.

## Review Panels

Run multiple reviewers against one frozen bundle:

```bash
"$AUTOREVIEW" --reviewers codex,claude,pi
```

`--panel` is shorthand for Codex plus Claude unless `--engine` changes the first reviewer:

```bash
"$AUTOREVIEW" --panel
```

Set reviewer models and thinking/effort explicitly:

```bash
"$AUTOREVIEW" --reviewers codex,claude --model codex=gpt-5.6-sol --thinking codex=high --model claude=claude-fable-5 --thinking claude=max
```

Inline syntax is also supported for simple model IDs:

```bash
"$AUTOREVIEW" --reviewers codex:gpt-5.6-sol:high,claude:claude-fable-5:max
```

For models with slashes or extra colons, prefer keyed form:

```bash
"$AUTOREVIEW" --engine pi --model anthropic/claude-sonnet-4 --thinking high
"$AUTOREVIEW" --reviewers codex,pi --model codex=gpt-5.6-sol --model pi=anthropic/claude-sonnet-4
```

`--reviewers all` covers Codex, Claude, and Pi. Droid, Copilot, Cursor, and OpenCode selections fail closed because their current CLI contracts cannot confine project instructions, filesystem reads, or network fetches to the review boundary.

## Models and thinking

The helper accepts `--model` globally or per engine (`engine=model`) and `--thinking` globally or per engine (`engine=level`). Repeat either flag for multiple reviewers.

Recommended model defaults:

| Engine              | Default model                                      | Source note                                           |
| ------------------- | -------------------------------------------------- | ----------------------------------------------------- |
| **codex** (default) | `gpt-5.6-sol` -> `gpt-5.6-terra` on access failure | OpenClaw org review default                           |
| **claude**          | `claude-fable-5`                                   | Anthropic's most capable widely released Claude model |

CLI flags and environment variables override these defaults. Pi does not get a built-in model default because its provider catalog may vary by installation. Droid, Copilot, Cursor, and OpenCode are currently refused.

| Engine              | Model flag                 | Example model IDs                                                            | Thinking flag                 | Accepted levels                                            |
| ------------------- | -------------------------- | ---------------------------------------------------------------------------- | ----------------------------- | ---------------------------------------------------------- |
| **codex** (default) | `codex --model X exec ...` | `gpt-5.6-sol`, then `gpt-5.6-terra` on Sol access failure                    | `-c model_reasoning_effort=Y` | `none`, `minimal`, `low`, `medium`, `high`, `xhigh`, `max` |
| **claude**          | `claude --model X`         | `claude-fable-5`, `claude-opus-4-8`, `claude-sonnet-4-6`, `claude-haiku-4-5` | `--effort Y`                  | `low`, `medium`, `high`, `xhigh`, `max`                    |
| **droid**           | currently refused          | Factory model IDs                                                            | `-r, --reasoning-effort Y`    | `off`, `none`, `low`, `medium`, `high`, `xhigh`, `max`     |
| **copilot**         | currently refused          | Copilot model aliases                                                        | not supported                 | n/a                                                        |
| **pi**              | `pi --model X`             | `anthropic/claude-sonnet-4`, `openai/gpt-4o`                                 | `--thinking Y`                | `off`, `minimal`, `low`, `medium`, `high`, `xhigh`         |
| **cursor**          | currently refused          | Cursor model aliases                                                         | not supported                 | n/a                                                        |
| **opencode**        | currently refused          | OpenCode provider/model IDs                                                  | not supported                 | n/a                                                        |

Claude also supports `--fallback-model a,b` for availability-based fallback chains ([model-config](https://code.claude.com/docs/en/model-config)). Current Claude docs note that auth, billing, rate-limit, request-size, and transport errors do not trigger fallback, and the changelog documents interactive-session support in `v2.1.166`.

[OpenAI's model guidance](https://developers.openai.com/api/docs/guides/latest-model) identifies Sol as the GPT-5.6 frontier-capability route and documents `max` support. Autoreview keeps `high` as its default; use `max` only for the hardest quality-first reviews after comparing its latency and cost with `xhigh` on representative changes.

Examples matching current `main` behavior:

```bash
# Codex with explicit model and reasoning
"$AUTOREVIEW" --engine codex --model gpt-5.6-sol --thinking high

# Codex fast mode (priority service tier); needs a model whose catalog lists the tier, silently standard otherwise
"$AUTOREVIEW" --engine codex --codex-speed fast

# Safe Codex model/response tuning overrides (--codex-speed wins over a service_tier here)
"$AUTOREVIEW" --engine codex --codex-config 'service_tier="fast"'

# Claude Code aliases or full model names, with optional availability fallback
"$AUTOREVIEW" --engine claude --model claude-fable-5 --thinking max
"$AUTOREVIEW" --engine claude --model claude-fable-5 --fallback-model claude-opus-4-8,claude-sonnet-4-6

# Pi with explicit model and thinking level
"$AUTOREVIEW" --engine pi --model anthropic/claude-sonnet-4 --thinking high --pi-bin pi

```

`--cursor-agent-bin` and `CURSOR_AGENT_BIN` remain compatibility aliases for
`--cursor-bin` and `CURSOR_BIN`.

### Environment defaults

CLI flags take precedence over environment variables.

Store persistent personal defaults in your shell startup file or launcher
environment. For repository-local defaults, use an existing local environment
loader such as an untracked `.envrc`; the helper does not write a config file.

| Variable                           | Purpose                                                                                                                          |
| ---------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| `AUTOREVIEW_MODEL`                 | Override the built-in default `--model` for all engines                                                                          |
| `AUTOREVIEW_THINKING`              | Default `--thinking` for all engines                                                                                             |
| `AUTOREVIEW_FALLBACK_MODEL`        | Default Claude `--fallback-model` chain                                                                                          |
| `AUTOREVIEW_<ENGINE>_MODEL`        | Per-engine model override, for example `AUTOREVIEW_CODEX_MODEL=gpt-5.6-sol`                                                      |
| `AUTOREVIEW_<ENGINE>_THINKING`     | Per-engine thinking override                                                                                                     |
| `AUTOREVIEW_CODEX_CONFIG`          | Safe Codex model/response tuning overrides, semicolon-separated, e.g. `service_tier="fast"`; capability-bearing keys fail closed |
| `AUTOREVIEW_CODEX_SPEED`           | Codex service tier override: `fast` (priority), `flex`, or `default`; silently standard when the model does not list the tier    |
| `AUTOREVIEW_CLAUDE_FALLBACK_MODEL` | Claude-only fallback chain                                                                                                       |
| `AUTOREVIEW_PROVIDER_ENV_ALLOW`    | Comma-separated custom Pi/OpenCode credential variable names; names must end in a recognized credential suffix                   |

Codex maps thinking to `model_reasoning_effort`. Claude maps thinking to `--effort`. Pi maps thinking to `--thinking`. Only Claude accepts `--fallback-model`; global CLI/env fallback requires at least one Claude reviewer, and engine-specific fallback overrides require that reviewer to be selected. Non-Claude fallback overrides, including `AUTOREVIEW_<NONCLAUDE>_FALLBACK_MODEL`, fail closed instead of being silently ignored.

## Review engine isolation

When autoreview runs inside the repository under review, external reviewer CLIs must not load project-local trust or configuration that the branch controls.

| Engine       | Isolation flags                                                                                                                                                                                  | Reference                                                                   |
| ------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------- |
| **codex**    | Auth-only config overrides, isolated workspace, `exec --ignore-user-config --ignore-rules --skip-git-repo-check`, plus read-only sandbox                                                         | Codex CLI `exec --help`                                                     |
| **claude**   | `--safe-mode --setting-sources user --strict-mcp-config --disallowedTools mcp__*`; auto-memory and filesystem/shell tools disabled; empty external workspace; WebSearch by default (`v2.1.169+`) | Claude Code [CLI reference](https://code.claude.com/docs/en/cli-reference)  |
| **droid**    | Fails closed: current CLI cannot disable both project instructions and all tools                                                                                                                 | Droid CLI `exec --help` and `--list-tools`                                  |
| **copilot**  | Fails closed: repository read tools also expose ignored files outside the reviewed bundle                                                                                                        | GitHub Copilot CLI command reference                                        |
| **pi**       | `--no-approve --no-session --no-context-files --no-extensions --no-skills --no-prompt-templates --no-themes --no-tools`                                                                          | Pi CLI `--help`; requires Pi `v0.79.0+`                                     |
| **opencode** | Fails closed: project/global config isolation and private-network fetch denial are not both proven                                                                                               | OpenCode CLI contract                                                       |
| **cursor**   | Fails closed: documented read permissions can target absolute host paths and no proven repository-only filesystem sandbox is exposed                                                             | Cursor CLI [permissions](https://cursor.com/docs/cli/reference/permissions) |

Codex `--ignore-user-config` skips config loading for the exec run. Autoreview reconstructs only the documented `cli_auth_credentials_store`, `forced_login_method`, and `forced_chatgpt_workspace_id` settings from `CODEX_HOME/config.toml`, keeping authentication usable without forwarding unrelated user configuration. Codex runs in an empty temporary workspace: the validated bundle is its sole repository input, ignored files and linked-worktree metadata remain unreadable, and the zero project-doc budget keeps workspace instructions out of the prompt. `--ignore-rules` skips user/project execpolicy rules. Claude `--safe-mode` disables project hooks, skills, plugins, MCP servers, and CLAUDE.md; autoreview supplies WebSearch by default, permits only explicitly domain-constrained WebFetch rules, and exposes no filesystem or shell tools. Pi runs from a neutral temporary directory with project resources disabled and `--no-tools`. Droid, Copilot, Cursor, and OpenCode fail closed because their current CLI contracts cannot isolate untrusted review input from host, project, or private-network trust surfaces.

Codex uses a named permission profile that grants read access only to an empty temporary workspace. This is narrower than repository-root access, which would expose ignored credentials, and narrower than the legacy `read-only` sandbox, which permits reads across the host filesystem.

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
python $AUTOREVIEW --help
```

and the smoke harness:

```powershell
& $AUTOREVIEW_HARNESS -Fixture benign -Engine codex
```

The helper:

- chooses dirty local changes first
- accepts `--mode uncommitted` as an alias for `--mode local`
- otherwise uses current PR base if `gh pr view` works
- otherwise uses `origin/main` for non-main branches
- does not fetch automatically during branch review; the selected base ref must already resolve locally
- recognizes `--engine droid`, `copilot`, `cursor`, and `opencode` only to fail closed with isolation errors; runnable engines are `codex`, `claude`, and `pi`; default is `AUTOREVIEW_ENGINE` or `codex`
- resolves bare `git`, `gh`, reviewer, and PowerShell shell commands from absolute `PATH` entries only, never from the reviewed checkout; explicit `--*-bin` paths are interpreted from the reviewed repository root when relative and accepted only when both the supplied path and resolved target stay outside the reviewed repository
- use `--mode commit --commit <ref>` for already-committed work, especially clean `main` after landing
- scans safe Git patches in full, recognizes synthetic fixture values tied to their credential field, reviews them in one pass up to the aggregate prompt limit, and automatically uses complete bounded passes above it
- should be left in `--mode auto` or forced to `--mode branch` for PR/branch work; do not force `--mode local` after committing
- writes only to stdout unless `--output`, `--json-output`, or live streamed engine stderr is set
- supports `--dry-run`, `--parallel-tests`, `--parallel-tests-shell`, `--prompt`, repo-relative `--prompt-file`, repo-relative `--dataset`, `--no-tools`, `--no-web-search`, repeatable Codex-only safe model/response tuning with `--codex-config key=value`, Codex-only `--codex-speed fast|flex|default`, and commit refs
- supports `--stream-engine-output` or `AUTOREVIEW_STREAM_ENGINE_OUTPUT=1` for live engine text while preserving structured validation; Codex and Claude hide tool/file event details, emit compact activity summaries, and report usage at turn completion
- supports opt-in review panels with `--panel` / `--reviewers`, plus per-engine `--model`, `--thinking`, and Claude `--fallback-model`
- uses built-in defaults `codex=gpt-5.6-sol` with `high` reasoning and an access-only `gpt-5.6-terra` retry, plus `claude=claude-fable-5`; honors `AUTOREVIEW_MODEL`, `AUTOREVIEW_THINKING`, `AUTOREVIEW_FALLBACK_MODEL`, and per-engine `AUTOREVIEW_<ENGINE>_MODEL` / `AUTOREVIEW_<ENGINE>_THINKING` environment overrides when CLI flags are omitted
- gives Codex the bundle in an empty workspace with web search available; Claude receives the bundle plus WebSearch by default and optional domain-constrained WebFetch, and Pi receives the bundle with no tools
- runs Claude with `--safe-mode` (`v2.1.169+`), `--setting-sources user`, MCP and auto-memory disabled, no filesystem/shell tools, an empty external workspace, and `--fallback-model` when set
- refuses Droid, Copilot, Cursor, and OpenCode reviews until their CLIs expose the required project, filesystem, and network isolation
- runs Pi `v0.79.0+` from neutral temporary directories with `--no-approve`, `--no-session`, disabled Pi context/resource loading, and `--no-tools` because its built-in read tools are not repository-confined
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
