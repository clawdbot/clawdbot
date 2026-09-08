package ai.openclaw.app.chat

import ai.openclaw.app.gateway.GatewayErrorDetails
import ai.openclaw.app.gateway.GatewayRequestRejected
import ai.openclaw.app.gateway.GatewaySession
import ai.openclaw.app.gateway.GatewaySessionRouting
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.test.TestScope
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.runTest
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner

@OptIn(ExperimentalCoroutinesApi::class)
@RunWith(RobolectricTestRunner::class)
class ChatControllerProgressCardTest {
  private data class StartedRun(
    val controller: ChatController,
    val gateway: ScriptedGateway,
    val runId: String,
  )

  private fun TestScope.newController(
    gateway: ScriptedGateway,
    gatewayAdvertisesMethod: (method: String) -> Boolean? = { null },
  ): ChatController =
    backgroundScope.createChatController(
      requestGateway = gateway::request,
      gatewayAdvertisesMethod = gatewayAdvertisesMethod,
    )

  private suspend fun TestScope.startRun(progressCardAdvertised: Boolean?): StartedRun {
    val gateway = ScriptedGateway(chatControllerTestJson)
    gateway.respondChatSend(status = "started")
    gateway.respondWith("chat.history", historyResponse("session-1", emptyList()))
    val controller =
      newController(gateway) { method ->
        if (method == "progressCard.get") progressCardAdvertised else true
      }
    controller.load("main")
    runCurrent()
    assertTrue(controller.sendMessageAwaitAcceptance("make a plan", "off", emptyList()))
    return StartedRun(controller, gateway, requireNotNull(gateway.lastRunId))
  }

  private fun planEvent(
    runId: String,
    data: String,
    timestamp: Long = 10,
  ): String = """{"sessionKey":"main","runId":"$runId","seq":1,"ts":$timestamp,"stream":"plan","data":$data}"""

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
  fun deniedProgressRefreshClearsOnlyTheCurrentOwner() =
    runTest {
      for (replacement in listOf("none", "session", "socket")) {
        var physicalConnection = 1
        var transientFailure = false
        var pendingFetch: CompletableDeferred<String>? = null
        val controller =
          ChatController(
            scope = backgroundScope,
            json = chatControllerTestJson,
            commandOutbox = backgroundScope.createChatCommandOutbox(),
            cacheScope = { ChatCacheScope("gateway-test", 1) },
            currentDefaultAgentId = { "research" },
            sessionRouting = { GatewaySessionRouting("agent:research:main", "main") },
            requestGateway = { method, _ -> emptyChatGatewayResponse(method) },
            captureRequestLease = { capturedScope ->
              val connection = physicalConnection
              GatewaySession.RequestLease(
                endpointStableId = requireNotNull(capturedScope).gatewayId,
                isCurrentImpl = { physicalConnection == connection },
              ) { method, params, _, withEnqueue ->
                withEnqueue {}
                if (method == "progressCard.get") {
                  val key =
                    chatControllerTestJson
                      .parseToJsonElement(requireNotNull(params))
                      .jsonObject
                      .getValue("sessionKey")
                      .jsonPrimitive
                      .content
                  if (transientFailure) throw CancellationException("Disconnected")
                  val pending = pendingFetch
                  if (key == "agent:research:main" && pending != null) pending.await() else cardResponse(sessionKey = key, markdown = key)
                } else {
                  emptyChatGatewayResponse(method)
                }
              }
            },
          )
        controller.switchSession("agent:research:main", "research")
        runCurrent()
        assertEquals("agent:research:main", controller.progressCard.value?.markdown)
        transientFailure = true
        controller.handleGatewayEvent("progressCard.changed", changedEvent("agent:research:main", "2"))
        runCurrent()
        assertEquals("agent:research:main", controller.progressCard.value?.markdown)

        transientFailure = false
        val deniedFetch = CompletableDeferred<String>()
        pendingFetch = deniedFetch
        controller.handleGatewayEvent("progressCard.changed", changedEvent("agent:research:main", "3"))
        runCurrent()
        if (replacement == "session") {
          controller.switchSession("agent:research:other", "research")
          runCurrent()
          assertEquals("agent:research:other", controller.progressCard.value?.markdown)
        } else if (replacement == "socket") {
          // Physical retirement precedes the controller's disconnect callback.
          physicalConnection += 1
        }
        deniedFetch.completeExceptionally(
          GatewayRequestRejected(
            GatewaySession.ErrorShape(
              code = "INVALID_REQUEST",
              message = "Session access denied",
              details = GatewayErrorDetails("SESSION_PARTICIPATION_REQUIRED", false, null),
            ),
          ),
        )
        runCurrent()
        if (replacement == "none") {
          assertNull(controller.progressCard.value)
          pendingFetch = null
          controller.handleGatewayEvent("progressCard.changed", changedEvent("agent:research:main", "4"))
          runCurrent()
          assertEquals("agent:research:main", controller.progressCard.value?.markdown)
        } else {
          assertEquals(if (replacement == "session") "agent:research:other" else "agent:research:main", controller.progressCard.value?.markdown)
        }
      }
    }

  @Test
  fun mainProgressAliasesRequireANonblankRoutingKey() =
    runTest {
      val routes =
        listOf(
          GatewaySessionRouting(null, null) to "agent:research:main",
          GatewaySessionRouting("agent:main:main", null) to "agent:research:main",
          GatewaySessionRouting("agent:main:main", "") to "agent:research:main",
          GatewaySessionRouting("agent:main:workbench", "workbench") to "agent:research:workbench",
        )
      for ((routing, expectedKey) in routes) {
        for (selectedKey in listOf("main", "agent:research:main")) {
          val requestedKeys = mutableListOf<String>()
          var response = cardResponse(sessionKey = expectedKey, markdown = "Selected owner")
          val controller =
            ChatController(
              scope = backgroundScope,
              json = chatControllerTestJson,
              commandOutbox = backgroundScope.createChatCommandOutbox(),
              cacheScope = { ChatCacheScope("gateway-test", 1) },
              currentDefaultAgentId = { "main" },
              sessionRouting = { routing },
              requestGateway = { method, params ->
                if (method == "progressCard.get") {
                  val request = chatControllerTestJson.parseToJsonElement(requireNotNull(params)).jsonObject
                  requestedKeys += request.getValue("sessionKey").jsonPrimitive.content
                  response
                } else {
                  emptyChatGatewayResponse(method)
                }
              },
            )
          controller.switchSession(selectedKey, "research")
          runCurrent()
          assertEquals(listOf(expectedKey), requestedKeys)
          assertEquals("Selected owner", controller.progressCard.value?.markdown)

          response = cardResponse(sessionKey = "agent:research:other", revision = 2, markdown = "Another session")
          controller.handleGatewayEvent("progressCard.changed", changedEvent(expectedKey, "2"))
          runCurrent()
          assertEquals(listOf(expectedKey, expectedKey), requestedKeys)
          assertEquals("Selected owner", controller.progressCard.value?.markdown)
        }
      }
    }

  @Test
  fun globalProgressCardFollowsTheSelectedOwner() =
    runTest {
      for (routingKnownAtSelection in listOf(true, false)) {
        val globalRouting = GatewaySessionRouting("global", "workbench")
        var routing = globalRouting.takeIf { routingKnownAtSelection }
        val requestedKeys = mutableListOf<String>()
        var heldResearchFetch: CompletableDeferred<String>? = null
        val controller =
          ChatController(
            scope = backgroundScope,
            json = chatControllerTestJson,
            commandOutbox = backgroundScope.createChatCommandOutbox(),
            cacheScope = { ChatCacheScope("gateway-test", 1) },
            currentDefaultAgentId = { "main" },
            sessionRouting = { routing },
            gatewayAdvertisesCapability = { it == "progress-card-agent-scope-v1" },
            requestGateway = { method, params ->
              if (method == "progressCard.get") {
                val key =
                  chatControllerTestJson
                    .parseToJsonElement(requireNotNull(params))
                    .jsonObject
                    .getValue("sessionKey")
                    .jsonPrimitive.content
                requestedKeys += key
                val owner =
                  chatControllerTestJson
                    .parseToJsonElement(requireNotNull(params))
                    .jsonObject["agentId"]
                    ?.jsonPrimitive
                    ?.content ?: "main"
                if (owner == "research" && heldResearchFetch != null) {
                  requireNotNull(heldResearchFetch).await()
                } else {
                  cardResponse(sessionKey = "agent:$owner:global", markdown = owner)
                }
              } else {
                emptyChatGatewayResponse(method)
              }
            },
          )
        controller.switchSession("global", "research")
        routing = globalRouting
        runCurrent()
        assertEquals("research", controller.progressCard.value?.markdown)
        assertEquals(listOf("global"), requestedKeys)

        val oldFetch = CompletableDeferred<String>()
        heldResearchFetch = oldFetch
        controller.handleGatewayEvent("progressCard.changed", changedEvent("agent:research:global", "2"))
        runCurrent()
        assertEquals(listOf("global", "global"), requestedKeys)
        controller.switchSession("global", "main")
        assertNull(controller.progressCard.value)
        runCurrent()
        assertEquals("main", controller.progressCard.value?.markdown)
        oldFetch.complete(cardResponse(sessionKey = "agent:research:global", revision = 2, markdown = "Stale research"))
        runCurrent()
        assertEquals("main", controller.progressCard.value?.markdown)
        assertEquals("global", requestedKeys.last())
        val requestsAfterSwitch = requestedKeys.size
        controller.handleGatewayEvent("progressCard.changed", changedEvent("agent:research:global", "null"))
        runCurrent()
        assertEquals("main", controller.progressCard.value?.markdown)
        assertEquals(requestsAfterSwitch, requestedKeys.size)
      }
    }

  @Test
  fun perSenderGlobalProgressRetainsSelectedOwner() =
    runTest {
      val requests = mutableListOf<Pair<String, String?>>()
      val controller =
        ChatController(
          scope = backgroundScope,
          json = chatControllerTestJson,
          commandOutbox = backgroundScope.createChatCommandOutbox(),
          cacheScope = { ChatCacheScope("gateway-test", 1) },
          currentDefaultAgentId = { "main" },
          sessionRouting = { GatewaySessionRouting("agent:main:workbench", "workbench") },
          gatewayAdvertisesCapability = { it == "progress-card-agent-scope-v1" },
          requestGateway = { method, params ->
            if (method == "progressCard.get") {
              val request = chatControllerTestJson.parseToJsonElement(requireNotNull(params)).jsonObject
              val key = request.getValue("sessionKey").jsonPrimitive.content
              val agent = request["agentId"]?.jsonPrimitive?.content
              requests += key to agent
              val owner = agent ?: "main"
              if (key == "global") {
                cardResponse(sessionKey = "agent:$owner:global", markdown = "$owner raw global")
              } else {
                cardResponse(sessionKey = key, markdown = "ordinary qualified global")
              }
            } else {
              emptyChatGatewayResponse(method)
            }
          },
        )
      controller.switchSession("global", "research")
      runCurrent()
      assertEquals("research raw global", controller.progressCard.value?.markdown)
      assertEquals("global" to "research", requests.last())

      controller.switchSession("agent:research:global", "research")
      runCurrent()
      assertEquals("ordinary qualified global", controller.progressCard.value?.markdown)
      assertEquals("agent:research:global" to null, requests.last())
    }

  @Test
  fun ambiguousGlobalNullEventRefreshesCapturedTarget() =
    runTest {
      val requests = mutableListOf<Pair<String, String?>>()
      val controller =
        ChatController(
          scope = backgroundScope,
          json = chatControllerTestJson,
          commandOutbox = backgroundScope.createChatCommandOutbox(),
          cacheScope = { ChatCacheScope("gateway-test", 1) },
          currentDefaultAgentId = { "main" },
          sessionRouting = { GatewaySessionRouting("agent:main:workbench", "workbench") },
          gatewayAdvertisesCapability = { it == "progress-card-agent-scope-v1" },
          requestGateway = { method, params ->
            if (method == "progressCard.get") {
              val request = chatControllerTestJson.parseToJsonElement(requireNotNull(params)).jsonObject
              val key = request.getValue("sessionKey").jsonPrimitive.content
              val agent = request["agentId"]?.jsonPrimitive?.content
              requests += key to agent
              if (key == "global") cardResponse(sessionKey = "agent:main:global", markdown = "Retained raw global") else """{"card":null}"""
            } else {
              emptyChatGatewayResponse(method)
            }
          },
        )
      controller.switchSession("global", "main")
      runCurrent()
      assertEquals("Retained raw global", controller.progressCard.value?.markdown)
      val before = requests.size

      // The ordinary qualified row shares this wire key and may have been cleared.
      controller.handleGatewayEvent("progressCard.changed", changedEvent("agent:main:global", "null"))
      runCurrent()

      assertEquals("Retained raw global", controller.progressCard.value?.markdown)
      assertEquals(before + 1, requests.size)
      assertEquals("global" to "main", requests.last())
    }

  @Test
  fun unavailableOwnerCapabilityRetainsCardAndQualifiedRequestsStayCompatible() =
    runTest {
      for (unsupported in listOf(false, null)) {
        var ownerCapability: Boolean? = true
        val targets = mutableListOf<Pair<String, String?>>()
        val controller =
          ChatController(
            scope = backgroundScope,
            json = chatControllerTestJson,
            commandOutbox = backgroundScope.createChatCommandOutbox(),
            cacheScope = { ChatCacheScope("gateway-test", 1) },
            currentDefaultAgentId = { "main" },
            sessionRouting = { GatewaySessionRouting("agent:main:workbench", "workbench") },
            gatewayAdvertisesCapability = { ownerCapability },
            requestGateway = { method, params ->
              if (method == "progressCard.get") {
                val request = chatControllerTestJson.parseToJsonElement(requireNotNull(params)).jsonObject
                val key = request.getValue("sessionKey").jsonPrimitive.content
                targets += key to request["agentId"]?.jsonPrimitive?.content
                if (ownerCapability != true) assertEquals(setOf("sessionKey"), request.keys)
                cardResponse(sessionKey = "agent:research:global", markdown = if (key == "global") "Retained" else "Ordinary")
              } else {
                emptyChatGatewayResponse(method)
              }
            },
          )
        controller.switchSession("global", "research")
        runCurrent()
        assertEquals("Retained", controller.progressCard.value?.markdown)
        ownerCapability = unsupported
        controller.handleGatewayEvent("progressCard.changed", changedEvent("agent:research:global", "null"))
        runCurrent()
        assertEquals("Retained", controller.progressCard.value?.markdown)
        assertEquals(listOf("global" to "research"), targets)
        assertEquals("Update the gateway to load progress cards for this agent.", controller.errorText.value)
        controller.switchSession("agent:research:global", "research")
        runCurrent()
        assertEquals("Ordinary", controller.progressCard.value?.markdown)
        assertNull(controller.errorText.value)
        assertEquals("agent:research:global" to null, targets.last())
      }
    }

  @Test
  fun legacyPlanRendersWhenGatewayLacksProgressCardStore() =
    runTest {
      val (controller, _, runId) = startRun(progressCardAdvertised = false)

      controller.handleGatewayEvent(
        "agent",
        planEvent(
          runId,
          """{"phase":"update","explanation":" Inspect, patch, and test ","steps":[{"step":" Inspect ","status":"completed"},{"step":"Patch","status":"in_progress"},{"step":"Test","status":"pending"}]}""",
        ),
      )

      assertEquals(
        ChatProgressCard(
          revision = 1,
          updatedAt = 10,
          markdown = "Inspect, patch, and test",
          steps =
            listOf(
              ChatPlanStep("Inspect", ChatPlanStepStatus.Completed),
              ChatPlanStep("Patch", ChatPlanStepStatus.InProgress),
              ChatPlanStep("Test", ChatPlanStepStatus.Pending),
            ),
        ),
        controller.progressCard.value,
      )
    }

  @Test
  fun emptyLegacyPlanClearsFallbackCard() =
    runTest {
      val (controller, _, runId) = startRun(progressCardAdvertised = false)
      controller.handleGatewayEvent(
        "agent",
        planEvent(runId, """{"phase":"update","steps":[{"step":"Active","status":"in_progress"}]}"""),
      )
      assertEquals(
        "Active",
        controller.progressCard.value
          ?.steps
          ?.single()
          ?.step,
      )

      controller.handleGatewayEvent("agent", planEvent(runId, """{"phase":"update","steps":[]}"""))

      assertNull(controller.progressCard.value)
    }

  @Test
  fun capableGatewayIgnoresLegacyPlanDualEmit() =
    runTest {
      val (controller, gateway, runId) = startRun(progressCardAdvertised = true)
      gateway.respondWith("progressCard.get", cardResponse(markdown = "Canonical"))
      controller.handleGatewayEvent("progressCard.changed", changedEvent("main", "1"))
      runCurrent()
      val expected = requireNotNull(controller.progressCard.value)

      controller.handleGatewayEvent(
        "agent",
        planEvent(runId, """{"phase":"update","explanation":"Legacy","steps":[{"step":"Duplicate","status":"in_progress"}]}"""),
      )

      assertEquals(expected, controller.progressCard.value)
    }

  @Test
  fun unknownGatewayCapabilityIgnoresLegacyPlan() =
    runTest {
      val (controller, _, runId) = startRun(progressCardAdvertised = null)

      controller.handleGatewayEvent(
        "agent",
        planEvent(runId, """{"phase":"update","steps":[{"step":"Wait","status":"in_progress"}]}"""),
      )

      assertNull(controller.progressCard.value)
    }

  @Test
  fun healthRefreshSkipsUnadvertisedStoreAndPreservesLegacyFallbackCard() =
    runTest {
      val (controller, gateway, runId) = startRun(progressCardAdvertised = false)
      controller.handleGatewayEvent(
        "agent",
        planEvent(runId, """{"phase":"update","explanation":"Keep me","steps":[{"step":"Active","status":"in_progress"}]}"""),
      )
      val expected = requireNotNull(controller.progressCard.value)
      gateway.respond("progressCard.get") { error("method not found") }

      controller.handleGatewayEvent("health", null)
      runCurrent()

      assertEquals(expected, controller.progressCard.value)
      assertEquals(0, gateway.callCount("progressCard.get"))
    }

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
  fun duplicateRevisionRefreshesItsTarget() =
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
      assertEquals(requestsAfterFirstChange + 1, gateway.callCount("progressCard.get"))
    }

  @Test
  fun nullRevisionClearsOnlyAfterAuthoritativeFetch() =
    runTest {
      val gateway = ScriptedGateway(chatControllerTestJson)
      gateway.respondWith("progressCard.get", cardResponse())
      val controller = newController(gateway)
      controller.handleGatewayEvent("progressCard.changed", changedEvent("main", "1"))
      runCurrent()
      val requestsBeforeClear = gateway.callCount("progressCard.get")
      gateway.respondWith("progressCard.get", """{"card":null}""")

      controller.handleGatewayEvent("progressCard.changed", changedEvent("main", "null"))
      runCurrent()

      assertNull(controller.progressCard.value)
      assertEquals(requestsBeforeClear + 1, gateway.callCount("progressCard.get"))
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
      controller.load("main")
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
          "agent:main:main" -> {
            mainRequests += 1
            if (mainRequests == 1) {
              cardResponse(revision = 1)
            } else {
              oldFetchStarted.complete(Unit)
              releaseOldFetch.await()
            }
          }

          "agent:main:other" -> {
            newFetchStarted.complete(Unit)
            releaseNewFetch.await()
          }

          else -> {
            error("unexpected session")
          }
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
      assertTrue(gateway.calls.any { it.method == "progressCard.get" && gateway.sessionKeyOf(it.paramsJson) == "agent:main:other" })
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

      response = cardResponse(sessionKey = "agent:research:main", revision = 4, markdown = "Wrong owner")
      controller.handleGatewayEvent("progressCard.changed", changedEvent("main", "4"))
      runCurrent()
      assertEquals(expected, controller.progressCard.value)
    }
}
