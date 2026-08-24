---
summary: "Choose Standard, Code, or Minimal tools for each OpenClaw session"
read_when:
  - You want to change one session's tool surface without changing its model
  - You are enabling or troubleshooting the bundled Developer Mode plugin
  - You need to understand Standard, Code, and Minimal Tool modes
title: "Developer Mode plugin"
---

The Developer Mode plugin adds a per-session **Tool mode** control to the
Control UI. It changes how the OpenClaw runtime presents and filters tools; it
does not change the model, provider, permission mode, sandbox, or runtime.

## Enable it

Developer Mode is bundled but disabled by default:

1. Open **Plugins** in the Control UI.
2. Find **Developer Mode** and choose **Enable**.
3. Restart the Gateway when prompted.

The equivalent CLI flow is:

```bash
openclaw plugins enable developer-mode
openclaw gateway restart
```

After restart, open the composer **+** menu and choose **Tool mode**. The same
menu is available before the first message on the New session screen.

## Modes

| Mode         | Behavior                                                               |
| ------------ | ---------------------------------------------------------------------- |
| **Standard** | Direct tools with the coding profile. Best for most work.              |
| **Code**     | [OpenClaw Code Mode](/tools/code-mode) with the coding profile.        |
| **Minimal**  | Direct tools with the minimal profile for a smaller, focused tool set. |

QuickJS-WASI is an implementation detail of OpenClaw Code Mode. The menu does
not expose JavaScript engine, tool-profile, or schema terminology.

## Session lifecycle

- A mode change during an active response applies to the next unadmitted turn.
- Forked sessions inherit the selected mode.
- New sessions default to Standard unless another mode is selected before send.
- Retries and recovery keep the Tool surface frozen for the admitted turn.
- If the selected plugin mode becomes unavailable, OpenClaw uses configured
  defaults and shows the unavailable selection in the composer **+** menu.

## Runtime compatibility

Developer Mode currently applies only to the built-in `openclaw` runtime. For
Codex or an external session, **Tool mode** remains visible but disabled with an
explanation. Codex Code Mode and ACP sessions have separate runtime ownership
and are not remapped by this plugin.

Developer Mode adds no global Gateway setting or plugin-specific configuration.
Disable it through the standard Plugins page or CLI:

```bash
openclaw plugins disable developer-mode
openclaw gateway restart
```

## See also

- [Agent runtimes](/concepts/agent-runtimes)
- [Code Mode](/tools/code-mode)
- [Tool profiles](/tools)
- [Manage plugins](/plugins/manage-plugins)
