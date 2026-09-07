---
summary: "First-run setup flow for OpenClaw (macOS app)"
read_when:
  - Setting up the macOS app for the first time
  - Choosing between a local and a remote Gateway during macOS setup
  - Connecting an AI provider from the macOS app
title: "Onboarding (macOS app)"
sidebarTitle: "Onboarding: macOS App"
---

The macOS app's first-run flow: pick where the Gateway runs, install any
missing local runtime, and connect a verified AI backend. The app then opens
guided onboarding in the dashboard for optional setup and the handoff to your
agent.
For CLI onboarding and a comparison of both paths, see [Onboarding Overview](/start/onboarding-overview).

<Tip>
Need the app first? [Download OpenClaw for macOS](/platforms/macos#download),
then return here for first-run setup.
</Tip>

<Steps>
<Step title="Approve macOS warning">
The first time you open OpenClaw.app, macOS asks you to approve a downloaded
app. Click **Open** to continue.

<Frame>
<img src="/assets/macos-onboarding/01-macos-warning.jpeg" alt="macOS dialog that asks whether to open the downloaded OpenClaw app" />
</Frame>
</Step>
<Step title="Approve find local networks">
macOS then asks whether OpenClaw may find devices on your local network.
Click **Allow**. The app uses this to reach a Gateway on another machine.

<Frame>
<img src="/assets/macos-onboarding/02-local-networks.jpeg" alt="macOS dialog that asks whether OpenClaw may find devices on the local network" />
</Frame>
</Step>
<Step title="Welcome and security notice">
The app opens on its welcome screen with the security notice. Read the notice,
then continue when you accept the trust model below.

<Frame caption="Read the security notice displayed and decide accordingly">
<img src="/assets/macos-onboarding/03-security-notice.png" alt="OpenClaw welcome screen with the security notice" />
</Frame>

Security trust model:

- By default, OpenClaw is a personal agent: one trusted operator boundary.
- Shared/multi-user setups need lock-down: split trust boundaries, keep tool access minimal, and follow [Security](/gateway/security).
- Local onboarding defaults new configs to `tools.profile: "coding"` so fresh setups keep filesystem/runtime tools without the unrestricted `full` profile.
- If hooks/webhooks or other untrusted content feeds are enabled, use a strong modern model tier and keep strict tool policy/sandboxing.

</Step>
<Step title="Local vs Remote">
<Frame>
<img src="/assets/macos-onboarding/04-choose-gateway.png" alt="" />
</Frame>

Where does the **Gateway** run?

- **This Mac (Local only):** onboarding configures auth and writes credentials locally.
- **Remote (over SSH/Tailnet):** onboarding does **not** configure local auth;
  credentials must already exist on the gateway host. The remote gateway token
  field stores the token the macOS app uses to connect to that Gateway;
  existing `gateway.remote.token` SecretRef values are preserved until you
  replace them.
- **Configure later:** skip setup and leave the app unconfigured.

<Tip>
**Gateway auth tip:**

- Gateway auth mode defaults to `token` even for loopback binds, so local WS clients must authenticate.
- Setting `gateway.auth.mode: "none"` lets any local process connect; use that only on fully trusted machines.
- Use a token for multi-machine access or non-loopback binds.

</Tip>
</Step>
<Step title="CLI">
  Local setup reuses a compatible CLI installation or uses the bundled installer
  to install `openclaw` and Node in a private managed runtime. It does not require
  a global npm, pnpm, or bun install.

Attaching to an independently managed local Gateway skips CLI installation
and proceeds to AI checks without taking over its CLI or service installation.
See [Gateway on macOS](/platforms/mac/bundled-gateway#automatic-setup).
</Step>
<Step title="Connect your AI">
If the connected Gateway already has a configured agent model, it appears as
**Current model**. Select it to verify that exact route with a real completion
and open the normal dashboard. Opening onboarding does not test an existing
route or choose a different provider.

Once the Gateway is ready, onboarding looks for AI access you already have:
a Claude Code or Codex login, `OPENAI_API_KEY` / `ANTHROPIC_API_KEY`, or a
tool-capable model with at least 16K of measured effective context already
loaded in a reachable LM Studio or Ollama server. Detection runs on the
Gateway host, including when the macOS app connects to a Linux Gateway. Detection
only presents choices: it does not test, activate, install, or save any candidate.
Select the connection you want before OpenClaw runs a real completion and saves it.
In particular, an existing Codex subscription is never selected automatically.
If setup fails, the app keeps the detailed reason visible so you can retry or
choose another connection. Local discovery never pulls or downloads a model.
Ollama checks `/api/ps` for loaded models; an eligible
model that is only installed on disk requires explicit setup through
**Choose connection** → **Local only**. See [Ollama](/providers/ollama).

The provider picker is built from installed manifests and OpenClaw's official
provider-plugin catalog, so installable providers such as Meta appear before their
plugin is present. When a connection needs a runtime plugin, the app and dashboard show the
staged package's source and capabilities, with integrity when available before installing or
enabling it, including verified first-party packages. Review the details, then
explicitly confirm acceptance to continue.
Declining or confirmed cancellation stops that attempt without selecting another
inference route. When the Gateway confirms that the live AI test failed before
saving the connection, the app shows the failure and lets you retry or choose a
different connection. Runtime plugins installed for that attempt are kept.

Fresh installs also ask whether existing native provider conversations should
appear in the sidebar. This is discovery in place, not transcript copying, and is
off until selected. Turning it off persists `sessionCatalog.enabled=false` for
the available native catalog plugins; existing upgraded installations keep their
current behavior.

For a custom OpenAI- or Anthropic-compatible endpoint on a local Gateway, choose
**Custom OpenAI/Anthropic-compatible endpoint** and complete the Gateway-owned
wizard. When the Gateway is remote, the Mac does not collect that host's secret;
run `openclaw onboard --auth-choice custom-api-key` on the Gateway host, then
return to the app and refresh detection.

If the result is uncertain or settings may already have been saved, the app keeps
replacement setup blocked while it checks the Gateway. **Check again** repeats
that check without starting another activation; it does not discard the pending
attempt or shorten its wait. If reconciliation still cannot confirm completion
after the wait, the app returns to connection choices with the error visible
instead of automatically retrying a detected credential. Retry that connection
or choose another one to start a new activation.

The macOS setup sheet shows the selected provider and current activity with a
spinner while the Gateway works. Plugin installation does not estimate a
completion percentage. Review prompts and input controls appear when an answer
is needed; installation and the final live AI test stay in the same flow.

After you choose **Cancel**, wait for confirmation. The Gateway may need to
finish an operation that has already reached its commit point. If cancellation
cannot be confirmed, the sheet says setup may still be running and lets you
retry **Cancel**.

To use a Claude subscription when the Gateway host has no Claude CLI login, run
`claude setup-token` on any machine with Claude Code installed, then paste the
printed token as **Anthropic setup-token** under **Connect with an API key or
token**.

Pi and OpenCode installs may be shown for context when they cannot be selected
as the reusable guided-setup inference route. They are whole-agent harnesses,
not setup inference routes; their session integrations require separate runtime
and plugin setup. Gemini CLI and Antigravity are not offered as detected setup
routes.

You can also sign in through the provider's own OAuth or device-pairing flow.
The built-in choices include OpenAI/ChatGPT, OpenRouter, GitHub Copilot, xAI,
MiniMax Global and CN, and Chutes. Google is available through the supported AI
Studio API-key route. The list comes from the
Gateway's active text-inference provider plugins rather than a fixed app list,
so another provider can opt in without adding provider-specific macOS code.

The manual key/token picker uses the same provider registry. In every route,
the provider supplies its starter model and configuration. If the starter is an
alias, OpenClaw tests and saves the provider's canonical model name while
preserving existing model settings that the starter does not replace. The credential is stored only after
that live test succeeds.
Continuing remains locked until one backend has passed, so the first agent
chat cannot start without working inference.
</Step>
<Step title="Continue in the dashboard">
After a new model passes its live check, native setup closes and opens guided
onboarding in the dashboard. OpenClaw helps configure the remaining workspace,
Gateway, channels, and other optional features, then hands you off to normal
agent chat. A verified pre-existing model opens the normal dashboard instead.

Memory import is part of guided setup, not a separate native onboarding page.
For a local Gateway, supported sources include Claude Code auto-memory, Codex
consolidated memories, and Hermes memory files. Selected memories are copied
into the agent workspace under `memory/imports/` for indexed recall;
already-imported files are skipped. Import is optional and remains available
later under **Settings → Import Memory**, with per-file control.

There is no separate native permissions walkthrough before this handoff. Grant
macOS access for the features you want to use from **Settings → Permissions**.
Available permissions include Automation (AppleScript), Notifications,
Accessibility, Screen Recording, Microphone, Speech Recognition, Camera, and
Location. See [macOS permissions](/platforms/mac/permissions) for grant and
recovery guidance.

See [Bootstrapping](/start/bootstrapping) for what happens on the Gateway host
during the agent's first real turn. OpenClaw remains available later under
**Settings → OpenClaw**.
</Step>
</Steps>

## Related

- [Onboarding overview](/start/onboarding-overview)
- [Getting started](/start/getting-started)
