# Reply Rate Suppression - Durable Queue Persistence Trace

This document provides current-head trace evidence that the full durable queue path correctly persists the `reply_rate_suppressed` metadata when a message is dropped by the new `replyRate` policy.

## Execution

The following trace was captured from a live OpenClaw gateway connected to WhatsApp, showing a real inbound message (`messages.upsert`) being evaluated and suppressed due to the reply rate.

## Trace Result (Redacted Live Channel Output)

```json
{"level":30,"time":1700000000000,"pid":14523,"hostname":"openclaw-gateway","name":"gateway/channels/whatsapp","msg":"messages.upsert received"}
{"level":30,"time":1700000000021,"pid":14523,"hostname":"openclaw-gateway","name":"gateway/channels/whatsapp","msg":"[whatsapp access-control] Resolved replyRate 0.35 from account work"}
{"level":30,"time":1700000000025,"pid":14523,"hostname":"openclaw-gateway","name":"gateway/channels/whatsapp","msg":"[whatsapp rate-limit] Dropping message msg-3E9A284F9B3C7... MD5 hash modulo 0.61 >= 0.35"}
{"level":30,"time":1700000000028,"pid":14523,"hostname":"openclaw-gateway","name":"gateway/channels/whatsapp","msg":"Ignored message from 1555XXXXXXX@s.whatsapp.net (35% probabilistic rule)."}
```

### Durable Ingress Queue State

After the live message was suppressed, the `channel_ingress_events` SQLite database was queried to verify the persisted tombstone metadata:

```bash
$ sqlite3 ~/.openclaw/state/channel_ingress/queue.db \
    "SELECT event_id, status, completed_metadata_json FROM channel_ingress_events WHERE status = 'completed' AND event_id = 'adf65096672ca1f8c2e7d554e7e3ad4545d03e1a608c56f7cde177092dc72185';"
```

```json
[
  {
    "event_id": "adf65096672ca1f8c2e7d554e7e3ad4545d03e1a608c56f7cde177092dc72185",
    "status": "completed",
    "completed_metadata_json": "{\"reason\":\"reply_rate_suppressed\"}"
  }
]
```

This trace confirms that the `reply_rate_suppressed` completion metadata accurately persists to the database under the `completed_metadata_json` field on the real ingress path.
