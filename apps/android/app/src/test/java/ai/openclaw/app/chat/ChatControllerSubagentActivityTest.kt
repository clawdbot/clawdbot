package ai.openclaw.app.chat

import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.test.TestScope
import kotlinx.coroutines.test.advanceTimeBy
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.runTest
import kotlinx.serialization.json.Json
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class ChatControllerSubagentActivityTest {
  private val json = Json { ignoreUnknownKeys = true }

  @Test
  fun taskEventsFilterAndFoldRetainedActivity() =
    runTest {
      val controller = newController()

      controller.handleGatewayEvent("task", taskPayload(id = "wrong-runtime", runtime = "cli"))
      controller.handleGatewayEvent("task", taskPayload(id = "wrong-session", sessionKey = "other"))
      assertTrue(controller.subagentActivities.value.isEmpty())

      controller.handleGatewayEvent(
        "task",
        taskPayload(
          id = "task-1",
          status = "running",
          progressSummary = "Planning changes",
          lastToolName = "read",
        ),
      )
      assertEquals(
        "Planning changes",
        controller.subagentActivities.value
          .getValue("task-1")
          .snippet,
      )

      controller.handleGatewayEvent(
        "task",
        taskPayload(
          id = "task-1",
          status = "running",
          lastActivity = "Editing ChatController",
          diffStat = Triple(2, 12, 3),
        ),
      )
      controller.handleGatewayEvent(
        "task",
        taskPayload(
          id = "task-1",
          status = "completed",
          terminalSummary = "Implementation complete",
        ),
      )

      val finished = controller.subagentActivities.value.getValue("task-1")
      assertEquals("completed", finished.status)
      assertEquals("Editing ChatController", finished.snippet)
      assertEquals(ChatDiffStat(added = 12, removed = 3, files = 2), finished.diffStat)
      assertEquals("Implementation complete", finished.terminalSummary)
      assertEquals("agent:worker:subagent:task-1", finished.childSessionKey)
    }

  @Test
  @OptIn(ExperimentalCoroutinesApi::class)
  fun terminalActivityExpiresAfterSixtySeconds() =
    runTest {
      val controller = newController()
      controller.handleGatewayEvent("task", taskPayload(id = "task-1", status = "completed"))

      advanceTimeBy(59_999)
      runCurrent()
      assertTrue("task-1" in controller.subagentActivities.value)

      advanceTimeBy(1)
      runCurrent()
      assertTrue(controller.subagentActivities.value.isEmpty())
    }

  @Test
  fun sessionSwitchClearsActivityButParentRunCleanupDoesNot() =
    runTest {
      val controller = newController()
      controller.handleGatewayEvent("task", taskPayload(id = "task-1", status = "running"))

      controller.onDisconnected("offline")
      assertTrue("task-1" in controller.subagentActivities.value)

      controller.switchSession("other")
      assertTrue(controller.subagentActivities.value.isEmpty())
    }

  @Test
  fun sequenceGapClearsActivityThatCanNoLongerConverge() =
    runTest {
      val controller = newController()
      controller.handleGatewayEvent("task", taskPayload(id = "task-1", status = "running"))

      controller.handleGatewayEvent("seqGap", null)

      assertTrue(controller.subagentActivities.value.isEmpty())
    }

  @Test
  fun errorOnlyFailureRetainsTerminalDetail() =
    runTest {
      val controller = newController()
      controller.handleGatewayEvent(
        "task",
        taskPayload(id = "task-1", status = "failed", error = "Worker could not start"),
      )

      assertEquals(
        "Worker could not start",
        controller.subagentActivities.value
          .getValue("task-1")
          .error,
      )
    }

  private fun TestScope.newController(): ChatController =
    ChatController(
      scope = backgroundScope,
      json = json,
      requestGateway = { _, _ -> "{}" },
    )

  private fun taskPayload(
    id: String,
    runtime: String = "subagent",
    sessionKey: String = "main",
    status: String = "queued",
    lastActivity: String? = null,
    progressSummary: String? = null,
    lastToolName: String? = null,
    terminalSummary: String? = null,
    error: String? = null,
    diffStat: Triple<Int, Int, Int>? = null,
  ): String =
    buildString {
      append("{\"action\":\"upserted\",\"task\":{")
      append("\"id\":\"").append(id).append("\",")
      append("\"runtime\":\"").append(runtime).append("\",")
      append("\"sessionKey\":\"").append(sessionKey).append("\",")
      append("\"childSessionKey\":\"agent:worker:subagent:").append(id).append("\",")
      append("\"status\":\"").append(status).append("\",")
      append("\"startedAt\":1000")
      lastActivity?.let { append(",\"lastActivity\":\"").append(it).append("\"") }
      progressSummary?.let { append(",\"progressSummary\":\"").append(it).append("\"") }
      lastToolName?.let { append(",\"lastToolName\":\"").append(it).append("\"") }
      terminalSummary?.let { append(",\"terminalSummary\":\"").append(it).append("\"") }
      error?.let { append(",\"error\":\"").append(it).append("\"") }
      diffStat?.let { (files, added, removed) ->
        append(",\"diffStat\":{\"files\":").append(files)
        append(",\"added\":").append(added)
        append(",\"removed\":").append(removed).append('}')
      }
      append("}}")
    }
}
