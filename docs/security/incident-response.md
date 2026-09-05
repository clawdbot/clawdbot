---
summary: "How OpenClaw triages, responds to, and follows up on security incidents"
title: "Incident response"
read_when:
  - Responding to a security report or suspected security incident
  - Preparing a coordinated disclosure or patched security release
  - Reviewing post-incident follow-up expectations
---

## 1. Detection and triage

Security signals come from:

- GitHub Security Advisories (GHSA) and private vulnerability reports.
- Public GitHub issues/discussions when reports are not sensitive.
- Automated signals: Dependabot, CodeQL, npm advisories, secret scanning.

Initial triage:

1. Confirm affected component, version, and trust boundary impact.
2. Classify as a security issue vs. hardening/no-action, using `SECURITY.md`'s scope and out-of-scope rules.
3. An incident owner responds accordingly.

## 2. Severity

| Severity | Definition                                                                                                                                                                            |
| -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Critical | Package/release/repository compromise, active exploitation, or unauthenticated trust-boundary bypass with high-impact control or data exposure.                                       |
| High     | Verified trust-boundary bypass requiring limited preconditions (for example, authenticated but unauthorized high-impact action), or exposure of OpenClaw-owned sensitive credentials. |
| Medium   | Significant security weakness with practical impact but constrained exploitability or substantial prerequisites.                                                                      |
| Low      | Defense-in-depth findings, narrowly scoped denial-of-service, or hardening/parity gaps without a demonstrated trust-boundary bypass.                                                  |

## 3. Response

1. Acknowledge receipt to the reporter (privately when sensitive).
2. Reproduce on supported releases and latest `main`, then implement and validate a patch with regression coverage.
3. Critical/high: prepare patched release(s) as fast as practical.
4. Medium/low: patch in the normal release flow and document mitigation guidance.

## 4. Communication and disclosure

Communicate through GitHub Security Advisories in the affected repository, release notes/changelog entries for fixed versions, and direct reporter follow-up on status and resolution.

Critical/high incidents get coordinated disclosure, with CVE issuance when appropriate. Low-risk hardening findings may be documented in release notes or advisories without a CVE, depending on impact and user exposure.

## 5. Recovery and follow-up

After shipping the fix:

1. Verify remediations in CI and release artifacts.
2. Run a short post-incident review: timeline, root cause, detection gap, prevention plan.
3. Add follow-up hardening/tests/docs tasks and track them to completion.

## Related

- [Security policy](https://github.com/openclaw/openclaw/blob/main/SECURITY.md) — report scope and trust model.
- [Threat model](/security/THREAT-MODEL-ATLAS)
