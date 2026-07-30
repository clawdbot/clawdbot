# OpenClaw Recovery Readiness

## Recovery objectives

- Production configuration and application code: recovery point objective (RPO) 24 hours; recovery time objective (RTO) 2 hours.
- PostgreSQL application data: RPO 24 hours until database backups run more frequently; RTO 4 hours.
- Reference documents on external storage: RPO 24 hours; RTO 8 hours.
- A backup older than 2 days is not healthy.

## Isolated PostgreSQL restore rehearsal

1. Select the newest PostgreSQL dump with a matching checksum.
2. Copy it to a temporary rehearsal directory on development storage.
3. Start an isolated PostgreSQL container with no production network, volume, or credentials.
4. Restore into a new rehearsal database.
5. Validate schema version, table counts, foreign keys, and representative read-only queries.
6. Run PropertyManager API smoke tests against the rehearsal database with writes confined to test records.
7. Record dump identity, checksum, start/end time, validation results, and cleanup result.
8. Destroy only the temporary rehearsal container and volume.

The rehearsal must never mount the production database volume or write to the
production database. A successful archive listing is not a database restore
proof.

## Current readiness gaps

- The full production archive is generated less frequently than the 2-day target.
- The newest Dashboard/PropertyManager archive is checksum-valid and readable,
  but the weekly verification report predates it.
- Existing PostgreSQL dumps are deployment checkpoints, not a current scheduled
  database-backup chain.
- The Dashboard/PropertyManager archive includes a Python virtual environment;
  future backups should exclude reproducible dependencies and include a current
  PostgreSQL dump plus schema metadata.

## Acceptance evidence

A recovery checkpoint is acceptable only when the archive checksum passes, the
archive can be listed, the PostgreSQL dump restores in isolation, representative
queries pass, and the measured RPO/RTO are recorded.
