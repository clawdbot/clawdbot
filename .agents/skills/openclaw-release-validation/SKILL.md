---
name: openclaw-release-validation
description: "Guide human release testing on an isolated OCM copy or approved in-place gateway, collect feedback, or refresh the release campaign."
user-invocable: true
disable-model-invocation: true
---

# OpenClaw Release Validation

Help a human test an immutable latest-main build against a selected real
Gateway's state. Automate preparation, triage, and reporting; the human drives
interactive surfaces and judges quality. This skill collects feedback, not a
release go/no-go decision.

## Choose the mode

- **Campaign artifact:** only when `RELEASE_VALIDATION_ARTIFACT_PATH` is present. Read [artifact generation](references/campaign-artifact.md), write that artifact, and stop. GitHub is read-only; no skill-update request or interactive setup.
- **Update campaign:** for an explicit refresh request, read [installed skill check](references/skill-update.md), then [campaign lookup/dispatch](references/campaign.md). Dispatch the isolated runner for the selected explicit tag, verify its issue, and stop. Never analyze or edit the canonical issue yourself.
- **Validate release:** default human-testing workflow below. It joins the campaign; it never creates or rewrites the issue body directly.

## Human validation

1. Read [installed skill check](references/skill-update.md). Introduce the run briefly: choose a Gateway, protect it with a disposable OCM copy or approve an in-place update, prepare the pinned main build, then test and review feedback.
2. Read [campaign lookup/dispatch](references/campaign.md). Require a current campaign and record its stable train and current beta. Gateway preparation pins the main test target separately.
3. Read [Gateway preparation](references/gateway-preparation.md). Discover without mutation, let the tester choose source and mode, then prepare the selected target. Never use the caller's active checkout.
4. Only after readiness succeeds, offer [local diagnostics](references/local-diagnostics.md) for an isolated target, then read [human testing](references/human-testing.md) to create the worksheet and guide one chosen surface at a time.
5. On `finish validation`, read [cleanup and report approval](references/report-closeout.md). It handles blocked upgrades too. Review the complete batch before any post and preserve the exact structured-report contract.

Before readiness is terminal, show only campaign/beta identity, source/mode
choice, and upgrade progress or errors. Do not expose testing instructions or
create a worksheet for a Gateway that never became ready.

## Boundaries

An isolated OCM copy must prove all candidate-writable paths remain contained.
Do not bypass a failed containment check with manual copying. Copied channel
credentials require explicit authorization to stop their current owner and a
restoration plan. In-place mode changes real state: present verified
backup/snapshot and dry-run evidence before obtaining update approval. Rollback
requires separate approval because newer migrations can make code-only
reversion unsafe.

Keep one worksheet for a ready candidate; only tester-authored results count
as tested. A blocked candidate uses its final upgrade-report draft instead.
For setup, OCM, backup, build or cleanup failures, use the private
[tooling-feedback packet](references/tooling-feedback.md); do not turn these
into candidate findings. With no candidate evaluation, clean up and report that
fact without producing a candidate vote or posting batch.

Diagnostics are opt-in, disposable-target-only, loopback-only and content-off.
Public feedback excludes raw logs, telemetry, paths, Gateway names, identifiers,
credentials and setup/cleanup details. Apply the report's narrow environment
allowlist and sanitization before showing the complete draft. `finish
validation` does not authorize posts; existing explicit batch approval does.
The Discord summary is a copy-ready handoff, never an automatic send.
