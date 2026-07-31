# Test plan and exact results

## Skill suite

Command:

`node --test .agents/skills/cyborgclaw-groupthink-charrette/tests/*.test.mjs`

Result:

- tests: 161
- pass: 161
- fail: 0
- cancelled: 0
- skipped: 0
- todo: 0
- duration: 5,293.987062 ms

Coverage includes routing, every terminal outcome, exact authority, graph and
consensus non-authority, expiry, chronology, evidence drift, strict
duplicate-key and UTF-8 handling, parser resource limits, prompt injection, gate
drift, reviewer separation, objections, contradictions, challenge custody,
typed exact-change repair authority, command and output-path safety, escaped
Markdown, Unicode code-point/schema agreement, Gregorian timestamp agreement,
repository-governance-file containment, large-record round trips, transactional
install/update/rollback/recovery, unsafe state linkage, and source-drift
restoration.

## Validators

- `node scripts/build-checksums.mjs --check`: valid, 39 files
- `node scripts/validate-skill.mjs`: valid, version 1.0.0, 49 entries, 5
  examples, logical-tree digest
  `3c788a417c3b00586760845d60f5859599c85acc9673bc8775b0ea97a80c05aa`
- canonical `quick_validate.py`: `Skill is valid!`
- targeted Oxfmt check: all hand-authored JavaScript, JSON, Markdown, and YAML
  files correctly formatted; the generated standalone validator is excluded as
  a machine artifact
- Draft 2020-12 schema meta-validation: 3/3 valid
- Schema instances: 7 sessions, 5 findings, and 5 S.ADR records valid
- Unicode contract regression: a 40-code-point astral summary is rejected by
  the engine and both applicable schemas; an 80-code-point summary is accepted
  by all three
- Gregorian timestamp regression: impossible dates are rejected by the engine
  and all three schemas; valid leap-day artifacts are accepted
- Governance-path regression: fully bound local repairs targeting root, nested,
  case-varied, and recognized-equivalent instruction files escalate and cannot
  continue autonomously
- Canonical-base loader test:
  `node scripts/run-vitest.mjs run --config test/vitest/vitest.unit.config.ts src/skills/loading/agents-directory.test.ts`:
  1 file passed, 3/3 tests passed, 666 ms
- secret/local-Codex-path scan of the skill: no matches

The exact 161-test run, validators, and loader test were repeated against the
frozen source on 2026-07-31 UTC. The complete TAP run ended:

```text
1..161
# tests 161
# suites 0
# pass 161
# fail 0
# cancelled 0
# skipped 0
# todo 0
# duration_ms 5293.987062
```

## Repository-wide check

After canonical-ancestor replay, `pnpm check` passed every preflight guard except
the repository's pre-existing npm-shrinkwrap freshness guard:

```text
.: npm-shrinkwrap.json is stale. Run `pnpm deps:shrinkwrap:generate`.
```

The first post-replay run also identified the evidence builder as a tracked
source file outside duplicate-scan targets. That mission-owned issue was
repaired by moving the builder to `scripts/`; the exact retry then reported
duplicate-scan target coverage `ok` and only the shrinkwrap baseline above.

Per repository policy, `pnpm install` was run before the exact retry.
`package.json`, `pnpm-lock.yaml`, and `npm-shrinkwrap.json` are byte-unchanged
from governing ancestor
`13d474134f38b36637473b736d37a3e0e4886140`. Regenerating dependency lock
artifacts would be unrelated scope, so the baseline is recorded rather than
modified. The focused loader and all skill-specific checks pass.
