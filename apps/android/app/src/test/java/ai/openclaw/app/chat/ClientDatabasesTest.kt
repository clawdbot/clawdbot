package ai.openclaw.app.chat

import android.database.sqlite.SQLiteDatabase
import kotlinx.coroutines.test.runTest
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import java.util.UUID

@RunWith(RobolectricTestRunner::class)
class ClientDatabasesTest {
  @Test
  fun deferredOutboxPersistsAtomicMutationDemotion() =
    runTest {
      val names = databaseNames()
      val databases = open(names, registeredGatewayIds = setOf("gateway-a"))
      try {
        val outbox = databases.commandOutbox()
        val scope = ChatOutboxScope("main", "main")
        val lease = requireNotNull(outbox.beginSessionMutation("gateway-a", scope, nowMs = 1_000))

        val state = requireNotNull(outbox.demoteSessionMutationToReconciliationState("gateway-a", scope, lease))

        assertTrue(state.needsReconciliation)
        assertNull(state.switchPendingSinceMs)
        val persisted = requireNotNull(outbox.branchState("gateway-a", scope))
        assertTrue(persisted.needsReconciliation)
        assertNull(persisted.switchPendingSinceMs)
      } finally {
        databases.close()
        delete(names)
      }
    }

  @Test
  fun v2DurableRowsImportIntoClientStateWhileLegacyCacheIsDiscarded() =
    runTest {
      val names = databaseNames()
      val context = RuntimeEnvironment.getApplication()
      createV2Fixture(context.getDatabasePath(names.legacy).path)

      val databases = open(names, registeredGatewayIds = setOf("gateway-test"))
      try {
        assertEquals(
          2,
          databases
            .gatewayCacheDatabase()
            .openHelper.writableDatabase.version,
        )
        assertEquals(
          1,
          databases
            .clientStateDatabase()
            .openHelper.writableDatabase.version,
        )

        val rows = databases.commandOutbox().load("gateway-test").associateBy { it.id }
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
        databases.commandOutbox().deleteForSession("gateway-test", "agent:ops:side", "ops")
        assertTrue(databases.commandOutbox().load("gateway-test").none { it.id == explicitOwner.id })

        val legacyCommand = rows.getValue("legacy-command")
        assertEquals(ChatOutboxStatus.Failed, legacyCommand.status)
        assertEquals(OUTBOX_GATED_EPOCH_NEVER, legacyCommand.gatedEpoch)
        assertEquals(OUTBOX_OWNER_CHANGED_ERROR, legacyCommand.lastError)

        // Legacy gateway snapshots are disposable and never cross into the new cache file.
        assertTrue(databases.transcriptCache().loadSessions("gateway-test", "main").isEmpty())
        assertTrue(databases.transcriptCache().loadTranscript("gateway-test", "main", "main").isEmpty())
        assertFalse(context.getDatabasePath(names.legacy).exists())
        assertTrue(context.getDatabasePath(names.cache).exists())
        assertTrue(context.getDatabasePath(names.state).exists())
      } finally {
        databases.close()
        delete(names)
      }
    }

  @Test
  fun v8AttachmentBytesAndAdmissionReceiptsImportOnceAndSurviveReopen() =
    runTest {
      val names = databaseNames()
      val context = RuntimeEnvironment.getApplication()
      createV2Fixture(context.getDatabasePath(names.legacy).path)
      val bytes = ByteArray((OUTBOX_ATTACHMENT_CHUNK_BYTES * 9) + 77) { (it % 127).toByte() }
      addV8AttachmentFixture(names.legacy, bytes)

      val first = open(names, registeredGatewayIds = setOf("gateway-test"))
      try {
        val loaded = first.commandOutbox().loadAttachments("media-command")
        assertEquals(1, loaded.size)
        assertTrue(bytes.contentEquals(loaded.single().bytes))
        assertTrue(first.commandOutbox().wasAdmitted("media-command"))
      } finally {
        first.close()
      }

      // A fresh open reads only client-state.db. The completion marker prevents a stale legacy
      // file from being imported twice if deletion was interrupted.
      val reopened = open(names, registeredGatewayIds = setOf("gateway-test"))
      try {
        val loaded = reopened.commandOutbox().loadAttachments("media-command")
        assertEquals(1, loaded.size)
        assertTrue(bytes.contentEquals(loaded.single().bytes))
        assertTrue(reopened.commandOutbox().wasAdmitted("media-command"))
      } finally {
        reopened.close()
        delete(names)
      }
    }

  @Test
  fun cacheFormatMismatchRebuildsWithoutTouchingClientState() =
    runTest {
      val names = databaseNames()
      val context = RuntimeEnvironment.getApplication()
      val first = open(names, registeredGatewayIds = setOf("gateway-a"))
      try {
        first.transcriptCache().saveTranscript(
          gatewayId = "gateway-a",
          agentId = "main",
          sessionKey = "main",
          messages = listOf(cachedMessage("cache me")),
        )
        assertTrue(
          first.commandOutbox().enqueue(
            gatewayId = "gateway-a",
            sessionKey = "main",
            text = "preserve me",
            thinkingLevel = "off",
            nowMs = 1,
            ownerAgentId = "main",
          ) is ChatOutboxEnqueueResult.Queued,
        )
      } finally {
        first.close()
      }

      SQLiteDatabase.openDatabase(context.getDatabasePath(names.cache).path, null, SQLiteDatabase.OPEN_READWRITE).use {
        it.version = 99
      }

      val reopened = open(names, registeredGatewayIds = setOf("gateway-a"))
      try {
        assertTrue(reopened.transcriptCache().loadTranscript("gateway-a", "main", "main").isEmpty())
        assertEquals(listOf("preserve me"), reopened.commandOutbox().load("gateway-a").map { it.text })
      } finally {
        reopened.close()
        delete(names)
      }
    }

  @Test
  fun clientStateFormatMismatchFailsClosedWithoutDeletingDurableFile() =
    runTest {
      val names = databaseNames()
      val context = RuntimeEnvironment.getApplication()
      val first = open(names, registeredGatewayIds = setOf("gateway-a"))
      try {
        seedGateway(first, "gateway-a", "preserve")
      } finally {
        first.close()
      }

      val statePath = context.getDatabasePath(names.state).path
      SQLiteDatabase.openDatabase(statePath, null, SQLiteDatabase.OPEN_READWRITE).use {
        it.version = 99
      }

      val failedOpen = open(names, registeredGatewayIds = setOf("gateway-a"))
      val failure = runCatching { failedOpen.clientStateDatabase() }
      failedOpen.close()
      assertTrue(failure.isFailure)
      assertTrue(context.getDatabasePath(names.state).exists())
      SQLiteDatabase.openDatabase(statePath, null, SQLiteDatabase.OPEN_READONLY).use {
        assertEquals(99, it.version)
      }
      delete(names)
    }

  @Test
  fun absentGatewayCommitsStagedRemovalAcrossBothDatabasesAndKeepsOtherGateway() =
    runTest {
      val names = databaseNames()
      val first = open(names, registeredGatewayIds = setOf("gateway-a", "gateway-b"))
      try {
        seedGateway(first, "gateway-a", "remove")
        seedGateway(first, "gateway-b", "keep")
        first.stageGatewayRemoval("gateway-a")
      } finally {
        first.close()
      }

      val reopened = open(names, registeredGatewayIds = setOf("gateway-b"))
      try {
        assertTrue(reopened.transcriptCache().loadTranscript("gateway-a", "main", "main").isEmpty())
        assertTrue(reopened.commandOutbox().load("gateway-a").isEmpty())
        assertEquals(listOf("keep"), reopened.transcriptCache().loadTranscript("gateway-b", "main", "main").map { it.content.single().text })
        assertEquals(listOf("keep"), reopened.commandOutbox().load("gateway-b").map { it.text })
      } finally {
        reopened.close()
        delete(names)
      }
    }

  @Test
  fun cachePendingRemovalNeverDeletesNewDurableRowsOnResume() =
    runTest {
      val names = databaseNames()
      val first = open(names, registeredGatewayIds = setOf("gateway-a", "gateway-b"))
      try {
        seedGateway(first, "gateway-a", "remove")
        seedGateway(first, "gateway-b", "keep")
        // Force only the disposable half to fail after the durable state transaction commits.
        first.gatewayCacheDatabase().close()
        first.commitGatewayRemoval("gateway-a")
        assertTrue(first.commandOutbox().load("gateway-a").isEmpty())
        assertTrue(
          first.commandOutbox().enqueue(
            gatewayId = "gateway-a",
            sessionKey = "main",
            text = "new after purge",
            thinkingLevel = "off",
            nowMs = 2,
            ownerAgentId = "main",
          ) is ChatOutboxEnqueueResult.Queued,
        )
        // A retry may stage again before restart; it must not downgrade cache-pending into a
        // cancelable marker that could strand the old derived rows.
        first.stageGatewayRemoval("gateway-a")
      } finally {
        first.close()
      }

      val reopened = open(names, registeredGatewayIds = setOf("gateway-a", "gateway-b"))
      try {
        assertTrue(reopened.transcriptCache().loadTranscript("gateway-a", "main", "main").isEmpty())
        assertEquals(listOf("new after purge"), reopened.commandOutbox().load("gateway-a").map { it.text })
        assertEquals(listOf("keep"), reopened.transcriptCache().loadTranscript("gateway-b", "main", "main").map { it.content.single().text })
        assertEquals(listOf("keep"), reopened.commandOutbox().load("gateway-b").map { it.text })
        assertTrue(
          reopened
            .clientStateDatabase()
            .controlDao()
            .gatewayRemovals()
            .isEmpty(),
        )
      } finally {
        reopened.close()
        delete(names)
      }
    }

  @Test
  fun stillRegisteredGatewayCancelsCancelableStagedRemoval() =
    runTest {
      val names = databaseNames()
      val first = open(names, registeredGatewayIds = setOf("gateway-a"))
      try {
        seedGateway(first, "gateway-a", "keep")
        first.stageGatewayRemoval("gateway-a")
      } finally {
        first.close()
      }

      val reopened = open(names, registeredGatewayIds = setOf("gateway-a"))
      try {
        assertEquals(listOf("keep"), reopened.transcriptCache().loadTranscript("gateway-a", "main", "main").map { it.content.single().text })
        assertEquals(listOf("keep"), reopened.commandOutbox().load("gateway-a").map { it.text })
      } finally {
        reopened.close()
        delete(names)
      }
    }

  private suspend fun seedGateway(
    databases: AndroidClientDatabases,
    gatewayId: String,
    text: String,
  ) {
    databases.transcriptCache().saveTranscript(
      gatewayId = gatewayId,
      agentId = "main",
      sessionKey = "main",
      messages = listOf(cachedMessage(text)),
    )
    assertTrue(
      databases.commandOutbox().enqueue(
        gatewayId = gatewayId,
        sessionKey = "main",
        text = text,
        thinkingLevel = "off",
        nowMs = 1,
        ownerAgentId = "main",
      ) is ChatOutboxEnqueueResult.Queued,
    )
  }

  private fun cachedMessage(text: String): ChatMessage =
    ChatMessage(
      id = "id-$text",
      role = "user",
      content = listOf(ChatMessageContent(type = "text", text = text)),
      timestampMs = 1,
    )

  private fun addV8AttachmentFixture(
    legacyName: String,
    bytes: ByteArray,
  ) {
    val context = RuntimeEnvironment.getApplication()
    val legacy = LegacyChatDatabase.open(context, legacyName)
    try {
      val database = legacy.openHelper.writableDatabase
      database.execSQL(
        "INSERT INTO outbox_commands " +
          "(id, gatewayId, sessionKey, text, thinkingLevel, createdAtMs, status, retryCount, lastError, gatedEpoch, ownerAgentId) " +
          "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        arrayOf<Any?>("media-command", "gateway-test", "main", "media", "off", 100L, "queued", 0, null, null, "main"),
      )
      database.execSQL(
        "INSERT INTO composer_send_admissions (id, gatewayId, ownerAgentId, sessionKey) VALUES (?, ?, ?, ?)",
        arrayOf<Any?>("media-command", "gateway-test", "main", "main"),
      )
      database.execSQL(
        "INSERT INTO outbox_attachments (id, commandId, position, type, mimeType, fileName, durationMs, byteLength) " +
          "VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
        arrayOf<Any?>("media-attachment", "media-command", 0, "image", "image/jpeg", "a.jpg", null, bytes.size.toLong()),
      )
      var offset = 0
      var index = 0
      while (offset < bytes.size) {
        val end = minOf(offset + OUTBOX_ATTACHMENT_CHUNK_BYTES, bytes.size)
        database.execSQL(
          "INSERT INTO outbox_attachment_chunks (attachmentId, chunkIndex, bytes) VALUES (?, ?, ?)",
          arrayOf<Any?>("media-attachment", index, bytes.copyOfRange(offset, end)),
        )
        offset = end
        index += 1
      }
    } finally {
      legacy.close()
    }
  }

  private fun open(
    names: DatabaseNames,
    registeredGatewayIds: Set<String>,
  ): AndroidClientDatabases =
    AndroidClientDatabases.start(
      RuntimeEnvironment.getApplication(),
      gatewayCacheName = names.cache,
      clientStateName = names.state,
      legacyName = names.legacy,
      registeredGatewayIds = registeredGatewayIds,
    )

  private fun databaseNames(): DatabaseNames {
    val id = UUID.randomUUID().toString()
    return DatabaseNames(
      cache = "gateway-cache-$id.db",
      state = "client-state-$id.db",
      legacy = "chat-transcript-cache-$id.db",
    )
  }

  private fun delete(names: DatabaseNames) {
    val context = RuntimeEnvironment.getApplication()
    context.deleteDatabase(names.cache)
    context.deleteDatabase(names.state)
    context.deleteDatabase(names.legacy)
  }

  private data class DatabaseNames(
    val cache: String,
    val state: String,
    val legacy: String,
  )

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
