package ai.openclaw.app.chat

import ai.openclaw.app.ui.chat.buildChatTimeline
import ai.openclaw.app.ui.chat.readerPosition
import ai.openclaw.app.ui.chat.restoredChatReaderTransition
import android.database.sqlite.SQLiteDatabase
import androidx.room3.RoomDatabase
import androidx.room3.executeSQL
import androidx.room3.useReaderConnection
import androidx.room3.useWriterConnection
import androidx.room3.withWriteTransaction
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.CoroutineStart
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.async
import kotlinx.coroutines.cancel
import kotlinx.coroutines.currentCoroutineContext
import kotlinx.coroutines.launch
import kotlinx.coroutines.test.runTest
import kotlinx.coroutines.withContext
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
  fun readerBookmarksReopenWithV1StateAndQueuedInputIntact() =
    runTest {
      val names = databaseNames()
      val original = ChatReaderPositionScope("gateway-a", "main", "main", "session-a")
      val scopes = listOf(original, original.copy(gatewayId = "gateway-b"), original.copy(ownerAgentId = "other"), original.copy(sessionKey = "side"))
      val largeMessages =
        (0..1).map { index ->
          ChatMessage(id = "before-$index", role = "assistant", content = listOf(ChatMessageContent(text = "x".repeat(20_000))), timestampMs = 1, entryId = if (index == 0) "canonical" else null)
        }
      val positions =
        scopes.indices.map { index ->
          if (index < 2) {
            requireNotNull(buildChatTimeline(listOf(largeMessages[index]), 0, emptyList(), null).readerPosition(0, index + 17))
          } else {
            ChatReaderPosition("message-$index", index + 17, entryId = "entry-$index")
          }
        }
      withDatabases(names) { databases ->
        val readers = databases.readerPositionStore()
        for ((index, scope) in scopes.withIndex()) {
          readers.save(requireNotNull(readers.bind(scope)), positions[index])
        }
        databases.enqueue("gateway-a", "keep queued input")
      }
      val file = RuntimeEnvironment.getApplication().getDatabasePath(names.state)
      SQLiteDatabase.openDatabase(file.path, null, SQLiteDatabase.OPEN_READWRITE).use { oldReader ->
        assertEquals(1, oldReader.version)
        oldReader.rawQuery("SELECT identity_hash FROM room_master_table WHERE id = 42", null).use { rows ->
          assertTrue(rows.moveToFirst())
          assertEquals("924cec9afdb455dced2592399a08f5da", rows.getString(0))
        }
        oldReader.execSQL("INSERT INTO client_state_metadata VALUES ('old-reader', 'still writable')")
      }
      withCleanDatabases(names) { databases ->
        assertEquals(3, databases.gatewayCacheDatabase().userVersion())
        assertEquals("still writable", databases.clientStateDatabase().controlDao().metadataValue("old-reader"))
        assertEquals(listOf("keep queued input"), databases.commandOutbox().load("gateway-a").map { it.text })
        for ((index, scope) in scopes.withIndex()) {
          val saved = requireNotNull(databases.readerPositionStore().bind(scope)?.position)
          assertEquals(positions[index], saved)
          if (index < 2) {
            val timeline = buildChatTimeline(listOf(largeMessages[index].copy(id = "after-$index")), 0, emptyList(), null)
            assertEquals(index + 17, requireNotNull(restoredChatReaderTransition(timeline, saved)).scrollOffset)
          }
        }
        assertNull(databases.readerPositionStore().bind(original.copy(sessionId = "replacement"))?.position)
      }
    }

  @Test
  fun reboundAndDeletedReadersCannotOverwriteTheCurrentBookmark() =
    runTest {
      withCleanDatabases(databaseNames()) { databases ->
        val readers = databases.readerPositionStore()
        val oldScope = ChatReaderPositionScope("gateway-a", "main", "main", "old")
        val old = requireNotNull(readers.bind(oldScope))
        readers.save(old, ChatReaderPosition("old-message", 17))
        val currentScope = oldScope.copy(sessionId = "new")
        val current = requireNotNull(readers.bind(currentScope))
        assertNull(current.position)
        val expected = ChatReaderPosition("new-message", 23)
        readers.save(current, expected)
        readers.save(old, null)
        readers.save(old, ChatReaderPosition("late-old-message", 2))
        readers.deleteSession(oldScope)
        assertEquals(expected, readers.bind(currentScope)?.position)

        val rebound = requireNotNull(readers.bind(currentScope))
        readers.save(current, null)
        readers.save(rebound, null)
        assertNull(databases.clientStateDatabase().controlDao().metadataValue(chatReaderPositionMetadataKey("gateway-a")))
        readers.save(rebound, expected)
        readers.deleteSession(currentScope)
        readers.save(rebound, ChatReaderPosition("after-delete", 1))
        assertNull(readers.bind(currentScope)?.position)
      }
    }

  @Test
  fun readerRetirementWaitsForTheInFlightSaveAndRejectsLateWrites() =
    runTest {
      for (wholeGateway in listOf(false, true)) {
        withCleanDatabases(databaseNames()) { databases ->
          val readers = databases.readerPositionStore()
          val scope = ChatReaderPositionScope("gateway-a", "main", "main", "session-a")
          val binding = requireNotNull(readers.bind(scope))
          val other = scope.copy(gatewayId = "gateway-b")
          val preserved = ChatReaderPosition("other-gateway", 11)
          readers.save(requireNotNull(readers.bind(other)), preserved)
          val writerEntered = CompletableDeferred<Unit>()
          val releaseWriter = CompletableDeferred<Unit>()
          withContext(Dispatchers.IO) {
            val writer =
              async {
                databases.clientStateDatabase().withWriteTransaction {
                  writerEntered.complete(Unit)
                  releaseWriter.await()
                }
              }
            writerEntered.await()
            val save = async(start = CoroutineStart.UNDISPATCHED) { readers.save(binding, ChatReaderPosition("in-flight", 7)) }
            val retire =
              async(start = CoroutineStart.UNDISPATCHED) {
                if (wholeGateway) databases.commitGatewayRemoval("gateway-a") else readers.deleteSession(scope)
              }
            val rebound = async(start = CoroutineStart.UNDISPATCHED) { readers.bind(scope) }
            try {
              assertFalse(save.isCompleted)
              assertFalse(retire.isCompleted)
              assertFalse(rebound.isCompleted)
            } finally {
              releaseWriter.complete(Unit)
            }
            writer.await()
            save.await()
            retire.await()
            assertNull(rebound.await()?.position)
          }
          readers.save(binding, ChatReaderPosition("late", 3))
          assertNull(readers.bind(scope)?.position)
          assertEquals(preserved, readers.bind(other)?.position)
          if (wholeGateway) {
            assertNull(readers.bind(scope))
            assertFalse(readers.activateGateway("gateway-a") { false })
            assertNull(readers.bind(scope))
            assertTrue(readers.activateGateway("gateway-a") { true })
            readers.save(requireNotNull(readers.bind(scope)), preserved)
            assertEquals(preserved, readers.bind(scope)?.position)
          }
        }
      }
    }

  @Test
  fun startupRemovalCompletesBeforeTheSingleReaderStoreIsPublished() =
    runTest {
      val names = databaseNames()
      val scope = ChatReaderPositionScope("gateway-a", "main", "main", "session-a")
      withDatabases(names) { databases ->
        val readers = databases.readerPositionStore()
        readers.save(requireNotNull(readers.bind(scope)), ChatReaderPosition("before-removal", 12))
        databases.stageGatewayRemoval("gateway-a")
      }
      withCleanDatabases(names, registeredGatewayIds = emptySet()) { databases ->
        val readers = databases.readerPositionStore()
        assertNull(readers.bind(scope))
        assertFalse(readers.activateGateway("gateway-a") { false })
        assertTrue(readers.activateGateway("gateway-a") { true })
        assertNull(readers.bind(scope)?.position)
      }
    }

  @Test
  fun readerMetadataIsBoundedAndMalformedDataDoesNotPreventBinding() =
    runTest {
      withCleanDatabases(databaseNames()) { databases ->
        val readers = databases.readerPositionStore()
        val scope = ChatReaderPositionScope("gateway-a", "main", "session-0", "session-a")
        repeat(MAX_CACHED_SESSIONS + 1) { index ->
          readers.save(requireNotNull(readers.bind(scope.copy(sessionKey = "session-$index"))), ChatReaderPosition("entry", index))
        }
        assertNull(readers.bind(scope)?.position)
        assertEquals(ChatReaderPosition("entry", MAX_CACHED_SESSIONS), readers.bind(scope.copy(sessionKey = "session-$MAX_CACHED_SESSIONS"))?.position)
        val control = databases.clientStateDatabase().controlDao()
        for (invalid in listOf("not json", "{}", "x".repeat(256 * 1_024 + 1))) {
          control.upsertMetadata(ClientStateMetadataEntity(chatReaderPositionMetadataKey("gateway-a"), invalid))
          assertNull(readers.bind(scope)?.position)
        }
      }
    }

  @Test
  fun exactDeletionRetiresAnUncachedBookmarkWithoutTouchingOtherReaders() =
    runTest {
      withCleanDatabases(databaseNames()) { databases ->
        val readers = databases.readerPositionStore()
        val old = ChatReaderPositionScope("gateway-a", "main", "older-chat", "old-instance")
        val other = old.copy(sessionKey = "other-chat", sessionId = "other-instance")
        readers.save(requireNotNull(readers.bind(old)), ChatReaderPosition("old-entry", 17))
        readers.save(requireNotNull(readers.bind(other)), ChatReaderPosition("other-entry", 23))
        assertTrue(databases.transcriptCache().loadSessions("gateway-a", "main").isEmpty())
        val deletionFinished = CompletableDeferred<Unit>()
        val controller =
          createChatController(
            transcriptCache = databases.transcriptCache(),
            cacheScope = { ChatCacheScope("gateway-a", 1) },
            onSessionDeleted = { deletion ->
              launch {
                readers.deleteSession(ChatReaderPositionScope(requireNotNull(deletion.gatewayId), deletion.agentId, deletion.sessionKey, requireNotNull(deletion.sessionId)))
                deletionFinished.complete(Unit)
              }
            },
          )
        controller.handleGatewayEvent("sessions.changed", """{"reason":"delete","sessionKey":"older-chat","agentId":"main","sessionId":"old-instance"}""")
        // Room runs on IO: draining only the test scheduler is not completion of the deletion.
        deletionFinished.await()
        assertNull(readers.bind(old)?.position)
        assertEquals(ChatReaderPosition("other-entry", 23), readers.bind(other)?.position)
      }
    }

  @Test
  fun deferredOutboxPersistsAtomicMutationDemotion() =
    runTest {
      val names = databaseNames()
      val scope = ChatOutboxScope("main", "main")
      withDatabases(names) { databases ->
        val outbox = databases.commandOutbox()
        val lease = requireNotNull(outbox.beginSessionMutation("gateway-a", scope, nowMs = 1_000))

        val state = requireNotNull(outbox.demoteSessionMutationToReconciliationState("gateway-a", scope, lease))

        assertTrue(state.needsReconciliation)
        assertNull(state.switchPendingSinceMs)
      }
      withCleanDatabases(names) { reopened ->
        val persisted = requireNotNull(reopened.commandOutbox().branchState("gateway-a", scope))
        assertTrue(persisted.needsReconciliation)
        assertNull(persisted.switchPendingSinceMs)
      }
    }

  @Test
  fun v2DurableRowsImportIntoClientStateWhileLegacyCacheIsDiscarded() =
    runTest {
      val names = databaseNames()
      val context = RuntimeEnvironment.getApplication()
      createV2Fixture(context.getDatabasePath(names.legacy).path)

      withCleanDatabases(names, setOf("gateway-test")) { databases ->
        assertEquals(3, databases.gatewayCacheDatabase().userVersion())
        assertEquals(1, databases.clientStateDatabase().userVersion())

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

      withDatabases(names, setOf("gateway-test")) { first ->
        val loaded = first.commandOutbox().loadAttachments("media-command")
        assertEquals(1, loaded.size)
        assertTrue(bytes.contentEquals(loaded.single().bytes))
        assertTrue(first.commandOutbox().wasAdmitted("media-command"))
      }

      // Recreate stale legacy state to model an interrupted deletion after the import committed.
      createV2Fixture(context.getDatabasePath(names.legacy).path)
      addV8AttachmentFixture(names.legacy, byteArrayOf(99))
      withCleanDatabases(names, setOf("gateway-test")) { reopened ->
        val loaded = reopened.commandOutbox().loadAttachments("media-command")
        assertEquals(1, loaded.size)
        assertTrue(bytes.contentEquals(loaded.single().bytes))
        assertTrue(reopened.commandOutbox().wasAdmitted("media-command"))
        assertFalse(context.getDatabasePath(names.legacy).exists())
      }
    }

  @Test
  fun cacheFormatMismatchRebuildsWithoutTouchingClientState() =
    runTest {
      val names = databaseNames()
      val context = RuntimeEnvironment.getApplication()
      withDatabases(names) { first ->
        first.transcriptCache().saveTranscript(
          gatewayId = "gateway-a",
          agentId = "main",
          sessionKey = "main",
          messages = listOf(cachedMessage("cache me")),
        )
        first.enqueue("gateway-a", "preserve me")
      }

      SQLiteDatabase.openDatabase(context.getDatabasePath(names.cache).path, null, SQLiteDatabase.OPEN_READWRITE).use {
        it.version = 99
      }

      withCleanDatabases(names) { reopened ->
        assertTrue(reopened.transcriptCache().loadTranscript("gateway-a", "main", "main").isEmpty())
        assertEquals(listOf("preserve me"), reopened.commandOutbox().load("gateway-a").map { it.text })
      }
    }

  @Test
  fun clientStateFormatMismatchFailsClosedWithoutDeletingDurableFile() =
    runTest {
      val names = databaseNames()
      val context = RuntimeEnvironment.getApplication()
      withDatabases(names) { first ->
        seedGateway(first, "gateway-a", "preserve")
      }

      val statePath = context.getDatabasePath(names.state).path
      SQLiteDatabase.openDatabase(statePath, null, SQLiteDatabase.OPEN_READWRITE).use {
        it.version = 99
      }

      val failedOpen = open(names)
      val failure = runCatching { failedOpen.clientStateDatabase() }
      failedOpen.close()
      assertTrue(failure.isFailure)
      assertTrue(context.getDatabasePath(names.state).exists())
      SQLiteDatabase.openDatabase(statePath, null, SQLiteDatabase.OPEN_READONLY).use {
        assertEquals(99, it.version)
        it.rawQuery("SELECT text FROM outbox_commands", null).use { rows ->
          assertTrue(rows.moveToFirst())
          assertEquals("preserve", rows.getString(0))
        }
      }
      delete(names)
    }

  @Test
  fun cancelledCacheOpenPreservesTheExistingOfflineTranscript() =
    runTest {
      val names = databaseNames()
      val context = RuntimeEnvironment.getApplication()
      withDatabases(names) { first -> seedGateway(first, "gateway-a", "offline transcript") }

      val attempt =
        launch(start = CoroutineStart.UNDISPATCHED) {
          currentCoroutineContext().cancel()
          GatewayCacheDatabase.open(context, names.cache).close()
        }
      attempt.join()
      assertTrue(attempt.isCancelled)
      assertTrue(context.getDatabasePath(names.cache).exists())

      withCleanDatabases(names) { reopened ->
        assertEquals(
          listOf("offline transcript"),
          reopened.transcriptCache().loadTranscript("gateway-a", "main", "main").map { it.content.single().text },
        )
      }
    }

  @Test
  fun failedGatewayRemovalRollsBackTheNestedOutboxPurgeAndItsPhase() =
    runTest {
      val names = databaseNames()
      val bytes = byteArrayOf(1, 2, 3)
      withDatabases(names) { first ->
        seedGateway(first, "gateway-a", "keep cached")
        first.commandOutbox().enqueue(
          gatewayId = "gateway-a",
          sessionKey = "main",
          text = "keep attachment",
          thinkingLevel = "off",
          nowMs = 2,
          ownerAgentId = "main",
          idempotencyKey = "purge-admission",
          attachments = listOf(OutboxAttachmentPayload("image", "image/png", "keep.png", null, bytes)),
        )
        first.stageGatewayRemoval("gateway-a")
        val state = first.clientStateDatabase()
        state.useWriterConnection {
          it.executeSQL(
            "CREATE TRIGGER fail_removal_commit BEFORE INSERT ON gateway_removals " +
              "WHEN NEW.phase = 'cache-pending' BEGIN SELECT RAISE(ABORT, 'removal failed'); END",
          )
        }

        val failure = runCatching { first.commitGatewayRemoval("gateway-a") }
        assertTrue(
          failure
            .exceptionOrNull()
            ?.message
            .orEmpty()
            .contains("removal failed"),
        )
        assertEquals(listOf(GatewayRemovalEntity("gateway-a", "staged")), state.controlDao().gatewayRemovals())
        state.useWriterConnection { it.executeSQL("DROP TRIGGER fail_removal_commit") }
      }

      withCleanDatabases(names) { reopened ->
        assertEquals(listOf("keep cached", "keep attachment"), reopened.commandOutbox().load("gateway-a").map { it.text })
        assertTrue(
          bytes.contentEquals(
            reopened
              .commandOutbox()
              .loadAttachments("purge-admission")
              .single()
              .bytes,
          ),
        )
        assertTrue(reopened.commandOutbox().wasAdmitted("purge-admission"))
        assertEquals(listOf("keep cached"), reopened.transcriptCache().loadTranscript("gateway-a", "main", "main").map { it.content.single().text })
        assertTrue(
          reopened
            .clientStateDatabase()
            .controlDao()
            .gatewayRemovals()
            .isEmpty(),
        )
      }
    }

  @Test
  fun absentGatewayCommitsStagedRemovalAcrossBothDatabasesAndKeepsOtherGateway() =
    runTest {
      val names = databaseNames()
      withDatabases(names, setOf("gateway-a", "gateway-b")) { first ->
        seedGateway(first, "gateway-a", "remove")
        seedGateway(first, "gateway-b", "keep")
        first.stageGatewayRemoval("gateway-a")
      }

      withCleanDatabases(names, setOf("gateway-b")) { reopened ->
        assertTrue(reopened.transcriptCache().loadTranscript("gateway-a", "main", "main").isEmpty())
        assertTrue(reopened.commandOutbox().load("gateway-a").isEmpty())
        assertEquals(listOf("keep"), reopened.transcriptCache().loadTranscript("gateway-b", "main", "main").map { it.content.single().text })
        assertEquals(listOf("keep"), reopened.commandOutbox().load("gateway-b").map { it.text })
      }
    }

  @Test
  fun cachePendingRemovalNeverDeletesNewDurableRowsOnResume() =
    runTest {
      val names = databaseNames()
      withDatabases(names, setOf("gateway-a", "gateway-b")) { first ->
        seedGateway(first, "gateway-a", "remove")
        seedGateway(first, "gateway-b", "keep")
        // Force only the disposable half to fail after the durable state transaction commits.
        first.gatewayCacheDatabase().close()
        first.commitGatewayRemoval("gateway-a")
        assertTrue(first.commandOutbox().load("gateway-a").isEmpty())
        first.enqueue("gateway-a", "new after purge", nowMs = 2)
        // A retry may stage again before restart; it must not downgrade cache-pending into a
        // cancelable marker that could strand the old derived rows.
        first.stageGatewayRemoval("gateway-a")
      }

      withCleanDatabases(names, setOf("gateway-a", "gateway-b")) { reopened ->
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
      }
    }

  @Test
  fun stillRegisteredGatewayCancelsCancelableStagedRemoval() =
    runTest {
      val names = databaseNames()
      withDatabases(names) { first ->
        seedGateway(first, "gateway-a", "keep")
        first.stageGatewayRemoval("gateway-a")
      }

      withCleanDatabases(names) { reopened ->
        assertEquals(listOf("keep"), reopened.transcriptCache().loadTranscript("gateway-a", "main", "main").map { it.content.single().text })
        assertEquals(listOf("keep"), reopened.commandOutbox().load("gateway-a").map { it.text })
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
    databases.enqueue(gatewayId, text)
  }

  private suspend fun AndroidClientDatabases.enqueue(
    gatewayId: String,
    text: String,
    nowMs: Long = 1,
  ) {
    assertTrue(
      commandOutbox().enqueue(
        gatewayId = gatewayId,
        sessionKey = "main",
        text = text,
        thinkingLevel = "off",
        nowMs = nowMs,
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

  private suspend fun addV8AttachmentFixture(
    legacyName: String,
    bytes: ByteArray,
  ) {
    val context = RuntimeEnvironment.getApplication()
    val legacy = LegacyChatDatabase.open(context, legacyName)
    try {
      val dao = legacy.outboxDao()
      legacy.withWriteTransaction {
        dao.insert(
          OutboxCommandEntity(
            id = "media-command",
            gatewayId = "gateway-test",
            sessionKey = "main",
            text = "media",
            thinkingLevel = "off",
            createdAtMs = 100L,
            status = "queued",
            retryCount = 0,
            lastError = null,
            gatedEpoch = null,
            ownerAgentId = "main",
          ),
        )
        dao.insertAdmissionReceipt(ComposerSendAdmissionEntity("media-command", "gateway-test", "main", "main"))
        dao.insertAttachment(
          OutboxAttachmentEntity("media-attachment", "media-command", 0, "image", "image/jpeg", "a.jpg", null, bytes.size.toLong()),
        )
        var offset = 0
        var index = 0
        while (offset < bytes.size) {
          val end = minOf(offset + OUTBOX_ATTACHMENT_CHUNK_BYTES, bytes.size)
          dao.insertChunk(OutboxAttachmentChunkEntity("media-attachment", index, bytes.copyOfRange(offset, end)))
          offset = end
          index += 1
        }
      }
    } finally {
      legacy.close()
    }
  }

  private suspend fun RoomDatabase.userVersion(): Int =
    useReaderConnection { connection ->
      connection.usePrepared("PRAGMA user_version") { statement ->
        check(statement.step())
        statement.getLong(0).toInt()
      }
    }

  private fun open(
    names: DatabaseNames,
    registeredGatewayIds: Set<String> = setOf("gateway-a"),
  ): AndroidClientDatabases =
    AndroidClientDatabases.start(
      RuntimeEnvironment.getApplication(),
      gatewayCacheName = names.cache,
      clientStateName = names.state,
      legacyName = names.legacy,
      registeredGatewayIds = registeredGatewayIds,
    )

  private suspend fun <T> withDatabases(
    names: DatabaseNames,
    registeredGatewayIds: Set<String> = setOf("gateway-a"),
    block: suspend (AndroidClientDatabases) -> T,
  ): T {
    val databases = open(names, registeredGatewayIds)
    return try {
      block(databases)
    } finally {
      databases.close()
    }
  }

  private suspend fun <T> withCleanDatabases(
    names: DatabaseNames,
    registeredGatewayIds: Set<String> = setOf("gateway-a"),
    block: suspend (AndroidClientDatabases) -> T,
  ): T =
    try {
      withDatabases(names, registeredGatewayIds, block)
    } finally {
      delete(names)
    }

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
      listOf(
        LegacyOutboxFixture("pristine", "queued"),
        LegacyOutboxFixture("legacy-queued-error", "queued", lastError = "socket closed after send"),
        LegacyOutboxFixture("interrupted-send", "sending", retryCount = 1),
        LegacyOutboxFixture("already-failed", "failed", retryCount = 3, lastError = "original failure"),
        LegacyOutboxFixture("legacy-command", "queued", text = "/clear"),
        LegacyOutboxFixture("accepted", "accepted"),
        LegacyOutboxFixture("explicit-owner", "queued", sessionKey = "agent:ops:side"),
      ).forEachIndexed { index, fixture -> insertOutbox(database, fixture, now + index) }
      database.version = 2
    }
  }

  private fun insertOutbox(
    database: SQLiteDatabase,
    fixture: LegacyOutboxFixture,
    createdAtMs: Long,
  ) {
    database.execSQL(
      "INSERT INTO outbox_commands " +
        "(id, gatewayId, sessionKey, text, thinkingLevel, createdAtMs, status, retryCount, lastError) " +
        "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
      fixture.run {
        arrayOf<Any?>(id, "gateway-test", sessionKey, text, "off", createdAtMs, status, retryCount, lastError)
      },
    )
  }

  private data class LegacyOutboxFixture(
    val id: String,
    val status: String,
    val retryCount: Int = 0,
    val lastError: String? = null,
    val text: String = id,
    val sessionKey: String = "main",
  )
}
