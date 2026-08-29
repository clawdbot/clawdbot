package ai.openclaw.app.chat

import androidx.room.Room
import kotlinx.coroutines.test.runTest
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment

@RunWith(RobolectricTestRunner::class)
class RoomChatTranscriptCacheTest {
  private val database: GatewayCacheDatabase =
    Room
      .inMemoryDatabaseBuilder(RuntimeEnvironment.getApplication(), GatewayCacheDatabase::class.java)
      .build()
  private val store = RoomChatTranscriptCache(database = database)

  @After
  fun tearDown() {
    database.close()
  }

  private fun message(
    text: String,
    role: String = "user",
    timestampMs: Long? = 1L,
    idempotencyKey: String? = null,
    extraParts: List<ChatMessageContent> = emptyList(),
  ): ChatMessage =
    ChatMessage(
      id = "id-$text",
      role = role,
      content = listOf(ChatMessageContent(type = "text", text = text)) + extraParts,
      timestampMs = timestampMs,
      idempotencyKey = idempotencyKey,
    )

  private suspend fun saveTranscript(
    messages: List<ChatMessage>,
    gatewayId: String = "gateway-a",
    agentId: String = "main",
    sessionKey: String = "main",
  ) = store.saveTranscript(gatewayId, agentId, sessionKey, messages)

  private suspend fun loadTranscript(
    gatewayId: String = "gateway-a",
    agentId: String = "main",
    sessionKey: String = "main",
  ): List<ChatMessage> = store.loadTranscript(gatewayId, agentId, sessionKey)

  private suspend fun saveSessions(
    sessions: List<ChatSessionEntry>,
    gatewayId: String = "gateway-a",
    agentId: String = "main",
    retainedSessionKey: String? = null,
  ) = store.saveSessions(gatewayId, agentId, sessions, retainedSessionKey)

  private suspend fun loadSessions(
    gatewayId: String = "gateway-a",
    agentId: String = "main",
  ): List<ChatSessionEntry> = store.loadSessions(gatewayId, agentId)

  @Test
  fun transcriptRoundTripKeepsTextAndManagedReferencesWithoutBinaryParts() =
    runTest {
      val imagePart = ChatMessageContent(type = "image", mimeType = "image/png", fileName = "a.png", base64 = "AAAA")
      val managedImage =
        ChatMessageContent(
          type = "image",
          mimeType = "image/png",
          artifactId = "artifact_managed_image_11111111-1111-4111-8111-111111111111",
          url = "/api/chat/media/outgoing/main/11111111-1111-4111-8111-111111111111/full",
          alt = "Managed image",
        )
      saveTranscript(
        messages =
          listOf(
            message("hello", role = "user", timestampMs = 10, idempotencyKey = "run-1:user", extraParts = listOf(imagePart))
              .copy(senderLabel = "Alex (Slack)"),
            // Inline binary-only messages remain disposable and are skipped entirely.
            ChatMessage(id = "img", role = "user", content = listOf(imagePart), timestampMs = 11),
            ChatMessage(id = "managed", role = "assistant", content = listOf(managedImage), timestampMs = 11),
            message("world", role = "assistant", timestampMs = 12),
          ),
      )

      val loaded = loadTranscript()

      assertEquals(listOf("hello", null, "world"), loaded.map { it.content.single().text })
      assertTrue(loaded.all { message -> message.content.all { part -> part.base64 == null } })
      assertEquals(managedImage.artifactId, loaded[1].content.single().artifactId)
      assertEquals(listOf("user", "assistant", "assistant"), loaded.map { it.role })
      assertEquals(listOf(10L, 11L, 12L), loaded.map { it.timestampMs })
      assertEquals(listOf("run-1:user", null, null), loaded.map { it.idempotencyKey })
      assertEquals(listOf("Alex (Slack)", null, null), loaded.map { it.senderLabel })
    }

  @Test
  fun transcriptRoundTripKeepsManagedAudioVideoAndDocumentMetadata() =
    runTest {
      val audio =
        ChatMessageContent(
          type = "audio",
          mimeType = "audio/mpeg",
          fileName = "reply.mp3",
          artifactId = "artifact_managed_media_33333333-3333-4333-8333-333333333333",
          durationMs = 2_100,
        )
      val video =
        ChatMessageContent(
          type = "video",
          mimeType = "video/mp4",
          fileName = "demo.mp4",
          artifactId = "artifact_managed_media_44444444-4444-4444-8444-444444444444",
          durationMs = 5_300,
          playback = "transcode",
          width = 1920,
          height = 1080,
        )
      val userDocument =
        ChatMessageContent(
          type = "file",
          mimeType = "application/pdf",
          fileName = "proposal.pdf",
          artifactId = "artifact_managed_media_55555555-5555-4555-8555-555555555555",
          url = "/api/chat/media/outgoing/main/55555555-5555-4555-8555-555555555555/full",
          sizeBytes = 4_096,
        )
      val assistantDocument =
        ChatMessageContent(
          type = "file",
          mimeType = "text/plain",
          fileName = "summary.txt",
          url = "https://files.example/summary.txt",
          sizeBytes = 48,
        )
      val mixedText = ChatMessageContent(type = "text", text = "See attached.")
      saveTranscript(
        messages =
          listOf(
            ChatMessage(id = "audio", role = "assistant", content = listOf(audio), timestampMs = 10),
            ChatMessage(id = "video", role = "assistant", content = listOf(video), timestampMs = 11),
            ChatMessage(
              id = "user-document",
              role = "user",
              content = listOf(userDocument),
              timestampMs = 12,
              idempotencyKey = "run-document:user",
              entryId = "live-user-entry",
              senderLabel = "Alex (Slack)",
            ),
            ChatMessage(id = "assistant-document", role = "assistant", content = listOf(assistantDocument), timestampMs = 13),
            ChatMessage(id = "user-mixed", role = "user", content = listOf(mixedText, userDocument), timestampMs = 14),
            ChatMessage(id = "assistant-mixed", role = "assistant", content = listOf(mixedText, assistantDocument), timestampMs = 15),
          ),
      )

      val loaded = loadTranscript()

      assertEquals(
        listOf(
          listOf(audio),
          listOf(video),
          listOf(userDocument),
          listOf(assistantDocument),
          listOf(mixedText, userDocument),
          listOf(mixedText, assistantDocument),
        ),
        loaded.map { it.content },
      )
      assertEquals(listOf("assistant", "assistant", "user", "assistant", "user", "assistant"), loaded.map { it.role })
      assertEquals("Alex (Slack)", loaded[2].senderLabel)
      assertEquals("run-document:user", loaded[2].idempotencyKey)
      assertTrue(loaded.all { it.entryId == null && it.content.all { part -> part.base64 == null } })
      assertTrue(loadTranscript(gatewayId = "gateway-b").isEmpty())
      assertTrue(loadTranscript(agentId = "other").isEmpty())
      assertTrue(loadTranscript(sessionKey = "other").isEmpty())
    }

  @Test
  fun transcriptRoundTripKeepsSystemNoticeMetadataIncludingMarkerOnlyRows() =
    runTest {
      val provenance =
        ChatMessageProvenance(
          kind = "internal_system",
          sourceTool = "restart-sentinel",
        )
      val marker =
        ChatTranscriptMarker(
          kind = "compaction",
          id = "checkpoint-1",
          tokensBefore = 42_500.0,
          tokensAfter = 2_000.0,
        )
      saveTranscript(
        messages =
          listOf(
            message("[System] Gateway restarted.").copy(provenance = provenance),
            ChatMessage(
              id = "marker-only",
              role = "system",
              content = emptyList(),
              timestampMs = 2L,
              transcriptMarker = marker,
            ),
          ),
      )

      val loaded = loadTranscript()

      assertEquals(2, loaded.size)
      assertEquals(provenance, loaded[0].provenance)
      assertEquals(marker, loaded[1].transcriptMarker)
      assertTrue(loaded[1].content.isEmpty())
    }

  @Test
  fun legacyTranscriptRowsRemainReadable() =
    runTest {
      database.dao().insertMessages(
        listOf(
          CachedMessageEntity(
            gatewayId = "gateway-a",
            agentId = "main",
            sessionKey = "main",
            rowOrder = 0,
            role = "assistant",
            textPartsJson = """["legacy one","legacy two"]""",
            timestampMs = 10,
            idempotencyKey = null,
          ),
          CachedMessageEntity(
            gatewayId = "gateway-a",
            agentId = "main",
            sessionKey = "main",
            rowOrder = 1,
            role = "assistant",
            textPartsJson = """[{"type":"text","text":"structured legacy"}]""",
            timestampMs = 11,
            idempotencyKey = null,
          ),
        ),
      )

      val loaded = loadTranscript()

      assertEquals(listOf("legacy one", "legacy two"), loaded[0].content.map { it.text })
      assertEquals(listOf("structured legacy"), loaded[1].content.map { it.text })
      assertEquals(listOf(null, null), loaded.map { it.senderLabel })
    }

  @Test
  fun lastDefaultOwnerIsGatewayScopedAndClearedWithItsCache() =
    runTest {
      store.saveLastDefaultAgentId("gateway-a", "agent-a")
      store.saveLastDefaultAgentId("gateway-b", "agent-b")

      assertEquals("agent-a", store.loadLastDefaultAgentId("gateway-a"))
      assertEquals("agent-b", store.loadLastDefaultAgentId("gateway-b"))

      store.clearGateway("gateway-a")

      assertEquals(null, store.loadLastDefaultAgentId("gateway-a"))
      assertEquals("agent-b", store.loadLastDefaultAgentId("gateway-b"))
    }

  @Test
  fun transcriptRoundTripDropsInternalRoleRows() =
    runTest {
      saveTranscript(
        messages =
          listOf(
            message("hello", role = "user"),
            message("private tool output", role = "toolResult"),
            message("visible plugin notice", role = "custom"),
            message("reply", role = "assistant"),
          ),
      )

      val loaded = loadTranscript()

      assertEquals(listOf("hello", "visible plugin notice", "reply"), loaded.map { it.content.single().text })
      assertEquals(listOf("user", "custom", "assistant"), loaded.map { it.role })
    }

  @Test
  fun transcriptWriteKeepsOnlyNewestBoundedMessages() =
    runTest {
      saveTranscript(
        messages = (0 until MAX_CACHED_MESSAGES_PER_SESSION + 50).map { index -> message("m$index", timestampMs = index.toLong()) },
      )

      val loadedTexts = loadTranscript().map { it.content.single().text }

      assertEquals(MAX_CACHED_MESSAGES_PER_SESSION, loadedTexts.size)
      assertEquals("m50", loadedTexts.first())
      assertEquals("m249", loadedTexts.last())
    }

  @Test
  fun sessionWriteEvictsBeyondBoundAndDropsOrphanedTranscripts() =
    runTest {
      saveTranscript(sessionKey = "session-10", messages = listOf(message("kept")))
      saveTranscript(sessionKey = "session-55", messages = listOf(message("evicted")))

      saveSessions(
        sessions =
          (0 until MAX_CACHED_SESSIONS + 10).map { index ->
            ChatSessionEntry(key = "session-$index", updatedAtMs = 1000L - index, displayName = "Session $index")
          },
      )

      val sessions = loadSessions()
      assertEquals(MAX_CACHED_SESSIONS, sessions.size)
      assertEquals("session-0", sessions.first().key)
      assertEquals("session-${MAX_CACHED_SESSIONS - 1}", sessions.last().key)
      assertEquals("Session 0", sessions.first().displayName)
      assertEquals(listOf("kept"), loadTranscript(sessionKey = "session-10").map { it.content.single().text })
      assertEquals(emptyList<ChatMessage>(), loadTranscript(sessionKey = "session-55"))
    }

  @Test
  fun sessionRoundTripKeepsRunMetadataAndColor() =
    runTest {
      saveSessions(
        sessions =
          listOf(
            ChatSessionEntry(
              key = "main",
              updatedAtMs = 20L,
              status = "done",
              color = "cyan",
              startedAt = 1_000L,
              endedAt = 5_000L,
              runtimeMs = 4_000L,
              outputTokens = 485L,
            ),
          ),
      )

      val loaded = loadSessions().single()

      assertEquals("done", loaded.status)
      assertEquals(1_000L, loaded.startedAt)
      assertEquals(5_000L, loaded.endedAt)
      assertEquals(4_000L, loaded.runtimeMs)
      assertEquals(485L, loaded.outputTokens)
      assertTrue(loaded.hasRunMetadata)
      assertEquals("cyan", loaded.color)

      saveTranscript(messages = listOf(message("new reply")))
      assertEquals("cyan", loadSessions().single().color)
      saveSessions(listOf(loaded.copy(color = null, hasColorMetadata = true)))
      assertEquals(null, loadSessions().single().color)
    }

  @Test
  fun sessionCacheDoesNotPersistDurableSessionIdentity() =
    runTest {
      saveSessions(
        sessions =
          listOf(
            ChatSessionEntry(
              key = "main",
              updatedAtMs = 20L,
              sessionId = "live-session-id",
            ),
          ),
      )

      assertEquals(null, loadSessions().single().sessionId)
    }

  @Test
  fun transcriptForSessionOutsideFullCachedListSurvivesEviction() =
    runTest {
      saveSessions(
        sessions =
          (0 until MAX_CACHED_SESSIONS).map { index ->
            ChatSessionEntry(key = "session-$index", updatedAtMs = 1000L - index)
          },
      )

      saveTranscript(sessionKey = "deep-session", messages = listOf(message("deep text")))

      assertEquals(listOf("deep text"), loadTranscript(sessionKey = "deep-session").map { it.content.single().text })
      val sessionKeys = loadSessions().map { it.key }
      assertEquals(MAX_CACHED_SESSIONS, sessionKeys.size)
      assertTrue(sessionKeys.contains("deep-session"))
    }

  @Test
  fun sessionCacheIsBoundedAcrossEveryAgentInOneGateway() =
    runTest {
      repeat(MAX_CACHED_SESSIONS + 1) { index ->
        saveTranscript(
          agentId = "agent-$index",
          messages = listOf(message("message-$index")),
        )
      }

      val cachedSessionCount =
        (0..MAX_CACHED_SESSIONS).sumOf { index ->
          loadSessions(agentId = "agent-$index").size
        }
      assertEquals(MAX_CACHED_SESSIONS, cachedSessionCount)
      assertTrue(loadTranscript(agentId = "agent-0").isEmpty())
      assertEquals(
        listOf("message-$MAX_CACHED_SESSIONS"),
        loadTranscript(agentId = "agent-$MAX_CACHED_SESSIONS")
          .map { it.content.single().text },
      )
    }

  @Test
  fun activeDeepTranscriptSurvivesSessionListRefresh() =
    runTest {
      val listedSessions =
        (0 until MAX_CACHED_SESSIONS).map { index ->
          ChatSessionEntry(key = "session-$index", updatedAtMs = 1000L - index)
        }
      saveSessions(sessions = listedSessions)
      saveTranscript(
        sessionKey = "deep-session",
        messages = listOf(message("deep text")),
      )

      saveSessions(
        sessions = listedSessions,
        retainedSessionKey = "deep-session",
      )

      assertEquals(MAX_CACHED_SESSIONS, loadSessions().size)
      assertTrue(loadSessions().any { it.key == "deep-session" })
      assertEquals(
        listOf("deep text"),
        loadTranscript(sessionKey = "deep-session").map { it.content.single().text },
      )
    }

  @Test
  fun completeSessionListRefreshDropsMissingDeepTranscript() =
    runTest {
      saveSessions(
        sessions = listOf(ChatSessionEntry(key = "deep-session", updatedAtMs = 1)),
      )
      saveTranscript(
        sessionKey = "deep-session",
        messages = listOf(message("deleted remotely")),
      )

      saveSessions(
        sessions = listOf(ChatSessionEntry(key = "main", updatedAtMs = 2)),
      )

      assertEquals(listOf("main"), loadSessions().map { it.key })
      assertTrue(loadTranscript(sessionKey = "deep-session").isEmpty())
    }

  @Test
  fun deleteSessionRemovesSessionRowAndTranscript() =
    runTest {
      saveSessions(
        sessions =
          listOf(
            ChatSessionEntry(key = "main", updatedAtMs = 1),
            ChatSessionEntry(key = "other", updatedAtMs = 2),
          ),
      )
      saveTranscript(messages = listOf(message("delete me")))
      saveTranscript(agentId = "other", messages = listOf(message("delete me too")))
      saveTranscript(sessionKey = "other", messages = listOf(message("keep me")))

      store.deleteSession("gateway-a", "main", "main")

      assertEquals(emptyList<ChatMessage>(), loadTranscript())
      assertEquals(listOf("delete me too"), loadTranscript(agentId = "other").map { it.content.single().text })
      assertEquals(listOf("other"), loadSessions().map { it.key })
      assertEquals(listOf("keep me"), loadTranscript(sessionKey = "other").map { it.content.single().text })
    }

  @Test
  fun transcriptsAreScopedToGatewayIdentity() =
    runTest {
      saveTranscript(messages = listOf(message("gateway a text")))
      saveSessions(listOf(ChatSessionEntry(key = "main", updatedAtMs = 1)))

      assertEquals(emptyList<ChatMessage>(), loadTranscript(gatewayId = "gateway-b"))
      assertEquals(emptyList<ChatSessionEntry>(), loadSessions(gatewayId = "gateway-b"))
      saveTranscript(gatewayId = "gateway-b", messages = listOf(message("gateway b text")))

      assertEquals(listOf("gateway a text"), loadTranscript().map { it.content.single().text })
      assertEquals(listOf("main"), loadSessions().map { it.key })
    }

  @Test
  fun blankGatewayIdentityDisablesReadsAndWrites() =
    runTest {
      saveTranscript(gatewayId = "", messages = listOf(message("must not persist")))
      saveSessions(listOf(ChatSessionEntry(key = "main", updatedAtMs = 1)), gatewayId = "")

      assertEquals(emptyList<ChatMessage>(), loadTranscript(gatewayId = ""))
      assertEquals(emptyList<ChatSessionEntry>(), loadSessions(gatewayId = ""))

      // Nothing was written under a fallback scope either.
      assertEquals(emptyList<ChatMessage>(), loadTranscript())
      assertEquals(emptyList<ChatSessionEntry>(), loadSessions())
    }

  @Test
  fun transcriptsAreScopedToAgentOwnership() =
    runTest {
      saveTranscript(agentId = "agent-a", sessionKey = "custom", messages = listOf(message("agent a text")))
      saveTranscript(agentId = "agent-b", sessionKey = "custom", messages = listOf(message("agent b text")))
      saveSessions(
        agentId = "agent-a",
        sessions = listOf(ChatSessionEntry(key = "agent-a-session", updatedAtMs = 1)),
        retainedSessionKey = "custom",
      )
      saveSessions(
        agentId = "agent-b",
        sessions = listOf(ChatSessionEntry(key = "agent-b-session", updatedAtMs = 2)),
        retainedSessionKey = "custom",
      )

      assertEquals(
        listOf("agent a text"),
        loadTranscript(agentId = "agent-a", sessionKey = "custom").map { it.content.single().text },
      )
      assertEquals(
        listOf("agent b text"),
        loadTranscript(agentId = "agent-b", sessionKey = "custom").map { it.content.single().text },
      )
      assertEquals(listOf("agent-a-session", "custom"), loadSessions(agentId = "agent-a").map { it.key })
      assertEquals(listOf("agent-b-session", "custom"), loadSessions(agentId = "agent-b").map { it.key })
    }
}
