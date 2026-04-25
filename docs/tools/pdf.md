---
summary: "Analyze one or more PDF documents with native provider support and extraction fallback"
title: "PDF tool"
read_when:
  - You want to analyze PDFs from agents
  - You need exact pdf tool parameters and limits
  - You are debugging native PDF mode vs extraction fallback
---

`pdf` analyzes one or more PDF documents and returns text.

Quick behavior:

- Native provider mode for Anthropic and Google model providers.
- Extraction fallback mode for other providers (extract text first, then page images when needed).
- Supports single (`pdf`) or multi (`pdfs`) input, max 10 PDFs per call.

## Availability

The tool is only registered when OpenClaw can resolve a PDF-capable model config for the agent:

1. `agents.defaults.pdfModel`
2. fallback to `agents.defaults.imageModel`
3. fallback to the agent's resolved session/default model
4. if native-PDF providers are auth-backed, prefer them ahead of generic image fallback candidates

If no usable model can be resolved, the `pdf` tool is not exposed.

Availability notes:

- The fallback chain is auth-aware. A configured `provider/model` only counts if
  OpenClaw can actually authenticate that provider for the agent.
- Native PDF providers are currently **Anthropic** and **Google**.
- If the resolved session/default provider already has a configured vision/PDF
  model, the PDF tool reuses that before falling back to other auth-backed
  providers.

## Input reference

<ParamField path="pdf" type="string">
One PDF path or URL.
</ParamField>

<ParamField path="pdfs" type="string[]">
Multiple PDF paths or URLs, up to 10 total.
</ParamField>

<ParamField path="prompt" type="string" default="Analyze this PDF document.">
Analysis prompt.
</ParamField>

<ParamField path="pages" type="string">
Page filter like `1-5` or `1,3,7-9`.
</ParamField>

<ParamField path="model" type="string">
Optional model override in `provider/model` form.
</ParamField>

<ParamField path="maxBytesMb" type="number">
Per-PDF size cap in MB. Defaults to `agents.defaults.pdfMaxBytesMb` or `10`.
</ParamField>

Input notes:

- `pdf` and `pdfs` are merged and deduplicated before loading.
- If no PDF input is provided, the tool errors.
- `pages` is parsed as 1-based page numbers, deduped, sorted, and clamped to the configured max pages.
- `maxBytesMb` defaults to `agents.defaults.pdfMaxBytesMb` or `10`.

## Supported PDF references

- local file path (including `~` expansion)
- `file://` URL
- `http://` and `https://` URL
- OpenClaw-managed inbound refs such as `media://inbound/<id>`

Reference notes:

- Other URI schemes (for example `ftp://`) are rejected with `unsupported_pdf_reference`.
- In sandbox mode, remote `http(s)` URLs are rejected.
- With workspace-only file policy enabled, local file paths outside allowed roots are rejected.
- Managed inbound refs and replayed paths under OpenClaw's inbound media store are allowed with workspace-only file policy.

## Execution modes

### Native provider mode

Native mode is used for provider `anthropic` and `google`.
The tool sends raw PDF bytes directly to provider APIs.

Native mode limits:

- `pages` is not supported. If set, the tool returns an error.
- Multi-PDF input is supported; each PDF is sent as a native document block /
  inline PDF part before the prompt.

### Extraction fallback mode

Fallback mode is used for non-native providers.

Flow:

1. Extract text from selected pages (up to `agents.defaults.pdfMaxPages`, default `20`).
2. If extracted text length is below `200` chars, render selected pages to PNG images and include them.
3. Send extracted content plus prompt to the selected model.

Fallback details:

- Page image extraction uses a pixel budget of `4,000,000`.
- If the target model does not support image input and there is no extractable text, the tool errors.
- If text extraction succeeds but image extraction would require vision on a
  text-only model, OpenClaw drops the rendered images and continues with the
  extracted text.
- Extraction fallback uses the bundled `document-extract` plugin. The plugin owns
  `pdfjs-dist`; `@napi-rs/canvas` is used only when image rendering fallback is
  available.

## Config

```json5
{
  agents: {
    defaults: {
      pdfModel: {
        primary: "anthropic/claude-opus-4-6",
        fallbacks: ["openai/gpt-5.4-mini"],
      },
      pdfMaxBytesMb: 10,
      pdfMaxPages: 20,
    },
  },
}
```

See [Configuration Reference](/gateway/configuration-reference) for full field details.

## Output details

The tool returns text in `content[0].text` and structured metadata in `details`.

Common `details` fields:

- `model`: resolved model ref (`provider/model`)
- `native`: `true` for native provider mode, `false` for fallback
- `attempts`: fallback attempts that failed before success

Path fields:

- single PDF input: `details.pdf`
- multiple PDF inputs: `details.pdfs[]` with `pdf` entries
- sandbox path rewrite metadata (when applicable): `rewrittenFrom`

## Error behavior

- Missing PDF input: throws `pdf required: provide a path or URL to a PDF document`
- Too many PDFs: returns structured error in `details.error = "too_many_pdfs"`
- Unsupported reference scheme: returns `details.error = "unsupported_pdf_reference"`
- Native mode with `pages`: throws clear `pages is not supported with native PDF providers` error

## Examples

Single PDF:

```json
{
  "pdf": "/tmp/report.pdf",
  "prompt": "Summarize this report in 5 bullets"
}
```

Multiple PDFs:

```json
{
  "pdfs": ["/tmp/q1.pdf", "/tmp/q2.pdf"],
  "prompt": "Compare risks and timeline changes across both documents"
}
```

Page-filtered fallback model:

```json
{
  "pdf": "https://example.com/report.pdf",
  "pages": "1-3,7",
  "model": "openai/gpt-5.4-mini",
  "prompt": "Extract only customer-impacting incidents"
}
```

## Related

- [Tools Overview](/tools) — all available agent tools
- [Configuration Reference](/gateway/config-agents#agent-defaults) — pdfMaxBytesMb and pdfMaxPages config
