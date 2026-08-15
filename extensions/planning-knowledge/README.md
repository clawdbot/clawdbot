# Planning Knowledge plugin

This optional OpenClaw tool plugin provides private retrieval from, and
explicit capture into, the Planning-owned personal Knowledge corpus. Retrieval
uses OneLibrary's existing CLI; capture uses Planning's narrow
`knowledge_notes.py create` writer and then refreshes the derived index.

Configure explicit paths for:

- OneLibrary's `planning_knowledge_index.py`;
- the canonical `notes/knowledge/` root; and
- the derived `planning_personal` index; and
- optionally Planning's `knowledge_notes.py` writer to enable capture.

The plugin never accepts a caller-controlled filesystem path, crawls
`config/secrets/`, or writes outside the Planning writer's canonical
`notes/knowledge/` boundary. Retrieval results retain the portable canonical
citation `note:notes/knowledge/<slug>`.

Without `writerScriptPath`, the capture tool remains recognition-only and
returns `capture_not_enabled_in_pln_500a`. With the Planning writer configured,
an explicit capture creates or retries one canonical note, refreshes only the
derived OneLibrary index, and returns the canonical `note:` ref. Mixed request
follow-ups are reported as `route_separately`; this plugin never creates tasks
or calendar events.
