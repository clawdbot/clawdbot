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
   - After `action="tabs"` or `action="open"`, store `suggestedTargetId` and pass it as `targetId` in later calls.
   - `suggestedTargetId` is the label when one exists, otherwise the stable `tabId` handle like `t1`.
   - Avoid relying on raw DevTools `targetId` except for immediate diagnostics; it can change under Chromium target replacement.
3. Read before you click:
   - For “read the page and answer X,” use a selector-scoped `action="snapshot"` or `act:evaluate` that returns only relevant text or structured data. Let the active agent model answer from that bounded result; use efficient snapshots for controls and action discovery because they omit most non-interactive prose.
   - For virtualized lists, scroll through each segment, capture only the relevant rows, then merge the results.
   - Use `action="snapshot"` on the intended `targetId`.
   - Use the same `targetId` for follow-up actions so refs stay on the same tab.
   - For durable Playwright refs, request `refs="aria"` when supported. If you receive `axN` refs from `snapshotFormat="aria"`, use them only after that same snapshot call; stale or unbound `axN` refs fail fast and need a fresh snapshot.
   - Use `urls=true` when link text is ambiguous or a direct navigation target would avoid brittle clicks.
   - Use `labels=true` on snapshot or screenshot when visual position matters. On Playwright-backed profiles, the response includes an `annotations` array (`{ref, number, role, name?, box}`) with each ref's bounding box in the captured image's coordinate space, so you can reason about position without re-snapshotting; screenshot labels can also combine with `fullPage=true` (CLI: `--full-page`) to label the whole document, or `ref` / `element` to clip to one element. `profile="user"` and other existing-session (chrome-mcp) profiles render an overlay into page screenshots but do not attach `annotations` or use the Playwright full-page/ref/element projection helper, so read positions from the labeled image itself on those profiles. The raw-CDP fallback (no Playwright) does not support labeled screenshots at all and returns a 501, so only request `labels` when Playwright is available.
4. Act narrowly:
   - Prefer `action="act"` with a ref from the latest snapshot.
   - `navigate` returns the loaded page's compact snapshot inline, and batch `act` results that report a cross-document navigation include fresh page state; use those refs directly instead of a follow-up snapshot call.
   - After a single act that triggers navigation, and after modal changes or form submissions, snapshot again before the next action.
   - Avoid blind waits. Wait for visible UI state when possible.
5. Report real blockers:
   - If the page needs login, permission, captcha, 2FA, camera/microphone approval, or another manual step, stop and tell the user exactly what is needed.
   - Do not claim the browser is not logged in just because the current page shows a permission or onboarding dialog. Inspect the visible UI first.

## Browser batch CLI

`openclaw browser batch` runs an array of nested `/act` actions in one `/act` call (the same `kind="batch"` runtime reached through the agent tool), so CLI users and scripts can combine actions like `wait`, `click`, `type`, and `evaluate` into a single replayable plan without per-action round trips. Each entry in `actions[]` is a `BrowserActRequest` — the closed union the `/act` route accepts — not arbitrary `openclaw browser` subcommands. `batch` is not supported on `profile="user"` and other existing-session (chrome-mcp) profiles; send actions individually there.

- CLI: `openclaw browser batch --actions '<json>'`, `--actions-file plan.json`, or `--actions-file -` for stdin. `--continue` sets `stopOnError=false`; default stops on first error.
- Ref lifecycle: refs come from a `snapshot` run before the batch (snapshot is not a nested action). A nested action that changes page state — such as a `click` that triggers navigation, or an `evaluate` that mutates the DOM — can invalidate earlier refs for the rest of the batch; put state-changing actions first, or split into a follow-up batch after re-snapshotting. Navigation and re-snapshotting happen outside the batch, since `open`, `navigate`, and `snapshot` are not `/act` kinds.
- Target id: nested actions share the request's tab; an explicit nested `targetId` that resolves to a different tab is rejected with `ACT_TARGET_ID_MISMATCH`.
- Response: `{ "results": [{ "ok": true } | { "ok": false, "error": "..." }, ...] }` in order; with default `stopOnError` the array ends at the first failure. Any failed entry exits nonzero; use `--json` to preserve the full response in scripts.

## Code Mode Loop

When `tools.codeMode` is enabled, the Browser tool has no normal turn — it is cataloged behind `exec`/`wait`. Call it from exec cells as an async global, using the callable name the exec quick index advertises for the Browser tool (normally `browser`; colliding names get suffixed, and a client tool can win an identical name). An exact `catalog.search("browser")` returns a handle already bound to the effective callable name, so resolve the handle in each cell and call it instead of hard-coding the literal global; an empty result means the Browser tool is not cataloged in this run.

Keep the same labeled tab through the loop, and alternate reads with actions. Each `exec` cell starts a fresh VM — bindings from a completed cell are gone in the next, and only runs left `waiting` keep their state until `wait` resumes them — so carry comparison state across cells by returning it and re-embedding the returned values in the next cell:

```javascript
// previous = the url/newElements returned by the last completed cell (a fresh
// VM runs this cell, so prior bindings do not exist here).
const previous = { url: "https://example.com/inbox", newElements: 0 };
const [browser] = await catalog.search("browser", { limit: 1 });
const details = await browser({
  action: "snapshot",
  snapshotFormat: "ai",
  targetId: "task",
  refs: "aria",
  interactive: true,
});
const changed =
  details?.url !== previous.url ||
  (details?.newElements ?? 0) > 0 ||
  details?.blockedByDialog === true;
return {
  targetId: details?.targetId,
  url: details?.url,
  newElements: details?.newElements,
  stats: details?.stats,
  changed,
};
```

- Code-mode calls return the tool's structured `details` directly (`targetId`, `url`, `newElements`, `stats`, `blockedByDialog`); rendered page text is not returned to code cells.
- To read text inside code mode, run a targeted `act` evaluate (requires the evaluate capability; `browser.evaluateEnabled` can disable it) and keep the returned value bounded, because page-script output is untrusted:

```javascript
const [browser] = await catalog.search("browser", { limit: 1 });
const read = await browser({
  action: "act",
  kind: "evaluate",
  fn: "() => document.body.innerText.slice(0, 2000)",
  targetId: "task",
});
return { url: read?.url, text: read?.result };
```

When evaluate is unavailable, keep the loop on structured state only.

- Return only the fields the next step needs; never return the whole details object.
- Completed cells share no state: re-embed the previous cell's returned `url`/`newElements` in the next cell, or keep the comparison inside one cell. Only `waiting` runs persist, resumed by `wait`.
- Interleave each act with a URL or tabs check before the next dependent act.
- If a batch returns `aborted`, take a fresh snapshot before continuing.
- If `newElements` is positive, inspect those elements first, then update the re-embedded state.
- Use separate act calls when navigation is expected between steps.

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

On macOS, `action="importprofile"` is the alternative when the agent should use an isolated managed browser with cookies copied from a real Chrome-family profile. First use `action="profiles"` and inspect `systemProfiles`, then import into a fresh managed profile name. Import asks for one Keychain/Touch ID consent prompt. It copies cookies, not local storage or IndexedDB; device-bound session credentials (DBSC) mean some Google sessions may still require re-authentication.

For `profile="user"` and other existing-session profiles, omit `timeoutMs` on `act:type`, `hover`, `scrollIntoView`, `drag`, `select`, and `fill`; that driver rejects per-call timeout overrides for those actions. `act:evaluate` accepts `timeoutMs`.

## Google Meet Notes

When creating or joining a Meet:

- Treat camera/microphone permission screens as progress, not login failure.
- If asked whether people can hear you, click the microphone option when voice is required.
- If Google asks for sign-in, 2FA, account chooser confirmation, or permission that needs user approval, report the exact manual action.
- Use one labeled tab per meeting flow, for example `label="meet"`, and reuse it during retries.
