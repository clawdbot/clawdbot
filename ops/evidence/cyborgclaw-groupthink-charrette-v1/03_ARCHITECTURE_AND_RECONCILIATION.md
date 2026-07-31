# Architecture and reconciliation record

## Core design

The skill is a self-contained Node 22 contract with no runtime dependencies.
It contains strict duplicate-key JSON parsing, canonical JSON/SHA-256 binding,
three JSON Schemas, executable routing and terminal precedence, five complete
examples, an escaped human S.ADR renderer, adversarial tests, and a
transactional user-scope installer.

## Authority model

- The immutable charter defines allowed and reserved categories/effects.
- A live delegation must list the canonical digest of the entire exact action
  object; a category label alone never authorizes changed scope.
- Authority evidence must exactly reproduce the canonical proxy charter under
  `cyborgclaw.glen-delegation.v1`.
- The immutable network policy is `none`.
- Remote repository writes, Git push, PR creation, merge, release, production,
  credentials, external communication, destructive work, financial/legal
  commitment, and material risk acceptance are reserved.
- Decision creation uses the runtime clock, records `authority_verified_at` and
  delegation expiry, and requires a fresh execution-time authority check.
- The claim ceiling is immutable `INTERNAL_DECISION_ONLY`.

Direct-prompt custody and declared role IDs are not cryptographic
authentication. The contract preserves that limitation explicitly instead of
claiming more than a same-user process can prove.

## Process model

- Router outcomes: `RUN_CHARRETTE`, `DIRECT_WITHIN_DELEGATION`, `HOLD`,
  `ESCALATE_TO_GLEN`.
- Required independent lenses: epistemic integrity, authority/security, and
  development practicality.
- Reviewer submissions bind the same freeze digest, substantive analysis,
  examined evidence IDs, strict chronology, exact attestations, and role
  incompatibilities.
- Gates are frozen before review. Manual gates require an immutable evaluator
  attestation and exact threshold result.
- Challenges are bounded to two contiguous evidence-backed rounds.
- Material contradictions cannot be omitted, rewritten, or severity-lowered.
- Unresolved material objections cannot silently fall through to `PROCEED`.
- Terminal precedence is
  `ESCALATE_TO_GLEN > HOLD > ABORT_PATH > REWORK_AND_CONTINUE > PROCEED`.
- `no_action` never enables autonomous continuation.

## Record and installation model

The S.ADR embeds frozen session and findings, reproduces derived fields, records
point-in-time authority, preserves dissent, omits raw evidence bodies from
Markdown, escapes untrusted rendering content, and hashes the complete record.

The installer inventories the logical tree, rejects unsafe file/link/path
states, stages on the destination filesystem, journals updates, creates
receipt-bound backups, repairs only exact partial receipt pairs, restores prior
state on source drift, supports adoption of byte-identical unmanaged payloads,
and leaves deletion outside its authority.
