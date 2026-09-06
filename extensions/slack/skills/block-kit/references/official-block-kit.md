---
name: block-kit
description: 'Use when a developer wants to build or validate Block Kit layouts for Slack messages, modals, or Home tabs: message layouts, modals/forms/dialogs, Home tab interfaces, interactive buttons or menus, or modifying existing Block Kit JSON. Also trigger on any Slack UI component (sections, actions, inputs, headers, alerts, tables, carousels), the words "blocks" or "Block Kit Builder", a request to preview rendered blocks, or pasted JSON like "type": "section". Validates via the blocks.validate API method.'
argument-hint: "[message | modal | home-tab]"
---

# Block Kit

Help the developer build a rich Block Kit layout. If `$0` is provided, it specifies the target surface (`message`, `modal`, or `home-tab`).

This skill walks through surface selection, layout planning, JSON generation, and validation. Block types, elements, and fields come from the live docs (see **Source of Truth** below) — discover them and read each component's schema there, never from memory.

> **OpenClaw adaptation:** This copy keeps Slack's authoring guidance while using capabilities available in the current agent session. Native Block Kit JSON is developer output; ordinary Slack replies use OpenClaw's portable `presentation` field.

> **Common Block Kit mistakes (and why):** A few errors recur often enough to flag up front. Most others are caught by `blocks.validate` in Step 5, so lean on validation rather than memorizing rules.
>
> - **`"type": "text"` is not a thing.** Text is a composition object: `{ "type": "plain_text", "text": "..." }` or `{ "type": "mrkdwn", "text": "..." }`.
> - **`markdown` is a _block_ type, not a text type.** A `markdown` block holds standard markdown; text objects inside other blocks use `mrkdwn` (see **mrkdwn vs. the `markdown` block** in Step 4). Slack's `mrkdwn` is `*bold*` / `_italic_` / `~strike~`, not `**bold**`.
> - **Messages need a top-level `text` fallback.** `blocks.validate` won't flag a missing one, but notifications and screen readers display it instead of the blocks — so summarize what the layout conveys rather than leaving it empty.

---

## Source of Truth: the Live Docs

Every block, element, and composition object is documented on `docs.slack.dev`. Append `.md` to any reference URL to fetch it as markdown with an available web-documentation capability (no auth required).

- **Master index**: the authoritative list of every block, block element, and composition object, each linking to its own page: `https://docs.slack.dev/reference/block-kit.md`. Fetch it with an available web-documentation capability to confirm a type exists and to get the link to its page.
- **Per-component pages** carry the full field schema (a fields table with required/optional flags and constraints, plus JSON examples):
  - Blocks: `https://docs.slack.dev/reference/block-kit/blocks/<slug>-block.md`
  - Block elements: `https://docs.slack.dev/reference/block-kit/block-elements/<slug>-element.md`
  - Composition objects: `https://docs.slack.dev/reference/block-kit/composition-objects/<slug>.md`
- **The slug is not always the type name.** For example `datepicker` maps to `date-picker-element.md`, and every `*_select` menu (`static_select`, `users_select`, `multi_channels_select`, and so on) is documented on `select-menu-element.md`. When unsure of a slug, follow the link from the master index rather than building the URL by hand.
- **Surface payload structure** lives in the surface guides: messages at `https://docs.slack.dev/messaging/formatting-message-text.md`, modals at `https://docs.slack.dev/surfaces/modals.md`, and Home tabs at `https://docs.slack.dev/surfaces/app-home.md`.

Never use a block type, element, or field you have not seen on a live page.

---

## Fast Path (for clear, specific requests)

If the developer's request is specific enough to determine both the target surface and the desired layout, collapse Steps 1-4 into a single pass:

1. Determine the surface from `$0` or context
2. Fetch only the doc pages for the blocks and elements mentioned
3. Generate the JSON directly
4. Proceed to Step 5 (validation)

**Fast-path indicators** (skip the full workflow):

- Developer provides existing JSON to modify → use Modification Mode instead
- Developer names specific block types: "add an actions block with two buttons"
- Developer describes a well-known pattern: "approval message", "feedback form", "settings modal"
- Developer provides a complete description in one message with enough detail to build

**Full-workflow indicators** (use Steps 1-7):

- Vague requests: "make something cool", "build a dashboard"
- Exploratory: "what can Block Kit do?", "show me my options"
- Complex layouts: 10+ blocks, nested modals, conditional logic
- Developer asks for help deciding what to build

---

## Modification Mode

If the developer provides existing Block Kit JSON (pasted inline, in a file, or referenced from code), enter Modification Mode instead of the full creation workflow:

1. **Parse the existing structure:**
   - List each block by index, type, and a short description of its content
   - Infer the surface: `"type": "modal"` = modal, `"type": "home"` = home tab, bare `blocks` array = message

2. **Ask what changes they want:**
   - Add blocks (where in the sequence?)
   - Remove blocks (which ones?)
   - Modify blocks (which block, what change?)
   - Reorder blocks

3. **Apply changes while preserving:**
   - All existing `block_id` values (these are referenced in app interaction handlers)
   - All existing `action_id` values (these map to event listeners)
   - Existing styles, text content, and structure for unchanged blocks

4. **Validate the modified JSON**: proceed to Step 5 (validation)

**Detection:** If the developer's message contains a JSON array starting with `[{"type":` or a view object with `"blocks":`, enter Modification Mode automatically. If they say "edit", "update", "modify", or "change" in reference to existing blocks, ask them to provide the current JSON.

---

## Step 1: Determine the Target Surface

If `$0` is provided and matches one of `message`, `modal`, or `home-tab`, use it directly.

Otherwise, ask the developer:

- **Message**: Conversational content posted to a channel or DM. Max 50 blocks.
- **Modal**: A dialog or form opened by a user action. Max 100 blocks.
- **Home tab**: A persistent, per-user dashboard in the App Home. Max 100 blocks.

Once the surface is determined, use the correct payload structure for it:

- **Message**: a `{ "text": "Fallback text", "blocks": [...] }` object posted via `chat.postMessage` (and friends). The `text` field is the notification/accessibility fallback. For message text formatting (mrkdwn, mentions, dates), see `https://docs.slack.dev/messaging/formatting-message-text.md`.
- **Modal**: a view object (`{ "type": "modal", "title": ..., "blocks": [...] }`). For the full view object structure, lifecycle, and the rule that `submit` is required when the view contains any `input` block, see `https://docs.slack.dev/surfaces/modals.md`.
- **Home tab**: a view object (`{ "type": "home", "blocks": [...] }`) published via `views.publish`. For structure and behavior, see `https://docs.slack.dev/surfaces/app-home.md`.

---

## Step 2: Understand What to Build

Ask the developer to describe what they want their layout to look like or accomplish.

If they need inspiration, suggest examples — several map directly onto a ready-made template in `official-common-patterns.md` (named in parentheses), which you can start from in Step 3:

- "A feedback form with a text input and a category selector" (Simple Form Modal)
- "A notification message with an alert banner, description, and Approve/Reject buttons" (Notification Alert / Approval Message)
- "A dashboard home tab with a welcome header, key metrics in fields, and quick-action buttons" (Dashboard Home Tab)
- "A settings modal with dropdowns, checkboxes, and a time picker" (Settings Modal with Multiple Input Types)
- "A table of sprint tasks with status and points" (Data Table)

Get enough detail to plan the layout before generating any JSON.

---

## Step 3: Plan the Block Layout

Based on the developer's description:

1. **Fetch only what you need** from the live docs:
   - Fetch the master index (`https://docs.slack.dev/reference/block-kit.md`) with an available web-documentation capability to confirm the block and element types you plan to use exist and to grab links to their pages.
   - Check `official-common-patterns.md` (the one local reference file) if the request matches a common pattern; start from the template instead of building from scratch.
   - Defer reading individual component pages until Step 4, when you build each block's fields.
2. Propose a numbered block outline. For example:

   ```text
   1. header: "Weekly Report"
   2. section: Summary text with a datepicker accessory
   3. divider
   4. section: Status fields (Name, Role, Team)
   5. actions: "Approve" button (primary) and "Reject" button (danger)
   ```

3. Present the outline to the developer and ask for approval or changes before generating JSON.

**Surface constraints to check:**

- Block count limit: 50 for messages, 100 for modals/home tabs
- Modal-specific: if using `input` blocks, the modal payload must include a `submit` field
- Table: only one `table` block per message
- Surface compatibility (whether a block is valid on the chosen surface) and element compatibility (whether an element is allowed inside a given block) are not always spelled out on a component's doc page. Build the layout from the docs, and let `blocks.validate` in Step 5 confirm it. It is the authoritative check.

---

## Step 4: Generate the Block Kit JSON

Once the layout is approved, build each block from its live doc page, fetching each page's fields table (required vs optional, constraints) and JSON example with an available web-documentation capability. The URL patterns are in **Source of Truth** above; the one slug to remember is that every `*_select` menu (`static_select`, `users_select`, `multi_channels_select`, …) lives on `select-menu-element.md`. Fetch pages as you need them and reuse what you have already fetched — don't re-fetch the same page for every block of the same type. Then build the payload block-by-block and wrap it in the surface structure from Step 1.

**Guidelines:**

- Use descriptive `action_id` values (e.g., `"approve_report_btn"` not `"action_1"`) — they identify the element in your interaction handlers
- Include `block_id` values where the developer will need them for interaction handling
- For modals, include `title`, `submit`, `close`, and `callback_id`; for home tabs, the `type: "home"` wrapper
- Use `mrkdwn` text for rich formatting, `plain_text` where required (headers, labels, modal title)

**mrkdwn vs. the `markdown` block:** `section` and `context` blocks format text with Slack's `mrkdwn` (`*bold*`, `_italic_`, `~strike~`, `` `code` ``) — use these for short, interactive layouts. The separate `markdown` block (Messages only) renders _standard_ markdown (`**bold**`, headings, tables, numbered lists) and is meant for AI/LLM-generated or long-form content that already exists in standard markdown. Reach for it when the developer has such content or needs those features in the message body; there is a cumulative 12,000-character limit across all `markdown` blocks in one message.

**Accessibility** is easy to skip and hard to retrofit, so build it in now:

- Give images descriptive `alt_text` (what the image shows, not just "image"), and make sure image-heavy layouts also carry the key information as text
- Summarize the layout in the message's `text` fallback (notifications and screen readers show it instead of the blocks)
- Use `header` blocks for logical section headings — they convey document structure to assistive tech

Present the complete payload to the developer in the Step 1 surface structure.

---

## Step 5: Validate

**Always validate.** `blocks.validate` is a public Web API method, so no auth token is required.

The authoritative reference for this method (its parameters, auth requirements, and response/error shape) is the live doc. Fetch it before relying on any detail here: `https://docs.slack.dev/reference/methods/blocks.validate.md`. It documents the accepted parameters (`blocks` for a message's blocks array, `view` for a modal/home-tab view, `message` for a full message payload; send exactly one) and the response shape.

### 5a. Build the validation request

Use an available HTTP capability to POST to `https://slack.com/api/blocks.validate`. The API uses form-urlencoded encoding, so pass the JSON directly as the parameter value. If the current session has no HTTP capability, deliver the payload with a clear note that live validation remains pending.

**For messages**, send the `blocks` array as a form-encoded parameter:

```bash
curl -s -X POST 'https://slack.com/api/blocks.validate' \
  --data-urlencode 'blocks=[ ... the blocks array ... ]'
```

**For modals and home tabs**, send the complete view object in the `view` field:

```bash
curl -s -X POST 'https://slack.com/api/blocks.validate' \
  --data-urlencode 'view={ "type": "modal", "title": ..., "blocks": [...] }'
```

### 5b. Handle the response

**Success:**

```json
{ "ok": true }
```

Tell the developer their blocks are valid.

**Failure:**

```json
{
  "ok": false,
  "error": "invalid_blocks",
  "errors": [
    {
      "code": "missing_field",
      "message": "missing required field: type",
      "field": "type",
      "pointer": "/0"
    }
  ]
}
```

When validation fails:

1. Read each error. `pointer` is a JSON pointer to the offending node (e.g., `/0` = first block, `/2/elements/1` = second element of the third block, `/0/text/type` = the `type` field of the first block's text object). `message` describes the problem, and `constraint` (when present) names the rule that failed and its expected values.
2. Fix the JSON. For the authoritative meaning of an error code and the field requirements behind it, consult the live method doc (`https://docs.slack.dev/reference/methods/blocks.validate.md`) and the relevant block/element/composition-object page you fetched in Steps 3-4.
3. Re-validate. Repeat until `"ok": true`.

---

## Step 6: Deliver the Final Output

Present the validated payload, then help the developer put it to use.

### Send it

Building the native payload is this skill's job. Return it for the developer's Slack app integration. Do not pass native Slack blocks to OpenClaw's `presentation` field; translate the result into the portable presentation schema when the user instead wants the current OpenClaw agent to post it.

### Preview it

Help the developer view their layout with the **Block Kit Builder**. Offer `https://app.slack.com/block-kit-builder` so they can paste the JSON in and tweak visually. Builder needs an object (`{ "blocks": [...] }` or a full view object), not a bare array.

---

## Step 7: Iterate

Ask whether the developer wants to add, modify, remove, or reorder blocks, or build a layout for a different surface. If they want to change the layout you just produced, re-enter **Modification Mode** (it preserves their `block_id`/`action_id` values); for a fresh layout, loop back to Step 3.

---

## Notes

- **Scope:** this skill owns building and validating native Block Kit payloads for a developer. OpenClaw conversation delivery uses portable `presentation` instead.
- **`blocks.validate` needs no auth** — it's a public method. Always validate before finalizing when the current session has an HTTP capability (Step 5).
