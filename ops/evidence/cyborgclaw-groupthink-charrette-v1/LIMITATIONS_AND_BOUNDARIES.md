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
- The repository-wide `pnpm check` currently reaches unrelated baseline
  TypeScript diagnostics documented in `05_TEST_PLAN_AND_RESULTS.md`. The
  mission-owned suite, schemas, checksums, structure validation, formatting,
  and OpenClaw skill-loader tests pass.

## Closed uncertainties

- Prompt Architect identity was established from verified admission custody,
  not directory preference.
- No governing pre-existing GroupThink artifact was found; the exact operator
  mission prompt is the first governing artifact.
- The source candidate is frozen by a complete logical-tree digest and every
  countable final reviewer is bound to it.

## Prohibited actions not taken

- no merge;
- no production deployment, release, publish, restart, or production access;
- no credential creation, disclosure, or use;
- no external operational message or product/runtime side effect;
- no gate weakening, mission-purpose change, or material scope expansion;
- no destructive cleanup, stash, reset, force-push, or cross-worktree mutation;
- no modification of Prompt Architect, CGAT work, unrelated skills, sessions,
  branches, or worktrees.

The eventual authorized branch push and draft-PR creation are repository
publication effects required by the mission. They are not production or
operational execution and do not imply merge authority.
