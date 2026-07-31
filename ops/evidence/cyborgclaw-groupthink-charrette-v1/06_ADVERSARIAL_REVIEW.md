# Adversarial review and repair record

## Frozen review target

- Skill: `cyborgclaw-groupthink-charrette` 1.0.0
- Logical-tree digest:
  `3c788a417c3b00586760845d60f5859599c85acc9673bc8775b0ea97a80c05aa`
- Entry count: 49
- Checksum-manifest digest:
  `67a199980d30931dfd049a84c8f6c3f863550919347b05b20b2200c15e9c3813`
- Final adversarial verdict: `ACCEPTED`

The read-only authority red-team reproduced the earlier 157/157 suite and
49-entry skill validator. Clean-context reviewers subsequently found the
material proof-plan equality, Unicode-length, Gregorian timestamp, and
governance-file laundering defects recorded as A13 through A16 below. All four
repaired paths are now included in the 161/161 suite, and the source has been
re-frozen at the digest above.

## Objection ledger

| ID  | Attack or objection                                       | Severity | Disposition and proof                                                                                                                                                                                                                       |
| --- | --------------------------------------------------------- | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A01 | Personas or titles can replace failure lenses             | Material | Rejected structurally. Frozen lens-to-principal assignments are exact; tests 5–9 and 144–147 pass.                                                                                                                                          |
| A02 | Shared preliminary conclusions can anchor all reviewers   | Material | Independent findings bind the same frozen inputs before challenge/synthesis; substitution and freeze-mismatch tests pass.                                                                                                                   |
| A03 | Sage can omit dissent or rewrite contradictions           | Material | Contradictions are exact-match and severity-preserving; tests 13, 44–47, 62–66, and 141 pass.                                                                                                                                               |
| A04 | Consensus, graph edges, or labels can manufacture power   | Critical | Typed action profiles and exact delegation digests control authority; tests 51–59, 103–104, and 151–152 pass.                                                                                                                               |
| A05 | The process escalates routine choices and blocks autonomy | Material | Router supports direct routine/factual paths while unknowns fail closed; tests 144–150 pass.                                                                                                                                                |
| A06 | The process continues through reserved or expired power   | Critical | Reserved actions and expired/conflicting custody outrank green gates; tests 31–32, 57–59, 98, 102–104, and 152 pass.                                                                                                                        |
| A07 | Evidence-borne prompt injection changes instructions      | Critical | Evidence is inert hashed data and raw bodies are omitted from rendering; tests 89–90 and 139–143 pass.                                                                                                                                      |
| A08 | Gates can change after outcomes are visible               | Critical | Proof plans predate receipts/freeze and receipt values control gates; tests 14–26 and 88 pass.                                                                                                                                              |
| A09 | Decision outputs indirectly authorize execution           | Critical | Router, S.ADR, and recheck surfaces fix `execution_authority_granted=false`; tests 48, 58–59, 102, and 107–109 pass.                                                                                                                        |
| A10 | A decision cannot be reproduced from its record           | Material | Frozen inputs, current authority, derived fields, and five fixtures reproduce deterministically; tests 91–109 pass.                                                                                                                         |
| A11 | Parser or output-path ambiguity bypasses custody          | Critical | Strict UTF-8/JSON, resource caps, no-follow reads, and no-clobber/alias defenses pass tests 67–87 and 128–138.                                                                                                                              |
| A12 | Installation silently overwrites or loses provenance      | Critical | Transactional adoption/update/backup/rollback, drift, journal, receipt, and lock tests 110–127 pass.                                                                                                                                        |
| A13 | Proof-plan commitment may equal freeze time               | Critical | Reproduced: a manual-only equal timestamp could reach `PROCEED`. Validation and routing now require strict predating; the new regression and full suite pass.                                                                               |
| A14 | Engine length semantics may diverge from JSON Schema      | Material | Reproduced: 40 astral code points passed an 80-unit JavaScript check but failed schema `minLength: 80`. Engine checks now count Unicode code points; 40 fails and 80 passes in both engine and schemas.                                     |
| A15 | Schema timestamps may admit impossible calendar dates     | Material | Reproduced: standalone validators accepted February 31 while the engine rejected it. Generated validators now enforce Gregorian month lengths and leap-year rules; invalid dates fail all surfaces and valid leap days pass.                |
| A16 | Governance instructions can be labeled as local repairs   | Critical | Reproduced: an exact delegated `AGENTS.md` mutation could yield autonomous `REWORK_AND_CONTINUE`. Recognized governance basenames are now protected case-insensitively at every depth; fully bound probes escalate with continuation false. |

## Pre-freeze repairs

The challenge–repair loop closed material findings before the digest was
frozen. Repairs included:

- replacing prose-only action categories with immutable typed operation
  profiles and exact canonical action digests;
- binding local repair authority to canonical before/after bytes, a file
  allowlist, rollback digest, and focused validation;
- separating draft routing from frozen charrette minima;
- binding receipts to a precommitted proof plan and strict chronology;
- fixing panel assignments to distinct principals and excluding operational,
  authority-custody, synthesis, builder, executor, and final-judge roles;
- preserving exact contradictions, dissent, objections, challenge evidence, and
  final-review resolutions;
- adding strict duplicate-key, malformed UTF-8, lone-surrogate, depth, node,
  byte-size, FIFO, symlink, hard-link, and output-collision defenses;
- separating JSON decision writes, Markdown rendering, and stdout-only authority
  rechecks;
- adding a short-lived, record-bound execution-time authority recheck that
  preserves original decision context;
- hardening the transactional global installer and receipt recovery.
- aligning runtime text minima with Draft 2020-12 Unicode code-point semantics.
- aligning standalone timestamp validation with engine Gregorian semantics.
- reserving repository-governance instruction files from local repair actions.

Each repair was followed by the affected focused tests and then the full suite.
The final full rerun passed 161/161. The combined adversarial and schema suites
passed 75/75. Exact A15 probes reject impossible dates across all three schemas
and engine validators while accepting leap-day artifacts. Exact A16 probes
escalate root, nested, case-varied, and recognized-equivalent governance paths.

## Final red-team recheck

The final reviewer independently reproduced the predecessor digest and the A13
repair.
The former equality exploit now returns `HOLD` before creating a frozen session,
decision record, output, or continuation. Direct frozen-session validation
returns `INVALID_CONTRACT`; both chronology controls use `>=`. The new
manual-only regression passed, the focused suite passed 66/66, the full suite
passed 158/158, and checksum/skill validation passed.

That reviewer also rechecked future freeze, authority-envelope injection,
receipt replay, reviewer substitution, Unicode digest collision, empty
thresholds, `NO_ACTION` repair, reserved actions, record-recheck replay, and
execution-capability confusion. All fail closed. Exact action, target, evidence,
proof-plan, panel, expiry, nonce, and recheck bindings reproduce.

A dedicated read-only A14 repair recheck independently reproduced the current
digest using a standalone walker: 49 entries, 40 files, and 9 directories. Its
exact astral probe observed engine/schema rejection at 40 code points and
engine/findings/record-schema acceptance at 80. It confirmed both runtime sites
use code-point length, reran the 7/7 schema suite, 39-file checksum validation,
the skill validator, and the complete 159/159 suite, and observed no source
drift. It also confirmed the A13 chronology guard remains intact. Verdict:
`ACCEPTED`.

Dedicated read-only A15 and A16 repair rechecks independently reproduced the
current 49-entry digest before and after testing.

The A15 reviewer rejected invalid month days and non-leap-century February 29
across session, findings, and decision-record engine/schema paths; accepted
valid leap days including 2000 and 2028; passed the 8/8 schema suite, 161/161
full suite, validator, and 39-file checksums. Verdict: `ACCEPTED`.

The A16 reviewer replayed the original exact-current-byte root `AGENTS.md`
exploit and fully bound probes for nested, case-varied, and every listed
governance basename. Every structurally valid probe returned
`ESCALATE_TO_GLEN`, `RESERVED`, `RESERVED_ACTION`, and autonomous continuation
false; dot-leading rule files failed structurally even earlier. The full
161/161 suite, validator, and both checksum surfaces passed. Verdict:
`ACCEPTED`.

## Retained nonblocking limitations

- Direct-prompt custody is not cryptographic authentication.
- The decision-only skill intentionally has no executor.
- Autonomous execution needs a separately authorized enforcing runtime with a
  trusted logical-adapter registry, path/symlink controls, exact-byte checks,
  network and shell containment, and atomic nonce consumption.

These limitations are declared in the charter, manifest, decision records, and
operator guide. They do not contradict the mission’s bounded decision-support
outcome.
