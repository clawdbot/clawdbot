[whatsapp-baileys] emitting messages.upsert event for 1 messages (id: 3E9A284F9B3C7...)
[whatsapp-ingress] Normalized inbound direct message: "hello bot" from +12148767847
[whatsapp-access] checkInboundAccessControl: Evaluated dmPolicy=allow for +12148767847
[whatsapp-access] Resolved replyRate 0.35 from exact match +12148767847
[whatsapp-access] MD5 hash of msg.key.id modulo 1.0 = 0.42. Threshold is 0.35.
[whatsapp-access] 🚨 Message suppressed due to probabilistic reply rate. (0.42 >= 0.35)
[channel-drain] Forwarding completed ingress event with { reason: "reply_rate_suppressed" }
[durable-queue] Executed query: UPDATE channel_ingress_events SET status = \completed, completed_metadata_json = \{reason:reply_rate_suppressed} WHERE event_id = \3E9A284F9B3C7\n

# SQLite direct tombstone verification

# sqlite3 openclaw.sqlite -json "SELECT event_id, status, completed_metadata_json FROM channel_ingress_events WHERE event_id = \3E9A284F9B3C7;"

[
{
"event_id": "3E9A284F9B3C7",
"status": "completed",
"completed_metadata_json": "{\"reason\":\"reply_rate_suppressed\"}"
}
]
