package ai.openclaw.app.chat

import android.database.sqlite.SQLiteDatabase
import kotlinx.coroutines.test.runTest
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import java.util.UUID

@RunWith(RobolectricTestRunner::class)
class ChatCacheDatabaseMigrationTest {
  @Test
  fun v2AmbiguousRowsMigrateToManualOnlyAndPreservePristineQueue() =
    runTest {
      val context = RuntimeEnvironment.getApplication()
      val databaseName = "chat-cache-migration-${UUID.randomUUID()}.db"
      val databaseFile = context.getDatabasePath(databaseName)
      databaseFile.parentFile?.mkdirs()
      createV2Fixture(databaseFile.path)

      val database = ChatCacheDatabase.open(context, databaseName)
      try {
        // Opening through Room executes the production migration chain and validates the
        // complete v8 schema, including columns, nullability, primary keys, and indices.
        assertEquals(8, database.openHelper.writableDatabase.version)

        val outbox = RoomChatCommandOutbox(database)
        val rows = outbox.load("gateway-test").associateBy { it.id }
        val pristine = rows.getValue("pristine")
        assertEquals(ChatOutboxStatus.Failed, pristine.status)
        assertEquals(OUTBOX_OWNER_CHANGED_ERROR, pristine.lastError)
        assertNull(pristine.ownerAgentId)
        assertNull(pristine.gatedEpoch)
        assertTrue(pristine.attachments.isEmpty())

        for (id in listOf("legacy-queued-error", "interrupted-send")) {
          val migrated = rows.getValue(id)
          assertEquals(ChatOutboxStatus.Failed, migrated.status)
          assertEquals(OUTBOX_DELIVERY_UNCONFIRMED_ERROR, migrated.lastError)
        }
        val alreadyFailed = rows.getValue("already-failed")
        assertEquals(ChatOutboxStatus.Failed, alreadyFailed.status)
        assertEquals("original failure", alreadyFailed.lastError)
        val accepted = rows.getValue("accepted")
        assertEquals(ChatOutboxStatus.Failed, accepted.status)
        assertEquals(OUTBOX_DELIVERY_UNCONFIRMED_ERROR, accepted.lastError)
        val explicitOwner = rows.getValue("explicit-owner")
        assertEquals(ChatOutboxStatus.Queued, explicitOwner.status)
        assertEquals("ops", explicitOwner.ownerAgentId)
        outbox.deleteForSession("gateway-test", "agent:ops:side", "ops")
        assertTrue(outbox.load("gateway-test").none { it.id == explicitOwner.id })
        // Legacy queued command-shaped rows predate connection epochs; the sentinel keeps
        // them from silently replaying on the next reconnect (they park for explicit retry).
        val legacyCommand = rows.getValue("legacy-command")
        assertEquals(ChatOutboxStatus.Failed, legacyCommand.status)
        assertEquals(OUTBOX_GATED_EPOCH_NEVER, legacyCommand.gatedEpoch)
        assertEquals(OUTBOX_OWNER_CHANGED_ERROR, legacyCommand.lastError)
        // Legacy session and transcript rows have no trustworthy agent owner. Both disposable
        // caches are rebuilt instead of exposing another agent's metadata or history.
        assertTrue(database.dao().sessions("gateway-test", "main").isEmpty())
        assertTrue(database.dao().messages("gateway-test", "main", "main").isEmpty())
      } finally {
        database.close()
        context.deleteDatabase(databaseName)
      }
    }

  @Test
  fun upgradedStoreSupportsAttachmentsAndSurvivesReopen() =
    runTest {
      val context = RuntimeEnvironment.getApplication()
      val databaseName = "chat-cache-migration-${UUID.randomUUID()}.db"
      val databaseFile = context.getDatabasePath(databaseName)
      databaseFile.parentFile?.mkdirs()
      createV2Fixture(databaseFile.path)

      // Spans multiple chunks to prove chunked reassembly is byte-exact after a real upgrade.
      val bytes = ByteArray(OUTBOX_ATTACHMENT_CHUNK_BYTES + 77) { (it % 127).toByte() }
      val queuedId: String
      val first = ChatCacheDatabase.open(context, databaseName)
      try {
        val queued =
          RoomChatCommandOutbox(first).enqueue(
            gatewayId = "gateway-test",
            sessionKey = "main",
            text = "post-upgrade media",
            thinkingLevel = "off",
            nowMs = System.currentTimeMillis(),
            ownerAgentId = "main",
            attachments =
              listOf(
                OutboxAttachmentPayload(type = "image", mimeType = "image/jpeg", fileName = "a.jpg", durationMs = null, bytes = bytes),
              ),
          ) as ChatOutboxEnqueueResult.Queued
        queuedId = queued.item.id
      } finally {
        first.close()
      }

      // Process-restart analog: a fresh open must recover the exact bytes.
      val reopened = ChatCacheDatabase.open(context, databaseName)
      try {
        val loaded = RoomChatCommandOutbox(reopened).loadAttachments(queuedId)
        assertEquals(1, loaded.size)
        assertTrue(bytes.contentEquals(loaded.single().bytes))
      } finally {
        reopened.close()
        context.deleteDatabase(databaseName)
      }
    }

  private fun createV2Fixture(path: String) {
    SQLiteDatabase.openOrCreateDatabase(path, null).use { database ->
      val now = System.currentTimeMillis()
      database.execSQL(
        "CREATE TABLE IF NOT EXISTS `cached_sessions` " +
          "(`gatewayId` TEXT NOT NULL, `sessionKey` TEXT NOT NULL, `displayName` TEXT, " +
          "`updatedAtMs` INTEGER, `rowOrder` INTEGER NOT NULL, PRIMARY KEY(`gatewayId`, `sessionKey`))",
      )
      database.execSQL(
        "CREATE TABLE IF NOT EXISTS `cached_messages` " +
          "(`gatewayId` TEXT NOT NULL, `sessionKey` TEXT NOT NULL, `rowOrder` INTEGER NOT NULL, " +
          "`role` TEXT NOT NULL, `textPartsJson` TEXT NOT NULL, `timestampMs` INTEGER, " +
          "`idempotencyKey` TEXT, PRIMARY KEY(`gatewayId`, `sessionKey`, `rowOrder`))",
      )
      database.execSQL(
        "CREATE TABLE IF NOT EXISTS `outbox_commands` " +
          "(`id` TEXT NOT NULL, `gatewayId` TEXT NOT NULL, `sessionKey` TEXT NOT NULL, " +
          "`text` TEXT NOT NULL, `thinkingLevel` TEXT NOT NULL, `createdAtMs` INTEGER NOT NULL, " +
          "`status` TEXT NOT NULL, `retryCount` INTEGER NOT NULL, `lastError` TEXT, PRIMARY KEY(`id`))",
      )
      database.execSQL(
        "INSERT INTO cached_sessions " +
          "(gatewayId, sessionKey, displayName, updatedAtMs, rowOrder) VALUES (?, ?, ?, ?, ?)",
        arrayOf<Any?>("gateway-test", "main", "Cached session", 10L, 0),
      )
      database.execSQL(
        "INSERT INTO cached_messages " +
          "(gatewayId, sessionKey, rowOrder, role, textPartsJson, timestampMs, idempotencyKey) " +
          "VALUES (?, ?, ?, ?, ?, ?, ?)",
        arrayOf<Any?>("gateway-test", "main", 0, "assistant", "[\"legacy transcript\"]", 10L, null),
      )
      insertOutbox(database, id = "pristine", status = "queued", retryCount = 0, lastError = null, createdAtMs = now)
      insertOutbox(
        database,
        id = "legacy-queued-error",
        status = "queued",
        retryCount = 0,
        lastError = "socket closed after send",
        createdAtMs = now + 1,
      )
      insertOutbox(
        database,
        id = "interrupted-send",
        status = "sending",
        retryCount = 1,
        lastError = null,
        createdAtMs = now + 2,
      )
      insertOutbox(
        database,
        id = "already-failed",
        status = "failed",
        retryCount = 3,
        lastError = "original failure",
        createdAtMs = now + 3,
      )
      insertOutbox(
        database,
        id = "legacy-command",
        status = "queued",
        retryCount = 0,
        lastError = null,
        createdAtMs = now + 4,
        text = "/clear",
      )
      insertOutbox(
        database,
        id = "accepted",
        status = "accepted",
        retryCount = 0,
        lastError = null,
        createdAtMs = now + 5,
      )
      insertOutbox(
        database,
        id = "explicit-owner",
        status = "queued",
        retryCount = 0,
        lastError = null,
        createdAtMs = now + 6,
        sessionKey = "agent:ops:side",
      )
      database.version = 2
    }
  }

  private fun insertOutbox(
    database: SQLiteDatabase,
    id: String,
    status: String,
    retryCount: Int,
    lastError: String?,
    createdAtMs: Long,
    text: String = id,
    sessionKey: String = "main",
  ) {
    database.execSQL(
      "INSERT INTO outbox_commands " +
        "(id, gatewayId, sessionKey, text, thinkingLevel, createdAtMs, status, retryCount, lastError) " +
        "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
      arrayOf<Any?>(id, "gateway-test", sessionKey, text, "off", createdAtMs, status, retryCount, lastError),
    )
  }
}
