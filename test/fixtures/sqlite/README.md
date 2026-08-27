# SQLite Release Fixtures

`openclaw-state-v2026.7.1-2.sqlite.gz` is a deterministic fixture for the
shared state database created by OpenClaw tag `v2026.7.1-2` at commit
`0790d9f593ad30c940ed93b5872a8cf6d6f3cf8c`.

The tagged runtime, whose package version is `2026.7.1`, created the database
with Node `v26.7.0` and SQLite `3.51.0`. The fixture then received fixed
synthetic rows for durable state, audit sequence preservation, diagnostic
ordering, task foreign keys, cron history import, and one representative
commitment. The commitment exists solely to prove irreversible retirement of
shipped commitment data; it is not archived or exported. Metadata timestamps
are fixed, the WAL is checkpointed, and the database is vacuumed before
deterministic Node `gzipSync(raw, { level: 9, mtime: 0 })` compression.

The sorted `sqlite_schema` rows are byte-identical to a database initialized
from `src/state/openclaw-state-schema.sql` at the commit above. Synthetic data
and metadata normalization do not alter the released schema.

Fixture contract:

- raw SQLite SHA-256:
  `8511bb91f02d104f818c70b08397a678045d04741c931b0ee7ce6650b5519e85`
- gzip SHA-256:
  `c775499d9a46462ae2368090a0c4ec75877784c40694046dd3af63df77b8737c`
- sorted `sqlite_schema` SHA-256:
  `f2fd6488e283470718547fb45886f04cc940b1de798e52fbf34a3a3408ae25e4`
- 73 application tables
- 103 named indexes
- zero `STRICT` tables
