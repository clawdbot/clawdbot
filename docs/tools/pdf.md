---
summary: "Analyze one or more PDF documents with native provider support and extraction fallback"
title: "PDF tool"
read_when:
  - You want to analyze PDFs from agents
  - You need exact pdf tool parameters and limits
  - You are debugging native PDF mode vs extraction fallback
---

`pdf` analyzes one or more PDF documents and returns text. It uses native document input on Anthropic and Google models, and falls back to text/image extraction for every other provider.

## Availability

The tool registers only when OpenClaw can resolve a PDF-capable model for the agent. Resolution order:

1. `agents.defaults.pdfModel` (explicit primary/fallbacks)
2. `agents.defaults.imageModel` (explicit primary/fallbacks)
3. The agent's resolved session/default model, if its provider supports native PDF input (Anthropic, Google) or already has a configured vision model
4. Auto-detected image/vision-capable providers with usable auth, preferring native-PDF providers first

Every fallback candidate is auth-checked before use, so a configured `provider/model` only counts if OpenClaw can authenticate that provider for the agent. If no usable model resolves, the `pdf` tool is not exposed.

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
Page filter like `1-5` or `1,3,7-9`. Not supported in native provider mode.
</ParamField>

<ParamField path="password" type="string">
Password for encrypted PDFs. Applies to every PDF in the request; only used by extraction fallback mode.
</ParamField>

<ParamField path="model" type="string">
Optional model override in `provider/model` form.
</ParamField>

<ParamField path="maxBytesMb" type="number">
Per-PDF size cap in MB. Defaults to `agents.defaults.pdfMaxMb`, or `10` if unset.
</ParamField>

Notes:

- `pdf` and `pdfs` are merged and deduplicated before loading; at least one is required.
- `pages` is parsed as 1-based page numbers, deduped, sorted, and clamped to `agents.defaults.pdfMaxPages` (default `20`). A range that matches no in-bounds pages errors before the model call.

## Supported PDF references

- Local file path (including `~` expansion)
- `file://` URL
- `http://` and `https://` URL
- OpenClaw-managed inbound refs such as `media://inbound/<id>`

Other URI schemes (for example `ftp://`) return `details.error = "unsupported_pdf_reference"`. Remote `http(s)` URLs are rejected when the tool runs sandboxed. With workspace-only file policy enabled, local paths outside allowed roots are rejected; managed inbound refs and replayed paths under OpenClaw's inbound media store are still allowed.

## Execution modes

### Native provider mode

Used for provider `anthropic` and `google` (the only providers that currently declare native PDF document support). Raw PDF bytes go directly to the provider API as a native document/inline-PDF part per file.

Limits:

- `pages` is not supported; if set, the tool throws `pages is not supported with native PDF providers`.
- `password` is not supported; if set, the tool throws `password is not supported with native PDF providers`. Use a non-native model for encrypted PDFs.

### Extraction fallback mode

Used for every other provider.

1. Extract text from the selected pages (up to `agents.defaults.pdfMaxPages`, default `20`) via the bundled `document-extract` plugin, which uses the `clawpdf` package (PDFium WebAssembly) for text and image extraction.
2. If the extracted text is shorter than `200` characters, render the same pages to PNG images. The render budget is `4,000,000` pixels total, shared across all pages needing images (allocated proportionally per remaining page, not per page), so text pages that already have enough text skip rendering entirely.
3. Send the extracted text (and any rendered images) plus the prompt to the selected model.

Details:

- Encrypted PDFs open with the top-level `password` parameter.
- If the model has no image input and there is no extractable text, the tool errors.
- If image rendering fails, OpenClaw drops the images and continues with the extracted text.
- If the target model is text-only and extraction produced images, OpenClaw drops the images and sends text only.

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

| Key                           | Default | Meaning                                                                                   |
| ----------------------------- | ------- | ----------------------------------------------------------------------------------------- |
| `agents.defaults.pdfModel`    | unset   | Explicit primary/fallback PDF models; falls back to `imageModel`, then the session model. |
| `agents.defaults.pdfMaxMb`    | `10`    | Per-PDF size cap in MB.                                                                   |
| `agents.defaults.pdfMaxPages` | `20`    | Max pages processed per PDF.                                                              |

See [Configuration Reference](/gateway/config-agents#agent-defaults) for full field details.

## Output details

The tool returns text in `content[0].text` and structured metadata in `details`.

Common `details` fields:

- `model`: resolved model ref (`provider/model`)
- `native`: `true` for native provider mode, `false` for fallback
- `attempts`: fallback attempts that failed before success

Path fields:

- Single PDF input: `details.pdf`
- Multiple PDF inputs: `details.pdfs[]` with `pdf` entries
- Sandbox path rewrite metadata (when applicable): `rewrittenFrom`

## Error behavior

| Condition                         | Result                                                         |
| --------------------------------- | -------------------------------------------------------------- |
| No PDF input                      | Throws `pdf required: provide a path or URL to a PDF document` |
| More than 10 PDFs                 | `details.error = "too_many_pdfs"`                              |
| Unsupported reference scheme      | `details.error = "unsupported_pdf_reference"`                  |
| `pages` with a native provider    | Throws `pages is not supported with native PDF providers`      |
| `password` with a native provider | Throws `password is not supported with native PDF providers`   |

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

Encrypted PDF with extraction fallback:

```json
{
  "pdf": "/tmp/locked.pdf",
  "password": "example-password",
  "model": "openai/gpt-5.4-mini",
  "prompt": "Summarize this contract"
}
```

## Related

- [Tools Overview](/tools) - all available agent tools
- [Configuration Reference](/gateway/config-agents#agent-defaults) - pdfMaxBytesMb and pdfMaxPages config
