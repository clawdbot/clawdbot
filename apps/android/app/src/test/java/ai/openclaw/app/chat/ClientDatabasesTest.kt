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
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.currentCoroutineContext
import kotlinx.coroutines.launch
import kotlinx.coroutines.test.runTest
import kotlinx.coroutines.withContext
import kotlinx.coroutines.withTimeout
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
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
  fun readerPositionSurvivesLargeMessagesAcrossReopen() =
    runTest {
      val contents =
        listOf(
          listOf(ChatMessageContent(text = "x".repeat(20_000))),
          List(256) { index -> ChatMessageContent(text = "part-$index") },
        )
      for ((content, entryId) in contents.flatMap { content -> listOf(content to "canonical-entry", content to null) }) {
        val names = databaseNames()
        val message =
          ChatMessage(
            id = "display-before",
            role = "assistant",
            content = content,
            timestampMs = 1,
            entryId = entryId,
          )
        val before = buildChatTimeline(listOf(message), 0, emptyList(), null)
        val position = requireNotNull(before.readerPosition(index = 0, offset = 73))
        val scope = readerScope("gateway-a", "main")
        withDatabases(names) { databases ->
          val store = databases.readerPositionStore()
          store.save(store.bind(scope), position)
        }

        withCleanDatabases(names) { databases ->
          val saved = databases.readerPositionStore().bind(scope).position
          assertNotNull("content parts: ${content.size}, entryId: $entryId", saved)
          assertEquals(entryId, saved?.entryId)
          val after = buildChatTimeline(listOf(message.copy(id = "display-after")), 0, emptyList(), null)
          val restored = requireNotNull(restoredChatReaderTransition(after, requireNotNull(saved)))
          assertEquals(0, restored.scrollIndex)
          assertEquals(73, restored.scrollOffset)
        }
      }
    }

  @Test
  fun sessionDeleteRemovesSavedReaderPosition() =
    runTest {
      val names = databaseNames()
      withDatabases(names) { databases ->
        val store = databases.readerPositionStore()
        val scope = readerScope("gateway-a", "main")
        val binding = store.bind(scope)
        store.save(binding, ChatReaderPosition("message-a", 37))

        store.deleteSession(scope)

        assertNull(store.bind(scope).position)
      }
    }

  @Test
  fun sessionDeleteFencesLateReaderPositionSave() =
    runTest {
      val names = databaseNames()
      withDatabases(names) { databases ->
        val store = databases.readerPositionStore()
        val scope = readerScope("gateway-a", "main")
        val binding = store.bind(scope)
        store.deleteSession(scope)

        store.save(binding, ChatReaderPosition("message-a", 37))

        assertNull(store.bind(scope).position)
      }
    }

  @Test
  fun gatewayDeleteRemovesSavedReaderPosition() =
    runTest {
      val names = databaseNames()
      withDatabases(names) { databases ->
        val store = databases.readerPositionStore()
        val scope = readerScope("gateway-a", "main")
        val binding = store.bind(scope)
        store.save(binding, ChatReaderPosition("message-a", 37))

        databases.commitGatewayRemoval("gateway-a")

        assertNull(store.bind(scope).position)
      }
    }

  @Test
  fun sessionRetirementWaitsForInFlightSaveThenWins() =
    runTest {
      val fence = ChatReaderPositionFence()
      val scope = readerScope("gateway-a", "main")
      val binding = ChatReaderPositionBinding(scope, position = null, generation = fence.bind(scope))
      val saveStarted = CompletableDeferred<Unit>()
      val releaseSave = CompletableDeferred<Unit>()
      var stored = false

      withContext(Dispatchers.IO) {
        val save =
          async(start = CoroutineStart.UNDISPATCHED) {
            fence.save(binding) {
              saveStarted.complete(Unit)
              releaseSave.await()
              stored = true
            }
          }
        saveStarted.await()
        val retirement =
          async(start = CoroutineStart.UNDISPATCHED) {
            fence.retireSession(scope)
          }
        assertFalse(retirement.isCompleted)

        releaseSave.complete(Unit)
        save.await()
        val owner = retirement.await()
        check(owner is ChatReaderPositionRetirement.Owner)
        fence.deleteSession(owner) { stored = false }
      }

      assertFalse(stored)
    }

  @Test
  fun gatewayRetirementWaitsForInFlightSaveThenWins() =
    runTest {
      val fence = ChatReaderPositionFence()
      val scope = readerScope("gateway-a", "main")
      val binding = ChatReaderPositionBinding(scope, position = null, generation = fence.bind(scope))
      val saveStarted = CompletableDeferred<Unit>()
      val releaseSave = CompletableDeferred<Unit>()
      var stored = false

      withContext(Dispatchers.IO) {
        val save =
          async(start = CoroutineStart.UNDISPATCHED) {
            fence.save(binding) {
              saveStarted.complete(Unit)
              releaseSave.await()
              stored = true
            }
          }
        saveStarted.await()
        val retirement =
          async(start = CoroutineStart.UNDISPATCHED) {
            fence.clearGateway(scope.gatewayId) { stored = false }
          }
        assertFalse(retirement.isCompleted)
        val queuedBinding = async { fence.bind(scope) }
        assertFalse(queuedBinding.isCompleted)

        releaseSave.complete(Unit)
        save.await()
        retirement.await()
        val retiredBinding = ChatReaderPositionBinding(scope, position = null, generation = queuedBinding.await())
        fence.save(retiredBinding) { stored = true }
      }

      assertFalse(stored)
    }

  @Test
  fun gatewayRetirementQueuedDuringActivationRemainsClosed() =
    runTest {
      val fence = ChatReaderPositionFence()
      val scope = readerScope("gateway-a", "main")
      val retired = CompletableDeferred<Unit>()
      fence.activateGateway(scope.gatewayId) {
        // Queue removal while activation still owns the fence, before it updates the marker.
        launch(start = CoroutineStart.UNDISPATCHED) {
          fence.clearGateway(scope.gatewayId) { }
          retired.complete(Unit)
        }
        true
      }
      retired.await()
      val binding = ChatReaderPositionBinding(scope, null, fence.bind(scope))
      var stored = false
      fence.save(binding) { stored = true }
      assertFalse(stored)
    }

  @Test
  fun gatewayActivationStartsANewReaderPositionLifecycle() =
    runTest {
      val fence = ChatReaderPositionFence()
      val scope = readerScope("gateway-a", "main")
      var stored = false
      fence.clearGateway(scope.gatewayId) { }

      val retired = ChatReaderPositionBinding(scope, position = null, generation = fence.bind(scope))
      fence.save(retired) { stored = true }
      assertFalse(stored)

      fence.activateGateway(scope.gatewayId)
      val replacement = ChatReaderPositionBinding(scope, position = null, generation = fence.bind(scope))
      fence.save(replacement) { stored = true }

      assertTrue(stored)
    }

  @Test
  fun staleGatewayActivationCannotOpenARetiredLifecycle() =
    runTest {
      val fence = ChatReaderPositionFence()
      val scope = readerScope("gateway-a", "main")
      fence.clearGateway(scope.gatewayId) { }

      assertFalse(fence.activateGateway(scope.gatewayId) { false })
      val stale = ChatReaderPositionBinding(scope, position = null, generation = fence.bind(scope))
      var stored = false
      fence.save(stale) { stored = true }

      assertFalse(stored)
      assertTrue(fence.activateGateway(scope.gatewayId) { true })
    }

  @Test
  fun gatewayDeleteFencesLateReaderPositionSave() =
    runTest {
      val names = databaseNames()
      withDatabases(names) { databases ->
        val store = databases.readerPositionStore()
        val scope = readerScope("gateway-a", "main")
        val binding = store.bind(scope)
        databases.commitGatewayRemoval("gateway-a")

        store.save(binding, ChatReaderPosition("message-a", 37))

        assertNull(store.bind(scope).position)
      }
    }

  @Test
  fun clearingCurrentReaderBindingKeepsItActiveForLaterSaves() =
    runTest {
      val names = databaseNames()
      withDatabases(names) { databases ->
        val store = databases.readerPositionStore()
        val scope = readerScope("gateway-a", "main")
        val binding = store.bind(scope)
        store.save(binding, ChatReaderPosition("message-a", 37))

        store.clear(binding)
        assertNull(
          databases
            .clientStateDatabase()
            .controlDao()
            .metadataValue(chatReaderPositionMetadataKey("gateway-a")),
        )
        val latest = ChatReaderPosition("message-b", 11)
        store.save(binding, latest)
        assertEquals(latest, store.bind(scope).position)
      }
    }

  @Test
  fun pendingInitializationDoesNotHoldReaderFenceAgainstRecovery() =
    runTest {
      val names = databaseNames()
      withDatabases(names) { databases ->
        val state = databases.clientStateDatabase()
        val fence = ChatReaderPositionFence()
        val recoveryComplete = CompletableDeferred<Unit>()
        val deferredStore =
          ChatReaderPositionStore(
            database = {
              recoveryComplete.await()
              state
            },
            fence = fence,
          )
        val recoveryStore = ChatReaderPositionStore({ state }, fence)

        withContext(Dispatchers.IO) {
          val binding = async { deferredStore.bind(readerScope("gateway-a", "main")) }
          val recovery =
            async {
              recoveryStore.clearGateway("gateway-a") { database ->
                database.controlDao().deleteMetadata(chatReaderPositionMetadataKey("gateway-a"))
              }
              recoveryComplete.complete(Unit)
            }

          withTimeout(5_000) {
            recovery.await()
            binding.await()
          }
        }
      }
    }

  @Test
  fun gatewayActivationWaitsForStartupRecoveryBeforeOpeningCurrentLifecycle() = runTest { assertGatewayActivationAfterRecovery(keepCurrent = true) }

  @Test
  fun gatewayActivationRechecksIntentAfterStartupRecovery() = runTest { assertGatewayActivationAfterRecovery(keepCurrent = false) }

  private suspend fun assertGatewayActivationAfterRecovery(keepCurrent: Boolean) =
    coroutineScope {
      withCleanDatabases(databaseNames()) { databases ->
        val state = databases.clientStateDatabase()
        val fence = ChatReaderPositionFence()
        val ready = CompletableDeferred<Unit>()
        val deferredStore =
          ChatReaderPositionStore({
            ready.await()
            state
          }, fence)
        val recoveryStore = ChatReaderPositionStore({ state }, fence)
        var current = true
        val activation = async(start = CoroutineStart.UNDISPATCHED) { deferredStore.activateGateway("gateway-a") { current } }
        val returnedBeforeRecovery = activation.isCompleted
        try {
          recoveryStore.clearGateway("gateway-a") { database ->
            database.controlDao().deleteMetadata(chatReaderPositionMetadataKey("gateway-a"))
          }
          current = keepCurrent
        } finally {
          ready.complete(Unit)
        }
        assertEquals(keepCurrent, activation.await())
        assertFalse("Activation must await initialization outside the fence", returnedBeforeRecovery)
        val scope = readerScope("gateway-a", "main")
        val binding = deferredStore.bind(scope)
        val position = ChatReaderPosition("after-recovery", 23)
        deferredStore.save(binding, position)
        assertEquals(if (keepCurrent) position else null, deferredStore.bind(scope).position)
      }
    }

  @Test
  fun replacementBindingWaitsForPendingSessionRetirement() =
    runTest {
      val names = databaseNames()
      withDatabases(names) { databases ->
        val state = databases.clientStateDatabase()
        val fence = ChatReaderPositionFence()
        val databaseReady = CompletableDeferred<Unit>()
        val retiringStore =
          ChatReaderPositionStore(
            database = {
              databaseReady.await()
              state
            },
            fence = fence,
          )
        val replacementStore = ChatReaderPositionStore({ state }, fence)
        val scope = readerScope("gateway-a", "main")

        withContext(Dispatchers.IO) {
          val deletion =
            async(start = CoroutineStart.UNDISPATCHED) {
              retiringStore.deleteSession(scope)
            }
          val replacement =
            async(start = CoroutineStart.UNDISPATCHED) {
              replacementStore.bind(scope)
            }
          assertFalse(replacement.isCompleted)

          databaseReady.complete(Unit)
          deletion.await()
          val binding = replacement.await()
          val position = ChatReaderPosition("message-new", 17)
          replacementStore.save(binding, position)
          assertEquals(position, replacementStore.bind(scope).position)
        }
      }
    }

  @Test
  fun duplicateSessionDeleteDoesNotRemoveReplacementBookmark() =
    runTest {
      val names = databaseNames()
      withDatabases(names) { databases ->
        val state = databases.clientStateDatabase()
        val fence = ChatReaderPositionFence()
        val firstDatabaseReady = CompletableDeferred<Unit>()
        val secondDatabaseReady = CompletableDeferred<Unit>()
        val firstStore =
          ChatReaderPositionStore(
            database = {
              firstDatabaseReady.await()
              state
            },
            fence = fence,
          )
        val secondStore =
          ChatReaderPositionStore(
            database = {
              secondDatabaseReady.await()
              state
            },
            fence = fence,
          )
        val replacementStore = ChatReaderPositionStore({ state }, fence)
        val deletedScope = readerScope("gateway-a", "main", sessionId = "deleted-session")
        val replacementScope = readerScope("gateway-a", "main", sessionId = "replacement-session")

        withContext(Dispatchers.IO) {
          val firstDelete =
            async(start = CoroutineStart.UNDISPATCHED) {
              firstStore.deleteSession(deletedScope)
            }
          val duplicateDelete =
            async(start = CoroutineStart.UNDISPATCHED) {
              secondStore.deleteSession(deletedScope)
            }

          firstDatabaseReady.complete(Unit)
          firstDelete.await()
          val replacement = replacementStore.bind(replacementScope)
          val position = ChatReaderPosition("message-new", 17)
          replacementStore.save(replacement, position)

          secondDatabaseReady.complete(Unit)
          duplicateDelete.await()
          assertEquals(position, replacementStore.bind(replacementScope).position)
        }
      }
    }

  @Test
  fun lateDeleteForRetiredSessionDoesNotRemoveReplacementBookmark() =
    runTest {
      val names = databaseNames()
      withDatabases(names) { databases ->
        val store = databases.readerPositionStore()
        val retired = readerScope("gateway-a", "main", sessionId = "retired-session")
        val replacement = readerScope("gateway-a", "main", sessionId = "replacement-session")
        store.save(store.bind(retired), ChatReaderPosition("message-old", 7))
        store.deleteSession(retired)
        val position = ChatReaderPosition("message-new", 17)
        store.save(store.bind(replacement), position)

        store.deleteSession(retired)

        assertEquals(position, store.bind(replacement).position)
      }
    }

  @Test
  fun readerPositionScopeSeparatesOwnersAndSessionInstances() =
    runTest {
      val names = databaseNames()
      withDatabases(names) { databases ->
        val store = databases.readerPositionStore()
        val ownerA = readerScope("gateway-a", "global", ownerAgentId = "owner-a", sessionId = "owner-a-old")
        val ownerB = readerScope("gateway-a", "global", ownerAgentId = "owner-b", sessionId = "owner-b-current")
        store.save(store.bind(ownerA), ChatReaderPosition("message-a", 7))
        store.save(store.bind(ownerB), ChatReaderPosition("message-b", 11))

        assertEquals(ChatReaderPosition("message-a", 7), store.bind(ownerA).position)
        assertEquals(ChatReaderPosition("message-b", 11), store.bind(ownerB).position)
        assertNull(store.bind(ownerA.copy(sessionId = "owner-a-replacement")).position)
      }
    }

  @Test
  fun readerPositionPersistsPerGatewayAndSessionAcrossReopen() =
    runTest {
      val names = databaseNames()
      withDatabases(names, setOf("gateway-a", "gateway-b")) { databases ->
        val store = databases.readerPositionStore()
        store.save(
          store.bind(readerScope("gateway-a", "main")),
          ChatReaderPosition("message-a", 37, entryId = "entry-a"),
        )
        store.save(store.bind(readerScope("gateway-a", "agent:main:side")), ChatReaderPosition("message-side", 12))
        store.save(store.bind(readerScope("gateway-b", "main")), ChatReaderPosition("message-b", 5))
      }

      withCleanDatabases(names, setOf("gateway-a", "gateway-b")) { reopened ->
        val store = reopened.readerPositionStore()
        assertEquals(
          ChatReaderPosition("message-a", 37, entryId = "entry-a"),
          store.bind(readerScope("gateway-a", "main")).position,
        )
        assertEquals(
          ChatReaderPosition("message-side", 12),
          store.bind(readerScope("gateway-a", "agent:main:side")).position,
        )
        assertEquals(ChatReaderPosition("message-b", 5), store.bind(readerScope("gateway-b", "main")).position)
        store.deleteSession(readerScope("gateway-a", "main"))
        assertNull(store.bind(readerScope("gateway-a", "main")).position)
        assertEquals(ChatReaderPosition("message-b", 5), store.bind(readerScope("gateway-b", "main")).position)
      }
    }

  @Test
  fun readerMetadataKeepsV1SchemaAndKnownStateWritable() =
    runTest {
      val names = databaseNames()
      val context = RuntimeEnvironment.getApplication()
      createClientStateV1Fixture(context.getDatabasePath(names.state).path)
      SQLiteDatabase.openDatabase(context.getDatabasePath(names.state).path, null, SQLiteDatabase.OPEN_READWRITE).use {
        it.execSQL(
          "INSERT INTO client_state_metadata (`key`, value) VALUES (?, ?)",
          arrayOf<Any>("v1-proof", "preserved"),
        )
      }

      withDatabases(names) { candidate ->
        assertEquals(1, candidate.clientStateDatabase().userVersion())
        assertEquals("preserved", candidate.clientStateDatabase().controlDao().metadataValue("v1-proof"))
        val position = ChatReaderPosition("message-1", 19)
        val store = candidate.readerPositionStore()
        store.save(store.bind(readerScope("gateway-a", "main")), position)
        assertEquals(position, store.bind(readerScope("gateway-a", "main")).position)
        candidate.enqueue("gateway-a", "preserve outbox")
      }

      SQLiteDatabase
        .openDatabase(
          context.getDatabasePath(names.state).path,
          null,
          SQLiteDatabase.OPEN_READWRITE,
        ).use { rollback ->
          assertEquals(1, rollback.version)
          rollback.rawQuery("SELECT identity_hash FROM room_master_table WHERE id = 42", null).use { rows ->
            assertTrue(rows.moveToFirst())
            assertEquals("924cec9afdb455dced2592399a08f5da", rows.getString(0))
          }
          rollback.rawQuery("SELECT text FROM outbox_commands WHERE gatewayId = ?", arrayOf("gateway-a")).use { rows ->
            assertTrue(rows.moveToFirst())
            assertEquals("preserve outbox", rows.getString(0))
          }
          rollback.execSQL(
            "INSERT OR REPLACE INTO client_state_metadata (`key`, value) VALUES (?, ?)",
            arrayOf<Any>("rollback-proof", "preserved"),
          )
        }

      withCleanDatabases(names) { reopened ->
        assertEquals(1, reopened.clientStateDatabase().userVersion())
        assertEquals("preserved", reopened.clientStateDatabase().controlDao().metadataValue("rollback-proof"))
        assertEquals(
          ChatReaderPosition("message-1", 19),
          reopened.readerPositionStore().bind(readerScope("gateway-a", "main")).position,
        )
        assertEquals(listOf("preserve outbox"), reopened.commandOutbox().load("gateway-a").map { it.text })
      }
    }

  @Test
  fun readerMetadataIsBoundedAndMalformedValuesFailToNoBookmark() =
    runTest {
      val names = databaseNames()
      withDatabases(names) { databases ->
        val store = databases.readerPositionStore()
        repeat(MAX_CACHED_SESSIONS + 1) { index ->
          val sessionKey = "session-$index"
          store.save(store.bind(readerScope("gateway-a", sessionKey)), ChatReaderPosition("message-$index", index))
        }

        assertNull(store.bind(readerScope("gateway-a", "session-0")).position)
        assertEquals(
          ChatReaderPosition("message-$MAX_CACHED_SESSIONS", MAX_CACHED_SESSIONS),
          store.bind(readerScope("gateway-a", "session-$MAX_CACHED_SESSIONS")).position,
        )
        databases
          .clientStateDatabase()
          .controlDao()
          .upsertMetadata(
            ClientStateMetadataEntity(chatReaderPositionMetadataKey("gateway-b"), "{\"version\":2}"),
          )
        assertNull(store.bind(readerScope("gateway-b", "main")).position)
      }
      delete(names)
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
        val readerStore = first.readerPositionStore()
        readerStore.save(readerStore.bind(readerScope("gateway-a", "main")), ChatReaderPosition("remove", 3))
        readerStore.save(readerStore.bind(readerScope("gateway-b", "main")), ChatReaderPosition("keep", 5))
        first.stageGatewayRemoval("gateway-a")
      }

      withCleanDatabases(names, setOf("gateway-b")) { reopened ->
        assertTrue(reopened.transcriptCache().loadTranscript("gateway-a", "main", "main").isEmpty())
        assertTrue(reopened.commandOutbox().load("gateway-a").isEmpty())
        assertNull(reopened.readerPositionStore().bind(readerScope("gateway-a", "main")).position)
        assertEquals(listOf("keep"), reopened.transcriptCache().loadTranscript("gateway-b", "main", "main").map { it.content.single().text })
        assertEquals(listOf("keep"), reopened.commandOutbox().load("gateway-b").map { it.text })
        assertEquals(
          ChatReaderPosition("keep", 5),
          reopened.readerPositionStore().bind(readerScope("gateway-b", "main")).position,
        )
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

  private fun readerScope(
    gatewayId: String,
    sessionKey: String,
    ownerAgentId: String = "main",
    sessionId: String = "$ownerAgentId:$sessionKey",
  ) = ChatReaderPositionScope(gatewayId, ownerAgentId, sessionKey, sessionId)

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

  private fun createClientStateV1Fixture(path: String) {
    SQLiteDatabase.openOrCreateDatabase(path, null).use { database ->
      listOf(
        "CREATE TABLE IF NOT EXISTS `outbox_commands` (`id` TEXT NOT NULL, `gatewayId` TEXT NOT NULL, `sessionKey` TEXT NOT NULL, `text` TEXT NOT NULL, `thinkingLevel` TEXT NOT NULL, `createdAtMs` INTEGER NOT NULL, `status` TEXT NOT NULL, `retryCount` INTEGER NOT NULL, `lastError` TEXT, `gatedEpoch` INTEGER, `ownerAgentId` TEXT, PRIMARY KEY(`id`))",
        "CREATE TABLE IF NOT EXISTS `outbox_attachments` (`id` TEXT NOT NULL, `commandId` TEXT NOT NULL, `position` INTEGER NOT NULL, `type` TEXT NOT NULL, `mimeType` TEXT NOT NULL, `fileName` TEXT NOT NULL, `durationMs` INTEGER, `byteLength` INTEGER NOT NULL, PRIMARY KEY(`id`))",
        "CREATE INDEX IF NOT EXISTS `index_outbox_attachments_commandId` ON `outbox_attachments` (`commandId`)",
        "CREATE TABLE IF NOT EXISTS `outbox_attachment_chunks` (`attachmentId` TEXT NOT NULL, `chunkIndex` INTEGER NOT NULL, `bytes` BLOB NOT NULL, PRIMARY KEY(`attachmentId`, `chunkIndex`))",
        "CREATE TABLE IF NOT EXISTS `composer_send_admissions` (`id` TEXT NOT NULL, `gatewayId` TEXT NOT NULL, `ownerAgentId` TEXT NOT NULL, `sessionKey` TEXT NOT NULL, PRIMARY KEY(`id`))",
        "CREATE TABLE IF NOT EXISTS `client_state_metadata` (`key` TEXT NOT NULL, `value` TEXT NOT NULL, PRIMARY KEY(`key`))",
        "CREATE TABLE IF NOT EXISTS `gateway_removals` (`gatewayId` TEXT NOT NULL, `phase` TEXT NOT NULL, PRIMARY KEY(`gatewayId`))",
        "CREATE TABLE IF NOT EXISTS room_master_table (id INTEGER PRIMARY KEY, identity_hash TEXT)",
      ).forEach(database::execSQL)
      database.execSQL(
        "INSERT OR REPLACE INTO room_master_table (id, identity_hash) VALUES(42, ?)",
        arrayOf<Any>("924cec9afdb455dced2592399a08f5da"),
      )
      database.version = 1
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
