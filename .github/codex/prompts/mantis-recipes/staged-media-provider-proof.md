# Staged media provider proof

Use when a change alters how an uploaded document or image reaches the provider.

```bash
lane="$OPENCLAW_TELEGRAM_MANTIS_LANE_CMD"
media="$MANTIS_OUTPUT_DIR/sample.pdf"
sent="$($lane send --lane baseline --media "$media" --text '@{sut} inspect this document')"
message_id="$(jq -er '.sent.messageId' <<<"$sent")"
$lane observe --lane baseline --seconds 60 --until-provider-requests 1
requests="$($lane requests --lane baseline)"
jq -e '[.requests[].contentFacts[]? | select(.type == "legacy_media")] | length > 0' \
  <<<"$requests"
```

With no tool round trip, finish now using `message_id`. Otherwise continue below;
`finish` stops the lane.

For a reply-mention turn, first `send --media "$media"` without text, capture its
`.sent.messageId`, then `send --reply-to "$message_id" --text '@{sut} inspect this document'`.
A bare unmentioned upload stages the file but produces no provider turn.

Repeat for `candidate` with its returned message id, selecting `type == "input_file"`.
Assert the complete selected facts: `filename`, `mimeType`, and `byteLength` when present.
The structured facts are comparison evidence; never scrape `body` strings.

For a PDF tool round trip, start each lane with this patch. `pdf` is already in
the Code Mode catalog; `document-extract` lets the mock OpenAI route execute it.

```json
{ "configPatch": { "plugins": { "allow": ["telegram", "openai", "document-extract"] } } }
```

Replace `<legacy_media.filename>` below with the recorded value and save the
array as `pdf-exec-events.json` under `MANTIS_OUTPUT_DIR`:

```json
[
  {
    "type": "response.output_item.added",
    "item": {
      "type": "function_call",
      "id": "fc_mantis_pdf_exec",
      "call_id": "call_mantis_pdf_exec",
      "name": "exec",
      "arguments": ""
    }
  },
  {
    "type": "response.function_call_arguments.delta",
    "delta": "{\"language\":\"javascript\",\"code\":\"return await pdf({ pdf: \\\"<legacy_media.filename>\\\", prompt: \\\"Inspect this PDF.\\\" });\"}"
  },
  {
    "type": "response.output_item.done",
    "item": {
      "type": "function_call",
      "id": "fc_mantis_pdf_exec",
      "call_id": "call_mantis_pdf_exec",
      "name": "exec",
      "arguments": "{\"language\":\"javascript\",\"code\":\"return await pdf({ pdf: \\\"<legacy_media.filename>\\\", prompt: \\\"Inspect this PDF.\\\" });\"}"
    }
  },
  {
    "type": "response.completed",
    "response": {
      "id": "resp_mantis_pdf_exec",
      "status": "completed",
      "output": [
        {
          "type": "function_call",
          "id": "fc_mantis_pdf_exec",
          "call_id": "call_mantis_pdf_exec",
          "name": "exec",
          "arguments": "{\"language\":\"javascript\",\"code\":\"return await pdf({ pdf: \\\"<legacy_media.filename>\\\", prompt: \\\"Inspect this PDF.\\\" });\"}"
        }
      ],
      "usage": {
        "input_tokens": 64,
        "output_tokens": 16,
        "total_tokens": 80,
        "input_tokens_details": { "cached_tokens": 0 }
      }
    }
  }
]
```

Save this beside it as `pdf-exec-script.json`, install the two-response script,
then send the tool-driven turn:

```json
{
  "responses": [
    { "eventsFile": "pdf-exec-events.json" },
    { "text": "PDF tool round trip complete." }
  ]
}
```

```bash
script="$MANTIS_OUTPUT_DIR/pdf-exec-script.json"
sha256="$(sha256sum "$script" | cut -d ' ' -f 1)"
$lane mock --lane baseline --script "$script" "$sha256"
tool_sent="$($lane send --lane baseline --text '@{sut} inspect the staged PDF with the pdf tool')"
tool_message_id="$(jq -er '.sent.messageId' <<<"$tool_sent")"
$lane observe --lane baseline --seconds 120 --until-provider-requests 4
requests="$($lane requests --lane baseline)"
jq -e '[.requests[] | .body.input[]? | select(.type == "function_call_output"
  and .call_id == "call_mantis_pdf_exec")] | length > 0' <<<"$requests"
$lane finish --lane baseline --focus-message-id "$tool_message_id"
```

`finish` tears the lane down, so wait for the cumulative provider-request count
(staging turn, exec turn, the pdf tool's own model call, follow-up) and assert
the recorded `function_call_output` before finishing; its `output` carries the
serialized exec result. The pdf tool's model call consumes the script's second
response; the follow-up then repeats the exhausted script's last entry, which
is fine. The pdf tool's request is where the lanes diverge: compare its
`contentFacts` for `input_file` versus extracted text. Repeat the same script,
turn, wait, and assertions for `candidate`.
