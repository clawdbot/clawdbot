---
summary: "Overview of OpenClaw onboarding options and flows"
read_when:
  - Choosing an onboarding path
  - Setting up a new environment
title: "Onboarding overview"
sidebarTitle: "Onboarding Overview"
---

OpenClaw supports onboarding from the terminal, the macOS app, and the Linux
desktop companion. Every path establishes inference first: it detects existing
AI access, requires a live completion, and only then starts OpenClaw to
configure the remaining setup. A reachable, configured Gateway whose default
agent already has a configured model skips onboarding and opens the normal
agent UI. The terminal flow also offers the full classic wizard for detailed
setup.

## Which path should I use?

|                | CLI onboarding                         | macOS app onboarding                                | Linux app onboarding                      |
| -------------- | -------------------------------------- | --------------------------------------------------- | ----------------------------------------- |
| **Platforms**  | macOS, Linux, Windows (native or WSL2) | macOS                                               | Linux                                     |
| **Interface**  | Terminal or guided setup               | Native desktop setup                                | Native desktop setup                      |
| **Gateway**    | Local or remote                        | Local, direct remote, or SSH                        | Local, direct remote, or SSH              |
| **Best for**   | Servers, headless, full control        | Desktop Mac, visual setup                           | Linux desktop, visual setup               |
| **Automation** | `--non-interactive` for scripts        | Manual only                                         | Manual only                               |
| **Start**      | `openclaw onboard`                     | [Download the macOS app](/platforms/macos#download) | [Install the Linux app](/platforms/linux) |

Most users should start with **CLI onboarding** — it works everywhere and gives
you the most control.

## What onboarding configures

The guided inference phase establishes only:

1. **Model provider and auth** — detected access or a verified provider sign-in,
   API key, or token
2. **Verified inference** — a real completion on the default agent's effective
   model

After that completion passes, OpenClaw can configure the workspace, Gateway,
Gateway service, channels, agents, plugins, and other optional features.

The classic CLI wizard can additionally configure:

1. **Channels** (optional) — built-in and bundled chat channels such as
   Discord, Feishu, Google Chat, iMessage, Mattermost, Microsoft Teams,
   Telegram, WhatsApp, and more
2. **Advanced Gateway controls** — remote mode, network settings, and daemon choices

## CLI onboarding

Run in any terminal:

```bash
openclaw onboard
```

The guided flow detects existing AI access, live-tests candidates in order,
and falls through on failure. If detection is exhausted, it shows OpenAI,
Anthropic, xAI (Grok), Google, and OpenRouter first. **More…** contains the
remaining providers in provider groups, with regions, plans, and supported
browser, device, API-key, or token methods in a second menu. It saves the model
and credential only after a passing completion, then starts OpenClaw to
configure the workspace, Gateway, channels, agents, plugins, and other optional
features. **Skip for now** exits without starting OpenClaw. There is no
in-flow classic handoff; exit and run `openclaw onboard --classic` when you want
the classic wizard instead.

After inference passes, OpenClaw can hand channel setup to a masked terminal
wizard. It does not open guided or classic provider setup; exit OpenClaw and
run `openclaw onboard` to change the model provider or its authentication.

Use `openclaw onboard --classic` for detailed model/auth, channel, skill,
remote Gateway, or import setup. Adding `--install-daemon` also selects the
classic flow and installs the background service in one step. Use `openclaw
setup` for conversational non-inference setup and repair. `openclaw
onboard --modern` is a compatibility alias that uses the same live-inference
gate.

Full reference: [Onboarding (CLI)](/start/wizard)
CLI command docs: [`openclaw onboard`](/cli/onboard)

## macOS app onboarding

[Download the macOS app](/platforms/macos#download), then open it. If its
configured local or remote Gateway is reachable
and the default agent already has a configured model, the app skips onboarding
and OpenClaw and opens the normal agent UI immediately.

For a fresh or incomplete Gateway, the first-run flow detects existing AI
access (Claude Code, Codex, or API keys), live-tests the best
option, and saves it only after a real reply — falling back automatically and
offering a verified manual API-key step when nothing is found. Sensitive
credentials use masked input. Once inference passes, OpenClaw starts and
helps configure the rest.

Gemini CLI remains available as an explicitly configured runtime after setup,
but Gemini CLI and Antigravity are not offered as detected inference routes.
Use Google AI Studio API-key or Vertex AI for guided setup. The optional Gemini
CLI runtime specifically requires an AI Studio API-key profile.

Full reference: [Onboarding (macOS App)](/start/onboarding)

## Linux app onboarding

[Install the Linux desktop companion](/platforms/linux), then open it. The
welcome screen lets you choose a Gateway on **this computer** or **another
computer**. Local setup installs any missing CLI and managed Node runtime, then
starts the systemd user service. Remote setup connects to a discovered Gateway,
a manually entered Gateway URL, or a Gateway reached through an SSH tunnel;
token and password authentication are supported.

Model Setup checks existing provider access and offers sign-in or API-key entry
when needed. The selected Gateway verifies a real model response before guided
onboarding begins. An already configured Gateway opens the normal agent UI
instead. Active onboarding survives Gateway restarts, and model activation
resumes safely after closing and reopening the app.

Platform and remote-access details: [Linux app](/platforms/linux) and
[Remote access](/gateway/remote).

## Custom or unlisted providers

If your provider is not listed, run `openclaw onboard --classic`, choose
**Custom Provider**, and enter:

- Endpoint compatibility: OpenAI-compatible (`/chat/completions`), OpenAI Responses-compatible (`/responses`), Anthropic-compatible (`/messages`), or unknown (probes all three and auto-detects)
- Base URL and API key (API key is optional if the endpoint does not require one)
- Model ID and optional model alias

Multiple custom endpoints can coexist — each gets its own endpoint ID.

## Related

- [Getting started](/start/getting-started)
- [CLI setup reference](/start/wizard-cli-reference)
