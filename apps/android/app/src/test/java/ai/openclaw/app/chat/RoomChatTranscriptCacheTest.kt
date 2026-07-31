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

  @After
  fun tearDown() {
    database.close()
  }

  private fun cache(): RoomChatTranscriptCache = RoomChatTranscriptCache(database = database)

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

  @Test
  fun transcriptRoundTripKeepsTextAndManagedReferencesWithoutBinaryParts() =
    runTest {
      val store = cache()
      val imagePart = ChatMessageContent(type = "image", mimeType = "image/png", fileName = "a.png", base64 = "AAAA")
      val managedImage =
        ChatMessageContent(
          type = "image",
          mimeType = "image/png",
          artifactId = "artifact_managed_image_11111111-1111-4111-8111-111111111111",
          url = "/api/chat/media/outgoing/main/11111111-1111-4111-8111-111111111111/full",
          alt = "Managed image",
        )
      store.saveTranscript(
        gatewayId = "gateway-a",
        agentId = "main",
        sessionKey = "main",
        messages =
          listOf(
            message("hello", role = "user", timestampMs = 10, idempotencyKey = "run-1:user", extraParts = listOf(imagePart)),
            // Inline binary-only messages remain disposable and are skipped entirely.
            ChatMessage(id = "img", role = "user", content = listOf(imagePart), timestampMs = 11),
            ChatMessage(id = "managed", role = "assistant", content = listOf(managedImage), timestampMs = 11),
            message("world", role = "assistant", timestampMs = 12),
          ),
      )

      val loaded = store.loadTranscript("gateway-a", "main", "main")

      assertEquals(listOf("hello", null, "world"), loaded.map { it.content.single().text })
      assertTrue(loaded.all { message -> message.content.all { part -> part.base64 == null } })
      assertEquals(managedImage.artifactId, loaded[1].content.single().artifactId)
      assertEquals(listOf("user", "assistant", "assistant"), loaded.map { it.role })
      assertEquals(listOf(10L, 11L, 12L), loaded.map { it.timestampMs })
      assertEquals(listOf("run-1:user", null, null), loaded.map { it.idempotencyKey })
    }

  @Test
  fun transcriptRoundTripKeepsManagedAudioAndVideoMetadata() =
    runTest {
      val store = cache()
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
      store.saveTranscript(
        gatewayId = "gateway-a",
        agentId = "main",
        sessionKey = "main",
        messages =
          listOf(
            ChatMessage(id = "audio", role = "assistant", content = listOf(audio), timestampMs = 10),
            ChatMessage(id = "video", role = "assistant", content = listOf(video), timestampMs = 11),
          ),
      )

      val loaded = store.loadTranscript("gateway-a", "main", "main")

      assertEquals(listOf(audio, video), loaded.map { it.content.single() })
    }

  @Test
  fun legacyStringArrayTranscriptRowsRemainReadable() =
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
        ),
      )

      val loaded = cache().loadTranscript("gateway-a", "main", "main").single()

      assertEquals(listOf("legacy one", "legacy two"), loaded.content.map { it.text })
    }

  @Test
  fun lastDefaultOwnerIsGatewayScopedAndClearedWithItsCache() =
    runTest {
      val store = cache()
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
      val store = cache()
      store.saveTranscript(
        gatewayId = "gateway-a",
        agentId = "main",
        sessionKey = "main",
        messages =
          listOf(
            message("hello", role = "user"),
            message("private tool output", role = "toolResult"),
            message("visible plugin notice", role = "custom"),
            message("reply", role = "assistant"),
          ),
      )

      val loaded = store.loadTranscript("gateway-a", "main", "main")

      assertEquals(listOf("hello", "visible plugin notice", "reply"), loaded.map { it.content.single().text })
      assertEquals(listOf("user", "custom", "assistant"), loaded.map { it.role })
    }

  @Test
  fun transcriptWriteKeepsOnlyNewestBoundedMessages() =
    runTest {
      val store = cache()
      store.saveTranscript(
        gatewayId = "gateway-a",
        agentId = "main",
        sessionKey = "main",
        messages = (0 until MAX_CACHED_MESSAGES_PER_SESSION + 50).map { index -> message("m$index", timestampMs = index.toLong()) },
      )

      val loadedTexts = store.loadTranscript("gateway-a", "main", "main").map { it.content.single().text }

      assertEquals(MAX_CACHED_MESSAGES_PER_SESSION, loadedTexts.size)
      assertEquals("m50", loadedTexts.first())
      assertEquals("m249", loadedTexts.last())
    }

  @Test
  fun sessionWriteEvictsBeyondBoundAndDropsOrphanedTranscripts() =
    runTest {
      val store = cache()
      store.saveTranscript(gatewayId = "gateway-a", agentId = "main", sessionKey = "session-10", messages = listOf(message("kept")))
      store.saveTranscript(gatewayId = "gateway-a", agentId = "main", sessionKey = "session-55", messages = listOf(message("evicted")))

      store.saveSessions(
        gatewayId = "gateway-a",
        agentId = "main",
        sessions =
          (0 until MAX_CACHED_SESSIONS + 10).map { index ->
            ChatSessionEntry(key = "session-$index", updatedAtMs = 1000L - index, displayName = "Session $index")
          },
      )

      val sessions = store.loadSessions("gateway-a", "main")
      assertEquals(MAX_CACHED_SESSIONS, sessions.size)
      assertEquals("session-0", sessions.first().key)
      assertEquals("session-${MAX_CACHED_SESSIONS - 1}", sessions.last().key)
      assertEquals("Session 0", sessions.first().displayName)
      assertEquals(listOf("kept"), store.loadTranscript("gateway-a", "main", "session-10").map { it.content.single().text })
      assertEquals(emptyList<ChatMessage>(), store.loadTranscript("gateway-a", "main", "session-55"))
    }

  @Test
  fun sessionRoundTripKeepsRunMetadata() =
    runTest {
      val store = cache()
      store.saveSessions(
        gatewayId = "gateway-a",
        agentId = "main",
        sessions =
          listOf(
            ChatSessionEntry(
              key = "main",
              updatedAtMs = 20L,
              status = "done",
              startedAt = 1_000L,
              endedAt = 5_000L,
              runtimeMs = 4_000L,
              outputTokens = 485L,
            ),
          ),
      )

      val loaded = store.loadSessions("gateway-a", "main").single()

      assertEquals("done", loaded.status)
      assertEquals(1_000L, loaded.startedAt)
      assertEquals(5_000L, loaded.endedAt)
      assertEquals(4_000L, loaded.runtimeMs)
      assertEquals(485L, loaded.outputTokens)
      assertTrue(loaded.hasRunMetadata)
    }

  @Test
  fun transcriptForSessionOutsideFullCachedListSurvivesEviction() =
    runTest {
      val store = cache()
      store.saveSessions(
        gatewayId = "gateway-a",
        agentId = "main",
        sessions =
          (0 until MAX_CACHED_SESSIONS).map { index ->
            ChatSessionEntry(key = "session-$index", updatedAtMs = 1000L - index)
          },
      )

      store.saveTranscript(gatewayId = "gateway-a", agentId = "main", sessionKey = "deep-session", messages = listOf(message("deep text")))

      assertEquals(listOf("deep text"), store.loadTranscript("gateway-a", "main", "deep-session").map { it.content.single().text })
      val sessionKeys = store.loadSessions("gateway-a", "main").map { it.key }
      assertEquals(MAX_CACHED_SESSIONS, sessionKeys.size)
      assertTrue(sessionKeys.contains("deep-session"))
    }

  @Test
  fun sessionCacheIsBoundedAcrossEveryAgentInOneGateway() =
    runTest {
      val store = cache()
      repeat(MAX_CACHED_SESSIONS + 1) { index ->
        store.saveTranscript(
          gatewayId = "gateway-a",
          agentId = "agent-$index",
          sessionKey = "main",
          messages = listOf(message("message-$index")),
        )
      }

      val cachedSessionCount =
        (0..MAX_CACHED_SESSIONS).sumOf { index ->
          store.loadSessions("gateway-a", "agent-$index").size
        }
      assertEquals(MAX_CACHED_SESSIONS, cachedSessionCount)
      assertTrue(store.loadTranscript("gateway-a", "agent-0", "main").isEmpty())
      assertEquals(
        listOf("message-$MAX_CACHED_SESSIONS"),
        store
          .loadTranscript("gateway-a", "agent-$MAX_CACHED_SESSIONS", "main")
          .map { it.content.single().text },
      )
    }

  @Test
  fun activeDeepTranscriptSurvivesSessionListRefresh() =
    runTest {
      val store = cache()
      val listedSessions =
        (0 until MAX_CACHED_SESSIONS).map { index ->
          ChatSessionEntry(key = "session-$index", updatedAtMs = 1000L - index)
        }
      store.saveSessions(gatewayId = "gateway-a", agentId = "main", sessions = listedSessions)
      store.saveTranscript(
        gatewayId = "gateway-a",
        agentId = "main",
        sessionKey = "deep-session",
        messages = listOf(message("deep text")),
      )

      store.saveSessions(
        gatewayId = "gateway-a",
        agentId = "main",
        sessions = listedSessions,
        retainedSessionKey = "deep-session",
      )

      assertEquals(MAX_CACHED_SESSIONS, store.loadSessions("gateway-a", "main").size)
      assertTrue(store.loadSessions("gateway-a", "main").any { it.key == "deep-session" })
      assertEquals(
        listOf("deep text"),
        store.loadTranscript("gateway-a", "main", "deep-session").map { it.content.single().text },
      )
    }

  @Test
  fun completeSessionListRefreshDropsMissingDeepTranscript() =
    runTest {
      val store = cache()
      store.saveSessions(
        gatewayId = "gateway-a",
        agentId = "main",
        sessions = listOf(ChatSessionEntry(key = "deep-session", updatedAtMs = 1)),
      )
      store.saveTranscript(
        gatewayId = "gateway-a",
        agentId = "main",
        sessionKey = "deep-session",
        messages = listOf(message("deleted remotely")),
      )

      store.saveSessions(
        gatewayId = "gateway-a",
        agentId = "main",
        sessions = listOf(ChatSessionEntry(key = "main", updatedAtMs = 2)),
      )

      assertEquals(listOf("main"), store.loadSessions("gateway-a", "main").map { it.key })
      assertTrue(store.loadTranscript("gateway-a", "main", "deep-session").isEmpty())
    }

  @Test
  fun deleteSessionRemovesSessionRowAndTranscript() =
    runTest {
      val store = cache()
      store.saveSessions(
        gatewayId = "gateway-a",
        agentId = "main",
        sessions =
          listOf(
            ChatSessionEntry(key = "main", updatedAtMs = 1),
            ChatSessionEntry(key = "other", updatedAtMs = 2),
          ),
      )
      store.saveTranscript(gatewayId = "gateway-a", agentId = "main", sessionKey = "main", messages = listOf(message("delete me")))
      store.saveTranscript(gatewayId = "gateway-a", agentId = "other", sessionKey = "main", messages = listOf(message("delete me too")))
      store.saveTranscript(gatewayId = "gateway-a", agentId = "main", sessionKey = "other", messages = listOf(message("keep me")))

      store.deleteSession("gateway-a", "main", "main")

      assertEquals(emptyList<ChatMessage>(), store.loadTranscript("gateway-a", "main", "main"))
      assertEquals(listOf("delete me too"), store.loadTranscript("gateway-a", "other", "main").map { it.content.single().text })
      assertEquals(listOf("other"), store.loadSessions("gateway-a", "main").map { it.key })
      assertEquals(listOf("keep me"), store.loadTranscript("gateway-a", "main", "other").map { it.content.single().text })
    }

  @Test
  fun transcriptsAreScopedToGatewayIdentity() =
    runTest {
      val store = cache()
      store.saveTranscript(gatewayId = "gateway-a", agentId = "main", sessionKey = "main", messages = listOf(message("gateway a text")))
      store.saveSessions("gateway-a", "main", listOf(ChatSessionEntry(key = "main", updatedAtMs = 1)))

      assertEquals(emptyList<ChatMessage>(), store.loadTranscript("gateway-b", "main", "main"))
      assertEquals(emptyList<ChatSessionEntry>(), store.loadSessions("gateway-b", "main"))
      store.saveTranscript(gatewayId = "gateway-b", agentId = "main", sessionKey = "main", messages = listOf(message("gateway b text")))

      assertEquals(listOf("gateway a text"), store.loadTranscript("gateway-a", "main", "main").map { it.content.single().text })
      assertEquals(listOf("main"), store.loadSessions("gateway-a", "main").map { it.key })
    }

  @Test
  fun blankGatewayIdentityDisablesReadsAndWrites() =
    runTest {
      val store = cache()
      store.saveTranscript(gatewayId = "", agentId = "main", sessionKey = "main", messages = listOf(message("must not persist")))
      store.saveSessions("", "main", listOf(ChatSessionEntry(key = "main", updatedAtMs = 1)))

      assertEquals(emptyList<ChatMessage>(), store.loadTranscript("", "main", "main"))
      assertEquals(emptyList<ChatSessionEntry>(), store.loadSessions("", "main"))

      // Nothing was written under a fallback scope either.
      assertEquals(emptyList<ChatMessage>(), store.loadTranscript("gateway-a", "main", "main"))
      assertEquals(emptyList<ChatSessionEntry>(), store.loadSessions("gateway-a", "main"))
    }

  @Test
  fun transcriptsAreScopedToAgentOwnership() =
    runTest {
      val store = cache()
      store.saveTranscript("gateway-a", "agent-a", "custom", listOf(message("agent a text")))
      store.saveTranscript("gateway-a", "agent-b", "custom", listOf(message("agent b text")))
      store.saveSessions(
        "gateway-a",
        "agent-a",
        listOf(ChatSessionEntry(key = "agent-a-session", updatedAtMs = 1)),
        retainedSessionKey = "custom",
      )
      store.saveSessions(
        "gateway-a",
        "agent-b",
        listOf(ChatSessionEntry(key = "agent-b-session", updatedAtMs = 2)),
        retainedSessionKey = "custom",
      )

      assertEquals(
        listOf("agent a text"),
        store.loadTranscript("gateway-a", "agent-a", "custom").map { it.content.single().text },
      )
      assertEquals(
        listOf("agent b text"),
        store.loadTranscript("gateway-a", "agent-b", "custom").map { it.content.single().text },
      )
      assertEquals(listOf("agent-a-session", "custom"), store.loadSessions("gateway-a", "agent-a").map { it.key })
      assertEquals(listOf("agent-b-session", "custom"), store.loadSessions("gateway-a", "agent-b").map { it.key })
    }
}
