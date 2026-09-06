package ai.openclaw.app.wear

import ai.openclaw.app.WEAR_AGENT_PULSE_PHONE_BUDGET_MILLIS
import ai.openclaw.app.chat.BackgroundTask
import ai.openclaw.app.chat.ChatSwarmDot
import ai.openclaw.app.chat.ChatSwarmDotStatus
import ai.openclaw.app.chat.ChatSwarmGroup
import ai.openclaw.app.chat.ChatSwarmPhase
import ai.openclaw.app.readWearAgentPulseConcurrently
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.delay
import kotlinx.coroutines.test.currentTime
import kotlinx.coroutines.test.runTest
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.jsonObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class WearAgentPulseProjectionTest {
  @Test
  fun projectsOnlyBoundedAggregateFields() {
    val result =
      projectWearAgentPulse(
        gatewayConnected = true,
        tasks =
          listOf(
            task("private-task-queued", "queued"),
            task("private-task-running", "running"),
            task("private-task-completed", "completed"),
            task("private-task-cancelled", "cancelled"),
          ),
        swarmAvailable = true,
        swarmGroups =
          listOf(
            ChatSwarmGroup(
              groupId = "private-group",
              label = "private-label",
              running = 1,
              done = 2,
              failed = 3,
              narrator = "private-narrator",
              phases =
                listOf(
                  ChatSwarmPhase(
                    key = "private-phase",
                    title = "private-title",
                    dots =
                      listOf(
                        dot("queued", ChatSwarmDotStatus.Queued),
                        dot("running", ChatSwarmDotStatus.Running),
                        dot("done", ChatSwarmDotStatus.Done),
                        dot("failed", ChatSwarmDotStatus.Failed),
                      ),
                    hidden = 7,
                  ),
                ),
            ),
          ),
        pendingApprovalCount = 2,
        approvalsAvailable = true,
        approvalsRefreshing = false,
      )

    assertEquals(
      Json
        .parseToJsonElement(
          """{"tasks":{"state":"ready","scope":"bounded","queued":1,"running":1,"completed":1,"failed":1,"activeAtLimit":false,"recentAtLimit":false},"swarm":{"state":"active","scope":"selected-session","groups":1,"running":1,"done":2,"failed":3,"phases":[{"queued":1,"running":1,"done":1,"failed":1,"hidden":7}],"morePhases":false},"approvals":{"state":"ready","pending":2}}""",
        ).jsonObject,
      result,
    )
    assertFalse(result.toString().contains("private-"))
  }

  @Test
  fun marksBoundedLimitsAndKeepsUnknownApprovalCountUnavailable() {
    val bounded =
      projectWearAgentPulse(
        gatewayConnected = true,
        tasks =
          List(100) { index -> task("active-$index", "running") } +
            List(50) { index -> task("recent-$index", "failed") },
        swarmAvailable = true,
        swarmGroups = emptyList(),
        pendingApprovalCount = 9,
        approvalsAvailable = false,
        approvalsRefreshing = true,
      )

    assertEquals(
      Json
        .parseToJsonElement(
          """{"tasks":{"state":"ready","scope":"bounded","queued":0,"running":100,"completed":0,"failed":50,"activeAtLimit":true,"recentAtLimit":true},"swarm":{"state":"idle","scope":"selected-session"},"approvals":{"state":"refreshing"}}""",
        ).jsonObject,
      bounded,
    )
  }

  @Test
  fun makesEveryComponentUnavailableWhenTheGatewayRouteIsStale() {
    val result =
      projectWearAgentPulse(
        gatewayConnected = false,
        tasks = listOf(task("private-task", "running")),
        swarmAvailable = true,
        swarmGroups = emptyList(),
        pendingApprovalCount = 1,
        approvalsAvailable = true,
        approvalsRefreshing = true,
      )

    assertEquals(
      Json
        .parseToJsonElement(
          """{"tasks":{"state":"unavailable"},"swarm":{"state":"unavailable"},"approvals":{"state":"unavailable"}}""",
        ).jsonObject,
      result,
    )
  }

  @Test
  @OptIn(ExperimentalCoroutinesApi::class)
  fun concurrentPhoneBudgetKeepsTheCompletedComponentAndBoundsTheSlowOne() =
    runTest {
      var tasksStartedAt = -1L
      var swarmStartedAt = -1L

      val reads =
        readWearAgentPulseConcurrently(
          readTasks = {
            tasksStartedAt = currentTime
            "tasks"
          },
          readSwarm = {
            swarmStartedAt = currentTime
            delay(WEAR_AGENT_PULSE_PHONE_BUDGET_MILLIS * 2)
            "swarm"
          },
        )

      assertEquals("tasks", reads.tasks)
      assertEquals(null, reads.swarm)
      assertEquals(0L, tasksStartedAt)
      assertEquals(0L, swarmStartedAt)
      assertEquals(WEAR_AGENT_PULSE_PHONE_BUDGET_MILLIS, currentTime)
    }

  @Test
  fun concurrentPhoneBudgetPreservesCallerCancellation() =
    runTest {
      val failure =
        runCatching {
          readWearAgentPulseConcurrently(
            readTasks = { throw CancellationException("request retired") },
            readSwarm = {
              delay(WEAR_AGENT_PULSE_PHONE_BUDGET_MILLIS * 2)
              "swarm"
            },
          )
        }.exceptionOrNull()

      assertTrue(failure is CancellationException)
    }

  private fun task(
    id: String,
    status: String,
  ): BackgroundTask =
    BackgroundTask(
      id = id,
      status = status,
      runtime = "private-runtime",
      title = "private-title",
      agentId = "private-agent",
      childSessionKey = "private-session",
      createdAtMs = 1,
      updatedAtMs = 2,
      startedAtMs = 3,
      endedAtMs = 4,
      progress = "private-progress",
      terminal = "private-terminal",
      error = "private-error",
      prompt = "private-prompt",
    )

  private fun dot(
    suffix: String,
    status: ChatSwarmDotStatus,
  ): ChatSwarmDot =
    ChatSwarmDot(
      key = "private-dot-$suffix",
      label = "private-child-$suffix",
      status = status,
    )
}
