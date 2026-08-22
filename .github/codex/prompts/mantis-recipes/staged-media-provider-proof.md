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
$lane finish --lane baseline --focus-message-id "$message_id"
```

For a reply-mention turn, first `send --media "$media"` without text, capture its
`.sent.messageId`, then `send --reply-to "$message_id" --text '@{sut} inspect this document'`.
A bare unmentioned upload stages the file but produces no provider turn.

Repeat for `candidate` with its returned message id, selecting `type == "input_file"`.
Assert the complete selected facts: `filename`, `mimeType`, and `byteLength` when present.
The structured facts are comparison evidence; never scrape `body` strings.

If baseline needs a tool round trip, take the tool argument from the recorded
`legacy_media.filename`. Build a complete response-events JSON array from
`toolCallEvents()` in `scripts/e2e/mock-openai-server.mjs`
(`response.output_item.added`, `response.function_call_arguments.delta`,
`response.output_item.done`, `response.completed`), then install it before the
next turn with `mock --lane baseline --response-events-file <public-json>`.
