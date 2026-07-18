package ai.openclaw.app.chat

import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.launch
import kotlinx.coroutines.test.advanceUntilIdle
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.runTest
import kotlinx.serialization.json.Json
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class ChatControllerTranscriptCacheTest {
  private val json = Json { ignoreUnknownKeys = true }
  private val gatewayScope = ChatCacheScope(gatewayId = "gateway-a", connectionGeneration = 1)

  private data class TranscriptKey(
    val gatewayId: String,
    val agentId: String,
    val sessionKey: String,
  )

  private data class SavedTranscript(
    val gatewayId: String,
    val agentId: String,
    val sessionKey: String,
    val messages: List<ChatMessage>,
  )

  private data class SavedSessions(
    val gatewayId: String,
    val agentId: String,
    val sessions: List<ChatSessionEntry>,
  )

  private class FakeTranscriptCache : ChatTranscriptCache {
    val lastDefaultAgents = mutableMapOf<String, String>()
    val transcripts = mutableMapOf<TranscriptKey, List<ChatMessage>>()
    var sessions: List<ChatSessionEntry> = emptyList()
    val sessionsByOwner = mutableMapOf<Pair<String, String>, List<ChatSessionEntry>>()
    val savedTranscripts = mutableListOf<SavedTranscript>()
    val savedSessions = mutableListOf<SavedSessions>()
    val retainedSessionKeys = mutableListOf<String?>()
    val deletedSessions = mutableListOf<Triple<String, String, String>>()
    var beforeLastDefaultAgentLoad: suspend (String) -> Unit = {}
    var beforeLastDefaultAgentSave: suspend (String, String) -> Unit = { _, _ -> }

    override suspend fun loadLastDefaultAgentId(gatewayId: String): String? {
      val cached = lastDefaultAgents[gatewayId]
      beforeLastDefaultAgentLoad(gatewayId)
      return cached
    }

    override suspend fun saveLastDefaultAgentId(
      gatewayId: String,
      agentId: String,
    ) {
      beforeLastDefaultAgentSave(gatewayId, agentId)
      lastDefaultAgents[gatewayId] = agentId
    }

    override suspend fun loadSessions(
      gatewayId: String,
      agentId: String,
    ): List<ChatSessionEntry> = sessionsByOwner[gatewayId to agentId] ?: sessions

    override suspend fun loadTranscript(
      gatewayId: String,
      agentId: String,
      sessionKey: String,
    ): List<ChatMessage> = transcripts[TranscriptKey(gatewayId, agentId, sessionKey)].orEmpty()

    override suspend fun saveSessions(
      gatewayId: String,
      agentId: String,
      sessions: List<ChatSessionEntry>,
      retainedSessionKey: String?,
    ) {
      savedSessions += SavedSessions(gatewayId, agentId, sessions)
      retainedSessionKeys += retainedSessionKey
    }

    override suspend fun saveTranscript(
      gatewayId: String,
      agentId: String,
      sessionKey: String,
      messages: List<ChatMessage>,
    ) {
      savedTranscripts += SavedTranscript(gatewayId, agentId, sessionKey, messages)
    }

    override suspend fun deleteSession(
      gatewayId: String,
      agentId: String,
      sessionKey: String,
    ) {
      deletedSessions += Triple(gatewayId, agentId, sessionKey)
    }

    override suspend fun clearGateway(gatewayId: String) {
      lastDefaultAgents.remove(gatewayId)
      transcripts.keys.removeAll { it.gatewayId == gatewayId }
      sessionsByOwner.keys.removeAll { it.first == gatewayId }
      savedTranscripts.removeAll { it.gatewayId == gatewayId }
      savedSessions.removeAll { it.gatewayId == gatewayId }
    }
  }

  private fun cachedMessage(
    text: String,
    role: String = "assistant",
    timestampMs: Long = 1L,
  ): ChatMessage =
    ChatMessage(
      id = "cached-$text",
      role = role,
      content = listOf(ChatMessageContent(type = "text", text = text)),
      timestampMs = timestampMs,
    )

  @Test
  @OptIn(ExperimentalCoroutinesApi::class)
  fun offlineColdOpenShowsCachedTranscriptAndSessionsAndKeepsSendBlocked() =
    runTest {
      val cache = FakeTranscriptCache()
      cache.transcripts[TranscriptKey("gateway-a", "main", "main")] =
        listOf(cachedMessage("cached hello"), cachedMessage("cached reply"))
      cache.sessions = listOf(ChatSessionEntry(key = "main", updatedAtMs = 5, displayName = "Main"))
      val controller =
        ChatController(
          scope = this,
          json = json,
          requestGateway = { _, _ -> throw IllegalStateException("offline") },
          transcriptCache = cache,
          cacheScope = { gatewayScope },
          currentDefaultAgentId = { "main" },
        )

      controller.load("main")
      advanceUntilIdle()

      assertEquals(
        listOf("cached hello", "cached reply"),
        controller.messages.value.map { it.content.single().text },
      )
      assertTrue(controller.messagesFromCache.value)
      assertEquals(listOf("main"), controller.sessions.value.map { it.key })
      assertFalse(controller.healthOk.value)

      val accepted =
        controller.sendMessageAwaitAcceptance(message = "hi", thinkingLevel = "off", attachments = emptyList())
      assertFalse(accepted)
      assertEquals("Gateway health not OK; cannot send", controller.errorText.value)
    }

  @Test
  @OptIn(ExperimentalCoroutinesApi::class)
  fun offlineCachedOwnerRebuildsCanonicalMainSessionBeforeComposerSend() =
    runTest {
      val cache = FakeTranscriptCache()
      cache.lastDefaultAgents["gateway-a"] = "work"
      lateinit var controller: ChatController
      controller =
        ChatController(
          scope = this,
          json = json,
          requestGateway = { _, _ -> throw IllegalStateException("offline") },
          transcriptCache = cache,
          cacheScope = { gatewayScope },
          currentDefaultAgentId = { null },
          onOfflineDefaultAgentRestored = { agentId ->
            controller.applyMainSessionKey("agent:$agentId:node-test")
          },
        )

      controller.load("main")
      advanceUntilIdle()

      val owner = ChatComposerOwner("gateway-a", "work", "agent:work:node-test")
      assertEquals("agent:work:node-test", controller.sessionKey.value)
      assertTrue(controller.canSendForOwner(owner))
    }

  @Test
  @OptIn(ExperimentalCoroutinesApi::class)
  fun restoredPendingRunKeepsCachedTranscriptVisible() =
    runTest {
      val cache = FakeTranscriptCache()
      cache.transcripts[TranscriptKey("gateway-a", "main", "main")] = listOf(cachedMessage("cached history"))
      val controller =
        ChatController(
          scope = this,
          json = json,
          requestGateway = { method, _ ->
            when (method) {
              "chat.send" -> """{"runId":"run-pending"}"""
              "health" -> "{}"
              else -> throw IllegalStateException("offline")
            }
          },
          transcriptCache = cache,
          cacheScope = { gatewayScope },
          currentDefaultAgentId = { "main" },
        )

      controller.load("main")
      runCurrent()
      controller.handleGatewayEvent("health", null)
      assertTrue(controller.sendMessageAwaitAcceptance("pending turn", "off", emptyList()))

      controller.switchSession("agent:other:main")
      runCurrent()
      controller.switchSession("main")
      runCurrent()

      assertEquals(
        listOf("cached history", "pending turn"),
        controller.messages.value.map { it.content.single().text },
      )
      assertTrue(controller.messagesFromCache.value)
    }

  @Test
  @OptIn(ExperimentalCoroutinesApi::class)
  fun cachedTranscriptEmitsFirstThenLiveHistoryReplacesWholesale() =
    runTest {
      val cache = FakeTranscriptCache()
      cache.transcripts[TranscriptKey("gateway-a", "main", "main")] =
        listOf(
          cachedMessage("cached hello", role = "user", timestampMs = 10),
          cachedMessage("stale line", role = "assistant", timestampMs = 11),
        )
      val historyGate = CompletableDeferred<Unit>()
      val controller =
        ChatController(
          scope = this,
          json = json,
          requestGateway = { method, _ ->
            when (method) {
              "chat.history" -> {
                historyGate.await()
                """
                {
                  "sessionId": "session-1",
                  "messages": [
                    { "role": "user", "content": "cached hello", "timestamp": 10 },
                    { "role": "assistant", "content": "fresh reply", "timestamp": 20 }
                  ]
                }
                """.trimIndent()
              }
              else -> "{}"
            }
          },
          transcriptCache = cache,
          cacheScope = { gatewayScope },
          currentDefaultAgentId = { "main" },
        )

      controller.load("main")
      runCurrent()

      // Cached transcript is visible while chat.history is still in flight.
      assertTrue(controller.messagesFromCache.value)
      assertEquals(
        listOf("cached hello", "stale line"),
        controller.messages.value.map { it.content.single().text },
      )
      val cachedFirstMessageId =
        controller.messages.value
          .first()
          .id

      historyGate.complete(Unit)
      advanceUntilIdle()

      assertFalse(controller.messagesFromCache.value)
      assertEquals(
        listOf("cached hello", "fresh reply"),
        controller.messages.value.map { it.content.single().text },
      )
      // Existing reconciliation keeps stable ids for rows the live history confirms.
      val liveFirstMessageId =
        controller.messages.value
          .first()
          .id
      assertEquals(cachedFirstMessageId, liveFirstMessageId)
      // Live history is written through to the cache.
      val savedTranscript = cache.savedTranscripts.last()
      assertEquals("gateway-a", savedTranscript.gatewayId)
      assertEquals("main", savedTranscript.agentId)
      assertEquals("main", savedTranscript.sessionKey)
      assertEquals(
        listOf("cached hello", "fresh reply"),
        savedTranscript.messages.map { it.content.single().text },
      )
    }

  @Test
  @OptIn(ExperimentalCoroutinesApi::class)
  fun switchSessionOfflineShowsCachedTranscriptForThatSession() =
    runTest {
      val cache = FakeTranscriptCache()
      cache.transcripts[TranscriptKey("gateway-a", "other", "agent:other:main")] = listOf(cachedMessage("other session text"))
      val controller =
        ChatController(
          scope = this,
          json = json,
          requestGateway = { _, _ -> throw IllegalStateException("offline") },
          transcriptCache = cache,
          cacheScope = { gatewayScope },
          currentDefaultAgentId = { "main" },
        )
      controller.load("main")
      advanceUntilIdle()
      assertEquals(emptyList<ChatMessage>(), controller.messages.value)

      controller.switchSession("agent:other:main")
      advanceUntilIdle()

      assertEquals(
        listOf("other session text"),
        controller.messages.value.map { it.content.single().text },
      )
      assertTrue(controller.messagesFromCache.value)
    }

  @Test
  @OptIn(ExperimentalCoroutinesApi::class)
  fun sessionDeleteEventPurgesCachedSession() =
    runTest {
      val cache = FakeTranscriptCache()
      val deletions = mutableListOf<ChatSessionDeletion>()
      val controller =
        ChatController(
          scope = this,
          json = json,
          requestGateway = { _, _ -> "{}" },
          transcriptCache = cache,
          cacheScope = { gatewayScope },
          currentDefaultAgentId = { "main" },
          onSessionDeleted = deletions::add,
        )

      controller.handleGatewayEvent(
        "sessions.changed",
        """{"reason":"delete","sessionKey":"agent:old:main"}""",
      )
      advanceUntilIdle()

      assertEquals(listOf(Triple("gateway-a", "old", "agent:old:main")), cache.deletedSessions)
      assertEquals(
        listOf(ChatSessionDeletion("gateway-a", "old", "agent:old:main", "main")),
        deletions,
      )
    }

  @Test
  @OptIn(ExperimentalCoroutinesApi::class)
  fun unscopedDeleteEventDoesNotGuessACacheOwner() =
    runTest {
      val cache = FakeTranscriptCache()
      var sessionListRequests = 0
      val controller =
        ChatController(
          scope = this,
          json = json,
          requestGateway = { method, _ ->
            if (method == "sessions.list") sessionListRequests += 1
            if (method == "sessions.list") """{"sessions":[]}""" else "{}"
          },
          transcriptCache = cache,
          cacheScope = { gatewayScope },
          currentDefaultAgentId = { "new-default" },
        )

      controller.handleGatewayEvent(
        "sessions.changed",
        """{"reason":"delete","sessionKey":"custom"}""",
      )
      advanceUntilIdle()

      assertTrue(cache.deletedSessions.isEmpty())
      assertEquals(1, sessionListRequests)
    }

  @Test
  @OptIn(ExperimentalCoroutinesApi::class)
  fun ownerlessDeleteEventFallsBackAfterCurrentOwnersRefreshConfirmsRemoval() =
    runTest {
      var deleted = false
      val deletions = mutableListOf<ChatSessionDeletion>()
      val controller =
        ChatController(
          scope = this,
          json = json,
          requestGateway = { method, _ ->
            if (method == "sessions.list") {
              if (deleted) """{"sessions":[]}""" else """{"sessions":[{"key":"custom"}]}"""
            } else {
              "{}"
            }
          },
          cacheScope = { gatewayScope },
          currentDefaultAgentId = { "owner-a" },
          onSessionDeleted = deletions::add,
        )
      controller.load("custom", ownerAgentId = "owner-a")
      advanceUntilIdle()
      assertEquals("custom", controller.sessionKey.value)

      deleted = true
      controller.handleGatewayEvent(
        "sessions.changed",
        """{"reason":"delete","sessionKey":"custom"}""",
      )
      advanceUntilIdle()

      assertEquals("main", controller.sessionKey.value)
      assertEquals(
        listOf(ChatSessionDeletion("gateway-a", "owner-a", "custom", "main")),
        deletions,
      )
    }

  @Test
  @OptIn(ExperimentalCoroutinesApi::class)
  fun ownerlessDeleteProofStaysBoundToCapturedOwnerAcrossAgentSwitch() =
    runTest {
      val cache = FakeTranscriptCache()
      val proofStarted = CompletableDeferred<Unit>()
      val releaseProof = CompletableDeferred<Unit>()
      var deleting = false
      val controller =
        ChatController(
          scope = this,
          json = json,
          requestGateway = { method, params ->
            if (method == "sessions.list") {
              val ownerA = params.orEmpty().contains("\"agentId\":\"owner-a\"")
              if (deleting && ownerA) {
                proofStarted.complete(Unit)
                releaseProof.await()
                """{"sessions":[]}"""
              } else {
                """{"sessions":[{"key":"custom"}]}"""
              }
            } else {
              "{}"
            }
          },
          transcriptCache = cache,
          cacheScope = { gatewayScope },
          currentDefaultAgentId = { "owner-a" },
        )
      controller.load("custom", ownerAgentId = "owner-a")
      advanceUntilIdle()

      deleting = true
      controller.handleGatewayEvent(
        "sessions.changed",
        """{"reason":"delete","sessionKey":"custom"}""",
      )
      proofStarted.await()

      controller.load("custom", ownerAgentId = "owner-b")
      runCurrent()
      releaseProof.complete(Unit)
      advanceUntilIdle()

      assertEquals("custom", controller.sessionKey.value)
      assertEquals("owner-b", controller.sessionOwnerAgentId.value)
      assertEquals(listOf(Triple("gateway-a", "owner-a", "custom")), cache.deletedSessions)
    }

  @Test
  @OptIn(ExperimentalCoroutinesApi::class)
  fun overlappingOwnerlessDeletesReconcileEveryCapturedKey() =
    runTest {
      val cache = FakeTranscriptCache()
      val deletedKeys = mutableSetOf<String>()
      val controller =
        ChatController(
          scope = this,
          json = json,
          requestGateway = { method, _ ->
            if (method == "sessions.list") {
              val sessions =
                listOf("custom-a", "custom-b")
                  .filterNot(deletedKeys::contains)
                  .joinToString(",") { key -> """{"key":"$key"}""" }
              """{"sessions":[$sessions]}"""
            } else {
              "{}"
            }
          },
          transcriptCache = cache,
          cacheScope = { gatewayScope },
          currentDefaultAgentId = { "owner-a" },
        )
      controller.refreshSessions()
      advanceUntilIdle()

      deletedKeys += "custom-a"
      deletedKeys += "custom-b"
      controller.handleGatewayEvent(
        "sessions.changed",
        """{"reason":"delete","sessionKey":"custom-a"}""",
      )
      controller.handleGatewayEvent(
        "sessions.changed",
        """{"reason":"delete","sessionKey":"custom-b"}""",
      )
      advanceUntilIdle()

      assertEquals(
        setOf(
          Triple("gateway-a", "owner-a", "custom-a"),
          Triple("gateway-a", "owner-a", "custom-b"),
        ),
        cache.deletedSessions.toSet(),
      )
    }

  @Test
  @OptIn(ExperimentalCoroutinesApi::class)
  fun truncatedOwnerlessDeleteProofPreservesLocalState() =
    runTest {
      val cache = FakeTranscriptCache()
      var deleting = false
      val controller =
        ChatController(
          scope = this,
          json = json,
          requestGateway = { method, _ ->
            when {
              method != "sessions.list" -> "{}"
              deleting -> """{"sessions":[],"hasMore":true}"""
              else -> """{"sessions":[{"key":"custom"}]}"""
            }
          },
          transcriptCache = cache,
          cacheScope = { gatewayScope },
          currentDefaultAgentId = { "owner-a" },
        )
      controller.refreshSessions()
      advanceUntilIdle()

      deleting = true
      controller.handleGatewayEvent(
        "sessions.changed",
        """{"reason":"delete","sessionKey":"custom"}""",
      )
      advanceUntilIdle()

      assertEquals(listOf("custom"), controller.sessions.value.map(ChatSessionEntry::key))
      assertTrue(cache.deletedSessions.isEmpty())
    }

  @Test
  @OptIn(ExperimentalCoroutinesApi::class)
  fun deleteEventForAnotherOwnerDoesNotMutateTheVisibleSessionList() =
    runTest {
      val cache = FakeTranscriptCache()
      val controller =
        ChatController(
          scope = this,
          json = json,
          requestGateway = { method, _ ->
            if (method == "sessions.list") """{"sessions":[{"key":"custom"}]}""" else "{}"
          },
          transcriptCache = cache,
          cacheScope = { gatewayScope },
          currentDefaultAgentId = { "owner-b" },
        )
      controller.refreshSessions()
      advanceUntilIdle()

      controller.handleGatewayEvent(
        "sessions.changed",
        """{"reason":"delete","sessionKey":"custom","agentId":"owner-a"}""",
      )
      advanceUntilIdle()

      assertEquals(listOf("custom"), controller.sessions.value.map { it.key })
      assertEquals(listOf(Triple("gateway-a", "owner-a", "custom")), cache.deletedSessions)
    }

  @Test
  @OptIn(ExperimentalCoroutinesApi::class)
  fun sessionUpdatesStayBoundToTheVisibleOwnerAndRefreshAmbiguousEvents() =
    runTest {
      var sessionListRequests = 0
      val controller =
        ChatController(
          scope = this,
          json = json,
          requestGateway = { method, _ ->
            if (method == "sessions.list") {
              sessionListRequests += 1
              """{"sessions":[{"key":"custom","label":"Original"}]}"""
            } else {
              "{}"
            }
          },
          currentDefaultAgentId = { "owner-a" },
        )
      controller.refreshSessions()
      advanceUntilIdle()

      controller.handleGatewayEvent(
        "sessions.changed",
        """{"session":{"key":"custom","agentId":"owner-b","label":"Foreign"}}""",
      )
      controller.handleGatewayEvent(
        "session.message",
        """{"session":{"key":"custom","agentId":"owner-b","label":"Also foreign"}}""",
      )
      assertEquals(
        "Original",
        controller.sessions.value
          .single()
          .label,
      )

      controller.handleGatewayEvent(
        "sessions.changed",
        """{"session":{"key":"custom","label":"Ambiguous"}}""",
      )
      advanceUntilIdle()

      assertEquals(2, sessionListRequests)
      assertEquals(
        "Original",
        controller.sessions.value
          .single()
          .label,
      )
    }

  @Test
  @OptIn(ExperimentalCoroutinesApi::class)
  fun requestedUnscopedDeleteCarriesAndPurgesItsCapturedOwner() =
    runTest {
      val cache = FakeTranscriptCache()
      var deleteParams = ""
      var defaultAgentId = "owner-a"
      val controller =
        ChatController(
          scope = this,
          json = json,
          requestGateway = { method, params ->
            if (method == "sessions.delete") deleteParams = params.orEmpty()
            when (method) {
              "sessions.list" -> """{"sessions":[{"key":"custom"}]}"""
              "sessions.delete" -> """{"deleted":true}"""
              else -> "{}"
            }
          },
          transcriptCache = cache,
          cacheScope = { gatewayScope },
          currentDefaultAgentId = { defaultAgentId },
        )

      controller.refreshSessions()
      advanceUntilIdle()
      val renderedRow = controller.sessions.value.single()
      defaultAgentId = "owner-b"
      val deletion = controller.deleteSession(renderedRow.key, ownerAgentId = renderedRow.ownerAgentId)
      advanceUntilIdle()

      assertEquals("gateway-a", deletion?.gatewayId)
      assertEquals("owner-a", deletion?.agentId)
      assertEquals("custom", deletion?.sessionKey)
      assertTrue(deleteParams.contains("\"agentId\":\"owner-a\""))
      assertEquals(listOf(Triple("gateway-a", "owner-a", "custom")), cache.deletedSessions)
    }

  @Test
  @OptIn(ExperimentalCoroutinesApi::class)
  fun openingUnscopedSessionRetainsTheRenderedOwnerAfterDefaultChanges() =
    runTest {
      var defaultAgentId = "owner-a"
      var defaultAgentRevision = 1L
      val historyOwners = mutableListOf<String>()
      val controller =
        ChatController(
          scope = this,
          json = json,
          requestGateway = { method, params ->
            when (method) {
              "sessions.list" -> """{"sessions":[{"key":"custom"}]}"""
              "chat.history" -> {
                historyOwners += if (params.orEmpty().contains("\"agentId\":\"owner-a\"")) "owner-a" else "owner-b"
                """{"sessionId":"custom-id","messages":[]}"""
              }
              else -> "{}"
            }
          },
          cacheScope = { gatewayScope },
          currentDefaultAgentId = { defaultAgentId },
          currentDefaultAgentRevision = { defaultAgentRevision },
        )

      controller.refreshSessions()
      advanceUntilIdle()
      val renderedRow = controller.sessions.value.single()
      defaultAgentId = "owner-b"
      defaultAgentRevision += 1

      controller.switchSession(renderedRow.key, renderedRow.ownerAgentId)
      advanceUntilIdle()

      assertEquals("owner-a", controller.sessionOwnerAgentId.value)
      assertEquals(listOf("owner-a"), historyOwners)

      controller.onDefaultAgentChanged("owner-b")
      advanceUntilIdle()

      assertEquals("owner-a", controller.sessionOwnerAgentId.value)
      assertEquals(listOf("owner-a"), historyOwners)
    }

  @Test
  @OptIn(ExperimentalCoroutinesApi::class)
  fun oldGatewayDeleteResponseDoesNotRemoveTheCurrentGatewayRow() =
    runTest {
      val cache = FakeTranscriptCache()
      val deleteStarted = CompletableDeferred<Unit>()
      val deleteGate = CompletableDeferred<Unit>()
      var currentScope = ChatCacheScope(gatewayId = "gateway-a", connectionGeneration = 1)
      var defaultAgentId = "owner-a"
      val controller =
        ChatController(
          scope = this,
          json = json,
          requestGateway = { method, _ ->
            when (method) {
              "sessions.list" -> """{"sessions":[{"key":"custom"}]}"""
              "sessions.delete" -> {
                deleteStarted.complete(Unit)
                deleteGate.await()
                """{"deleted":true}"""
              }
              else -> "{}"
            }
          },
          transcriptCache = cache,
          cacheScope = { currentScope },
          currentDefaultAgentId = { defaultAgentId },
        )

      controller.refreshSessions()
      advanceUntilIdle()
      val oldRow = controller.sessions.value.single()
      val deleteJob = launch { controller.deleteSession(oldRow.key, oldRow.ownerAgentId) }
      deleteStarted.await()

      currentScope = ChatCacheScope(gatewayId = "gateway-b", connectionGeneration = 2)
      defaultAgentId = "owner-b"
      controller.onGatewayScopeChanging()
      controller.refreshSessions()
      runCurrent()
      assertEquals(
        "owner-b",
        controller.sessions.value
          .single()
          .ownerAgentId,
      )

      deleteGate.complete(Unit)
      deleteJob.join()
      advanceUntilIdle()

      assertEquals(listOf("custom"), controller.sessions.value.map { it.key })
      assertEquals(
        "owner-b",
        controller.sessions.value
          .single()
          .ownerAgentId,
      )
      assertEquals(listOf(Triple("gateway-a", "owner-a", "custom")), cache.deletedSessions)
    }

  @Test
  @OptIn(ExperimentalCoroutinesApi::class)
  fun unsuccessfulDeleteResponseKeepsTheOfflineCopy() =
    runTest {
      val cache = FakeTranscriptCache()
      val controller =
        ChatController(
          scope = this,
          json = json,
          requestGateway = { method, _ ->
            if (method == "sessions.delete") """{"deleted":false}""" else """{"sessions":[]}"""
          },
          transcriptCache = cache,
          cacheScope = { gatewayScope },
          currentDefaultAgentId = { "owner-a" },
        )

      assertEquals(null, controller.deleteSession("custom", ownerAgentId = "owner-a"))
      advanceUntilIdle()

      assertTrue(cache.deletedSessions.isEmpty())
    }

  @Test
  @OptIn(ExperimentalCoroutinesApi::class)
  fun liveSessionListIsWrittenThroughToCache() =
    runTest {
      val cache = FakeTranscriptCache()
      var sessionListParams = ""
      val controller =
        ChatController(
          scope = this,
          json = json,
          requestGateway = { method, params ->
            if (method == "sessions.list") sessionListParams = params.orEmpty()
            when (method) {
              "sessions.list" -> """{"sessions":[{"key":"main","updatedAt":7,"displayName":"Main"}]}"""
              "chat.history" -> """{"sessionId":"session-1","messages":[]}"""
              else -> "{}"
            }
          },
          transcriptCache = cache,
          cacheScope = { gatewayScope },
          currentDefaultAgentId = { "main" },
        )

      controller.load("main")
      advanceUntilIdle()

      assertEquals("gateway-a", cache.savedSessions.last().gatewayId)
      assertEquals("main", cache.savedSessions.last().agentId)
      assertEquals(
        listOf("main"),
        cache.savedSessions
          .last()
          .sessions
          .map { it.key },
      )
      assertEquals(null, cache.retainedSessionKeys.last())
      assertEquals(listOf("main"), controller.sessions.value.map { it.key })
      assertTrue(sessionListParams.contains("\"agentId\":\"main\""))
    }

  @Test
  @OptIn(ExperimentalCoroutinesApi::class)
  fun sessionListParsesGroupingAndUnreadMetadata() =
    runTest {
      val controller =
        ChatController(
          scope = this,
          json = json,
          requestGateway = { method, _ ->
            when (method) {
              "sessions.list" ->
                """
                {
                  "sessions": [{
                    "key": "main",
                    "label": "Daily",
                    "category": "Work",
                    "pinned": true,
                    "archived": false,
                    "unread": true,
                    "lastReadAt": 10,
                    "lastActivityAt": 20
                  }]
                }
                """.trimIndent()
              else -> "{}"
            }
          },
        )

      controller.refreshSessions()
      advanceUntilIdle()

      val session = controller.sessions.value.single()
      assertEquals("Daily", session.label)
      assertEquals("Work", session.category)
      assertEquals(true, session.pinned)
      assertEquals(false, session.archived)
      assertEquals(true, session.unread)
      assertEquals(10L, session.lastReadAt)
      assertEquals(20L, session.lastActivityAt)
    }

  @Test
  @OptIn(ExperimentalCoroutinesApi::class)
  fun partialSessionChangedEventPreservesExistingMetadata() =
    runTest {
      val controller =
        ChatController(
          scope = this,
          json = json,
          requestGateway = { method, _ ->
            when (method) {
              "sessions.list" ->
                """{"sessions":[{"key":"main","label":"Daily","category":"Work","pinned":true,"unread":true}]}"""
              else -> "{}"
            }
          },
        )
      controller.refreshSessions()
      advanceUntilIdle()

      controller.handleGatewayEvent(
        "sessions.changed",
        """{"session":{"key":"main","agentId":"main","lastActivityAt":30}}""",
      )

      val session = controller.sessions.value.single()
      assertEquals("Daily", session.label)
      assertEquals("Work", session.category)
      assertEquals(true, session.pinned)
      assertEquals(true, session.unread)
      assertEquals(30L, session.lastActivityAt)
    }

  @Test
  @OptIn(ExperimentalCoroutinesApi::class)
  fun truncatedSessionListRetainsActiveDeepTranscript() =
    runTest {
      val cache = FakeTranscriptCache()
      val controller =
        ChatController(
          scope = this,
          json = json,
          requestGateway = { method, _ ->
            when (method) {
              "sessions.list" ->
                """{"totalCount":2,"hasMore":true,"sessions":[{"key":"main","updatedAt":7}]}"""
              "chat.history" -> """{"sessionId":"session-1","messages":[]}"""
              else -> "{}"
            }
          },
          transcriptCache = cache,
          cacheScope = { gatewayScope },
          currentDefaultAgentId = { "main" },
        )

      controller.load("deep-session")
      advanceUntilIdle()

      assertEquals("deep-session", cache.retainedSessionKeys.last())
    }

  @Test
  @OptIn(ExperimentalCoroutinesApi::class)
  fun completeSessionListRetainsActiveTranscriptBeyondLocalCacheWindow() =
    runTest {
      val cache = FakeTranscriptCache()
      val sessions =
        (0 until MAX_CACHED_SESSIONS + 10).joinToString(",") { index ->
          """{"key":"session-$index","updatedAt":${100 - index}}"""
        }
      val controller =
        ChatController(
          scope = this,
          json = json,
          requestGateway = { method, _ ->
            when (method) {
              "sessions.list" ->
                """{"totalCount":60,"hasMore":false,"sessions":[$sessions]}"""
              "chat.history" -> """{"sessionId":"session-55","messages":[]}"""
              else -> "{}"
            }
          },
          transcriptCache = cache,
          cacheScope = { gatewayScope },
          currentDefaultAgentId = { "main" },
        )

      controller.load("session-55")
      advanceUntilIdle()

      assertEquals("session-55", cache.retainedSessionKeys.last())
    }

  @Test
  @OptIn(ExperimentalCoroutinesApi::class)
  fun oldGatewayHistoryResponseIsNeitherAppliedNorCachedAfterScopeChange() =
    runTest {
      val cache = FakeTranscriptCache()
      val historyGate = CompletableDeferred<Unit>()
      var currentScope = gatewayScope
      val controller =
        ChatController(
          scope = this,
          json = json,
          requestGateway = { method, _ ->
            if (method == "chat.history") {
              historyGate.await()
              """{"sessionId":"old","messages":[{"role":"assistant","content":"old gateway"}]}"""
            } else {
              "{}"
            }
          },
          transcriptCache = cache,
          cacheScope = { currentScope },
          currentDefaultAgentId = { "main" },
        )

      controller.load("main")
      runCurrent()
      assertTrue(controller.historyLoading.value)
      currentScope = ChatCacheScope(gatewayId = "gateway-b", connectionGeneration = 2)
      controller.onGatewayScopeChanging()
      assertFalse(controller.historyLoading.value)
      historyGate.complete(Unit)
      advanceUntilIdle()

      assertTrue(controller.messages.value.isEmpty())
      assertTrue(cache.savedTranscripts.isEmpty())
    }

  @Test
  @OptIn(ExperimentalCoroutinesApi::class)
  fun oldGatewaySessionListIsNeitherAppliedNorCachedAfterScopeChange() =
    runTest {
      val cache = FakeTranscriptCache()
      val sessionsGate = CompletableDeferred<Unit>()
      var currentScope = gatewayScope
      val controller =
        ChatController(
          scope = this,
          json = json,
          requestGateway = { method, _ ->
            if (method == "sessions.list") {
              sessionsGate.await()
              """{"sessions":[{"key":"old-gateway-session"}]}"""
            } else {
              "{}"
            }
          },
          transcriptCache = cache,
          cacheScope = { currentScope },
          currentDefaultAgentId = { "main" },
        )

      controller.refreshSessions()
      runCurrent()
      currentScope = ChatCacheScope(gatewayId = "gateway-b", connectionGeneration = 2)
      sessionsGate.complete(Unit)
      advanceUntilIdle()

      assertTrue(controller.sessions.value.isEmpty())
      assertTrue(cache.savedSessions.isEmpty())
    }

  @Test
  @OptIn(ExperimentalCoroutinesApi::class)
  fun switchingGatewayScopeIsolatesCachedTranscriptAndSessionsThenRestoresThem() =
    runTest {
      val cache = FakeTranscriptCache()
      cache.transcripts[TranscriptKey("gateway-a", "main", "main")] = listOf(cachedMessage("gateway A transcript"))
      cache.sessionsByOwner["gateway-a" to "main"] = listOf(ChatSessionEntry(key = "main", updatedAtMs = 1L, displayName = "Gateway A"))
      cache.sessionsByOwner["gateway-b" to "main"] = emptyList()
      var currentScope = ChatCacheScope(gatewayId = "gateway-a", connectionGeneration = 1)
      val controller =
        ChatController(
          scope = this,
          json = json,
          requestGateway = { _, _ -> throw IllegalStateException("offline") },
          transcriptCache = cache,
          cacheScope = { currentScope },
          currentDefaultAgentId = { "main" },
        )

      controller.load("main")
      advanceUntilIdle()
      assertEquals(listOf("gateway A transcript"), controller.messages.value.map { it.content.single().text })
      assertEquals(listOf("Gateway A"), controller.sessions.value.mapNotNull { it.displayName })

      currentScope = ChatCacheScope(gatewayId = "gateway-b", connectionGeneration = 2)
      controller.onGatewayScopeChanging()
      controller.load("main")
      advanceUntilIdle()
      assertTrue(controller.messages.value.isEmpty())
      assertTrue(controller.sessions.value.isEmpty())

      currentScope = ChatCacheScope(gatewayId = "gateway-a", connectionGeneration = 3)
      controller.onGatewayScopeChanging()
      controller.load("main")
      advanceUntilIdle()
      assertEquals(listOf("gateway A transcript"), controller.messages.value.map { it.content.single().text })
      assertEquals(listOf("Gateway A"), controller.sessions.value.mapNotNull { it.displayName })
    }

  @Test
  @OptIn(ExperimentalCoroutinesApi::class)
  fun unscopedHistoryWaitsForAProvableDefaultOwner() =
    runTest {
      var requestCount = 0
      val controller =
        ChatController(
          scope = this,
          json = json,
          requestGateway = { _, _ ->
            requestCount += 1
            "{}"
          },
          transcriptCache = FakeTranscriptCache(),
          cacheScope = { gatewayScope },
          currentDefaultAgentId = { null },
        )

      controller.load("custom")
      advanceUntilIdle()

      assertEquals(0, requestCount)
      assertFalse(controller.historyLoading.value)
      assertTrue(controller.messages.value.isEmpty())
      assertEquals(null, controller.errorText.value)
    }

  @Test
  @OptIn(ExperimentalCoroutinesApi::class)
  fun offlineUnscopedHistoryUsesTheLastVerifiedGatewayOwner() =
    runTest {
      val cache = FakeTranscriptCache()
      cache.lastDefaultAgents["gateway-a"] = "agent-a"
      cache.transcripts[TranscriptKey("gateway-a", "agent-a", "custom")] = listOf(cachedMessage("offline custom"))
      cache.sessionsByOwner["gateway-a" to "agent-a"] =
        listOf(ChatSessionEntry(key = "custom", updatedAtMs = 1, displayName = "Offline custom"))
      val controller =
        ChatController(
          scope = this,
          json = json,
          requestGateway = { _, _ -> error("offline") },
          transcriptCache = cache,
          cacheScope = { gatewayScope },
          currentDefaultAgentId = { null },
        )

      controller.load("custom")
      advanceUntilIdle()

      assertEquals(listOf("offline custom"), controller.messages.value.map { it.content.single().text })
      assertEquals(listOf("Offline custom"), controller.sessions.value.mapNotNull { it.displayName })
      assertEquals(GatewayDefaultAgentOwner("gateway-a", "agent-a"), controller.composerDefaultAgentOwner.value)
      assertFalse(controller.historyLoading.value)
    }

  @Test
  @OptIn(ExperimentalCoroutinesApi::class)
  fun defaultOwnerChangeClearsAndReloadsActiveUnscopedHistory() =
    runTest {
      var defaultAgentId: String? = "agent-a"
      var defaultAgentRevision = 1L
      val requestedOwners = mutableListOf<String>()
      val cache = FakeTranscriptCache()
      val controller =
        ChatController(
          scope = this,
          json = json,
          requestGateway = { method, params ->
            when (method) {
              "chat.history" -> {
                val owner = if (params.orEmpty().contains("\"agentId\":\"agent-a\"")) "agent-a" else "agent-b"
                requestedOwners += owner
                """{"sessionId":"$owner","messages":[{"role":"assistant","content":"$owner history"}]}"""
              }
              "sessions.list" -> {
                val owner = defaultAgentId ?: "unknown"
                """{"sessions":[{"key":"custom","displayName":"$owner title","updatedAt":1}]}"""
              }
              else -> "{}"
            }
          },
          transcriptCache = cache,
          cacheScope = { gatewayScope },
          currentDefaultAgentId = { defaultAgentId },
          currentDefaultAgentRevision = { defaultAgentRevision },
        )

      controller.load("custom")
      advanceUntilIdle()
      assertEquals(listOf("agent-a history"), controller.messages.value.map { it.content.single().text })
      assertEquals(listOf("agent-a title"), controller.sessions.value.mapNotNull { it.displayName })

      defaultAgentId = null
      defaultAgentRevision += 1
      controller.onDefaultAgentChanged(null)
      runCurrent()
      assertEquals(listOf("agent-a"), requestedOwners)
      assertEquals(listOf("agent-a history"), controller.messages.value.map { it.content.single().text })
      assertEquals(listOf("agent-a title"), controller.sessions.value.mapNotNull { it.displayName })

      defaultAgentId = "agent-a"
      defaultAgentRevision += 1
      controller.onDefaultAgentChanged(defaultAgentId)
      runCurrent()
      assertEquals(listOf("agent-a"), requestedOwners)

      defaultAgentId = "agent-b"
      defaultAgentRevision += 1
      controller.onDefaultAgentChanged(defaultAgentId)
      advanceUntilIdle()

      assertEquals(listOf("agent-a", "agent-b"), requestedOwners)
      assertEquals("agent-b", cache.lastDefaultAgents["gateway-a"])
      assertEquals(listOf("agent-b history"), controller.messages.value.map { it.content.single().text })
      assertEquals(listOf("agent-b title"), controller.sessions.value.mapNotNull { it.displayName })
      assertFalse(controller.historyLoading.value)
    }

  @Test
  @OptIn(ExperimentalCoroutinesApi::class)
  fun latestDefaultOwnerWinsWhenThePreviousCacheWriteFinishesLate() =
    runTest {
      val cache = FakeTranscriptCache()
      val firstWriteStarted = CompletableDeferred<Unit>()
      val releaseFirstWrite = CompletableDeferred<Unit>()
      cache.beforeLastDefaultAgentSave = { _, agentId ->
        if (agentId == "agent-a") {
          firstWriteStarted.complete(Unit)
          releaseFirstWrite.await()
        }
      }
      var defaultAgentId: String? = "agent-a"
      var defaultAgentRevision = 1L
      val controller =
        ChatController(
          scope = this,
          json = json,
          requestGateway = { _, _ -> "{}" },
          transcriptCache = cache,
          cacheScope = { gatewayScope },
          currentDefaultAgentId = { defaultAgentId },
          currentDefaultAgentRevision = { defaultAgentRevision },
        )

      controller.onDefaultAgentChanged("agent-a")
      runCurrent()
      firstWriteStarted.await()
      defaultAgentId = "agent-b"
      defaultAgentRevision += 1
      controller.onDefaultAgentChanged("agent-b")
      runCurrent()
      releaseFirstWrite.complete(Unit)
      advanceUntilIdle()

      assertEquals("agent-b", cache.lastDefaultAgents["gateway-a"])
    }

  @Test
  @OptIn(ExperimentalCoroutinesApi::class)
  fun gatewayCachePurgeDeletesAnInFlightDefaultOwnerWriteAndInvalidatesQueuedWrites() =
    runTest {
      val cache = FakeTranscriptCache()
      val firstWriteStarted = CompletableDeferred<Unit>()
      val releaseFirstWrite = CompletableDeferred<Unit>()
      cache.beforeLastDefaultAgentSave = { _, agentId ->
        if (agentId == "agent-a") {
          firstWriteStarted.complete(Unit)
          releaseFirstWrite.await()
        }
      }
      val controller =
        ChatController(
          scope = this,
          json = json,
          requestGateway = { _, _ -> "{}" },
          transcriptCache = cache,
          cacheScope = { gatewayScope },
        )

      controller.onDefaultAgentChanged("agent-a")
      runCurrent()
      firstWriteStarted.await()
      controller.onDefaultAgentChanged("agent-b")
      val purge = launch { controller.clearGatewayCache("gateway-a") }
      runCurrent()

      releaseFirstWrite.complete(Unit)
      purge.join()
      advanceUntilIdle()

      assertFalse(cache.lastDefaultAgents.containsKey("gateway-a"))
      assertEquals(null, controller.composerDefaultAgentOwner.value)
    }

  @Test
  @OptIn(ExperimentalCoroutinesApi::class)
  fun liveDefaultOwnerWinsWhenPersistedOwnerLoadFinishesLate() =
    runTest {
      val cache = FakeTranscriptCache()
      cache.lastDefaultAgents["gateway-a"] = "agent-b"
      val cacheLoadStarted = CompletableDeferred<Unit>()
      val releaseCacheLoad = CompletableDeferred<Unit>()
      cache.beforeLastDefaultAgentLoad = {
        cacheLoadStarted.complete(Unit)
        releaseCacheLoad.await()
      }
      var defaultAgentId: String? = null
      var defaultAgentRevision = 1L
      val controller =
        ChatController(
          scope = this,
          json = json,
          requestGateway = { _, _ -> "{}" },
          transcriptCache = cache,
          cacheScope = { gatewayScope },
          currentDefaultAgentId = { defaultAgentId },
          currentDefaultAgentRevision = { defaultAgentRevision },
        )

      controller.load("custom")
      runCurrent()
      cacheLoadStarted.await()
      defaultAgentId = "agent-a"
      defaultAgentRevision += 1
      controller.onDefaultAgentChanged("agent-a")
      runCurrent()
      releaseCacheLoad.complete(Unit)
      advanceUntilIdle()

      assertEquals(GatewayDefaultAgentOwner("gateway-a", "agent-a"), controller.composerDefaultAgentOwner.value)
    }
}
