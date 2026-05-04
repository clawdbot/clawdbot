---
summary: "How OpenClaw triages, responds to, and follows up on security incidents"
title: "Incident response"
read_when:
  - Responding to a security report or suspected security incident
  - Preparing a coordinated disclosure or patched security release
  - Reviewing post-incident follow-up expectations
---

# Incident Response

## 1. Detection and triage

We monitor security signals from:

- GitHub Security Advisories (GHSA) and private vulnerability reports.
- Public GitHub issues/discussions when reports are not sensitive.
- Automated signals (for example Dependabot, CodeQL, npm advisories, and secret scanning).

Initial triage:

1. Confirm affected component, version, and trust boundary impact.
2. Classify as security issue vs hardening/no-action using the repository `SECURITY.md` scope and out-of-scope rules.
3. An incident owner responds accordingly.

## 2. Assessment

Severity guide:

- **Critical:** Package/release/repository compromise, active exploitation, or unauthenticated trust-boundary bypass with high-impact control or data exposure.
- **High:** Verified trust-boundary bypass requiring limited preconditions (for example authenticated but unauthorized high-impact action), or exposure of OpenClaw-owned sensitive credentials.
- **Medium:** Significant security weakness with practical impact but constrained exploitability or substantial prerequisites.
- **Low:** Defense-in-depth findings, narrowly scoped denial-of-service, or hardening/parity gaps without a demonstrated trust-boundary bypass.

## 3. Response

1. Acknowledge receipt to the reporter (private when sensitive).
2. Reproduce on supported releases and latest `main`, then implement and validate a patch with regression coverage.
3. For critical/high incidents, prepare patched release(s) as fast as practical.
4. For medium/low incidents, patch in normal release flow and document mitigation guidance.

## 4. Communication

We communicate through:

- GitHub Security Advisories in the affected repository.
- Release notes/changelog entries for fixed versions.
- Direct reporter follow-up on status and resolution.

Disclosure policy:

- Critical/high incidents should receive coordinated disclosure, with CVE issuance when appropriate.
- Low-risk hardening findings may be documented in release notes or advisories without CVE, depending on impact and user exposure.

## 5. Recovery and follow-up

After shipping the fix:

1. Verify remediations in CI and release artifacts.
2. Run a short post-incident review (timeline, root cause, detection gap, prevention plan).
3. Add follow-up hardening/tests/docs tasks and track them to completion.
