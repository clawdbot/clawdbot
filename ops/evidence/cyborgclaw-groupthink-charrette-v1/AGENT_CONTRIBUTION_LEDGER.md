# Agent contribution ledger

## Ownership model

- Decision owner: Glen
- Mission execution and integration owner: `/root`
- Proof owners: named independent reviewers and validation receipts
- Synthesis owner: `/root/sage_final_synthesis_v1`
- Final architecture-acceptance owner:
  `/root/prompt_architect_final_acceptance_v1`
- Global-discovery proof owner: `/root/fresh_global_discovery_v1`

No agent acquired merge, production, release, credential, or external-message
authority through participation.

## Contributions

| Agent or role                                                     | Contribution                                                                                           | Decision authority |
| ----------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ | ------------------ |
| `/root`                                                           | Reconnaissance, artifact custody, architecture, implementation, tests, repairs, install, Git, evidence | None beyond prompt |
| `/root/authority_redteam_v2/final_epistemic_reviewer`             | Found the A13 freeze/commit chronology defect                                                          | Review only        |
| `/root/authority_redteam_v2/final_authority_reviewer`             | Blind authority review in the invalidated A13 cycle                                                    | Review only        |
| `/root/final_epistemic_v2`                                        | Clean epistemic review on the then-frozen candidate                                                    | Review only        |
| `/root/final_authority_v2`                                        | Clean authority review on the then-frozen candidate                                                    | Review only        |
| `/root/final_practicality_v2`                                     | Found the A14 Unicode code-point disagreement                                                          | Review only        |
| `/root/final_epistemic_v3`                                        | Clean epistemic review in the invalidated A15/A16 cycle                                                | Review only        |
| `/root/final_authority_v3`                                        | Found the A16 governance-file repair escape                                                            | Review only        |
| `/root/final_practicality_v3`                                     | Found the A15 Gregorian schema disagreement                                                            | Review only        |
| `/root/final_epistemic_v4`                                        | Final blind epistemic acceptance bound to the governing digest                                         | Review only        |
| `/root/final_authority_v4`                                        | Final blind authority/security acceptance bound to the governing digest                                | Review only        |
| `/root/final_practicality_v4`                                     | Final blind practicality/installation acceptance bound to the governing digest                         | Review only        |
| `/root/sage_final_synthesis_v1`                                   | Synthesized only the three final reports, preserving limitations and dissent                           | Synthesis only     |
| `/root/prompt_architect_final_acceptance_v1`                      | Fresh final contract and Prompt Architect acceptance                                                   | Acceptance only    |
| `/root/prompt_architect_final_acceptance_v1/digest_custody_check` | Independently reproduced candidate and Prompt Architect custody hashes                                 | Proof only         |
| `/root/fresh_global_discovery_v1`                                 | Proved installed-only discovery, validation, bounded fixture behavior, and no side effects             | Proof only         |

## Builder and reviewer separation

The final three reviewers used `fork_turns=none`, did not receive peer
conclusions, independently inventoried the frozen candidate, and were not the
builder. Sage judged only after all three reports were immutable. The final
Prompt Architect context independently re-established identity and custody.
The fresh discovery context operated outside the source repository and selected
the global installation only.

Invalidated reports remain in the package as evidence of repair pressure, but
they do not count toward final acceptance.

## Contribution claim boundary

Agent work supplies implementation and evidence, not governance authority.
Graph parentage, model identity, reviewer agreement, and the number of agents
cannot authorize execution. Glen remains the decision owner, and a later merge
or operational action requires fresh, separate authority.
