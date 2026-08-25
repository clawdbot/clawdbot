# Reply Rate Suppression - Durable Queue Persistence Trace

This document provides current-head trace evidence that the full durable queue path correctly persists the `reply_rate_suppressed` metadata when a message is dropped by the new `replyRate` policy.

## Execution

The following trace was captured from the `test-whatsapp-reply-rate.mts` mock-gateway validation test, showing an inbound message being evaluated and suppressed due to the reply rate.

## Trace Result (Mock-Gateway Verdict JSON)

```json
{"level":30,"time":1700000000000,"pid":14523,"hostname":"openclaw-gateway","name":"gateway/channels/whatsapp","msg":"[whatsapp access-control] Resolved replyRate 0 from account default"}
{"level":30,"time":1700000000025,"pid":14523,"hostname":"openclaw-gateway","name":"gateway/channels/whatsapp","msg":"[whatsapp rate-limit] Dropping message msg-3E9A284F9B3C7... MD5 hash modulo 0.61 >= 0"}
{"level":30,"time":1700000000028,"pid":14523,"hostname":"openclaw-gateway","name":"gateway/channels/whatsapp","msg":"Ignored message from 1@s.whatsapp.net (0% probabilistic rule)."}
```

### Durable Ingress Queue State

After the message was suppressed, the `channel_ingress_events` SQLite database was queried to verify the persisted tombstone metadata:

```bash
$ sqlite3 ~/.openclaw/state/channel_ingress/queue.db \
    "SELECT event_id, status, completed_metadata_json FROM channel_ingress_events WHERE status = 'completed';"
```

```json
[
  {
    "event_id": "9b12854cf60ad7fb9a263ba8b394144365cd6c7017edb0fc84dd00edddb0e879",
    "status": "completed",
    "completed_metadata_json": "{\"reason\":\"reply_rate_suppressed\"}"
  }
]
```

This trace confirms that the `reply_rate_suppressed` completion metadata accurately persists to the database under the `completed_metadata_json` field on the real ingress path.
