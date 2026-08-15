# Security tooling

This directory holds OpenClaw's shipped OpenGrep security rulepack and the
supporting tooling that validates and runs it. Maintainer-only advisory triage
and detector-generation prompts live outside the public repo; this repo keeps the
durable artifacts needed to block regressions in PRs and support local rule
validation.

## Layout

```text
security/
├── README.md                              <- this file
└── opengrep/
    ├── README.md                          <- precise rulepack details + compile recipe
    └── precise.yml                        <- compiled super-config: precise rules
```

The related scripts are:

- `security/opengrep/compile-rules.mjs` — gathers source OpenGrep rule YAMLs from
  a folder and appends new compiled rule IDs to `security/opengrep/precise.yml`.
- `security/opengrep/check-rule-metadata.mjs` — enforces that every committed
  rule carries durable source/provenance metadata.
- `scripts/run-opengrep.sh` — runs the compiled precise rulepack locally or in
  CI with consistent paths and exclusions.

## Rule lifecycle

Maintainers investigate advisories and generate candidate rules outside the public repo.
Once a candidate rule has been validated and reviewed, put the shippable source
rule YAML in any local folder and compile it into this repo:

```bash
node security/opengrep/compile-rules.mjs \
  --rules-dir <folder-with-source-rule-yaml>
```

Commit the resulting `security/opengrep/precise.yml` diff. Durable rule
provenance lives in each compiled rule's metadata and is checked by
`pnpm check:opengrep-rule-metadata`.

Rule quality contract: precise rules must catch the vulnerable behavior they were
written for, should be silent on corresponding fixed behavior when a fix exists,
and should keep current findings limited to verified regressions or variants.

## Writing precise OpenGrep rules

A rule is appropriate for `security/opengrep/precise.yml` only when the dangerous
shape is stable enough to block PRs. Prefer, in order:

1. **Variant detector** — source-to-sink or missing-guard detection across the
   same bug family.
2. **Scoped behavioral regression** — a narrow subsystem-specific rule anchored
   on the affected API or trust boundary.
3. **Exact regression canary** — a labelled canary for the original vulnerable
   shape when broader variants would be noisy.
4. **No OpenGrep rule** — if runtime state, product policy, or external data is
   required to distinguish vulnerable and safe behavior.

Before compiling a rule, validate it against vulnerable/fixed/current code when
those surfaces exist. Every current finding must be classified as a true original
issue or true variant, or the rule must be tightened/dropped before it ships.

## Running the rules locally

The wrapper script handles paths, exclusions, and output formatting so local
scans match CI exactly.

```bash
scripts/run-opengrep.sh                 # precise rules, human output
scripts/run-opengrep.sh --json          # write .opengrep-out/precise.json
scripts/run-opengrep.sh --sarif         # write .opengrep-out/precise.sarif
scripts/run-opengrep.sh --changed       # scan changed first-party paths
scripts/run-opengrep.sh -- src/agents/  # scan a single dir
```

If you'd rather invoke `opengrep` directly, the equivalent is:

```bash
opengrep scan --no-strict --no-git-ignore \
  --config security/opengrep/precise.yml \
  src/ extensions/ apps/ packages/ scripts/
```

Both forms read `.semgrepignore` at the repo root automatically — that's the
single source of truth for which paths are skipped (test files, fixtures, mocks,
QA-tooling extensions, test-orchestration scripts, …). Add a glob there if a new
test naming convention shows up.

## Running the rules in CI

There are two OpenGrep workflows:

- **OpenGrep — PR Diff** (`.github/workflows/opengrep-precise.yml`) runs on pull
  requests and executes `scripts/run-opengrep.sh --changed --sarif --error` so
  findings stay scoped to changed first-party paths.
- **OpenGrep — Full** (`.github/workflows/opengrep-precise-full.yml`) is manual
  dispatch only and executes `scripts/run-opengrep.sh --sarif --error` across
  the full first-party source set for maintainers who want a repository-wide
  audit.

Both workflows:

- Inherit the same `.semgrepignore` exclusions used by the local wrapper
- Upload SARIF to GitHub Code Scanning under stable OpenGrep categories
- Fail on precise findings so the rulepack acts as a regression firewall
- Enforce committed rule provenance with `pnpm check:opengrep-rule-metadata`

## Editing, silencing, or removing rules

`precise.yml` is the checked-in compiled rulepack. Prefer editing source rule
YAML and recompiling instead of hand-editing compiled rules, because the compiler
normalizes rule IDs, metadata, duplicates, and OpenGrep validation. The compiler
appends new rule IDs by default; use `--replace-precise` only when intentionally
rebuilding the rulepack from a complete source folder.

To drop a noisy rule:

1. Delete the offending source rule from the local source-rule folder.
2. Re-run `node security/opengrep/compile-rules.mjs --rules-dir <folder-with-source-rule-yaml>`.
3. Commit the resulting `security/opengrep/precise.yml` diff.

To narrow a rule's path scope, edit the source rule's `paths.include` /
`paths.exclude` fields in the same local artifact location and recompile.

## Tracing a finding back to its source

Every compiled rule's `id` is `<source-id>.<original-id>`. For GHSA-backed rules,
`<source-id>` is the lower-case GHSA ID. For other source-backed rules, use a
stable source identifier without dots such as a CVE, OSV ID, internal advisory ID, or other
review identifier. Rule `metadata` must include `advisory-url`,
`detector-bucket`, and `source-rule-id`, plus either `ghsa` or `advisory-id`.
New compilations also add `source-file` when available.
`pnpm check:opengrep-rule-metadata` enforces these durable source fields so each
committed rule is traceable without a separate committed manifest.
