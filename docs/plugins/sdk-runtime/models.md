---
summary: "Host-owned completions, model-selection policy, and provider auth resolution"
read_when:
  - You need a host-owned text completion without importing provider internals
  - You are resolving a model reference against an agent allowlist
  - You are resolving provider credentials or auth profiles
title: "Plugin runtime model helpers"
sidebarTitle: "Model helpers"
---

Call a model, resolve model-selection policy, and resolve provider auth without importing host internals. Part of the [Plugin runtime helpers](/plugins/sdk-runtime) reference.

## Model namespaces

<AccordionGroup>
  <Accordion title="api.runtime.llm">
    Run a host-owned text completion without importing provider internals or
    duplicating OpenClaw model/auth/base URL preparation.

    ```typescript
    const result = await api.runtime.llm.complete({
      messages: [{ role: "user", content: "Summarize this transcript." }],
      purpose: "my-plugin.summary",
      maxTokens: 512,
      temperature: 0.2,
      reasoning: "high",
    });
    ```

    `maxTokens` and `temperature` are advisory sampling hints. The selected
    provider, CLI, or harness applies them when its transport exposes an
    equivalent control and otherwise may ignore them. They do not weaken the
    execution mode's isolation guarantees.

    To require the configured agent runtime and a literal zero-tool model
    surface, select isolated execution explicitly:

    ```typescript
    const result = await api.runtime.llm.complete({
      messages: [{ role: "user", content: "Return one JSON value." }],
      systemPrompt: "You are a JSON-only function.",
      model: "openai/gpt-5.6-sol",
      execution: {
        mode: "isolated-agent-runtime",
        authProfileId: "openai:work",
        timeoutMs: 30_000,
      },
    });
    ```

    This mode accepts exactly one user message. Core derives the configured CLI
    or harness owner, starts a fresh context, exposes no model-callable tools,
    and never falls back to direct provider transport. Unsupported runtimes fail
    before inference. `result.execution.owner` reports the selected owner;
    token usage remains absent when a CLI cannot report it.

    Completion failures expose a stable `code` on the thrown error. Isolated
    callers can distinguish authorization, invalid isolated input, unsupported
    or unavailable runtimes, aborts, timeouts, rejected output, and other
    completion failures without matching message text.

    Provider orchestration can also acquire the configured local-service
    lifecycle before issuing an HTTP request:

    ```typescript
    const lease = await api.runtime.llm.acquireLocalService(
      {
        providerId,
        baseUrl,
        headers,
      },
      signal,
    );
    try {
      // Send and fully consume the provider request.
    } finally {
      await lease?.release();
    }
    ```

    `acquireLocalService(...)` is a stable, generic provider-service SDK
    contract. The host resolves process configuration from
    `models.providers.<providerId>.localService`; callers cannot supply a
    command, arguments, environment, or lifecycle policy. Process spawning,
    readiness, diagnostics, and idle-stop policy remain internal to the host.

    Pass the exact configured provider id and resolved request base URL. Do not
    replace aliases with an adapter id: separate aliases can point at separate
    local GPU hosts. The host rejects endpoints that do not match the configured
    provider base URL, apart from the `/v1` normalization used by Ollama and LM
    Studio adapters. The host owns startup serialization, readiness probes,
    request leases, abort handling, and idle shutdown.

    The helper uses the same simple-completion preparation path as OpenClaw's
    built-in runtime and the host-owned runtime config snapshot. Context engines
    receive a session-bound `llm.complete` capability, so model calls use the
    active session's agent and do not silently fall back to the default agent. The
    result includes provider/model/agent attribution plus normalized token,
    cache, and estimated cost usage when available.

    Set `reasoning` to request a reasoning effort for the selected model. The
    host normalizes the canonical thinking levels (`off`, `minimal`, `low`,
    `medium`, `high`, `xhigh`, `adaptive`, `max`, and `ultra`) for the selected
    provider and model before dispatching the completion. `adaptive` becomes
    `medium`; `max` and `ultra` become `max` when supported, otherwise `xhigh`.

    <Warning>
    Model overrides require operator opt-in via `plugins.entries.<id>.llm.allowModelOverride: true` in config. `plugins.entries.<id>.llm.allowedModels` restricts those overrides; `plugins.entries.<id>.llm.allowedCompletionModels` separately restricts every completion, including host-resolved defaults. For direct completions, a `model@profile` override remains part of the authorized model override. Isolated `model@profile` overrides and `execution.authProfileId` require `plugins.entries.<id>.llm.allowAuthProfileOverride: true`. Cross-agent completions require `plugins.entries.<id>.llm.allowAgentIdOverride: true`.
    </Warning>

  </Accordion>
  <Accordion title="api.runtime.modelConfig">
    Synchronous model-selection policy, without preparing a model or starting a session.

    `resolveDefaultModelForAgent({ cfg, agentId })` resolves the agent's configured default. `resolveAllowedModelRef({ cfg, catalog, raw, defaultProvider, defaultModel, agentId })` resolves a model name or alias against the supplied catalog and agent allowlist, returning `{ ref, key }` or `{ error }`. It does not select or validate an agent runtime; callers that require a particular harness must apply that separate policy.

    Use these host operations instead of importing model-selection implementation modules into a plugin's registration entry.

  </Accordion>
  <Accordion title="api.runtime.modelAuth">
    Model and provider auth resolution.

    Synchronous profile operations are also available: `resolveProviderIdForAuth`, `ensureAuthProfileStore`, `resolveAuthProfileOrder`, `listProfilesForProvider`, and `isProviderApiKeyConfigured`. They use the canonical host auth policy. Supply the owning agent directory when reading agent profiles, and use `readOnly: true` and `allowKeychainPrompt: false` for non-interactive profile inspection. Profile stores and resolved credentials must not be logged.

    Capability factories should construct descriptors only. Keep credential inspection and resolution in the callbacks that need them, rather than performing them while registering a provider.

    ```typescript
    const auth = await api.runtime.modelAuth.getApiKeyForModel({ model, cfg });

    // Request-ready auth, including provider runtime exchanges (e.g. OAuth refresh)
    const runtimeAuth = await api.runtime.modelAuth.getRuntimeAuthForModel({ model, cfg });

    const providerAuth = await api.runtime.modelAuth.resolveApiKeyForProvider({
      provider: "openai",
      cfg,
    });
    ```

  </Accordion>
</AccordionGroup>
