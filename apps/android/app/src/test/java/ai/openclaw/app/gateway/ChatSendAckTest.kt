package ai.openclaw.app.gateway

import kotlinx.serialization.json.Json
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class ChatSendAckTest {
  private val json = Json { ignoreUnknownKeys = true }

  @Test
  fun parseChatSendAckPreservesNonTerminalPublicAdmissionStatuses() {
    for (status in listOf("started", "in_flight")) {
      val ack = parseChatSendAck(json, """{"runId":"run-1","status":"$status"}""")

      assertEquals("run-1", ack.runId)
      assertEquals(status, ack.normalizedStatus)
      assertFalse(ack.isTerminal)
    }
  }

  @Test
  fun parseChatSendAckNormalizesMissingAndMalformedStatusToEmpty() {
    val missing = parseChatSendAck(json, """{"runId":"legacy"}""")
    val malformed =
      listOf(
        parseChatSendAck(json, """{"runId":"number","status":42}"""),
        parseChatSendAck(json, """{"runId":"null","status":null}"""),
        parseChatSendAck(json, """{"runId":"blank","status":" "}"""),
        parseChatSendAck(json, "not-json"),
      )

    assertEquals("", missing.normalizedStatus)
    assertTrue(malformed.all { it.normalizedStatus.isEmpty() })
  }

  @Test
  fun parseChatSendAckMarksOkAsTerminalSuccess() {
    val ack = parseChatSendAck(json, """{"runId":"run-ok","status":" ok "}""")

    assertEquals("run-ok", ack.runId)
    assertEquals("ok", ack.normalizedStatus)
    assertTrue(ack.isTerminal)
    assertTrue(ack.isTerminalSuccess)
    assertFalse(ack.isTerminalFailure)
  }

  @Test
  fun parseChatSendAckMarksTimeoutAndErrorAsTerminalFailures() {
    val timeout = parseChatSendAck(json, """{"runId":"run-timeout","status":"timeout"}""")
    val error = parseChatSendAck(json, """{"runId":"run-error","status":" error "}""")

    assertEquals("run-timeout", timeout.runId)
    assertTrue(timeout.isTerminal)
    assertFalse(timeout.isTerminalSuccess)
    assertTrue(timeout.isTerminalFailure)
    assertEquals("run-error", error.runId)
    assertTrue(error.isTerminal)
    assertFalse(error.isTerminalSuccess)
    assertTrue(error.isTerminalFailure)
  }

  @Test
  fun cachedOkAckUsesUnfilteredHistoryFallback() {
    val startedAt = 123.0
    val ok = parseChatSendAck(json, """{"runId":"run-ok","status":"ok"}""")
    val started = parseChatSendAck(json, """{"runId":"run-started","status":"started"}""")

    assertNull(chatSendAckHistorySinceSeconds(ok, startedAt))
    assertEquals(startedAt, chatSendAckHistorySinceSeconds(started, startedAt) ?: -1.0, 0.0)
  }

  @Test
  fun parseChatSendAckToleratesMalformedPayloads() {
    val ack = parseChatSendAck(json, "not-json")

    assertNull(ack.runId)
    assertEquals("", ack.normalizedStatus)
    assertFalse(ack.isTerminal)
    assertFalse(ack.isTerminalSuccess)
    assertFalse(ack.isTerminalFailure)
  }
}
