# Busy queue with scripted provider responses

Use when two turns overlap and response order or queue draining is under test.

Write `provider-script.json`:

```json
{
  "responses": [
    { "text": "slow first response", "chunkDelayMs": 5000 },
    { "text": "distinct second response" }
  ]
}
```

Then run each lane without changing provider controls mid-flight:

```bash
sha="$(sha256sum "$MANTIS_OUTPUT_DIR/provider-script.json" | cut -d ' ' -f1)"
lane="$OPENCLAW_TELEGRAM_MANTIS_LANE_CMD"
$lane start --lane baseline --repo-root "$MANTIS_BASELINE_ROOT" --config "$config"
$lane mock --lane baseline --script "$MANTIS_OUTPUT_DIR/provider-script.json" "$sha"
$lane send --lane baseline --text '@{sut} turn one'
$lane send --lane baseline --text '@{sut} turn two'
$lane observe --lane baseline --seconds 60 --until-text 'distinct second response' --until-provider-requests 2
$lane requests --lane baseline
$lane finish --lane baseline
```

Repeat for `candidate`. Proof facts: session events and recorded Bot API
messages show the slow first and distinct second outcomes without a
control-file race. The tamper-evident provider request facts (`scriptEntry` 0
then 1, turn order in bodies) independently prove provider arrival order.
