---
name: autoreview
description: "Structured Codex, Claude, Amp, Pi, or Kimi code review when explicitly requested."
---

# Auto Review

Run an independent review when the user or an owning workflow asks for one.
This is code review, not Guardian approval routing. Let the reviewer choose how
to analyze the change; provide the target, relevant context, and desired severity.
Findings are advice to verify, not instructions to apply blindly.

## Run

Use `scripts/autoreview` beside this skill. Keep its custom `codex exec` path:
native `codex review` cannot combine explicit Git target flags with custom instructions.
The helper combines those with evidence, severity filtering, and validated JSON;
it leaves review judgment to Codex. For an OpenClaw checkout:

```bash
AUTOREVIEW=".agents/skills/autoreview/scripts/autoreview"
"$AUTOREVIEW" --mode local
```

In the canonical agent-skills repo, the path is
`skills/autoreview/scripts/autoreview`. On Windows, invoke the helper with Python.
Use `--help` for the complete flags and environment overrides.

Choose the Git target explicitly when the default is ambiguous:

| Target                         | Arguments                      | Scope                                                       |
| ------------------------------ | ------------------------------ | ----------------------------------------------------------- |
| Local work                     | `--mode local`                 | HEAD → index → working tree, plus untracked files           |
| Local candidate against a base | `--mode local --base <ref>`    | Pinned base → index → working tree, plus untracked files    |
| Committed branch/PR            | `--mode branch --base <ref>`   | Merge-base → HEAD; excludes dirty work                      |
| One commit                     | `--mode commit --commit <ref>` | Raw parent → commit; a root compares against the empty tree |

`--mode auto` selects local work when dirty, otherwise a branch review using the
PR base or `origin/main`. Clean main has no implicit review target.
`--mode uncommitted` is an alias for local. The helper does not fetch refs.

Registered nested linked checkouts from the same repository are outside the
current review scope. Their presence or edits do not make the parent dirty;
ordinary adjacent files remain included and scanned. Worktree boundaries are
revalidated without changing Git ignore rules.

For a complete PR candidate **including dirty rewrites**, use local mode with
its pinned merge base—not branch mode:

```bash
pr_base=$(gh pr view --json baseRefName --jq .baseRefName)
merge_base=$(git merge-base HEAD "origin/$pr_base")
"$AUTOREVIEW" --mode local --base "$merge_base"
```

When a file has both staged and unstaged changes, both states are reviewed.
A defect in the index remains actionable even if the working tree fixes it;
the report labels it `INDEX-only`.
Git display settings cannot suppress context markers or add patch colors;
repository configuration is not changed. Source paths and text retain literal
whitespace. An empty present
source uses line 1, column 1, and an empty excerpt; empty physical lines also
use an empty excerpt at column 1. Source identity remains mandatory.

## Context and severity

Use `--prompt` for task-specific guidance, or `--prompt-file` and `--dataset` for
repository-relative context files. Context does not expand the selected Git
target. The reviewer cannot read unchanged repository files from its empty
sandbox; supply relevant source or dependency evidence when the diff is insufficient.

The default threshold is **P0 only**: material blockers to normal operation or
safety. Use `--max-priority P1`, `P2`, or `P3` when the caller requests a wider
review. Do not add unrelated redesign goals or prescribe file counts, reading
sequences, or ritual extra passes. Historical blame requires a verified
parent-relative patch; otherwise leave the attribution unknown.

```bash
"$AUTOREVIEW" --mode local --prompt-file review-notes.md --dataset evidence.json
```

## Engines

Codex is the default: `gpt-5.6-sol`, high reasoning, with a `gpt-5.6-terra` retry
only for an account-access failure. Honor explicit engine/model choices; do not
switch because a review is slow or rate-limited.

Use `--engine`, `--model`, and `--thinking` to override the defaults.
`--codex-speed fast` selects priority service when supported. Only Claude accepts
`--fallback-model`. Per-engine environment overrides use `AUTOREVIEW_<ENGINE>_*`.

By default, Codex preserves only authentication settings from user configuration;
provider, profile, context and catalogue settings remain ignored. To project a
named route, select it explicitly through the existing config override:

```bash
"$AUTOREVIEW" --mode local --codex-config 'model_provider="review_api"'
```

The selector must match `model_provider` in the operator's external
`CODEX_HOME/config.toml`. It accepts one bare or simply quoted identifier;
provider definitions and other capabilities cannot be supplied through overrides.
Projection requires Python 3.11 or `tomli`; default auth-only operation retains
its existing fallback parser.

The selected route must use `https://api.openai.com/v1` and command authentication
with an absolute external executable. Fixed arguments belong in that executable's
wrapper; omitted or empty `auth.args` are accepted. Omitted `wire_api` and
`requires_openai_auth` retain Codex's `responses` and `false` defaults. Optional
auth timing and context settings keep native defaults and semantics.

Catalogue and authentication working-directory paths resolve relative to the
operator config directory and must remain outside the reviewed repository.
A supplied catalogue is copied byte-for-byte into the private client runtime;
retries use the same route and catalogue snapshot. Dry runs check the same
ownership and route shape without executing authentication. Codex owns catalogue
validation, model access and context clamping. Other custom provider forms and
split context overrides are unsupported when projection is selected.

| Optional engine | Prerequisites                                                                                         |
| --------------- | ----------------------------------------------------------------------------------------------------- |
| Claude          | CLI 2.1.169+; safe mode with web-only tools                                                           |
| Amp             | `AMP_API_KEY` for a plugin-free account; local POSIX execution, no custom endpoint or cloud/orb agent |
| Pi              | CLI 0.79.0+; configured model; no tools or project resources                                          |
| Kimi            | CLI 0.30.0+; configured model; Python 3.11+ or `tomli` for TOML config                                |

## Runtime boundaries

The helper owns reviewer isolation, sanitized authentication, process cleanup,
Git scope, and structured result validation. Keep those controls enabled.
TruffleHog must scan the complete frozen input for partitioned reviews and each
exact outgoing pack before it is sent; missing or failed scanning stops the run.
Source-controlled ignore tags cannot suppress this gate. Scanner refusals never
echo input headings or finding payloads; remove credentials locally and rerun.
Never reproduce credentials in findings or work around an isolation failure.

On macOS, reviewer tools cannot access the shared `/tmp` and `/var/tmp` trees
(including their `/private` aliases). Codex preflight rejects those temporary
roots before workspace, runtime, or authentication setup; unset a shared
`TMPDIR`/`TMP`/`TEMP` override to use macOS's private
temporary directory. Other engines and platforms retain their normal isolation.
Tools installed in shared scratch or requiring writes there will be denied too.

Review files have no size/count cap and are never truncated. Large diffs and
datasets are partitioned automatically. Intact instructions and required mixed
source context must still fit the per-pass prompt budget. A failed pass does not
produce a partial clean verdict.

Do not edit inputs during a review: the helper verifies captured sources before
sending and publishing results. Long reviews are normal; advancing heartbeats
mean progress. Use `--stream-engine-output` for visibility, not extra reviewer
runs. `--dry-run` checks preparation and startup without contacting a reviewer.

## Results

`--output` and `--json-output` paths must be outside the reviewed repository.

| Exit | Meaning                                                                         |
| ---- | ------------------------------------------------------------------------------- |
| `0`  | `scoped-clean`, or a correct verdict with only filtered lower-priority findings |
| `1`  | Accepted findings or an incorrect provider verdict                              |
| `2`  | Incomplete scope/attribution, or a missing required finding                     |

Treat `scoped-clean` as clean only for the selected target and requested priority.
`filtered` is not clean; resolve `incomplete` before claiming completion.
Verify findings against the actual code and task before changing anything.
No extra review rounds for a nicer verdict; follow the owning workflow after fixes.

Report material findings and status plainly. Do not add transcripts, proof
ledgers, commits, pushes, or a new workstream unless requested.
