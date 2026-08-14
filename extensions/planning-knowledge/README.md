# Planning Knowledge plugin

This optional OpenClaw tool plugin provides read-only retrieval from the
Planning-owned personal Knowledge corpus through OneLibrary's existing CLI.

Configure explicit paths for:

- OneLibrary's `planning_knowledge_index.py`;
- the canonical `notes/knowledge/` root; and
- the derived `planning_personal` index.

The plugin never crawls the Goal_Agent repository, reads `config/secrets/`,
or writes Planning files. Retrieval results retain the portable canonical
citation `note:notes/knowledge/<slug>`.

In PLN-500A, the capture tool only recognizes an explicit save-as-Knowledge
request and returns `capture_not_enabled_in_pln_500a`; it performs no write
and does not turn the request into a task.
