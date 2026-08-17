package ai.openclaw.app.chat

import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.test.TestScope
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.runTest
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

@OptIn(ExperimentalCoroutinesApi::class)
class ChatControllerProgressCardTest {
  private fun TestScope.newController(gateway: ScriptedGateway): ChatController = backgroundScope.createChatController(requestGateway = gateway::request)

  private fun changedEvent(
    sessionKey: String,
    revision: String,
  ): String = """{"sessionKey":"$sessionKey","revision":$revision}"""

  private fun cardResponse(
    sessionKey: String = "agent:main:main",
    revision: Int = 1,
    updatedAt: Long = 10,
    markdown: String = "Working",
    steps: String = "[]",
  ): String = """{"card":{"sessionKey":"$sessionKey","revision":$revision,"updatedAt":$updatedAt,"markdown":"$markdown","steps":$steps}}"""

  @Test
  fun matchingChangeFetchesAndPublishesTypedCard() =
    runTest {
      val gateway = ScriptedGateway(chatControllerTestJson)
      gateway.respondWith(
        "progressCard.get",
        cardResponse(
          markdown = "Inspecting",
          steps =
            """[{"step":"Done","status":"completed"},{"step":"Now","status":"in_progress"},{"step":"Bad","status":"unknown"},{"status":"pending"}]""",
        ),
      )
      val controller = newController(gateway)

      controller.handleGatewayEvent("progressCard.changed", changedEvent("main", "1"))
      runCurrent()

      assertEquals(
        ChatProgressCard(
          revision = 1,
          updatedAt = 10,
          markdown = "Inspecting",
          steps =
            listOf(
              ChatPlanStep("Done", ChatPlanStepStatus.Completed),
              ChatPlanStep("Now", ChatPlanStepStatus.InProgress),
            ),
        ),
        controller.progressCard.value,
      )
    }

  @Test
  fun duplicateRevisionDoesNotRefetch() =
    runTest {
      val gateway = ScriptedGateway(chatControllerTestJson)
      gateway.respondWith("progressCard.get", cardResponse())
      val controller = newController(gateway)

      controller.handleGatewayEvent("progressCard.changed", changedEvent("main", "1"))
      runCurrent()
      val requestsAfterFirstChange = gateway.callCount("progressCard.get")
      controller.handleGatewayEvent("progressCard.changed", changedEvent("main", "1"))
      runCurrent()

      assertEquals(1, requestsAfterFirstChange)
      assertEquals(requestsAfterFirstChange, gateway.callCount("progressCard.get"))
    }

  @Test
  fun nullRevisionClearsWithoutFetch() =
    runTest {
      val gateway = ScriptedGateway(chatControllerTestJson)
      gateway.respondWith("progressCard.get", cardResponse())
      val controller = newController(gateway)
      controller.handleGatewayEvent("progressCard.changed", changedEvent("main", "1"))
      runCurrent()
      val requestsBeforeClear = gateway.callCount("progressCard.get")

      controller.handleGatewayEvent("progressCard.changed", changedEvent("main", "null"))
      runCurrent()

      assertNull(controller.progressCard.value)
      assertEquals(requestsBeforeClear, gateway.callCount("progressCard.get"))
    }

  @Test
  fun foreignSessionChangeIsIgnored() =
    runTest {
      val gateway = ScriptedGateway(chatControllerTestJson)
      gateway.respondWith("progressCard.get", cardResponse())
      val controller = newController(gateway)
      controller.handleGatewayEvent("progressCard.changed", changedEvent("main", "1"))
      runCurrent()
      val expected = controller.progressCard.value
      val requestsBeforeForeignChange = gateway.callCount("progressCard.get")

      controller.handleGatewayEvent("progressCard.changed", changedEvent("other", "2"))
      runCurrent()

      assertEquals(expected, controller.progressCard.value)
      assertEquals(requestsBeforeForeignChange, gateway.callCount("progressCard.get"))
    }

  @Test
  fun unknownScopePokeRefetchesInsteadOfDropping() =
    runTest {
      val gateway = ScriptedGateway(chatControllerTestJson)
      gateway.respondWith("progressCard.get", cardResponse(sessionKey = "agent:main:main", markdown = "First poke"))
      val controller = newController(gateway)

      // Canonical scope key (e.g. global scope) with no learned mapping yet: the poke must
      // trigger an authoritative refetch rather than being dropped as foreign.
      controller.handleGatewayEvent("progressCard.changed", changedEvent("agent:main:main", "1"))
      runCurrent()

      assertEquals("First poke", controller.progressCard.value?.markdown)
    }

  @Test
  fun learnedCanonicalSessionKeyAcceptsLaterPoke() =
    runTest {
      val gateway = ScriptedGateway(chatControllerTestJson)
      gateway.respondWith("progressCard.get", cardResponse(revision = 1))
      val controller = newController(gateway)
      controller.handleGatewayEvent("progressCard.changed", changedEvent("main", "1"))
      runCurrent()
      gateway.respondWith("progressCard.get", cardResponse(revision = 2, markdown = "Canonical"))

      controller.handleGatewayEvent("progressCard.changed", changedEvent("agent:main:main", "2"))
      runCurrent()

      assertEquals(2, gateway.callCount("progressCard.get"))
      assertEquals("Canonical", controller.progressCard.value?.markdown)
    }

  @Test
  fun runTerminalAndStreamErrorPreserveCard() =
    runTest {
      val gateway = ScriptedGateway(chatControllerTestJson)
      gateway.respondWith("progressCard.get", cardResponse())
      gateway.respondWith("chat.history", historyResponse("session-1", emptyList()))
      gateway.respondChatSend(status = "started")
      val controller = newController(gateway)
      controller.handleGatewayEvent("progressCard.changed", changedEvent("main", "1"))
      runCurrent()
      controller.handleGatewayEvent("health", null)
      runCurrent()
      assertTrue(controller.sendMessageAwaitAcceptance("go", "off", emptyList()))
      val runId = requireNotNull(gateway.lastRunId)

      controller.handleGatewayEvent("chat", chatTerminalPayload("main", runId, seq = 1))
      runCurrent()
      assertEquals(1, controller.progressCard.value?.revision)

      controller.handleGatewayEvent(
        "agent",
        """{"sessionKey":"main","seq":2,"ts":20,"stream":"error","data":{}}""",
      )
      runCurrent()
      assertEquals(1, controller.progressCard.value?.revision)
    }

  @Test
  fun sessionSwitchClearsFetchesAndDiscardsStaleResponse() =
    runTest {
      val oldFetchStarted = CompletableDeferred<Unit>()
      val releaseOldFetch = CompletableDeferred<String>()
      val newFetchStarted = CompletableDeferred<Unit>()
      val releaseNewFetch = CompletableDeferred<String>()
      var mainRequests = 0
      val gateway = ScriptedGateway(chatControllerTestJson)
      gateway.respondWith("chat.history", historyResponse("session-1", emptyList()))
      gateway.respond("progressCard.get") { paramsJson ->
        when (gateway.sessionKeyOf(paramsJson)) {
          "main" -> {
            mainRequests += 1
            if (mainRequests == 1) {
              cardResponse(revision = 1)
            } else {
              oldFetchStarted.complete(Unit)
              releaseOldFetch.await()
            }
          }
          "other" -> {
            newFetchStarted.complete(Unit)
            releaseNewFetch.await()
          }
          else -> error("unexpected session")
        }
      }
      val controller = newController(gateway)
      controller.handleGatewayEvent("progressCard.changed", changedEvent("main", "1"))
      runCurrent()
      controller.handleGatewayEvent("progressCard.changed", changedEvent("main", "2"))
      runCurrent()
      oldFetchStarted.await()

      controller.switchSession("other")
      runCurrent()
      newFetchStarted.await()
      assertNull(controller.progressCard.value)

      releaseNewFetch.complete(cardResponse(sessionKey = "agent:main:other", revision = 3, markdown = "Other"))
      runCurrent()
      assertEquals("Other", controller.progressCard.value?.markdown)

      releaseOldFetch.complete(cardResponse(revision = 2, markdown = "Stale"))
      runCurrent()
      assertEquals("Other", controller.progressCard.value?.markdown)
      assertTrue(gateway.calls.any { it.method == "progressCard.get" && gateway.sessionKeyOf(it.paramsJson) == "other" })
    }

  @Test
  fun malformedResponsesLeavePublishedCardUnchanged() =
    runTest {
      var response = cardResponse()
      val gateway = ScriptedGateway(chatControllerTestJson)
      gateway.respond("progressCard.get") { response }
      val controller = newController(gateway)
      controller.handleGatewayEvent("progressCard.changed", changedEvent("main", "1"))
      runCurrent()
      val expected = controller.progressCard.value

      response = """{"card":{"sessionKey":"agent:main:main","revision":0,"updatedAt":20,"markdown":"Bad"}}"""
      controller.handleGatewayEvent("progressCard.changed", changedEvent("main", "2"))
      runCurrent()
      assertEquals(expected, controller.progressCard.value)

      response = """{"card":{}}"""
      controller.handleGatewayEvent("progressCard.changed", changedEvent("main", "3"))
      runCurrent()
      assertEquals(expected, controller.progressCard.value)
    }
}
