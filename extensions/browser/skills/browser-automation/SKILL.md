---
name: browser-automation
description: Use when controlling web pages with the OpenClaw browser tool, especially multi-step flows, login checks, tab management, or recovery from stale refs/timeouts.
user-invocable: false
---

# Browser Automation

Use this skill when you need the `browser` tool for anything beyond a single page check.

## Operating Loop

1. Check browser state before acting:
   - `openclaw browser doctor` or `action="status"` when the browser/plugin setup itself may be broken.
   - `action="status"` for availability.
   - `action="profiles"` if login state or profile choice matters.
   - `action="tabs"` before opening a new tab if retries/timeouts may have left windows behind.
2. Prefer stable tab handles:
   - Open important tabs with `label`, for example `label="meet"`.
   - Use `tabId` handles like `t1` or labels like `meet` as `targetId` in later calls.
   - Avoid relying on raw DevTools `targetId` unless the tool just returned it.
3. Read before you click:
   - Use `action="snapshot"` on the intended `targetId`.
   - Use the same `targetId` for follow-up actions so refs stay on the same tab.
   - For durable Playwright refs, request `refs="aria"` when supported.
   - Use `urls=true` when link text is ambiguous or a direct navigation target would avoid brittle clicks.
   - Use `labels=true` on snapshot or screenshot when visual position matters.
4. Act narrowly:
   - Prefer `action="act"` with a ref from the latest snapshot.
   - After navigation, modal changes, or form submission, snapshot again before the next action.
   - Avoid blind waits. Wait for visible UI state when possible.
5. Report real blockers:
   - If the page needs login, permission, captcha, 2FA, camera/microphone approval, or another manual step, stop and tell the user exactly what is needed.
   - Do not claim the browser is not logged in just because the current page shows a permission or onboarding dialog. Inspect the visible UI first.

## Tab Hygiene

Before creating a tab for a named task, list tabs and reuse an existing matching label or URL when it is still usable.

Example:

```json
{ "action": "tabs" }
```

If no suitable tab exists:

```json
{ "action": "open", "url": "https://example.com", "label": "task" }
```

Then target it by label:

```json
{ "action": "snapshot", "targetId": "task", "refs": "aria" }
```

If a retry creates duplicates, close the extras by `tabId`:

```json
{ "action": "close", "targetId": "t3" }
```

Do not pass bare numbers like `"2"` as `targetId`. Numeric tab positions are only for the CLI `openclaw browser tab select 2` helper; browser tool calls need a `suggestedTargetId`, label, `tabId`, or raw target id.

## Stale Ref Recovery

If an action fails with a missing or stale ref:

1. Snapshot the same `targetId` again.
2. Find the current visible control.
3. Retry once with the new ref.
4. If the UI moved to a blocker state, report the blocker instead of looping.

## Existing User Browser

Use `profile="user"` only when existing cookies/login matter. This attaches to the user's running Chromium-based browser.

For `profile="user"` and other existing-session profiles, omit `timeoutMs` on `act:type`, `evaluate`, `hover`, `scrollIntoView`, `drag`, `select`, and `fill`; that driver rejects per-call timeout overrides for those actions.

## Google Meet Notes

When creating or joining a Meet:

- Treat camera/microphone permission screens as progress, not login failure.
- If asked whether people can hear you, click the microphone option when voice is required.
- If Google asks for sign-in, 2FA, account chooser confirmation, or permission that needs user approval, report the exact manual action.
- Use one labeled tab per meeting flow, for example `label="meet"`, and reuse it during retries.
