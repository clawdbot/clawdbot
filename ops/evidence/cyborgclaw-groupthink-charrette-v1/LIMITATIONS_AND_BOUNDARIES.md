# Limitations, uncertainties, and prohibited-action confirmation

## Retained limitations

- `operator_direct_prompt` is the platform trust root. Content hashes detect
  drift and substitution but do not cryptographically authenticate Glen.
- The skill is decision-only. It returns workflow eligibility and always fixes
  `execution_authority_granted=false`; it does not ship an action executor.
- A future executor would need separate authority and enforcement for trusted
  logical adapters, exact bytes and paths, no-symlink resolution, network and
  shell containment, atomic nonce use, validation, and rollback.
- Logical-tree identity covers relative paths, entry types, modes, sizes, file
  bytes, and empty directories. It intentionally does not claim identity for
  ownership, timestamps, ACLs, extended attributes, or allocation.
- Installer receipts prove same-user logical payload integrity, not authenticity
  against an attacker who can rewrite the user account and its receipt state.
- Prompt Architect custody is coherent and independently reproducible, but its
  deterministic manifest derivation procedure is not placed directly beside
  the provenance field.
- The strict JSON contracts favor auditability over low-friction authoring; a
  future authoring layer must preserve exact schema and freeze semantics.
- The fork-divergent branch was replayed onto verified canonical-`main`
  ancestor `13d474134f38b36637473b736d37a3e0e4886140`. At live PR audit, base
  `c892a712e675e3df8e490c4f5ac124ef50631691` was 14,087 commits ahead.
  GitHub reported the mission-only PR mergeable but behind; maintainer
  integration freshness remains unresolved by design.
- The repository-wide `pnpm check` passes all preflight guards except an
  unchanged baseline `npm-shrinkwrap.json` freshness guard documented in
  `05_TEST_PLAN_AND_RESULTS.md`. The mission-owned suite, schemas, checksums,
  structure validation, formatting, duplicate-scan coverage, and OpenClaw
  skill-loader tests pass.

## Closed uncertainties

- Prompt Architect identity was established from verified admission custody,
  not directory preference.
- No governing pre-existing GroupThink artifact was found; the exact operator
  mission prompt is the first governing artifact.
- The source candidate is frozen by a complete logical-tree digest and every
  countable final reviewer is bound to it.
- Global installation is exact, receipt-managed, durable, repeatable as a no-op,
  and discoverable by exact skill name from a fresh context outside the source
  repository.
- Inherited fork divergence no longer pollutes the draft diff; the remaining
  base lag is explicitly recorded rather than described as current.

## Prohibited actions not taken

- no merge;
- no production deployment, release, publish, restart, or production access;
- no production credential creation, disclosure, or use;
- no external operational message or product/runtime side effect beyond the
  explicitly authorized repository publication;
- no gate weakening, mission-purpose change, or material scope expansion;
- no destructive cleanup, stash, reset, force-push over unknown work, or
  cross-worktree mutation;
- no modification of Prompt Architect, CGAT work, unrelated skills, sessions,
  branches, or worktrees.

Existing authorized GitHub authentication was used only for the required branch
push and draft-PR publication. One exact-OID force-with-lease replaced only the
known dedicated branch commit to remove inherited fork divergence and bind the
PR to a verified canonical-`main` ancestor; it could not overwrite unknown
remote work. These Git effects are not production or operational execution and
do not imply merge authority or current-base freshness.
