---
summary: "Provider override, browser, OAuth TLS, and route repairs (checks 2b-2g)"
title: "Provider and route repairs"
read_when:
  - Doctor warns about a provider override, Codex route, or Chrome MCP readiness
  - You are changing provider or route migration behavior
---

Checks 2b-2g cover provider overrides, browser and Chrome MCP readiness,
OAuth TLS prerequisites, and route cleanup.

## Checks 2b-2g

<AccordionGroup>
  <Accordion title="2b. OpenCode provider overrides">
    If you have added `models.providers.opencode`, `opencode-zen`, or `opencode-go` manually while the matching official external plugin is installed and enabled, it overrides that plugin-provided catalog. That can force models onto the wrong API or zero out costs. Doctor warns so you can remove the override and restore per-model API routing + costs. Without the matching plugin, the entry remains a valid standalone custom provider.
  </Accordion>
  <Accordion title="2c. Browser migration and Chrome MCP readiness">
    If an extension-driver profile still carries a retired relay `cdpUrl`, doctor removes that URL while preserving `driver: "extension"`; the current extension relay owns its endpoint. Doctor also removes the retired `browser.relayBindHost` setting.

    Doctor warns while `browser.extensionRelay.allowLegacyAuth` is enabled. Upgrade paired Chrome extensions and external CDP clients to Browser Relay Authentication v2, then set the flag to `false`. V2 clients do not downgrade to legacy authentication.

    Doctor does not inspect personal browser profiles for optional extension
    readiness or cookie-import availability. It reports the importable cookie
    database count as unavailable, not zero. When a stable Chrome extension copy
    exists, Doctor reports its native-bootstrap status as not inspected;
    `openclaw doctor --fix` skips native-host registration repair.

    On the machine hosting Chrome, run `openclaw browser extension status --json`
    to inspect registration explicitly; this may request browser-profile access.
    If an upgrade leaves stale native-host targets, run
    `openclaw browser extension install --no-store` to repair through the explicit
    installer without requesting Store installation. The installer refuses to
    overwrite a foreign same-name manifest or launcher. Status distinguishes a
    requested installation, Chrome approval, and native-host registration health;
    it does not prove a live relay connection.

    For initial setup, run `openclaw browser extension install`. On macOS, this
    also requests the official Store installation in Google Chrome; reopen Chrome
    and approve or enable OpenClaw when prompted. Other browsers and platforms
    need a manual Store install. The unpacked stable path remains a development
    fallback with `openclaw browser extension install --no-store`. Explicit cookie
    import still requires its separate consent.

    Doctor also audits the host-local Chrome MCP path when you use `defaultProfile: "user"` or a configured `existing-session` profile:

    - checks whether Google Chrome is installed on the same host for default auto-connect profiles
    - checks the detected Chrome version and warns when it is below Chrome 144
    - reminds you to enable remote debugging in the browser inspect page (for example `chrome://inspect/#remote-debugging`, `brave://inspect/#remote-debugging`, or `edge://inspect/#remote-debugging`)

    Doctor cannot enable the Chrome-side setting for you. Host-local Chrome MCP still requires a Chromium-based browser 144+ on the gateway/node host, running locally, with remote debugging enabled and the first attach consent prompt approved in the browser.

    Readiness here only covers local attach prerequisites. Existing-session keeps the current Chrome MCP route limits; advanced routes like `responsebody`, PDF export, download interception, and batch actions still require a managed browser or raw CDP profile. This check does not apply to Docker, sandbox, remote-browser, or other headless flows, which continue to use raw CDP.

  </Accordion>
  <Accordion title="2d. OAuth TLS prerequisites">
    When an OpenAI Codex OAuth profile is configured, doctor probes the OpenAI authorization endpoint to verify that the local Node/OpenSSL TLS stack can validate the certificate chain. If the probe fails with a certificate error (for example `UNABLE_TO_GET_ISSUER_CERT_LOCALLY`, expired cert, or self-signed cert), doctor prints platform-specific fix guidance. On macOS with a Homebrew Node, the fix is usually `brew postinstall ca-certificates`. With `--deep`, the probe runs even if the gateway is healthy.
  </Accordion>
  <Accordion title="2e. Codex OAuth provider overrides">
    If you previously added legacy OpenAI transport settings under `models.providers.openai-codex`, they can shadow the built-in Codex OAuth provider path. Doctor warns when it sees those old transport settings alongside Codex OAuth so you can remove or rewrite the stale transport override and restore current routing behavior. Custom proxies and header-only overrides remain supported and do not trigger this warning, but those authored request routes are not eligible for implicit Codex selection.
  </Accordion>
  <Accordion title="2f. Codex route repair">
    Doctor checks for legacy `openai-codex/*` model refs. Native Codex harness routing uses canonical `openai/*` model refs, but the prefix alone never selects Codex. With runtime policy unset or `auto`, only an exact official HTTPS Platform Responses or ChatGPT Responses route with no authored request override is eligible. See [OpenAI implicit agent runtime](/providers/openai#implicit-agent-runtime).

    In `--fix` / `--repair` mode, doctor rewrites affected default-agent and per-agent refs, including primary models, fallbacks, image/video generation models, heartbeat/subagent/compaction overrides, hooks, channel model overrides, and stale persisted session route state:

    - `openai-codex/gpt-*` becomes `openai/gpt-*`.
    - Codex intent moves to provider/model-scoped `agentRuntime.id: "codex"` entries for repaired agent model refs.
    - Stale whole-agent runtime config and persisted session runtime pins are removed because runtime selection is provider/model-scoped.
    - Existing provider/model runtime policy is preserved unless the repaired legacy model ref needs Codex routing to keep the old auth path.
    - Existing model fallback lists are preserved with their legacy entries rewritten; copied per-model settings move from the legacy key to the canonical `openai/*` key.
    - Persisted session `modelProvider`/`providerOverride`, `model`/`modelOverride`, fallback notices, and auth-profile pins are repaired across all discovered agent session stores.
    - Doctor separately repairs stale `agentRuntime.id: "codex-cli"` pins (a distinct legacy runtime id) to `"codex"` across `agents.defaults`, `agents.entries.*`, and `models.providers.*` model entries.
    - `/codex ...` means "control or bind a native Codex conversation from chat."
    - `/acp ...` or `runtime: "acp"` means "use the external ACP/acpx adapter."

  </Accordion>
  <Accordion title="2g. Session route cleanup">
    Doctor also scans discovered agent session stores for stale auto-created route state after you move configured models or runtime away from a plugin-owned route such as Codex.

    `openclaw doctor --fix` can clear auto-created stale state such as `modelOverrideSource: "auto"` model pins, runtime model metadata, pinned harness ids, CLI session bindings, and auto auth-profile overrides when their owning route is no longer configured. Explicit user or legacy session model choices are reported for manual review and left untouched; switch them with `/model ...`, `/new`, or reset the session when that route is no longer intended.

  </Accordion>
</AccordionGroup>
