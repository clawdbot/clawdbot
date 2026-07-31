# Clean-context practicality review

> **INVALIDATED BY SOURCE CHANGE — NOT COUNTABLE.** This report is retained
> because its material objection caused the current repair. The reviewed digest
> was superseded by
> `c3fb89a3b6ac6ac455d207bc3c5ea9e97193908f321d33d8af932a67f0e6152a`.

- Reviewer task: `/root/final_practicality_v2`
- Model: `gpt-5.6-sol`
- Reasoning effort: `ultra`
- Context: `fork_turns=none`
- Reviewed source digest:
  `53c387c9197a5372e12b5df1e8f36913e9d5daa02a2f468d5a0f7b9e06e3dfb5`
- Peer conclusions seen before verdict: none

## Evidence examined

- Mission prompt and matching source provenance.
- Canonical Prompt Architect commit, tree, `SKILL.md` hash, and execution
  contract.
- Candidate charter, protocol, constants, schemas, fixtures, examples,
  renderer, CLI, strict JSON handling, installer, installation guide,
  provenance, and relevant tests.
- Independently reproduced 49-entry logical-tree digest for the reviewed
  source.
- Source validation, 158/158 tests, 39-file checksums, and an isolated
  install/validate/repeat-install rehearsal.

## Material finding

The engine accepted records that violated its declared Draft 2020-12 schema.
Both `analysis_summary` runtime checks used JavaScript UTF-16 code-unit length,
while the findings and decision-record schemas required 80 Unicode code
points. Forty astral characters therefore passed the engine but failed both
schemas.

Observed:

```text
js_length: 80
unicode_code_points: 40
engine_accepted: true
findings_schema_valid: false
record_schema_valid: false
```

The reviewer required code-point length at both runtime sites and an astral
regression. That repair is documented in
`00B_INVALIDATED_UNICODE_REVIEW_CYCLE.md` and was independently rechecked on the
current digest.

## Retained nonblockers

- Valid authoring remains high-ceremony without a scaffolding command.
- Execution and nonce consumption intentionally belong to a separate enforcing
  runtime.
- Static installer tests cannot prove actual fresh-context discovery.
- The documented installer update gap and logical-tree identity limitations
  remain.

## Terminal verdict

`REQUEST_CHANGES`
