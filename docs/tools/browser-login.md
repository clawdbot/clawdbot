---
summary: "Manual logins for browser automation + X/Twitter posting"
read_when:
  - You need to log into sites for browser automation
  - You want to post updates to X/Twitter
title: "Browser login"
---

## Manual login (recommended)

When a site requires login, sign in manually in the host browser's `openclaw`
profile. Do not give the model your credentials: automated logins often
trigger anti-bot defenses and can lock the account.

Use the host browser (manual login) for both reading (search/threads) and
posting on X/Twitter and other bot-sensitive sites. Sandboxed browser sessions
are more likely to trigger bot detection.

Back to the main browser docs: [Browser](/tools/browser).

## Which Chrome profile is used?

OpenClaw controls a dedicated Chrome profile named `openclaw` (orange-tinted
UI), separate from your daily browser profile.

For agent browser tool calls:

- Default choice: the agent uses its isolated `openclaw` browser.
- Use `profile="user"` only when existing logged-in sessions matter and you
  are at the computer to click/approve any attach prompt.
- If you have multiple user-browser profiles, specify the profile explicitly
  instead of guessing.

Two ways to access the `openclaw` profile:

1. Ask the agent to open the browser, then log in yourself.
2. Open it via CLI:

```bash
openclaw browser start
openclaw browser open https://x.com
```

For a non-default profile, put `--browser-profile <name>` before the
subcommand (default is `openclaw`):

```bash
openclaw browser --browser-profile <name> open https://x.com
```

## Sandboxing: allow host browser access

If the agent is sandboxed, its `browser` tool calls default to the sandbox
browser, not the host. To let the agent target the host browser instead:

```json5
{
  agents: {
    defaults: {
      sandbox: {
        mode: "non-main",
        browser: {
          allowHostControl: true,
        },
      },
    },
  },
}
```

CLI invocations always target the host browser, never the sandbox, so you can
open the host browser yourself regardless of this setting:

```bash
openclaw browser --browser-profile openclaw open https://x.com
```

Once `sandbox.browser.allowHostControl: true` is set, the agent's `browser`
tool calls can target the host too. Alternatively, disable sandboxing for the
agent that posts updates.

## Related

- [Browser](/tools/browser)
- [Browser Linux troubleshooting](/tools/browser-linux-troubleshooting)
- [Browser WSL2 troubleshooting](/tools/browser-wsl2-windows-remote-cdp-troubleshooting)
