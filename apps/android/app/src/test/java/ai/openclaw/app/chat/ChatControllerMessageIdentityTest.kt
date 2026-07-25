package ai.openclaw.app.chat

import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.test.advanceUntilIdle
import kotlinx.coroutines.test.runTest
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.jsonObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotEquals
import org.junit.Test

class ChatControllerMessageIdentityTest {
  @Test
  fun reconcileMessageIdsKeepsCanonicalEntryIdentityFromReload() {
    val previous =
      ChatMessage(
        id = "stable-compose-id",
        role = "user",
        content = listOf(ChatMessageContent(text = "hello")),
        timestampMs = 10,
        entryId = "old-entry",
      )
    val incoming = previous.copy(id = "temporary-id", entryId = "canonical-entry")

    val reconciled = reconcileMessageIds(listOf(previous), listOf(incoming)).single()

    assertEquals("stable-compose-id", reconciled.id)
    assertEquals("canonical-entry", reconciled.entryId)
  }

  private val json = Json { ignoreUnknownKeys = true }

  @Test
  fun parseChatMessageContentsReadsGatewayStringContent() {
    val obj =
      json
        .parseToJsonElement(
          """
          {"role":"user","content":"Hello","idempotencyKey":"run-1:user"}
          """.trimIndent(),
        ).jsonObject

    val content = parseChatMessageContents(obj)

    assertEquals(listOf(ChatMessageContent(type = "text", text = "Hello")), content)
  }

  @Test
  fun parseChatMessageContentsFallsBackToTopLevelText() {
    val obj =
      json
        .parseToJsonElement(
          """
          {"role":"assistant","text":"Hi there"}
          """.trimIndent(),
        ).jsonObject

    val content = parseChatMessageContents(obj)

    assertEquals(listOf(ChatMessageContent(type = "text", text = "Hi there")), content)
  }

  @Test
  @OptIn(ExperimentalCoroutinesApi::class)
  fun liveHistoryDropsInternalRoleRows() =
    runTest {
      val controller =
        ChatController(
          scope = this,
          json = json,
          requestGateway = { method, _ ->
            if (method == "chat.history") {
              """
              {
                "messages": [
                  { "role": "user", "content": "hello" },
                  { "role": "toolResult", "content": "private tool output" },
                  { "role": "internal", "text": "private reasoning" },
                  { "role": "custom", "content": "visible plugin notice" },
                  { "role": "Assistant", "content": "reply" }
                ]
              }
              """.trimIndent()
            } else {
              "{}"
            }
          },
        )

      controller.load("main")
      advanceUntilIdle()

      assertEquals(listOf("user", "custom", "assistant"), controller.messages.value.map { it.role })
      assertEquals(
        listOf("hello", "visible plugin notice", "reply"),
        controller.messages.value.map { it.content.single().text },
      )
    }

  @Test
  fun reconcileMessageIdsReusesMatchingIdsAcrossHistoryReload() {
    val previous =
      listOf(
        ChatMessage(
          id = "msg-1",
          role = "assistant",
          content = listOf(ChatMessageContent(type = "text", text = "hello")),
          timestampMs = 1000L,
        ),
        ChatMessage(
          id = "msg-2",
          role = "user",
          content = listOf(ChatMessageContent(type = "text", text = "hi")),
          timestampMs = 2000L,
        ),
      )

    val incoming =
      listOf(
        ChatMessage(
          id = "new-1",
          role = "assistant",
          content = listOf(ChatMessageContent(type = "text", text = "hello")),
          timestampMs = 1000L,
        ),
        ChatMessage(
          id = "new-2",
          role = "user",
          content = listOf(ChatMessageContent(type = "text", text = "hi")),
          timestampMs = 2000L,
        ),
      )

    val reconciled = reconcileMessageIds(previous = previous, incoming = incoming)

    assertEquals(listOf("msg-1", "msg-2"), reconciled.map { it.id })
  }

  @Test
  fun reconcileMessageIdsLeavesNewMessagesUntouched() {
    val previous =
      listOf(
        ChatMessage(
          id = "msg-1",
          role = "assistant",
          content = listOf(ChatMessageContent(type = "text", text = "hello")),
          timestampMs = 1000L,
        ),
      )

    val incoming =
      listOf(
        ChatMessage(
          id = "new-1",
          role = "assistant",
          content = listOf(ChatMessageContent(type = "text", text = "hello")),
          timestampMs = 1000L,
        ),
        ChatMessage(
          id = "new-2",
          role = "assistant",
          content = listOf(ChatMessageContent(type = "text", text = "new reply")),
          timestampMs = 3000L,
        ),
      )

    val reconciled = reconcileMessageIds(previous = previous, incoming = incoming)

    assertEquals("msg-1", reconciled[0].id)
    assertEquals("new-2", reconciled[1].id)
    assertNotEquals(reconciled[0].id, reconciled[1].id)
  }

  @Test
  fun reconcileMessageIdsPreservesOptimisticVoiceNoteDuration() {
    val previous =
      ChatMessage(
        id = "local-user",
        role = "user",
        content =
          listOf(
            ChatMessageContent(type = "text", text = "See attached."),
            ChatMessageContent(type = "audio", mimeType = "audio/mp4", fileName = "voice-note.m4a", durationMs = 4_321L),
          ),
        timestampMs = 1_000L,
        idempotencyKey = "run:user",
      )
    val incoming =
      previous.copy(
        id = "gateway-user",
        content = previous.content.map { it.copy(durationMs = null) },
      )

    val reconciled = reconcileMessageIds(previous = listOf(previous), incoming = listOf(incoming)).single()

    assertEquals("local-user", reconciled.id)
    assertEquals(4_321L, reconciled.content[1].durationMs)
  }

  @Test
  fun reconcileMessageIdsPreservesMultipleVoiceNoteDurationsInOrder() {
    val previous =
      ChatMessage(
        id = "local-user",
        role = "user",
        content =
          listOf(
            ChatMessageContent(type = "text", text = "See attached."),
            ChatMessageContent(type = "audio", mimeType = "audio/mp4", fileName = "first.m4a", durationMs = 1_000L),
            ChatMessageContent(type = "audio", mimeType = "audio/mp4", fileName = "second.m4a", durationMs = 2_000L),
          ),
        timestampMs = 1_000L,
        idempotencyKey = "run:user",
      )
    val incoming =
      previous.copy(
        id = "gateway-user",
        content =
          listOf(
            ChatMessageContent(type = "text", text = "See attached."),
            ChatMessageContent(type = "audio", mimeType = "audio/x-m4a", fileName = "stored-a.m4a"),
            ChatMessageContent(type = "audio", mimeType = "audio/x-m4a", fileName = "stored-b.m4a"),
          ),
      )

    val reconciled = reconcileMessageIds(previous = listOf(previous), incoming = listOf(incoming)).single()

    assertEquals(listOf(1_000L, 2_000L), reconciled.content.drop(1).map { it.durationMs })
  }

  @Test
  fun mergeOptimisticMessagesKeepsOutgoingUserTurnWhenHistoryOmitsIt() {
    val optimistic =
      ChatMessage(
        id = "local-user",
        role = "user",
        content = listOf(ChatMessageContent(type = "text", text = "Testing testing 1 2 3")),
        timestampMs = 1000L,
      )
    val assistant =
      ChatMessage(
        id = "remote-assistant",
        role = "assistant",
        content = listOf(ChatMessageContent(type = "text", text = "Received.")),
        timestampMs = 2000L,
      )

    val merged = mergeOptimisticMessages(incoming = listOf(assistant), optimistic = listOf(optimistic))

    assertEquals(listOf("local-user", "remote-assistant"), merged.map { it.id })
  }

  @Test
  fun retainUnmatchedOptimisticMessagesKeepsOutgoingUserTurnWhenHistoryOmitsIt() {
    val optimistic =
      ChatMessage(
        id = "local-user",
        role = "user",
        content = listOf(ChatMessageContent(type = "text", text = "Testing testing 1 2 3")),
        timestampMs = 1000L,
      )
    val assistant =
      ChatMessage(
        id = "remote-assistant",
        role = "assistant",
        content = listOf(ChatMessageContent(type = "text", text = "Received.")),
        timestampMs = 2000L,
      )

    val retained = retainUnmatchedOptimisticMessages(incoming = listOf(assistant), optimistic = listOf(optimistic))

    assertEquals(listOf("local-user"), retained.map { it.id })
  }

  @Test
  fun retainUnmatchedOptimisticMessagesDropsGatewayPersistedUserTurn() {
    val optimistic =
      ChatMessage(
        id = "local-user",
        role = "user",
        content = listOf(ChatMessageContent(type = "text", text = "hello")),
        timestampMs = 1000L,
        idempotencyKey = "run-1:user",
      )
    val remoteUser = optimistic.copy(id = "remote-user", timestampMs = 500L)

    val retained = retainUnmatchedOptimisticMessages(incoming = listOf(remoteUser), optimistic = listOf(optimistic))

    assertEquals(emptyList<String>(), retained.map { it.id })
  }

  @Test
  fun retainUnmatchedOptimisticMessagesKeepsDistinctIdempotencyKey() {
    val optimistic =
      ChatMessage(
        id = "local-user",
        role = "user",
        content = listOf(ChatMessageContent(type = "text", text = "hello")),
        timestampMs = 1000L,
        idempotencyKey = "run-2:user",
      )
    val remoteUser = optimistic.copy(id = "remote-user", timestampMs = 2000L, idempotencyKey = "run-1:user")

    val retained = retainUnmatchedOptimisticMessages(incoming = listOf(remoteUser), optimistic = listOf(optimistic))

    assertEquals(listOf("local-user"), retained.map { it.id })
  }

  @Test
  fun mergeOptimisticMessagesDoesNotDuplicateHistoryTurns() {
    val user =
      ChatMessage(
        id = "local-user",
        role = "user",
        content = listOf(ChatMessageContent(type = "text", text = "hello")),
        timestampMs = 1000L,
      )
    val remoteUser = user.copy(id = "remote-user")

    val merged = mergeOptimisticMessages(incoming = listOf(remoteUser), optimistic = listOf(user))

    assertEquals(listOf("remote-user"), merged.map { it.id })
  }

  @Test
  fun mergeOptimisticMessagesDoesNotDuplicateGatewayPersistedUserTurnWithDifferentTimestamp() {
    val optimistic =
      ChatMessage(
        id = "local-user",
        role = "user",
        content = listOf(ChatMessageContent(type = "text", text = "hello")),
        timestampMs = 1000L,
      )
    val remoteUser = optimistic.copy(id = "remote-user", timestampMs = 2000L)

    val merged = mergeOptimisticMessages(incoming = listOf(remoteUser), optimistic = listOf(optimistic))

    assertEquals(listOf("remote-user"), merged.map { it.id })
  }

  @Test
  fun mergeOptimisticMessagesKeepsRepeatedOptimisticTurnWhenHistoryOnlyHasOneMatch() {
    val first =
      ChatMessage(
        id = "local-user-1",
        role = "user",
        content = listOf(ChatMessageContent(type = "text", text = "hello")),
        timestampMs = 1000L,
      )
    val second = first.copy(id = "local-user-2", timestampMs = 1100L)
    val remoteUser = first.copy(id = "remote-user", timestampMs = 2000L)

    val merged = mergeOptimisticMessages(incoming = listOf(remoteUser), optimistic = listOf(first, second))

    assertEquals(listOf("local-user-2", "remote-user"), merged.map { it.id })
  }

  @Test
  fun mergeOptimisticMessagesDoesNotConsumeOlderIdenticalHistoryTurn() {
    val optimistic =
      ChatMessage(
        id = "local-user",
        role = "user",
        content = listOf(ChatMessageContent(type = "text", text = "ok")),
        timestampMs = 2000L,
      )
    val oldHistoryUser = optimistic.copy(id = "remote-old-user", timestampMs = 1000L)

    val merged = mergeOptimisticMessages(incoming = listOf(oldHistoryUser), optimistic = listOf(optimistic))

    assertEquals(listOf("remote-old-user", "local-user"), merged.map { it.id })
  }
}
