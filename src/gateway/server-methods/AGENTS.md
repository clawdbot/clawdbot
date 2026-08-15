# Gateway Server Methods Notes

- agent session transcripts are a `parentId` chain/DAG; never append raw `type: "message"` entries via JSONL writes (missing `parentId` can sever the leaf path and break compaction/history). Always write transcript messages via `SessionManager.appendMessage(...)` (or a wrapper that uses it).
