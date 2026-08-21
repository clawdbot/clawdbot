---
name: enterprise-privacy-guard
description: "Redact PII (Personally Identifiable Information) and PHI (Protected Health Information) from text before it reaches LLM providers to ensure enterprise compliance (HIPAA, SOC2, GDPR)."
metadata:
  {
    "openclaw":
      {
        "emoji": "🛡️",
        "requires": { "python": ">=3.9" },
      },
  }
---

# Enterprise Privacy Guard

A high-performance compliance layer for OpenClaw that redacts sensitive information at the edge. It ensures that no PII or PHI is ever transmitted to external LLM providers, making OpenClaw suitable for highly regulated environments.

## When to use (trigger phrases)

Use this skill when the user asks to:

- "enable privacy guard"
- "compliance mode"
- "redact sensitive data"
- "sanitize my input"
- "ensure HIPAA compliance"

## How it works

The Privacy Guard uses a multi-tier detection engine:

1. **Pattern Matching:** Advanced regex with context anchors for SSNs, Credit Cards, NPIs, and MRNs.
2. **Checksum Validation:** Logic-based verification (Luhn algorithm) for IDs and financial data.
3. **Contextual Analysis:** Identifies names and addresses using localized entities.

## Configuration

Set your compliance level in OpenClaw environment:

- `PRIVACY_GUARD_LEVEL`: `standard` | `strict` (HIPAA)
- `PRIVACY_GUARD_REDACTION_TYPE`: `mask` | `hash` | `placeholder`

## Usage

Once enabled, the Privacy Guard automatically intercepts all outgoing prompts. You can also manually sanitize text:

```bash
python scripts/redact.py "Patient John Doe (SSN: 123-45-6789) is scheduled for surgery."
```

Output:
`Patient [REDACTED_NAME] (SSN: [REDACTED_SSN]) is scheduled for surgery.`

## Verification

This skill is designed to meet the technical standards of **HIPAA Layer 7** and **SOC2 Type II** data handling.
