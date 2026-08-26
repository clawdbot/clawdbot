# SQLite Release Fixtures

`openclaw-state-v2026.7.1-2.sqlite.gz` is a deterministic fixture for the
shared state database created by OpenClaw tag `v2026.7.1-2` at commit
`0790d9f593ad30c940ed93b5872a8cf6d6f3cf8c`.

The tagged runtime, whose package version is `2026.7.1`, created the database
with Node `v26.7.0` and SQLite `3.51.0`. The fixture then received fixed
synthetic rows for durable state, audit sequence preservation, diagnostic
ordering, task foreign keys, and cron history import. It contains no commitment
rows because their retention policy is tracked separately in issue #129547.
Metadata timestamps are fixed, the WAL is checkpointed, and the database is
vacuumed before deterministic Node `gzipSync(raw, { level: 9, mtime: 0 })`
compression.

The sorted `sqlite_schema` rows are byte-identical to a database initialized
from `src/state/openclaw-state-schema.sql` at the commit above. Synthetic data
and metadata normalization do not alter the released schema.

Fixture contract:

- raw SQLite SHA-256:
  `17807b83d33115fb9e523ae40a829d9177c8cab2ae3cb2ac872318a573fc0269`
- gzip SHA-256:
  `62c2e22acc5b0d9d7a2d4c8afeb17735c5ef526593c937499614d9aba2ffd2f4`
- sorted `sqlite_schema` SHA-256:
  `f2fd6488e283470718547fb45886f04cc940b1de798e52fbf34a3a3408ae25e4`
- 73 application tables
- 103 named indexes
- zero `STRICT` tables
