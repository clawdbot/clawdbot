# Generated Docs Artifacts

Generated contract files are tracked drift-detection artifacts. Full pretty
snapshots remain local inspection artifacts.

**Tracked (committed to git):**

- `config-baseline.sha256` — hashes of config baseline JSON artifacts.
- `config-baseline.counts.json` — maximum entry counts for each config baseline kind.
- `sqlite-session-transcript-schema-baseline.sha256` — hash of the sessions/transcripts SQLite schema baseline.

**Local only (gitignored):**

- `config-baseline.json`, `config-baseline.core.json`, `config-baseline.channel.json`, `config-baseline.plugin.json`
- `.artifacts/sqlite-session-transcript-schema-baseline.sql`

Do not edit any of these files by hand.

- Regenerate config baseline: `pnpm config:docs:gen`
- Validate config baseline: `pnpm config:docs:check`
- Regenerate SQLite sessions/transcripts schema baseline: `pnpm sqlite:sessions-schema:gen`
- Validate SQLite sessions/transcripts schema baseline: `pnpm sqlite:sessions-schema:check`
