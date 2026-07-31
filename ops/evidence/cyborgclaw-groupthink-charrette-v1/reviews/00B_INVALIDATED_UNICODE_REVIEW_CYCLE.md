# Invalidated Unicode review cycle

This cycle is retained as repair evidence and is not counted toward final
acceptance because its source digest was superseded after a material finding.

## Review custody

- Source digest:
  `53c387c9197a5372e12b5df1e8f36913e9d5daa02a2f468d5a0f7b9e06e3dfb5`
- Epistemic reviewer: `/root/final_epistemic_v2`
- Authority reviewer: `/root/final_authority_v2`
- Practicality reviewer: `/root/final_practicality_v2`
- Each context: `fork_turns=none`, model `gpt-5.6-sol`, reasoning `ultra`
- Peer blindness: no reviewer read an ops/evidence review or peer conclusion
- Epistemic verdict: `ACCEPTED`
- Authority verdict: `ACCEPTED`
- Practicality verdict: `REQUEST_CHANGES`

The practicality objection controlled. Two acceptances could not outvote a
reproducible machine-contract defect.

## Material objection

The engine checked `analysis_summary` minima with JavaScript UTF-16
`String.length`, while the Draft 2020-12 schemas use Unicode code-point length.
A summary of forty astral characters therefore had JavaScript length 80 and
passed engine validation, but had schema length 40 and failed both the findings
and decision-record schemas.

Pre-repair observation:

```text
js_length: 80
unicode_code_points: 40
engine_accepted: true
findings_schema_valid: false
record_schema_valid: false
```

## Repair and invalidation

- Both runtime `analysis_summary` checks now use Unicode code-point length.
- A schema regression exercises both 40- and 80-code-point astral summaries.
- Post-repair 40-code-point result: engine rejects `INVALID_CONTRACT`; findings
  schema rejects.
- Post-repair 80-code-point result: engine, findings schema, and decision-record
  schema all accept.
- Combined adversarial and schema suites: 73/73 passed.
- Complete suite: 159/159 passed.
- Repaired source digest:
  `c3fb89a3b6ac6ac455d207bc3c5ea9e97193908f321d33d8af932a67f0e6152a`

Every countable final reviewer is restarted on the repaired digest.
