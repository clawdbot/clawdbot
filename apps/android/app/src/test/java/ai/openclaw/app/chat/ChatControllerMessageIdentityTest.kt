package ai.openclaw.app.chat

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.jsonObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotEquals
import org.junit.Test

class ChatControllerMessageIdentityTest {
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
