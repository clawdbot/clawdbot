package ai.openclaw.app.chat

import kotlinx.coroutines.test.TestScope
import kotlinx.coroutines.test.runTest
import kotlinx.serialization.json.Json
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class ChatControllerPlanStreamTest {
  private val json = Json { ignoreUnknownKeys = true }

  private data class StartedRun(
    val controller: ChatController,
    val gateway: ScriptedGateway,
    val runId: String,
  )

  private suspend fun TestScope.startRun(): StartedRun {
    val gateway = ScriptedGateway(json)
    gateway.respondChatSend(status = "started")
    val controller = ChatController(scope = this, json = json, requestGateway = gateway::request)
    controller.handleGatewayEvent("health", null)
    assertTrue(controller.sendMessageAwaitAcceptance("make a plan", "off", emptyList()))
    return StartedRun(controller = controller, gateway = gateway, runId = requireNotNull(gateway.lastRunId))
  }

  private fun planPayload(
    runId: String,
    data: String,
  ): String = """{"sessionKey":"main","runId":"$runId","seq":1,"ts":10,"stream":"plan","data":$data}"""

  @Test
  fun typedStepsAreParsedAndMalformedEntriesAreDropped() =
    runTest {
      val (controller, _, runId) = startRun()

      controller.handleGatewayEvent(
        "agent",
        planPayload(
          runId,
          """{"phase":"update","steps":[{"step":" Inspect ","status":"completed"},{"step":"Patch","status":"in_progress"},{"step":"Test","status":"pending"},{"step":"   ","status":"pending"},{"step":"Unknown","status":"blocked"},{"step":42,"status":"pending"},42]}""",
        ),
      )

      assertEquals(
        listOf(
          ChatPlanStep(step = "Inspect", status = ChatPlanStepStatus.Completed),
          ChatPlanStep(step = "Patch", status = ChatPlanStepStatus.InProgress),
          ChatPlanStep(step = "Test", status = ChatPlanStepStatus.Pending),
        ),
        controller.planSteps.value,
      )
    }

  @Test
  fun legacyStringStepsBecomePending() =
    runTest {
      val (controller, _, runId) = startRun()

      controller.handleGatewayEvent(
        "agent",
        planPayload(runId, """{"phase":"update","steps":[" First ","   ","Second"]}"""),
      )

      assertEquals(
        listOf(
          ChatPlanStep(step = "First", status = ChatPlanStepStatus.Pending),
          ChatPlanStep(step = "Second", status = ChatPlanStepStatus.Pending),
        ),
        controller.planSteps.value,
      )
    }

  @Test
  fun laterSnapshotReplacesEarlierSnapshot() =
    runTest {
      val (controller, _, runId) = startRun()

      controller.handleGatewayEvent(
        "agent",
        planPayload(runId, """{"phase":"update","steps":[{"step":"First","status":"in_progress"},{"step":"Second","status":"pending"}]}"""),
      )
      controller.handleGatewayEvent(
        "agent",
        planPayload(runId, """{"phase":"update","steps":[{"step":"Replacement","status":"completed"}]}"""),
      )

      assertEquals(
        listOf(ChatPlanStep(step = "Replacement", status = ChatPlanStepStatus.Completed)),
        controller.planSteps.value,
      )
    }

  @Test
  fun emptyOrExplanationOnlySnapshotClearsPlan() =
    runTest {
      val (controller, _, runId) = startRun()
      val populated = """{"phase":"update","steps":[{"step":"Active","status":"in_progress"}]}"""

      controller.handleGatewayEvent("agent", planPayload(runId, populated))
      controller.handleGatewayEvent("agent", planPayload(runId, """{"phase":"update","steps":[]}"""))
      assertTrue(controller.planSteps.value.isEmpty())

      controller.handleGatewayEvent("agent", planPayload(runId, populated))
      controller.handleGatewayEvent("agent", planPayload(runId, """{"phase":"update","explanation":"Revising"}"""))
      assertTrue(controller.planSteps.value.isEmpty())
    }

  @Test
  fun terminalRunClearsPlan() =
    runTest {
      val (controller, gateway, runId) = startRun()
      controller.handleGatewayEvent(
        "agent",
        planPayload(runId, """{"phase":"update","steps":[{"step":"Active","status":"in_progress"}]}"""),
      )
      gateway.respondWith("chat.history", historyResponse(sessionId = "session-1", messages = emptyList()))

      controller.handleGatewayEvent("chat", chatTerminalPayload("main", runId, seq = 2))

      assertTrue(controller.planSteps.value.isEmpty())
    }

  @Test
  fun terminalEventForAnotherRunPreservesActivePlan() =
    runTest {
      val (controller, gateway, runId) = startRun()
      val expected = listOf(ChatPlanStep(step = "Active", status = ChatPlanStepStatus.InProgress))
      controller.handleGatewayEvent(
        "agent",
        planPayload(runId, """{"phase":"update","steps":[{"step":"Active","status":"in_progress"}]}"""),
      )
      gateway.respondWith("chat.history", historyResponse(sessionId = "session-1", messages = emptyList()))

      controller.handleGatewayEvent("chat", chatTerminalPayload("main", "other-run", seq = 2))

      assertEquals(expected, controller.planSteps.value)
    }

  @Test
  fun wrongRunCannotReplaceCurrentPlan() =
    runTest {
      val (controller, _, runId) = startRun()
      val expected = listOf(ChatPlanStep(step = "Owned", status = ChatPlanStepStatus.InProgress))
      controller.handleGatewayEvent(
        "agent",
        planPayload(runId, """{"phase":"update","steps":[{"step":"Owned","status":"in_progress"}]}"""),
      )

      controller.handleGatewayEvent(
        "agent",
        planPayload("other-run", """{"phase":"update","steps":[{"step":"Foreign","status":"completed"}]}"""),
      )

      assertEquals(expected, controller.planSteps.value)
    }
}
