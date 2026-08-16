package ai.openclaw.app

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import org.junit.Assert.assertEquals
import org.junit.Assert.assertThrows
import org.junit.Test

class AndroidScreenshotFixtureTest {
  private val json = Json { ignoreUnknownKeys = true }

  @Test
  fun providesDeterministicProductionScreenData() {
    val sessions =
      json
        .parseToJsonElement(AndroidScreenshotFixture.request("sessions.list", null))
        .jsonObject["sessions"]
        ?.jsonArray
        .orEmpty()
    val metadata =
      json
        .parseToJsonElement(AndroidScreenshotFixture.request("chat.metadata", null))
        .jsonObject
    val cronJobs =
      json
        .parseToJsonElement(AndroidScreenshotFixture.request("cron.list", null))
        .jsonObject["jobs"]
        ?.jsonArray
        .orEmpty()
    val cronDetail =
      json
        .parseToJsonElement(AndroidScreenshotFixture.request("cron.get", null))
        .jsonObject
    val cronRunEntries =
      json
        .parseToJsonElement(AndroidScreenshotFixture.request("cron.runs", null))
        .jsonObject["entries"]
        ?.jsonArray
    val parsedCronRuns = parseGatewayCronRunHistory(cronRunEntries)

    assertEquals(3, sessions.size)
    assertEquals(
      AndroidScreenshotFixture.primarySessionTitle,
      sessions
        .first()
        .jsonObject["displayName"]
        ?.jsonPrimitive
        ?.content,
    )
    assertEquals(1, metadata["models"]?.jsonArray?.size)
    assertEquals(1, metadata["commands"]?.jsonArray?.size)
    assertEquals(
      AndroidScreenshotFixture.cronJobName,
      cronJobs
        .single()
        .jsonObject["name"]
        ?.jsonPrimitive
        ?.content,
    )
    assertEquals(AndroidScreenshotFixture.cronJobId, cronDetail["id"]?.jsonPrimitive?.content)
    assertEquals(2, parsedCronRuns.size)
    assertEquals("android-release-digest-run-2", parsedCronRuns.first().runId)
    assertEquals("Release checklist ready", parsedCronRuns.first().summary)
    assertEquals("android-release-digest-run-1", parsedCronRuns.last().runId)
    assertEquals("Play publish blocked", parsedCronRuns.last().error)
  }

  @Test
  fun providesSwarmChildRosterForSwarmScene() {
    AndroidScreenshotFixture.configure(AndroidScreenshotScene.Swarm)
    try {
      val params = "{\"spawnedBy\":\"${AndroidScreenshotFixture.mainSessionKey}\"}"
      val sessions =
        json
          .parseToJsonElement(AndroidScreenshotFixture.request("sessions.list", params))
          .jsonObject["sessions"]
          ?.jsonArray
          .orEmpty()
      val metadata =
        json
          .parseToJsonElement(AndroidScreenshotFixture.request("chat.metadata", null))
          .jsonObject
      assertEquals("true", metadata["swarmEnabled"]?.jsonPrimitive?.content)
      assertEquals(5, sessions.size)
      assertEquals(
        "swarm:${AndroidScreenshotFixture.mainSessionKey}:research",
        sessions
          .first()
          .jsonObject["swarmGroupId"]
          ?.jsonPrimitive
          ?.content,
      )
    } finally {
      AndroidScreenshotFixture.configure(AndroidScreenshotScene.Home)
    }
  }

  @Test
  fun providesDeterministicChatHistory() {
    val messages =
      json
        .parseToJsonElement(AndroidScreenshotFixture.request("chat.history", null))
        .jsonObject["messages"]
        ?.jsonArray
        .orEmpty()

    assertEquals(
      listOf(
        listOf("user", "What is blocking the Android release?", "1783555020000"),
        listOf(
          "assistant",
          "Two review threads are still open on the release branch, and the localization sync needs one more pass. " +
            "Once those land, the changelog draft is ready for review and the tag can go out.",
          "1783555080000",
        ),
        listOf("user", "[System] Continue the interrupted turn.", "1783555100000"),
        listOf("user", "[System] Gateway restarted during the Android release update.", "1783555120000"),
        listOf("user", "Summarize the open review feedback for me.", "1783555140000"),
        listOf(
          "assistant",
          "The main thread asks for a regression test around session restore, and the second one wants the new " +
            "config key documented before merge. Both are small; I can draft patches for each if you want.",
          "1783555200000",
        ),
        listOf("system", "Compaction", "1783555220000"),
        listOf("system", "Reset", "1783555240000"),
        listOf("user", "Draft a short status update for the team.", "1783555260000"),
        listOf(
          "assistant",
          "The Android release is close. Two review follow-ups and one localization pass remain; once those land, " +
            "the changelog can be reviewed and the tag can go out.",
          "1783555320000",
        ),
      ),
      messages.map { message ->
        val fields = message.jsonObject
        listOf(
          fields["role"]?.jsonPrimitive?.content,
          fields["content"]?.jsonPrimitive?.content,
          fields["timestamp"]?.jsonPrimitive?.content,
        )
      },
    )

    val restartRecovery = messages[2].jsonObject["provenance"]?.jsonObject
    assertEquals("internal_system", restartRecovery?.get("kind")?.jsonPrimitive?.content)
    assertEquals("main_session_restart_recovery", restartRecovery?.get("sourceTool")?.jsonPrimitive?.content)
    val gatewayRestarted = messages[3].jsonObject["provenance"]?.jsonObject
    assertEquals("restart-sentinel", gatewayRestarted?.get("sourceTool")?.jsonPrimitive?.content)
    val compaction = messages[6].jsonObject["__openclaw"]?.jsonObject
    assertEquals("compaction", compaction?.get("kind")?.jsonPrimitive?.content)
    assertEquals("android-screenshot-compaction", compaction?.get("id")?.jsonPrimitive?.content)
    assertEquals("900000", compaction?.get("tokensBefore")?.jsonPrimitive?.content)
    assertEquals("24700", compaction?.get("tokensAfter")?.jsonPrimitive?.content)
    val reset = messages[7].jsonObject["__openclaw"]?.jsonObject
    assertEquals("reset", reset?.get("kind")?.jsonPrimitive?.content)
    assertEquals("android-screenshot-reset", reset?.get("id")?.jsonPrimitive?.content)
  }

  @Test
  fun providesDeterministicSystemAgentConversation() {
    val greeting =
      json
        .parseToJsonElement(
          AndroidScreenshotFixture.request(
            "openclaw.chat",
            """{"sessionId":"android-settings-openclaw-test"}""",
          ),
        ).jsonObject
    val response =
      json
        .parseToJsonElement(
          AndroidScreenshotFixture.request(
            "openclaw.chat",
            """{"sessionId":"android-settings-openclaw-test","message":"Check status"}""",
          ),
        ).jsonObject

    assertEquals("android-screenshot-openclaw", greeting["sessionId"]?.jsonPrimitive?.content)
    assertEquals(
      "What should we look at first?",
      greeting["question"]
        ?.jsonObject
        ?.get("question")
        ?.jsonPrimitive
        ?.content,
    )
    assertEquals(
      "I’ll keep this conversation separate from ordinary agent chat.",
      response["reply"]?.jsonPrimitive?.content,
    )
  }

  @Test
  fun rejectsUnexpectedGatewayCalls() {
    val error =
      assertThrows(IllegalStateException::class.java) {
        AndroidScreenshotFixture.request("gateway.unexpected", null)
      }

    assertEquals(
      "Screenshot fixture does not implement gateway method gateway.unexpected with params null",
      error.message,
    )
  }
}
