import GRDB

extension OpenClawClientDatabases {
    static func registerClientStateMigrationsV1ThroughV5(_ migrator: inout DatabaseMigrator) {
        migrator.registerMigration("client-state-v1") { db in
            try db.execute(sql: """
            CREATE TABLE forgotten_gateways(
                gateway_hash TEXT NOT NULL PRIMARY KEY,
                gateway_id TEXT,
                forgotten_at REAL NOT NULL,
                cleanup_phase INTEGER NOT NULL CHECK(cleanup_phase IN (0, 1, 2, 3)),
                restore_finalized INTEGER NOT NULL DEFAULT 0
                    CHECK(restore_finalized IN (0, 1)),
                CHECK((cleanup_phase IN (1, 2) AND gateway_id IS NOT NULL) OR
                      (cleanup_phase IN (0, 3) AND gateway_id IS NULL AND restore_finalized = 0))
            );
            CREATE TABLE gateway_routing_identity(
                gateway_id TEXT NOT NULL PRIMARY KEY,
                scope TEXT NOT NULL,
                main_session_key TEXT NOT NULL,
                default_agent_id TEXT NOT NULL,
                updated_at REAL NOT NULL
            );
                CREATE TABLE outbox_commands(
                    enqueue_sequence INTEGER PRIMARY KEY AUTOINCREMENT,
                    gateway_id TEXT NOT NULL,
                    client_uuid TEXT NOT NULL,
                session_key TEXT NOT NULL,
                delivery_session_key TEXT NOT NULL,
                routing_contract TEXT NOT NULL,
                agent_id TEXT NOT NULL,
                text TEXT NOT NULL,
                thinking TEXT NOT NULL,
                created_at REAL NOT NULL,
                status TEXT NOT NULL CHECK(status IN (
                    'queued', 'sending', 'awaiting_confirmation', 'failed'
                )),
                    retry_count INTEGER NOT NULL DEFAULT 0,
                    last_error TEXT NOT NULL DEFAULT '',
                    attachment_bytes INTEGER NOT NULL DEFAULT 0,
                    UNIQUE(gateway_id, client_uuid)
                );
                CREATE INDEX outbox_commands_delivery_order
                    ON outbox_commands(gateway_id, created_at, enqueue_sequence);
            CREATE TABLE outbox_attachments(
                gateway_id TEXT NOT NULL,
                command_id TEXT NOT NULL,
                position INTEGER NOT NULL,
                type TEXT NOT NULL,
                mime_type TEXT NOT NULL,
                file_name TEXT NOT NULL,
                payload BLOB NOT NULL,
                duration_seconds REAL,
                PRIMARY KEY(gateway_id, command_id, position),
                FOREIGN KEY(gateway_id, command_id)
                    REFERENCES outbox_commands(gateway_id, client_uuid)
                    ON DELETE CASCADE
                    ON UPDATE CASCADE
            );
            """)
        }
        // Additive branch ownership remains local client state. Older app
        // builds ignore these fields while newer builds fail replay closed.
        migrator.registerMigration("client-state-branch-ownership-v2") { db in
            try db.execute(sql: """
            ALTER TABLE outbox_commands ADD COLUMN branch_epoch INTEGER NOT NULL DEFAULT 0;
            ALTER TABLE outbox_commands ADD COLUMN attempt_version INTEGER NOT NULL DEFAULT 1;
            ALTER TABLE outbox_commands ADD COLUMN parked_was_accepted INTEGER NOT NULL DEFAULT 0;
            CREATE TABLE outbox_branch_scopes(
                gateway_id TEXT NOT NULL,
                session_key TEXT NOT NULL,
                agent_id TEXT NOT NULL DEFAULT '',
                branch_epoch INTEGER NOT NULL DEFAULT 0,
                last_active_leaf_id TEXT,
                switch_pending_since REAL,
                needs_reconciliation INTEGER NOT NULL DEFAULT 0,
                PRIMARY KEY(gateway_id, session_key, agent_id)
            );
            """)
        }
        migrator.registerMigration("client-state-branch-revision-v3") { db in
            try db.execute(sql: """
            ALTER TABLE outbox_branch_scopes
                ADD COLUMN branch_state_revision INTEGER NOT NULL DEFAULT 0;
            """)
        }
        migrator.registerMigration("client-state-agent-id-v4") { db in
            try db.execute(sql: "UPDATE outbox_commands SET agent_id = '' WHERE agent_id IS NULL")
            try db.execute(sql: "UPDATE outbox_branch_scopes SET agent_id = '' WHERE agent_id IS NULL")
        }
        migrator.registerMigration("client-state-outbox-attempt-scope-v5") { db in
            try db
                .execute(
                    sql: "ALTER TABLE outbox_commands ADD COLUMN had_unacknowledged_send INTEGER NOT NULL DEFAULT 0")
            // Legacy rows with prior attempts may have reached the gateway before a
            // transport failure; without this evidence a post-park retry would reuse an
            // idempotency key the old branch may already own.
            try db.execute(
                sql: """
                UPDATE outbox_commands SET had_unacknowledged_send = 1
                WHERE retry_count > 0 OR status IN ('sending', 'awaiting_confirmation')
                """)
            try db.execute(sql: """
            INSERT OR IGNORE INTO outbox_branch_scopes(
                gateway_id, session_key, agent_id, branch_epoch, needs_reconciliation
            )
            SELECT gateway_id, session_key, agent_id, 0, 1 FROM outbox_commands
            """)
        }
    }

    static func registerClientStateMigrationsV6ThroughV8(_ migrator: inout DatabaseMigrator) {
        migrator.registerMigration("client-state-outbox-attachment-rekey-v6") { db in
            try db.execute(sql: """
            CREATE TABLE outbox_attachments_v6(
                gateway_id TEXT NOT NULL,
                command_id TEXT NOT NULL,
                position INTEGER NOT NULL,
                type TEXT NOT NULL,
                mime_type TEXT NOT NULL,
                file_name TEXT NOT NULL,
                payload BLOB NOT NULL,
                duration_seconds REAL,
                PRIMARY KEY(gateway_id, command_id, position),
                FOREIGN KEY(gateway_id, command_id)
                    REFERENCES outbox_commands(gateway_id, client_uuid)
                    ON DELETE CASCADE
                    ON UPDATE CASCADE
            );
            INSERT INTO outbox_attachments_v6(
                gateway_id, command_id, position, type, mime_type, file_name, payload, duration_seconds
            )
            SELECT gateway_id, command_id, position, type, mime_type, file_name, payload, duration_seconds
            FROM outbox_attachments;
            DROP TABLE outbox_attachments;
            ALTER TABLE outbox_attachments_v6 RENAME TO outbox_attachments;
            """)
        }
        // A queued command owns the authority it was captured under. Legacy
        // rows remain NULL so CAS-capable replay can park them for review.
        migrator.registerMigration("client-state-outbox-settings-expectation-v7") { db in
            try db.execute(sql: """
            ALTER TABLE outbox_commands ADD COLUMN expected_settings_json TEXT;
            """)
        }
        migrator.registerMigration("client-state-outbox-settings-claim-v8") { db in
            try db.execute(sql: """
            ALTER TABLE outbox_commands ADD COLUMN settings_retry_authorization INTEGER;
            CREATE TRIGGER outbox_settings_claim_guard
            BEFORE UPDATE OF status ON outbox_commands
            WHEN OLD.status = 'queued' AND NEW.status = 'sending'
                AND COALESCE(NEW.settings_retry_authorization, 0) =
                    COALESCE(OLD.settings_retry_authorization, 0)
            BEGIN
                UPDATE outbox_commands
                SET status = 'failed', last_error = 'settings_client_upgrade_required'
                WHERE gateway_id = OLD.gateway_id AND client_uuid = OLD.client_uuid
                    AND status = 'queued';
                SELECT RAISE(IGNORE);
            END;
            CREATE TRIGGER outbox_settings_retry_guard
            BEFORE UPDATE OF status ON outbox_commands
            WHEN OLD.status = 'failed' AND NEW.status = 'queued'
                AND COALESCE(NEW.settings_retry_authorization, 0) =
                    COALESCE(OLD.settings_retry_authorization, 0)
            BEGIN
                SELECT RAISE(ABORT, 'settings-fenced outbox retry requires current client');
            END;
            """)
        }
    }
}
