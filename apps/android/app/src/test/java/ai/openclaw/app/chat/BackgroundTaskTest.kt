package ai.openclaw.app.chat

import ai.openclaw.app.ui.chat.backgroundTasksEmptyStateVisible
import kotlinx.coroutines.test.runTest
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class BackgroundTaskTest {
  private val json = Json { ignoreUnknownKeys = true }

  @Test
  fun parsesPromptAndOutputFromTaskDetails() {
    val tasks =
      parseBackgroundTasks(
        json,
        """{"tasks":[{"id":"task-1","taskId":"worker-1","status":"failed","runtime":"cli","title":"Index docs","startedAt":1000,"endedAt":"2026-07-16T09:00:00Z","error":"Command failed","prompt":"Index the docs"}]}""",
      )

    assertEquals(1, tasks.size)
    assertEquals("Index docs", tasks.single().displayTitle)
    assertEquals("Index the docs", tasks.single().prompt)
    assertEquals("Command failed", tasks.single().output)
    assertEquals(BackgroundTaskDisplayStatus.Failed, tasks.single().displayStatus)
    assertFalse(tasks.single().isActive)
  }

  @Test
  fun parsesRunningBackgroundExecTask() {
    val tasks =
      parseBackgroundTasks(
        json,
        """{"tasks":[{"id":"task-exec","taskId":"task-exec","kind":"exec","status":"running","runtime":"cli","title":"CLI command","progressSummary":"Command running"}]}""",
      )

    assertEquals(1, tasks.size)
    assertEquals("CLI command", tasks.single().displayTitle)
    assertEquals("Command running", tasks.single().output)
    assertTrue(tasks.single().isActive)
    assertEquals(BackgroundTaskDisplayStatus.Running, tasks.single().displayStatus)
  }

  @Test
  fun listsActiveAndRecentTasksWithoutRequestingPrompts() =
    runTest {
      val calls = mutableListOf<Pair<String, String?>>()
      val controller =
        ChatController(
          scope = backgroundScope,
          json = json,
          requestGateway = { method, params ->
            calls += method to params
            """{"tasks":[]}"""
          },
        )

      assertTrue(controller.listBackgroundTasks("main").isEmpty())
      assertEquals(listOf("tasks.list", "tasks.list"), calls.map { it.first })
      val statuses =
        calls.map { (_, params) ->
          json
            .parseToJsonElement(params.orEmpty())
            .jsonObject["status"]!!
            .jsonArray
            .map { it.jsonPrimitive.content }
        }
      assertEquals(listOf("queued", "running"), statuses[0])
      assertEquals(listOf("completed", "failed", "cancelled", "timed_out"), statuses[1])
      assertNull(json.parseToJsonElement(calls[0].second.orEmpty()).jsonObject["prompt"])
    }

  @Test
  fun requestsTaskDetailsByCanonicalLedgerId() =
    runTest {
      var requestedParams: String? = null
      val controller =
        ChatController(
          scope = backgroundScope,
          json = json,
          requestGateway = { method, params ->
            assertEquals("tasks.get", method)
            requestedParams = params
            """{"task":{"id":"ledger-1","taskId":"runtime-1","status":"completed","runtime":"cli"}}"""
          },
        )

      val task = controller.getBackgroundTask("ledger-1")

      assertEquals("ledger-1", task.id)
      assertEquals(
        "ledger-1",
        json
          .parseToJsonElement(requestedParams.orEmpty())
          .jsonObject["taskId"]
          ?.jsonPrimitive
          ?.content,
      )
    }

  @Test
  fun newestTaskSnapshotWinsDuplicateAndGroupsActiveFirst() {
    val finished = sampleTask(id = "same", status = "completed", endedAtMs = 2000)
    val running = sampleTask(id = "same", status = "running", endedAtMs = 3000)
    val older = sampleTask(id = "older", status = "failed", endedAtMs = 1000)

    val merged = mergeBackgroundTasks(listOf(finished, older), listOf(running))

    assertEquals(listOf("same", "older"), merged.map { it.id })
    assertTrue(merged.first().isActive)
  }

  @Test
  fun terminalSnapshotWinsTimestampTie() {
    val running = sampleTask(id = "same", status = "running", endedAtMs = 2000)
    val finished = sampleTask(id = "same", status = "completed", endedAtMs = 2000)

    val merged = mergeBackgroundTasks(listOf(running), listOf(finished))

    assertEquals("completed", merged.single().status)
  }

  @Test
  fun finishedProtocolStatusesUseTheBinaryFailedPresentation() {
    assertEquals(
      BackgroundTaskDisplayStatus.Failed,
      sampleTask(id = "cancelled", status = "cancelled", endedAtMs = 2000).displayStatus,
    )
    assertEquals(
      BackgroundTaskDisplayStatus.Failed,
      sampleTask(id = "timed-out", status = "timed_out", endedAtMs = 2000).displayStatus,
    )
  }

  @Test
  fun emptyStateDoesNotMaskLoadFailure() {
    assertTrue(backgroundTasksEmptyStateVisible(loading = false, error = null, taskCount = 0))
    assertFalse(backgroundTasksEmptyStateVisible(loading = false, error = "offline", taskCount = 0))
  }

  private fun sampleTask(
    id: String,
    status: String,
    endedAtMs: Long?,
  ) = BackgroundTask(
    id = id,
    status = status,
    runtime = "cli",
    title = id,
    agentId = "main",
    childSessionKey = null,
    createdAtMs = 100,
    updatedAtMs = endedAtMs,
    startedAtMs = 500,
    endedAtMs = endedAtMs,
    progress = null,
    terminal = null,
    error = null,
    prompt = null,
  )
}
