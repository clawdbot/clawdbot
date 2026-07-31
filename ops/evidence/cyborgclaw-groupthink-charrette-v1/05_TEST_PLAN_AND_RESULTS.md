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
- `pnpm exec vitest run src/agents/skills.agents-skills-directory.test.ts`: 1
  file passed, 3/3 tests passed, 970 ms
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

`pnpm check` passed the repository format stage, then stopped in pre-existing
core TypeScript state outside this ignored, self-contained skill. Per repository
policy, `pnpm install` was run and the exact check was retried once; it produced
the same diagnostics:

- unresolved `@mariozechner/pi-ai/oauth` types/imports;
- two associated implicit-`any` diagnostics;
- a telemetry error-shape mismatch;
- a governor `void | false` mismatch.

No mission file touches those paths. The focused loader and all skill-specific
checks pass; the unrelated baseline is preserved rather than modified.
