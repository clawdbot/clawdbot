# Generated Docs Artifacts

SHA-256 hash files are the tracked drift-detection artifacts. Full baselines are
generated locally for inspection only.

**Tracked (committed to git):**

- `config-baseline.sha256` — hashes of config baseline JSON artifacts.
- `plugin-sdk-api-baseline.sha256` — hashes of Plugin SDK API baseline artifacts.
- `sqlite-session-transcript-schema-baseline.sha256` — hash of the sessions/transcripts SQLite schema baseline.

**Local only (gitignored):**

- `config-baseline.json`, `config-baseline.core.json`, `config-baseline.channel.json`, `config-baseline.plugin.json`
- `plugin-sdk-api-baseline.json`, `plugin-sdk-api-baseline.jsonl`
- `.artifacts/sqlite-session-transcript-schema-baseline.sql`

Do not edit any of these files by hand.

- Regenerate config baseline: `pnpm config:docs:gen`
- Validate config baseline: `pnpm config:docs:check`
- Regenerate Plugin SDK API baseline: `pnpm plugin-sdk:api:gen`
- Validate Plugin SDK API baseline: `pnpm plugin-sdk:api:check`
- Regenerate SQLite sessions/transcripts schema baseline: `pnpm sqlite:sessions-schema:gen`
- Validate SQLite sessions/transcripts schema baseline: `pnpm sqlite:sessions-schema:check`
