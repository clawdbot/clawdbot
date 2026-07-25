---
summary: "Markdown formatting pipeline for outbound channels"
read_when:
  - You are changing markdown formatting or chunking for outbound channels
  - You are adding a new channel formatter or style mapping
  - You are debugging formatting regressions across channels
title: "Markdown formatting"
---

OpenClaw converts outbound Markdown into a shared intermediate representation
(IR) before rendering channel-specific output. The IR keeps plain text plus
style/link spans, so one parse step feeds every channel and chunking never
splits formatting mid-span.

## Pipeline

1. **Parse Markdown into IR** (`markdownToIR`) - plain text plus style spans
   (bold, italic, strikethrough, code, code block, spoiler, blockquote,
   heading 1-6) and link spans. Offsets are UTF-16 code units so Signal style
   ranges align with its API directly. Tables parse only when the channel
   opts into a table mode.
2. **Chunk the IR** (`chunkMarkdownIR` / `renderMarkdownIRChunksWithinLimit`)
   - splitting happens on IR text before rendering, so inline styles and
     links are sliced per chunk instead of breaking across a boundary.
3. **Render per channel** (`renderMarkdownWithMarkers`) - a style-marker map
   turns spans into the channel's native markup.

| Channel                                                          | Renderer                                                                             | Notes                                                                                    |
| ---------------------------------------------------------------- | ------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------- |
| Slack                                                            | mrkdwn tokens (`*bold*`, `_italic_`, `` `code` ``, code fences)                      | Links become `<url\|label>`; autolink disabled during parse to avoid double-linking      |
| Telegram                                                         | HTML tags (`<b>`, `<i>`, `<s>`, `<code>`, `<pre><code>`, `<a href>`, `<tg-spoiler>`) | Also supports rich-message tables and headings (`<h1>`-`<h6>`) when `richMessages` is on |
| Signal                                                           | plain text + `text-style` ranges                                                     | Links render as `label (url)` when the label differs from the URL                        |
| Discord, WhatsApp, iMessage, Microsoft Teams, and other channels | plain text                                                                           | No IR-based styling; Markdown table conversion still runs via `convertMarkdownTables`    |

## IR example

Input Markdown:

```markdown
Hello **world** - see [docs](https://docs.openclaw.ai).
```

IR (schematic):

```json
{
  "text": "Hello world - see docs.",
  "styles": [{ "start": 6, "end": 11, "style": "bold" }],
  "links": [{ "start": 19, "end": 23, "href": "https://docs.openclaw.ai" }]
}
```

## Table handling

`markdown.tables` controls how a channel converts Markdown tables, per
channel and optionally per account:

| Mode      | Behavior                                                                             |
| --------- | ------------------------------------------------------------------------------------ |
| `code`    | Render as an aligned ASCII table inside a code block (fallback default)              |
| `bullets` | Convert each row into `label: value` bullet points                                   |
| `block`   | Keep native tables where the transport supports them; falls back to `code` otherwise |
| `off`     | Disable table parsing; raw table text passes through unchanged                       |

Per-channel plugin defaults: Signal, WhatsApp, and Matrix default to
`bullets`; Mattermost defaults to `off`; Telegram defaults to `block` (which
resolves to `code` unless the account has `richMessages` enabled). Any
channel without an explicit plugin default falls back to `code`.

```yaml
channels:
  discord:
    markdown:
      tables: code
    accounts:
      work:
        markdown:
          tables: off
```

## Chunking rules

- Chunk limits come from channel adapters/config and apply to IR text, not
  rendered output.
- Fenced code blocks are kept as one block with a trailing newline so
  channels render the closing fence correctly.
- List and blockquote prefixes are part of the IR text, so chunking never
  splits mid-prefix.
- Inline styles never split across chunks; the renderer reopens an open
  style at the start of the next chunk.

See [Streaming and chunking](/concepts/streaming) for chunk-boundary and
delivery behavior across channels.

## Link policy

- **Slack:** `[label](url)` -> `<url|label>`; bare URLs stay bare.
- **Telegram:** `[label](url)` -> `<a href="url">label</a>` (HTML parse mode).
- **Signal:** `[label](url)` -> `label (url)` unless the label already
  matches the URL.

## Spoilers

Spoiler markers (`||spoiler||`) are parsed for Signal (mapped to `SPOILER`
style ranges) and Telegram (mapped to `<tg-spoiler>`). Other channels treat
`||...||` as plain text.

## Adding or updating a channel formatter

1. **Parse once** with `markdownToIR(...)`, passing channel-appropriate
   options (`autolink`, `headingStyle`, `blockquotePrefix`, `tableMode`).
2. **Render** with `renderMarkdownWithMarkers(...)` and a style-marker map (or
   custom style-range logic for transports like Signal).
3. **Chunk** with `chunkMarkdownIR(...)` or
   `renderMarkdownIRChunksWithinLimit(...)` before rendering each chunk.
4. **Wire the adapter** to call the new chunker and renderer from the
   outbound send path.
5. **Test** with format tests plus an outbound delivery test if the channel
   chunks.

## Common gotchas

- Slack angle-bracket tokens (`<@U123>`, `<#C123>`, `<https://...>`) must
  survive escaping; raw HTML still needs to be escaped safely.
- Telegram HTML requires escaping text outside tags to avoid broken markup.
- Signal style ranges use UTF-16 offsets, not code-point offsets.
- Preserve trailing newlines on fenced code blocks so the closing marker
  lands on its own line.

## Related

<CardGroup cols={2}>
  <Card title="Streaming and chunking" href="/concepts/streaming" icon="bars-staggered">
    Outbound streaming behavior, chunk boundaries, and channel-specific delivery.
  </Card>
  <Card title="System prompt" href="/concepts/system-prompt" icon="message-lines">
    What the model sees before the conversation, including injected workspace files.
  </Card>
</CardGroup>
