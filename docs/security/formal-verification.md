---
summary: Machine-checked security models for OpenClaw's highest-risk paths.
title: Formal verification (security models)
read_when:
  - Reviewing formal security model guarantees or limits
  - Reproducing or updating TLA+/TLC security model checks
permalink: /security/formal-verification/
---

OpenClaw's formal security models (TLA+/TLC today) give a machine-checked argument that specific highest-risk paths — authorization, session isolation, tool gating, and misconfiguration safety — enforce their intended policy, under explicit stated assumptions.

> Note: some older links may refer to the previous project name.

## What this is

An executable, attacker-driven security regression suite:

- Each claim has a runnable model-check over a finite state space.
- Many claims have a paired negative model that produces a counterexample trace for a realistic bug class.

This is **not** a proof that OpenClaw is secure in all respects, and it does not verify the full TypeScript implementation.

## Where the models live

Models are maintained in a separate repo: [vignesh07/openclaw-formal-models](https://github.com/vignesh07/openclaw-formal-models).

<Note>
That repository is currently unreachable (GitHub returns "Repository not found" as of this writing). If it is still broken for you, ask in the OpenClaw maintainer channels for the current location before assuming the models were removed.
</Note>

## Caveats

- These are models, not the full TypeScript implementation — drift between model and code is possible.
- Results are bounded by the state space TLC explores. Green does not imply security beyond the modeled assumptions and bounds.
- Some claims rely on explicit environment assumptions (for example, correct deployment and correct configuration inputs).

## Reproducing results

Clone the models repo and run TLC:

```bash
git clone https://github.com/vignesh07/openclaw-formal-models
cd openclaw-formal-models

# Java 11+ required (TLC runs on the JVM).
# The repo vendors a pinned tla2tools.jar and provides bin/tlc plus Make targets.

make <target>
```

There is no CI integration back into this repo yet; a future iteration could add CI-run models with public artifacts (counterexample traces, run logs) or a hosted "run this model" workflow for small bounded checks.

## Claims and targets

### Gateway exposure and open gateway misconfiguration

**Claim:** binding beyond loopback without auth can make remote compromise possible and increases exposure; a token/password blocks unauthenticated attackers, per the model's assumptions.

| Result         | Targets                                                          |
| -------------- | ---------------------------------------------------------------- |
| Green          | `make gateway-exposure-v2`, `make gateway-exposure-v2-protected` |
| Red (expected) | `make gateway-exposure-v2-negative`                              |

See also `docs/gateway-exposure-matrix.md` in the models repo.

### Node exec pipeline (highest-risk capability)

**Claim:** `exec host=node` requires (a) a node command allowlist plus declared commands and (b) live approval when configured; approvals are tokenized to prevent replay, in the model.

| Result         | Targets                                                         |
| -------------- | --------------------------------------------------------------- |
| Green          | `make nodes-pipeline`, `make approvals-token`                   |
| Red (expected) | `make nodes-pipeline-negative`, `make approvals-token-negative` |

### Pairing store (DM gating)

**Claim:** pairing requests respect TTL and pending-request caps.

| Result         | Targets                                              |
| -------------- | ---------------------------------------------------- |
| Green          | `make pairing`, `make pairing-cap`                   |
| Red (expected) | `make pairing-negative`, `make pairing-cap-negative` |

### Ingress gating (mentions and control-command bypass)

**Claim:** in group contexts requiring mention, an unauthorized control command cannot bypass mention gating.

| Result         | Targets                        |
| -------------- | ------------------------------ |
| Green          | `make ingress-gating`          |
| Red (expected) | `make ingress-gating-negative` |

### Routing and session-key isolation

**Claim:** DMs from distinct peers do not collapse into the same session unless explicitly linked or configured.

| Result         | Targets                           |
| -------------- | --------------------------------- |
| Green          | `make routing-isolation`          |
| Red (expected) | `make routing-isolation-negative` |

## v1++ models: concurrency, retries, trace correctness

Follow-on models that tighten fidelity around real-world failure modes: non-atomic updates, retries, and message fan-out.

### Pairing store concurrency and idempotency

**Claim:** the pairing store enforces `MaxPending` and idempotency even under interleavings — check-then-write must be atomic/locked, and refresh must not create duplicates. Concretely: concurrent requests cannot exceed `MaxPending` for a channel, and repeated requests/refreshes for the same `(channel, sender)` do not create duplicate live pending rows.

| Result         | Targets                                                                                                                                                                     |
| -------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Green          | `make pairing-race` (atomic/locked cap check), `make pairing-idempotency`, `make pairing-refresh`, `make pairing-refresh-race`                                              |
| Red (expected) | `make pairing-race-negative` (non-atomic begin/commit cap race), `make pairing-idempotency-negative`, `make pairing-refresh-negative`, `make pairing-refresh-race-negative` |

### Ingress trace correlation and idempotency

**Claim:** ingestion preserves trace correlation across fan-out and is idempotent under provider retries. When one external event becomes multiple internal messages, every part keeps the same trace/event identity; retries do not double-process; if provider event IDs are missing, dedupe falls back to a safe key (for example trace ID) to avoid dropping distinct events.

| Result         | Targets                                                                                                                                     |
| -------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| Green          | `make ingress-trace`, `make ingress-trace2`, `make ingress-idempotency`, `make ingress-dedupe-fallback`                                     |
| Red (expected) | `make ingress-trace-negative`, `make ingress-trace2-negative`, `make ingress-idempotency-negative`, `make ingress-dedupe-fallback-negative` |

### Routing dmScope precedence and identityLinks

**Claim:** `dmScope` precedence and identity links behave deterministically: the default `main` scope shares one rolling session across a single owner's DMs (the personal-agent default), while any configured isolating scope (`per-peer`, `per-channel-peer`, `per-account-channel-peer`) keeps DM sessions strictly separated. Channel-specific `dmScope` overrides win over global defaults; `identityLinks` collapse sessions only within explicit linked groups, not across unrelated peers. Multi-user inboxes are expected to opt into an isolating scope (the runtime security audit recommends this when it detects multi-user DM traffic).

| Result         | Targets                                                                   |
| -------------- | ------------------------------------------------------------------------- |
| Green          | `make routing-precedence`, `make routing-identitylinks`                   |
| Red (expected) | `make routing-precedence-negative`, `make routing-identitylinks-negative` |

## Related

- [Threat model](/security/THREAT-MODEL-ATLAS)
- [Contributing to the threat model](/security/CONTRIBUTING-THREAT-MODEL)
- [Incident response](/security/incident-response)
