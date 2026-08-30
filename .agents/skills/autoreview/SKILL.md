---
name: autoreview
description: "Structured Codex, Claude, Amp, Pi, or Kimi code review when explicitly requested."
---

# Auto Review

Run the bundled structured review helper only when the user explicitly asks for autoreview, a second-model review, or one of its named review engines. This is code review, not Guardian `auto_review` approval routing.

Codex review is the default when no engine is set. It uses `gpt-5.6-sol` with `high` reasoning by default, then retries once with `gpt-5.6-terra` only when the account cannot access Sol. Claude review is optional and uses `claude-fable-5` by default. Amp review is optional and uses `openai/gpt-5.6-sol` with `high` reasoning by default. Pi and Kimi use the model configured by their respective CLIs unless `--model` overrides it.

Do not invoke Autoreview automatically before a commit, push, PR, merge, deploy, or final reply. Repository or workflow rules may call it only when they explicitly name it.

## Contract

- Default accepted findings are P0 only: report issues worth blocking the current change
  because they materially break the normal flow, outcome, or safety boundary.
  Use `--max-priority P1`, `P2`, or `P3` only when the caller explicitly asks
  for a wider review.
- Treat review output as advisory. Never blindly apply it.
- Verify every finding by reading the real code path and adjacent files.
- Read dependency docs/source/types when the finding depends on external behavior.
- Reject unrealistic edge cases, speculative risks, unrelated rewrites, and fixes that over-complicate the codebase.
- Prefer root-cause fixes at the right ownership boundary. A coherent refactor is appropriate when it removes the bug class, duplicate policy, stale paths, or ownership confusion; do not default to a symptom patch.
- When an accepted finding exposes a bug class or repeated pattern, inspect its owner and relevant sibling implementations before fixing.
- Fix the same bug class across its owner-boundary neighborhood when practical; stop at unrelated invariants, different owners, and unapproved contract changes.
- Run one bounded review pass. If an accepted finding changes code, run the smallest relevant test; rerun Autoreview only when the user explicitly requests another pass.
- For security-audit suppression changes, verify accepted findings remain auditable: suppressed findings stay in structured output, active output keeps an unsuppressible suppression notice, and aggregate findings cannot hide unrelated active risk.
- Never switch or override the requested review engine/model except for the documented Codex Sol-to-Terra account-access fallback. Capacity, rate-limit, and unrelated failures keep the same engine/model.
- Be patient with large bundles. Structured review can take up to 30 minutes while the model call is active, especially with Codex tools or web search.
- Treat heartbeat lines like `review still running: ... elapsed=... pid=...` as healthy progress, not a hang. Let the helper continue while heartbeats are advancing. Pass `--stream-engine-output` when live engine text is useful; Codex and Claude filter tool/file chatter, other runnable engines pass raw output through.
- Do not kill a review just because it has been quiet for 2-5 minutes, or because it is still running under the 30-minute window. Inspect the process only after missing multiple expected heartbeats, after 30 minutes, or after an obviously failed subprocess; prefer letting the same helper command finish.
- Tools are useful in review mode. Codex receives the validated bundle in an empty workspace so ignored files and linked-worktree metadata remain unreadable; web search stays available for dependency contracts and upstream docs.
- Security perspective is always included, but it should not cripple legitimate functionality. Report security findings only when the change creates a concrete, actionable risk or removes an important safety check.
- Reviewer subprocesses preserve engine authentication and non-credentialed proxy variables needed by headless or restricted-network environments while stripping process-injection, Git override, and credentialed proxy values.
- Immediately before every provider call, autoreview writes the exact outgoing review pack to an owner-only temporary file and scans it with TruffleHog using `verified,unknown`. It uses the installed binary with `--no-update` to disable self-update checks and attempts. The scan covers prompt and dataset inputs, untracked content, and every diff line, including deleted lines. A finding, scanner error, or missing TruffleHog binary refuses the send and names the implicated repository file when it can be resolved; credentials are never redacted and forwarded. Security-sensitive paths remain omitted. Safe large diffs are sent as one pass while they fit the aggregate prompt limit, then partitioned into complete bounded passes without truncation.
- Regression provenance needs patch proof, not blame alone. `git log -S/-G`, `git blame`, commit subjects, and PR metadata locate candidates. Before saying `introduced by`, inspect raw parents with `git --no-replace-objects cat-file -p <sha>` and verify the implicated behavior changed in `git --no-replace-objects diff --no-ext-diff --no-textconv <raw-parent> <sha> -- <path>`; a genuine root needs raw-header proof that it has no parents.
- Blame `^sha`, porcelain `boundary`, and shallow/grafted history alone are not introduction proof. `--root` can hide boundary markers; `git show` or `rev-list --parents` can make a shallow boundary look like a root. An available raw parent permits explicit comparison even at a shallow boundary; missing parents or an unverifiable patch require `unknown` with the gap. Use `carried forward` only for verified preexisting behavior and `made visible` only for a verified trigger. Apply the same bar to finding prose, summaries, and owner hints.
- Keep code author, introducing PR author, merger, committer, automation trigger, and current PR author separate; none of those roles alone proves causation. Cite the verified commit/PR/date. If no PR is traceable, use the verified commit and known author identity; unknown identities stay unknown, and missing PR metadata is not a separate finding.
- For automation merges, identify the human trigger only from explicit timeline/comment/event evidence, such as a maintainer automerge command or arming label. Report `automerge triggered by @login` only when verified; otherwise say trigger unknown. Triggering or merging is not proof of authorship or introduction.
- Do not invoke built-in `codex review`, nested reviewers, or review panels from inside the review. The helper builds one validated bundle, calls the selected engine once for normal inputs or once per complete bounded chunk for oversized inputs, validates the structured results, and stops.
- Stop as soon as the helper exits 0 with no accepted/actionable findings. Do not run an extra review just to get a nicer "clean" line, a second opinion, or clearer closeout wording.
- Treat `scoped-clean` with exit 0 as clean only for the selected Git target and requested priority. `filtered` is not a correctness certificate; `incomplete` requires resolving the scope mismatch or missing required finding before claiming clean.
- If rejecting a finding as intentional/not worth fixing, add a brief inline code comment only when it explains a real invariant or ownership decision that future reviewers should know.
- If `gh`/Gitcrawl reports `database disk image is malformed`, run `gitcrawl doctor --json` once to let the portable cache repair before retrying review; do not bypass the shim unless repair fails and freshness requires live GitHub.
- If Gitcrawl reports a portable manifest mismatch, source/runtime DB health error, or stale portable-store checkout, run `gitcrawl doctor --json` and inspect `source_db_health`, `runtime_db_health`, and `portable_store_status` before falling back to live GitHub.
- Do not push just to review. Push only when the user requested push/ship/PR update.

## Scope

Autoreview does not expand the task. Fix only verified blockers in the requested path. Mention unrelated findings without opening a new workstream, and stop when the requested review pass is complete.

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

Dirty local work relative to HEAD:

```bash
"$AUTOREVIEW" --mode local
```

Without `--base`, this reviews HEAD-to-index, index-to-working-tree, and validated
untracked files only. `--mode auto` selects the same HEAD-based scope when dirty;
it does not include the committed PR merely because the checkout is on a PR
branch. `--mode uncommitted` is an alias for `--mode local`. A clean local checkout
without an explicit base has no local patch to review.

To review a dirty candidate against an explicit base, including a resolved merge
that has not been committed:

```bash
"$AUTOREVIEW" --mode local --base origin/main
```

The helper pins that base to a commit at target selection. It reviews base-to-index
changes and index-to-working-tree changes separately, plus validated untracked
files. Only files identical across the base, index, and working tree are outside
the change bundle; staged changes later undone remain included. Actual binary
or submodule changes still refuse review. The bundle labels its pinned
staged base. Git status remains relative to HEAD and does not define review scope.
Without `--base`, local mode retains its usual HEAD-to-index behavior; it never
infers a base from an in-progress merge.

Committed-only branch/PR work:

```bash
"$AUTOREVIEW" --mode branch --base origin/main
```

Branch mode reviews `BASE...HEAD` (merge-base-to-HEAD); staged, unstaged, and
untracked changes are excluded even in a dirty checkout. To review the **complete
PR candidate including dirty rewrites**, pin the PR merge base and use local mode:

```bash
pr_base=$(gh pr view --json baseRefName --jq .baseRefName)
merge_base=$(git merge-base HEAD "origin/$pr_base")
"$AUTOREVIEW" --mode local --base "$merge_base"
```

The remote base must already be available and current locally; the helper does
not fetch. The pinned merge base avoids including unrelated upstream changes.
Add `--max-priority P2` when the caller requests P2 findings. An explicit `--base`
also applies when auto selects local, but explicit local mode avoids changing
targets when the checkout becomes clean.

Optional review context is first-class. Prompt files and datasets must be repo-relative so review bundles cannot pull arbitrary host files. Context never expands the selected Git target, even if it contains a complete candidate diff or asks to review the whole PR. Finding membership is checked by changed file, not individual hunk:

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
with `--base`. Commit review compares the raw recorded parent with the selected
commit, ignoring replacement refs and legacy grafts. A genuine root compares
against the empty tree. Missing parent objects stop review: explicitly deepen/fetch the needed
history and rerun. The helper does not fetch it automatically.

## Oversized Bundles

The helper validates the complete patch before partitioning it. For partitioned
reviews it scans the complete frozen input first, so credentials cannot evade
detection by crossing a chunk boundary. It also scans each exact outgoing review
pack before sending it. A safe bundle that fits
the aggregate prompt limit remains one integrated review pass. Larger bundles
are split at bundle sections and file boundaries where possible; an oversized
single-file block is split at line boundaries with repeated file/hunk context
and an absolute new- or old-file line offset. Untracked snapshots use
injection-safe source-line records so continuation passes retain reportable
locations. A single physical diff line split across passes also retains its
original addition, deletion, or context marker.
Prompt instructions remain whole in every pass. Large datasets are grouped from
their validated file records, never by reparsing headings inside evidence.
Individual oversized datasets split at lines or UTF-8 boundaries with their
original path and byte offset. Each evidence batch is paired with the complete
change bundle: every original change byte appears exactly once per evidence
batch, and every evidence byte is retained. All validated reports are merged
before required-finding and exit-status checks.
There is no fixed pass-count ceiling: the complete frozen input determines the
finite pass sequence. The helper prints its size and pass count before running
passes serially. Each pass retains the same prompt-size limit, secret scan, and
reviewer isolation; a failed pass aborts without publishing a partial verdict.

Preparation prints immediate phase updates and periodic elapsed time to stderr,
with file/byte counts during hashing and no filenames or contents. These updates
are separate from provider heartbeats and do not count against engine deadlines.
Bundle construction captures finding membership alongside validated text; normal
and dry runs reuse that record without reopening untracked files for membership.

Dry runs reuse capture and scanning without whole-tree integrity sweeps. Real
reviews retain full fresh tree hashing before bundle construction, before review,
and before publication, including unrelated tracked files, nonignored untracked files, index
state, and initialized submodules. Explicit prompt files and datasets also retain
their own frozen bytes and raw path identities, regardless of Git ignore status
or finding scope. They are revalidated before sending each pass and before
publication; content changes, replacements, and leaf or ancestor symlink swaps
refuse stale results. These endpoint checks are not atomic filesystem snapshots
and cannot guarantee detection of transient changes restored between checks.

Evidence batches can multiply the pass count. Chunking cannot give one model
call every cross-file implementation detail. For architecture-heavy changes, still prefer
a coherent branch or PR shape whose semantic decision surface fits one pass.
Removing verified non-authoritative generated noise remains useful, but never
drop lockfiles, generated clients, policies, manifests, schemas, or other
independently semantic artifacts merely to shrink the review.

## Models and thinking

The helper accepts `--model` globally or per engine (`engine=model`) and `--thinking` globally or per engine (`engine=level`). Repeat either flag for multiple reviewers.

Recommended model defaults:

| Engine              | Default model                                      | Source note                                           |
| ------------------- | -------------------------------------------------- | ----------------------------------------------------- |
| **codex** (default) | `gpt-5.6-sol` -> `gpt-5.6-terra` on access failure | OpenClaw org review default                           |
| **claude**          | `claude-fable-5`                                   | Anthropic's most capable widely released Claude model |
| **amp**             | `openai/gpt-5.6-sol`                               | Amp structured-generation review default              |

CLI flags and environment variables override these defaults. Amp model IDs must use `provider/model` form. Pi and Kimi do not get built-in model defaults because their configured model catalogs may vary by installation.

| Engine              | Model flag                 | Example model IDs                                                            | Thinking flag                             | Accepted levels                                            |
| ------------------- | -------------------------- | ---------------------------------------------------------------------------- | ----------------------------------------- | ---------------------------------------------------------- |
| **codex** (default) | `codex --model X exec ...` | `gpt-5.6-sol`, then `gpt-5.6-terra` on Sol access failure                    | `-c model_reasoning_effort=Y`             | `none`, `minimal`, `low`, `medium`, `high`, `xhigh`, `max` |
| **claude**          | `claude --model X`         | `claude-fable-5`, `claude-opus-4-8`, `claude-sonnet-4-6`, `claude-haiku-4-5` | `--effort Y`                              | `low`, `medium`, `high`, `xhigh`, `max`                    |
| **amp**             | Amp `amp.ai.generate`      | `openai/gpt-5.6-sol`                                                         | `reasoningEffort`                         | `none`, `low`, `medium`, `high`, `xhigh`, `max`            |
| **pi**              | `pi --model X`             | `anthropic/claude-sonnet-4`, `openai/gpt-4o`                                 | `--thinking Y`                            | `off`, `minimal`, `low`, `medium`, `high`, `xhigh`         |
| **kimi**            | `kimi --model X`           | A model alias from the user's Kimi config                                    | `[thinking] enabled` in the staged config | `on`, `off`                                                |

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

# Amp direct structured generation (requires AMP_API_KEY)
"$AUTOREVIEW" --engine amp --model openai/gpt-5.6-sol --thinking high --amp-bin amp

# Pi with explicit model and thinking level
"$AUTOREVIEW" --engine pi --model anthropic/claude-sonnet-4 --thinking high --pi-bin pi

# Kimi with its configured default model, or a configured model alias
"$AUTOREVIEW" --engine kimi --thinking on --kimi-bin kimi
"$AUTOREVIEW" --engine kimi --model kimi-model-alias

```

### Environment defaults

CLI flags take precedence over environment variables.

Store persistent personal defaults in your shell startup file or launcher
environment. For repository-local defaults, use an existing local environment
loader such as an untracked `.envrc`; the helper does not write a config file.

| Variable                            | Purpose                                                                                                                          |
| ----------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| `AUTOREVIEW_MODEL`                  | Override the built-in default `--model` for all engines                                                                          |
| `AUTOREVIEW_THINKING`               | Default `--thinking` for all engines                                                                                             |
| `AUTOREVIEW_FALLBACK_MODEL`         | Default Claude `--fallback-model` chain                                                                                          |
| `AUTOREVIEW_ENGINE_TIMEOUT_SECONDS` | Optional positive wall-clock limit for each reviewer process; disabled by default                                                |
| `AUTOREVIEW_<ENGINE>_MODEL`         | Per-engine model override, for example `AUTOREVIEW_CODEX_MODEL=gpt-5.6-sol`                                                      |
| `AUTOREVIEW_<ENGINE>_THINKING`      | Per-engine thinking override                                                                                                     |
| `AUTOREVIEW_CODEX_CONFIG`           | Safe Codex model/response tuning overrides, semicolon-separated, e.g. `service_tier="fast"`; capability-bearing keys fail closed |
| `AUTOREVIEW_CODEX_SPEED`            | Codex service tier override: `fast` (priority), `flex`, or `default`; silently standard when the model does not list the tier    |
| `AUTOREVIEW_CLAUDE_FALLBACK_MODEL`  | Claude-only fallback chain                                                                                                       |
| `AUTOREVIEW_PROVIDER_ENV_ALLOW`     | Comma-separated custom Pi credential variable names; names must end in a recognized credential suffix                            |
| `AMP_API_KEY`                       | Required Amp API credential; file/keychain auth is intentionally excluded from the isolated runtime                              |

Codex maps thinking to `model_reasoning_effort`. Claude maps thinking to `--effort`. Amp maps thinking to `amp.ai.generate.reasoningEffort`. Pi maps thinking to `--thinking`. Kimi maps `on` and `off` to `[thinking] enabled` in the staged review config. Only Claude accepts `--fallback-model`; global CLI/env fallback requires at least one Claude reviewer, and engine-specific fallback overrides require that reviewer to be selected. Non-Claude fallback overrides, including `AUTOREVIEW_<NONCLAUDE>_FALLBACK_MODEL`, fail closed instead of being silently ignored.

Amp receives only `AMP_API_KEY` from the caller. Autoreview intentionally ignores `AMP_URL`, user settings, stored authentication, inherited MCP configuration, and other runtime variables. The API key's authenticated account and workspace must have no personal or workspace plugins: current normal Amp execution loads every authenticated plugin, so the preflight requests the complete inventory and fails before creating the review prompt unless the generated adapter is the only plugin. A dedicated Amp API key/account without plugins is the safest setup. Amp can still discover personal and workspace skill metadata, but the isolated settings deny every local and remote MCP server before use, and the outer adapter has no skill tool. Custom Amp endpoints are not supported because forwarding an arbitrary endpoint could disclose the API key and review bundle. Native Windows is refused because its `chmod` behavior cannot establish or attest the POSIX private-file permissions used here; use Linux, macOS, or WSL.

## Review engine isolation

When autoreview runs inside the repository under review, external reviewer CLIs must not load project-local trust or configuration that the branch controls.

| Engine     | Isolation flags                                                                                                                                                                                                                                                                                               | Reference                                                                      |
| ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------ |
| **codex**  | Auth-only config overrides, isolated workspace, `exec --ignore-user-config --ignore-rules --skip-git-repo-check`, plus read-only sandbox                                                                                                                                                                      | Codex CLI `exec --help`                                                        |
| **claude** | `--safe-mode --setting-sources user --strict-mcp-config --disallowedTools mcp__*`; auto-memory and filesystem/shell tools disabled; empty external workspace; WebSearch by default (`v2.1.169+`)                                                                                                              | Claude Code [CLI reference](https://code.claude.com/docs/en/cli-reference)     |
| **amp**    | Empty external workspace and isolated HOME/XDG roots; complete authenticated plugin inventory must contain only the generated adapter; catch-all MCP denial with a process-spawn probe; fixed outer trigger and one input-free adapter tool; private prompt only reaches schema-constrained `amp.ai.generate` | Amp [plugin API](https://ampcode.com/manual/plugin-api) and local CLI `--help` |
| **pi**     | `--no-approve --no-session --no-context-files --no-extensions --no-skills --no-prompt-templates --no-themes --no-tools`                                                                                                                                                                                       | Pi CLI `--help`; requires Pi `v0.79.0+`                                        |
| **kimi**   | Empty external workspace; staged `KIMI_CODE_HOME` with sanitized config; Markdown custom agent with no tools/subagents; explicit empty `--skills-dir`; isolated runtime state                                                                                                                                 | Kimi Code CLI `--help`; requires Kimi `v0.30.0+`                               |

Codex `--ignore-user-config` skips config loading for the exec run. Autoreview reconstructs only the documented `cli_auth_credentials_store`, `forced_login_method`, and `forced_chatgpt_workspace_id` settings from `CODEX_HOME/config.toml`, keeping authentication usable without forwarding unrelated user configuration. Codex runs in an empty temporary workspace: the validated bundle is its sole repository input, ignored files and linked-worktree metadata remain unreadable, and the zero project-doc budget keeps workspace instructions out of the prompt. `--ignore-rules` skips user/project execpolicy rules. Claude `--safe-mode` disables project hooks, skills, plugins, MCP servers, and CLAUDE.md; autoreview supplies WebSearch by default, permits only explicitly domain-constrained WebFetch rules, and exposes no filesystem or shell tools. Amp runs its local CLI with isolated HOME/XDG roots and one generated adapter plugin whose name includes a fresh 128-bit random suffix. Current normal Amp execution loads all authenticated plugins, so the preflight deliberately requests that same complete inventory and fails before writing the private prompt unless the generated adapter is the only active plugin, with exactly its expected tool, agent, and mode. Users with personal or workspace plugins must use a dedicated plugin-free Amp API key/account. Isolated `amp.mcpPermissions` reject every local command and remote URL. Before writing the private prompt, autoreview creates a temporary skill whose MCP command would write a marker, runs `amp tools list`, and requires Amp to report the policy rejection without creating the marker; it removes that skill before continuing. A custom outer mode then receives only a fixed harmless trigger and exposes exactly one trusted, input-free `autoreview_generate` tool. That tool reads the private prompt file and calls `amp.ai.generate` directly with an explicit system prompt and report schema, so the untrusted patch never enters the outer agent context. Autoreview requires the stream's leading init event to attest the empty working directory, the exact singleton adapter-tool inventory, and `mcp_servers: []`; it then requires exactly one correctly ordered empty-input tool call/result and one terminal result before consuming the permission-checked private structured-result file. Native Windows is refused; Linux, macOS, and WSL use permission-checked private files. Pi runs from a neutral temporary directory with project resources disabled and `--no-tools`. Kimi (`-p`, `stream-json`) runs from an empty external workspace with a staged `KIMI_CODE_HOME`: sanitized model/provider config only (no services, hooks, or extra skill/agent dirs), its OAuth credential directory linked in and device identity copied so native token refreshes remain durable without exposing the rest of the user's Kimi state. A Markdown `--agent-file` with `tools: []` and `subagents: []` plus an empty `--skills-dir` keep project instructions, tools, and MCP servers out of the review; the prompt travels as the `--prompt` argument, so per-pass prompts are capped at a platform-safe argv budget (120 KiB POSIX, 30 KiB Windows) and larger bundles partition into bounded passes.

Amp cloud/orb agent execution is deliberately unsupported. In current Amp CLI behavior, `--orb-execute` does not preserve the local tool isolation and can expose shell, patch, thread, and reviewer tools. Autoreview therefore never passes `--orb-execute`: the local isolated adapter may call Amp's cloud inference service through `amp.ai.generate`, but it does not launch a cloud Amp agent over an untrusted diff.

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
- supports `codex`, `claude`, `amp`, `pi`, and `kimi`; default is `AUTOREVIEW_ENGINE` or `codex`
- resolves bare `git`, `gh`, reviewer, and PowerShell shell commands from absolute `PATH` entries only, never from the reviewed checkout; explicit `--*-bin` paths are interpreted from the reviewed repository root when relative and accepted only when both the supplied path and resolved target stay outside the reviewed repository
- use `--mode commit --commit <ref>` for already-committed work, especially clean `main` after landing
- validates complete Git patches, scans every outgoing review pack, reviews them in one pass up to the aggregate prompt limit, and automatically uses complete bounded passes above it
- uses branch mode for committed-only PR work, or explicit local mode with a pinned merge base for a complete PR plus dirty candidate
- writes reports to stdout and optionally to `--output` or `--json-output` files; preparation progress and provider heartbeats use stderr
- supports `--dry-run` (validates bundle construction, reviewer CLI resolution, and local isolation startup with version/help probes without contacting a provider; exits nonzero if any check fails), an opt-in per-reviewer wall-clock bound via `--engine-timeout-seconds`, `--prompt`, repo-relative `--prompt-file`, repo-relative `--dataset`, `--no-tools`, `--no-web-search`, repeatable Codex-only safe model/response tuning with `--codex-config key=value`, Codex-only `--codex-speed fast|flex|default`, and commit refs
- supports `--stream-engine-output` or `AUTOREVIEW_STREAM_ENGINE_OUTPUT=1` for live engine text while preserving structured validation; Codex and Claude hide tool/file event details, emit compact activity summaries, and report usage at turn completion
- supports per-engine `--model`, `--thinking`, and Claude `--fallback-model`
- uses built-in defaults `codex=gpt-5.6-sol` with `high` reasoning and an access-only `gpt-5.6-terra` retry, `claude=claude-fable-5`, and `amp=openai/gpt-5.6-sol` with `high` reasoning; honors `AUTOREVIEW_MODEL`, `AUTOREVIEW_THINKING`, `AUTOREVIEW_FALLBACK_MODEL`, and per-engine `AUTOREVIEW_<ENGINE>_MODEL` / `AUTOREVIEW_<ENGINE>_THINKING` environment overrides when CLI flags are omitted
- gives Codex the bundle in an empty workspace with web search available; Claude receives the bundle plus WebSearch by default and optional domain-constrained WebFetch; Amp sends the bundle only through direct schema-constrained generation; Pi and Kimi receive the bundle with no tools
- runs Claude with `--safe-mode` (`v2.1.169+`), `--setting-sources user`, MCP and auto-memory disabled, no filesystem/shell tools, an empty external workspace, and `--fallback-model` when set
- runs Amp locally from an empty temporary workspace with isolated runtime roots, complete plugin inventory attestation that fails if any authenticated personal/workspace plugin exists, catch-all MCP denial verified by a no-spawn marker probe, a fixed outer trigger, one input-free adapter tool, and direct `amp.ai.generate`; requires `AMP_API_KEY`, refuses native Windows, and refuses cloud/orb agent execution
- runs Pi `v0.79.0+` from neutral temporary directories with `--no-approve`, `--no-session`, disabled Pi context/resource loading, and `--no-tools` because its built-in read tools are not repository-confined
- runs Kimi Code CLI `v0.30.0+` from an empty temporary workspace with a staged `KIMI_CODE_HOME`, sanitized config, an empty `--skills-dir`, and a no-tools/no-subagents Markdown `--agent-file`
- prints `review still running: <engine> elapsed=<seconds>s pid=<pid>` to stderr at long-running intervals while waiting for the selected review engine, unless streamed output or compact Codex activity has been visible recently
- prints `autoreview scoped-clean` only when no findings were rejected or filtered and the provider returned a correct verdict
- exits nonzero for accepted findings, a provider's incorrect verdict, or an incomplete result

## Result handling

Filtering never rewrites provider correctness, explanation, or confidence.
`findings` contains accepted findings at the requested priority; local JSON and
text results retain `scope_rejected_findings` and `priority_filtered_findings`
separately. Any scope rejection makes `review_status` `incomplete` and exits 2,
including when other findings remain or `--expect-findings` is set. Resolve the
target mismatch explicitly; do not infer a broader target from prompt prose.

With no scope rejection, status is `findings` for accepted findings, `filtered`
when only lower-priority findings remain, `incorrect` for an incorrect verdict
without findings, or `scoped-clean` otherwise. Exit 1 means accepted findings or
an incorrect provider verdict; even a priority-filtered incorrect verdict stays
nonzero. Exit 0 for a filtered correct verdict does not certify correctness.
`--expect-findings` accepts retained findings for harness checks, never scope
rejections. `--require-finding` checks only accepted findings after both filters
across every pass; missing text is retained in `missing_required_findings` and
exits 2 after writing results.

Chunked results retain each provider report under `pass_reports`, print each
provider explanation, and use the minimum pass confidence rather than promoting
confidence from another pass. Provider JSON remains strictly validated before
the helper adds local audit metadata. All engines use this same result path.

The exact source filename `CredentialFile.swift` is allowed for untracked and
evidence inputs only outside sensitive parent paths, matching its existing
tracked-source treatment. This is not a general source-extension exemption:
credential stores, credential directories, `.env`, PEM, and key files retain
their exclusions. TruffleHog still scans the exact outgoing pack, including
source content, deleted lines, prompts, and datasets, before every provider call.

## Final Report

Report material findings and the resulting status in chat. If there are none, say so plainly. Do not add command logs, test ledgers, proof blocks, or review receipts unless the user asks for them.
