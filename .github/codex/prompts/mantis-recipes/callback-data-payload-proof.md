# Callback data payload proof

Use when a button looks identical but its callback bytes or follow-up Bot API
payload changed.

```bash
lane="$OPENCLAW_TELEGRAM_MANTIS_LANE_CMD"
$lane start --lane baseline --repo-root "$MANTIS_BASELINE_ROOT" --config "$config"
$lane turn --lane baseline --text '@{sut} show the callback button' --observe-seconds 30
$lane press --lane baseline --message-id "$bot_message_id" --button 0
$lane observe --lane baseline --seconds 60 --until-events "$expected_event_count"
$lane botapi-requests --lane baseline --method answerCallbackQuery --limit 20
$lane botapi-requests --lane baseline --method editMessageText --limit 20
$lane finish --lane baseline --focus-message-id "$bot_message_id"
```

Repeat for `candidate`, using each lane's returned bot message id. Proof facts:
compare parsed `requestBody` values for `answerCallbackQuery` and
`editMessageText`, including exact callback-related strings and whitespace.
Screenshots establish identical visible context; a material recorded payload-byte
difference is the comparison evidence.
