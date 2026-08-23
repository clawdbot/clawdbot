# Send failure injection

Use when the change affects Telegram send failure handling, retrying, or visible
failure evidence.

```bash
lane="$OPENCLAW_TELEGRAM_MANTIS_LANE_CMD"
$lane start --lane baseline --repo-root "$MANTIS_BASELINE_ROOT" --config "$config"
$lane botapi-fail sendMessage --lane baseline --times 2 --status 429
$lane send --lane baseline --text '@{sut} prove send failure handling'
$lane observe --lane baseline --seconds 60 --until-provider-requests 1
$lane botapi-requests --lane baseline --method sendMessage --limit 20
$lane finish --lane baseline
```

Repeat with `candidate` and `MANTIS_CANDIDATE_ROOT`. Proof facts: two ordered
`sendMessage` entries with `status:429` and `injected:true`, followed by any retry
or recovery call; lane events/screenshots show the corresponding visible outcome.
Use `botapi-clear` only when the scenario needs recovery before finishing.
