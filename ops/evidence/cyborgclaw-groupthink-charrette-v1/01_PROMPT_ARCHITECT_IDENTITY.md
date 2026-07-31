# Canonical Prompt Architect identity

The admitted `cyborgclaw-prompt-architect` was recovered from persistent-host
source, Git custody, and mission evidence rather than selected by directory
preference.

## Canonical identity

- Review surface version: `2.1.1`
- Execution contract: `cyborgclaw.prompt-execution-contract.v2`
- Execution contract version: `2.0.0`
- Admission source commit: `02f531aea69a78898aabb4f23f0f2818ca777697`
- Skill subtree: `d6af830db0594ed7abe47074a2c16de1be8d8586`
- `SKILL.md` SHA-256: `d19bb279e09714e5ad38c7ae01917680c902ec5ac24c1842a4d2d31a429abeb2`
- Deterministic manifest hash: `519db46f13d0cfc49a7e7b23436eb6a0316bfabe69c4ea5c06561e0aa3e480ef`
- Admission decision SHA-256: `7c6c8fcc7d0f2e469c645efd59f2207c8365a14d31e84e6e4274371907aa257d`
- Admission ZIP SHA-256: `610d4533fc2aaa7c9b5a3dc416a1e94b65bca2a425d83cbadaee68f02c879616`

The exact commit, skill subtree, and `SKILL.md` hash were rechecked directly.
The admission and qualification packages in
`/home/spryguy/openclaw-workspace/mission-evidence` corroborated version and
contract identity.

## Reproducible custody paths

- Canonical read-only source:
  `/home/spryguy/cyborgclaw-prompt-architect-proof-context-dedup-repair-20260730/worktree/.agents/skills/cyborgclaw-prompt-architect`
- Canonical source repository:
  `/home/spryguy/cyborgclaw-prompt-architect-proof-context-dedup-repair-20260730/worktree`
- Admitted candidate evidence:
  `/home/spryguy/cyborgclaw-prompt-architect-proof-context-dedup-repair-20260730/evidence/CYBORGCLAW_PROMPT_ARCHITECT_PROOF_CONTEXT_AND_DEDUP_REPAIR_LOCAL_PROMPT_ARCHITECT_2_1_1_MAINTENANCE_CANDIDATE_READY_FOR_SAGE_ADMISSION_20260730T073949Z.zip`
- Admission handoff:
  `/home/spryguy/.codex/attachments/88e3c615-5476-4e75-8c89-38208752372c/CYBORGCLAW_TIER5_AFTER_REVIEW_2_1_1_ADMISSION_HANDOFF_20260730.zip`
- Admission sidecar: the same basename with `.sha256`
- Admission decision inside that handoff:
  `SAGE_ADMISSION_AND_OPENCLAW_CUSTODY_RECONCILIATION_DECISION_20260730.md`
- Candidate evidence manifest:
  `CYBORGCLAW_PROMPT_ARCHITECT_PROOF_CONTEXT_AND_DEDUP_REPAIR_20260730T071208Z/MANIFEST.json`
  inside the admitted candidate ZIP and at the matching evidence-directory
  path
- Candidate test receipt:
  `CYBORGCLAW_PROMPT_ARCHITECT_PROOF_CONTEXT_AND_DEDUP_REPAIR_20260730T071208Z/tests/complete-prompt-architect-suite.tap`

The admission handoff sidecar verified successfully. Its archive digest is
`610d4533fc2aaa7c9b5a3dc416a1e94b65bca2a425d83cbadaee68f02c879616`;
the decision extracted to stdout hashes to
`7c6c8fcc7d0f2e469c645efd59f2207c8365a14d31e84e6e4274371907aa257d`.
The decision expressly admits commit
`02f531aea69a78898aabb4f23f0f2818ca777697`, review surface 2.1.1, and
execution contract v2/2.0.0.

## Candidate reconciliation

| Candidate                          | Result        | Reason                                                                                          |
| ---------------------------------- | ------------- | ----------------------------------------------------------------------------------------------- |
| User-scoped installed skill        | Not present   | `$HOME/.agents/skills/cyborgclaw-prompt-architect` did not exist.                               |
| Current GroupThink worktree        | Not present   | No local Prompt Architect candidate was selected by checkout proximity.                         |
| Persistent repair worktree commit  | Canonical     | Exact commit/tree/SKILL identity named by the verified Sage admission decision.                 |
| Earlier evidence and HOLD archives | Rejected      | Historical inputs, superseded repairs, or HOLDs; none supersedes the final admission.           |
| Later amendment-HOLD candidate     | Not governing | The admission decision says its red-first claim was not reproduced and authorizes no PA change. |

Read-only discovery used `rg --files`, content-address searches for the
admitted commit and hashes, `git rev-parse`, `sha256sum`, `unzip -l`, and
`unzip -p`. It covered the user skills directory, current repository, other
repositories/worktrees beneath `/home/spryguy`, governed mission evidence,
Codex attachments, archives and sidecars, and available Git custody. No
candidate was selected merely because of its directory.

## Use in this mission

Prompt Architect was read-only. Its contract shaped:

- the explicit authority and claim ceilings;
- frozen inputs and exact contract hashes;
- deterministic machine/human outputs;
- proof-gated validation and malformed-input handling;
- final independent review against the immutable candidate;
- evidence and handoff custody.

No Prompt Architect source, evidence, admission artifact, or installed copy was
modified.
