# Matrix SQLite fixtures

`matrix-account-v2026.7.1.sqlite.gz.base64` is an account-scoped state database made with OpenClaw
2026.7.1 at commit `2d2ddc43d0dcf71f31283d780f9fe9ff4cc04fe4`.

The database started from the repository's released 2026.7.1 shared-state fixture. The 2026.7.1
Matrix storage metadata and sync-cache owners then wrote one synthetic account and cursor through
their production store APIs. The fixture has schema version 1, 73 tables, zero `STRICT` tables,
three Matrix rows, and an `ok` integrity check.

The file contains a wrapped Base64 encoding of the gzip bytes so code review can inspect the full
pull request without a binary-file exception.

- Compressed SHA-256: `2bbfc5b55c083a1532ac1162baa9a01a886b2bd6f17fb060c6794b2a10f7aeb0`
- Raw SHA-256: `d8a543808fe9d4ae3cd989bbae9cb5e3c425fe5ecf8322309e08787fd87ec7f6`
