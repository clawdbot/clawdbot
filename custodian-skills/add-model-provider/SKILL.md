---
name: add-model-provider
description: Add and live-prove a model provider without exposing credentials or breaking the active route.
---

# Add a model provider

Never print or persist secret values; credentials belong in SecretRefs or agent-scoped credential stores. Never hand-edit config files on disk. Every run ends with the observable Prove result or an exact explanation of why it could not be proven.

Use [Model providers](https://docs.openclaw.ai/providers/models), the provider page, and [OpenAI](https://docs.openclaw.ai/providers/openai) for the worked example.

## Gather

Read the current agent, default model, catalog, and redacted auth-profile status with `gateway` `config.get` plus the `openclaw` tool's model/status inspection. Decide which auth contract applies:

- API-key auth uses an agent-scoped `openai` API-key profile populated by the credential flow.
- ChatGPT/Codex subscription auth uses OpenAI OAuth and remains distinct from Platform API billing.

Never substitute one path for the other.

## Mutate

Provider credentials and catalogs cannot be changed with raw `config_set`. Use `openclaw onboard` and select the documented provider/auth choice; for OpenAI API-key setup use the masked credential-store flow, while subscription setup uses the documented OAuth login. Resume only after onboarding reports a passing candidate. If the user asks to change the default, have Custodian call the `openclaw` action `set_default_model` with the exact `provider/model` and optional `agentId`; it live-tests before saving. Do not mutate `auth.*`, `models.*`, or credential files directly.

## Repair

Run `openclaw doctor`. Apply `openclaw doctor --fix` only outside the active Custodian inference session and only after approval, then re-check auth profiles and the model catalog.

## Prove

Run one live inference through the Gateway using the newly configured provider and exact target agent. Record the resolved public model id and elapsed latency, not prompt content or credentials. A catalog listing or auth check alone is not proof. If the probe fails, keep the previous default and report the exact redacted failure.

## Report

State the provider, API-key or subscription/OAuth path, agent scope, whether the default changed, the live-proven model id and latency, and any next action.
