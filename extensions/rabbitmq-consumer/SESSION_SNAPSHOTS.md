# Conversation snapshots

New RabbitMQ chat runs save their Pi transcripts under the configured agent
sessions directory:

```text
agents/rabbitmq-<user_id>/sessions/<history_messages.session_id>/<history_messages.id>.jsonl
```

Before each run, the consumer copies the active transcript byte for byte into the
new row's file, then updates `sessions.json` to select it. The run appends its user,
assistant, and tool entries through OpenClaw's normal session machinery. Each
completed file therefore contains the conversation through that turn and can be
opened independently by Pi's SessionManager. Internal session and entry IDs stay
unchanged to preserve parent links and the existing context prefix.

Existing transcripts are not renamed, moved, or deleted. When an existing
conversation continues, its old transcript supplies the initial context for the
first new snapshot. Later turns leave earlier snapshots unchanged. A retry may
continue its currently selected file, but cannot overwrite an older snapshot.

The consumer prepares snapshots between serialized chat turns. It verifies that
the database record belongs to the requested user and session, rejects unsafe
directory names and linked transcript files, and locks the source while copying.
A preparation failure prevents the new agent run from starting.
