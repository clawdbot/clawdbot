---
summary: "First-run setup flow for OpenClaw (macOS app)"
read_when:
  - Designing the macOS onboarding assistant
  - Implementing auth or identity setup
title: "Onboarding (macOS app)"
sidebarTitle: "Onboarding: macOS App"
---

The macOS app's first-run flow: pick where the Gateway runs, connect a
verified AI backend, grant permissions, and hand off to the agent's own
bootstrap ritual.
For CLI onboarding and a comparison of both paths, see [Onboarding Overview](/start/onboarding-overview).

<Steps>
<Step title="Approve macOS warning">
<Frame>
<img src="/assets/macos-onboarding/01-macos-warning.jpeg" alt="" />
</Frame>
</Step>
<Step title="Approve find local networks">
<Frame>
<img src="/assets/macos-onboarding/02-local-networks.jpeg" alt="" />
</Frame>
</Step>
<Step title="Welcome and security notice">
<Frame caption="Read the security notice displayed and decide accordingly">
<img src="/assets/macos-onboarding/03-security-notice.png" alt="" />
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
  Local setup installs the global `openclaw` CLI via npm, pnpm, or bun,
  preferring npm first. Node remains the recommended runtime for the Gateway
  itself. Existing compatible installations are reused.
</Step>
<Step title="Connect your AI">
  A connected Gateway that already has a configured agent model skips this
  page entirely and opens the normal agent UI. OpenClaw and provider setup
  only run for a fresh or incomplete Gateway.

Once the Gateway is ready, onboarding looks for AI access you already have:
a Claude Code or Codex login, `OPENAI_API_KEY` / `ANTHROPIC_API_KEY`, or a
tool-capable model already installed in a reachable Ollama or LM Studio server.
Detection runs on the Gateway host, including when the macOS app connects to a
Linux Gateway. The best option is tested with a real completion and only saved
after it answers; when a test fails the app automatically tries the next option
and shows why the previous one failed. If several options are found you can
switch between them before continuing. Automatic local discovery never pulls
or downloads a model.

To use a Claude subscription when the Gateway host has no Claude CLI login, run
`claude setup-token` on any machine with Claude Code installed, then paste the
printed token as **Anthropic setup-token** under **Connect with an API key or
token**.

Gemini CLI and Antigravity remain available for normal use after setup. Their
installed CLIs are shown for context but are not auto-tested because neither can
enforce the tool-free inference probe.

You can also sign in through the provider's own OAuth or device-pairing flow.
The built-in choices include OpenAI/ChatGPT, OpenRouter, GitHub Copilot, Google
Gemini CLI, xAI, MiniMax Global and CN, and Chutes. The list comes from the
Gateway's active text-inference provider plugins rather than a fixed app list,
so another provider can opt in without adding provider-specific macOS code.

The manual key/token picker uses the same provider registry. In every route,
the provider supplies its starter model and configuration; OpenClaw verifies
the credential with the same live test before storing its auth profile. Next
remains locked until one backend has passed, so the first agent chat cannot
start without working inference. After that live check passes, OpenClaw becomes
available to help configure the remaining workspace, Gateway, channels, and
other optional features; it is also available later under Settings → OpenClaw.
</Step>
<Step title="Permissions">

<Frame caption="Choose what permissions do you want to give OpenClaw">
<img src="/assets/macos-onboarding/05-permissions.png" alt="" />
</Frame>

Onboarding requests TCC permissions for: Automation (AppleScript), Notifications, Accessibility, Screen Recording, Microphone, Speech Recognition, Camera, and Location.

</Step>
<Step title="Finish">
  After inference passes, OpenClaw owns the remaining optional setup and can
  hand you off to the normal agent chat. Finishing the permission walkthrough
  opens that same chat; the app does not create a workspace or launch a separate
  agent setup conversation before OpenClaw. See
  [Bootstrapping](/start/bootstrapping) for what happens on the gateway host
  during the agent's first real turn.
</Step>
</Steps>

## Related

- [Onboarding overview](/start/onboarding-overview)
- [Getting started](/start/getting-started)
