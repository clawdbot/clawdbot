# Invalidated calendar and authority-file review cycle

This cycle is retained as repair evidence and is not counted toward final
acceptance because two material findings changed the candidate source.

## Review custody

- Source digest:
  `c3fb89a3b6ac6ac455d207bc3c5ea9e97193908f321d33d8af932a67f0e6152a`
- Epistemic reviewer: `/root/final_epistemic_v3`
- Authority reviewer: `/root/final_authority_v3`
- Practicality reviewer: `/root/final_practicality_v3`
- Each context: `fork_turns=none`, model `gpt-5.6-sol`, reasoning `ultra`
- Peer blindness: no reviewer read the review directory or a peer conclusion
- Epistemic verdict: `REQUEST_CHANGES`
- Authority verdict: `REQUEST_CHANGES`
- Practicality verdict: `ACCEPTED`

Either material objection independently controlled. The practicality acceptance
could not outvote either reproducible defect.

## A15: impossible calendar dates

The standalone Ajv generator implemented `date-time` as a shape-only regular
expression. It accepted `2026-02-31T00:01:00.000Z` in session, findings, and
decision-record schemas while the engine rejected the same values.

Repair:

- standalone validation now enforces Gregorian month lengths and century-aware
  leap-year rules;
- impossible dates are rejected by all three schemas and engine validators;
- valid leap-day session, findings, and decision-record artifacts are accepted;
- the combined focused suites pass 75/75 and the complete suite passes 161/161.

## A16: repository-governance file laundering

A fully canonical, exact-digest `APPLY_LOCAL_TEST_REPAIR` bundle targeting the
repository root `AGENTS.md` could append authority-widening instructions and
produce:

```json
{
  "terminal_decision": "REWORK_AND_CONTINUE",
  "autonomous_continuation_allowed": true,
  "authority_status": "WITHIN_DELEGATION"
}
```

Repair:

- recognized governance instruction basenames are protected
  case-insensitively at every directory depth;
- protocol and charter explicitly reserve those paths;
- exact-digest probes for root, nested, case-varied, and recognized-equivalent
  files now return `ESCALATE_TO_GLEN` with autonomous continuation false;
- the combined focused suites pass 75/75 and the complete suite passes 161/161.

## New freeze

Repaired source digest:
`3c788a417c3b00586760845d60f5859599c85acc9673bc8775b0ea97a80c05aa`.

The finding owners must independently recheck their repairs, after which every
countable final reviewer is restarted on the new digest.
