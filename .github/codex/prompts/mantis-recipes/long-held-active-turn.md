# Long-held active turn

Use when a second Telegram turn must wait behind an active turn for more than 300 seconds.

Write `public-config.json`:

```text
{"mockResponse":"unused","configPatch":{"agents":{"defaults":{"timeoutSeconds":600}},"models":{"providers":{"openai":{"timeoutSeconds":600}}}}}
```

Write `long-exec-events.json`:

```text
[{"type":"response.output_item.added","item":{"type":"function_call","id":"fc_long","call_id":"call_long","name":"exec","arguments":""}},{"type":"response.function_call_arguments.delta","delta":"{\"language\":\"javascript\",\"code\":\"return \\\"MANTIS-FIRST-EXEC-DONE\\\";\"}"},{"type":"response.output_item.done","item":{"type":"function_call","id":"fc_long","call_id":"call_long","name":"exec","arguments":"{\"language\":\"javascript\",\"code\":\"return \\\"MANTIS-FIRST-EXEC-DONE\\\";\"}"}},{"type":"response.completed","response":{"id":"resp_long","status":"completed","output":[{"type":"function_call","id":"fc_long","call_id":"call_long","name":"exec","arguments":"{\"language\":\"javascript\",\"code\":\"return \\\"MANTIS-FIRST-EXEC-DONE\\\";\"}"}],"usage":{"input_tokens":64,"output_tokens":16,"total_tokens":80,"input_tokens_details":{"cached_tokens":0}}}}]
```

Write `provider-script.json` beside the events file:

```text
{"responses":[{"eventsFile":"long-exec-events.json"},{"text":"MANTIS-FIRST-LONG-START MANTIS-FIRST-LONG-DONE","chunkDelayMs":330000},{"text":"MANTIS-SECOND-SURVIVED"}],"default":{"text":"MANTIS-UNEXPECTED-EXTRA"}}
```

- Do not ask `observe` for more than 60 seconds; loop up to eight 60-second calls.
- Do not put `chunkDelayMs` on a `/v1/responses` request with `body.stream === false`; that JSON branch bypasses `writeDefaultResponseEvents`, whose delay runs only before streamed `response.output_text.delta` events after the first.
- Do not use an unawaited Code Mode `setTimeout` to hold the turn; pending timers do not keep `exec` alive.
- Do not rely on timeout defaults; pin both keys to 600 through `start --config` (current main: 48-hour agent-run default, 120-second cloud-model idle default).

Then run both lanes:

```bash
out="$MANTIS_OUTPUT_DIR"; lane="$OPENCLAW_TELEGRAM_MANTIS_LANE_CMD"
config="$out/public-config.json"; script="$out/provider-script.json"
sha="$(sha256sum "$script" | cut -d ' ' -f1)"
run_lane() {
  local name="$1" root="$2" second_id i
  $lane start --lane "$name" --repo-root "$root" --config "$config"
  $lane mock --lane "$name" --script "$script" "$sha"
  $lane send --lane "$name" --text '@{sut} MANTIS queue proof turn one'
  sleep 2
  second_id="$($lane send --lane "$name" --text '@{sut} MANTIS queue proof turn two' | jq -er '.revealedMessageId')"
  $lane observe --lane "$name" --seconds 30 --until-provider-requests 1
  for i in {1..8}; do
    $lane observe --lane "$name" --seconds 60 --until-provider-requests 2 --until-text 'MANTIS-SECOND-SURVIVED' >"$out/$name-observe-$i.json"
    $lane requests --lane "$name" >"$out/$name-requests-current.json"
    $lane observe --lane "$name" --seconds 0 --since 0 >"$out/$name-full-current.json"
    jq -e '(.requests | length) >= 3' "$out/$name-requests-current.json" >/dev/null && jq -e '(.events | tostring | contains("MANTIS-SECOND-SURVIVED"))' "$out/$name-full-current.json" >/dev/null && break
  done
  $lane requests --lane "$name"
  $lane botapi-requests --lane "$name" --method sendMessage
  $lane exec --lane "$name" --command "grep -E 'claim.*adoption stalled|queued behind an active turn|spooled update|retry limit|MANTIS' gateway.log | tail -n 80 || true"
  $lane view --lane "$name" --message-id "$second_id"
  $lane screenshot --lane "$name"
  $lane finish --lane "$name" --focus-message-id "$second_id"
}
run_lane baseline "$MANTIS_BASELINE_ROOT"
run_lane candidate "$MANTIS_CANDIDATE_ROOT"
```

Proof facts: three ordered provider requests show the `exec` call, its follow-up, and the queued turn; the long response holds the active turn for about 333 seconds. Provider requests, `sendMessage` records, gateway log lines, and the focused second message show whether `MANTIS-SECOND-SURVIVED` arrived after the 300-second watchdog window.
