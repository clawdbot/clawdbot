package ai.openclaw.app.wear

import ai.openclaw.wear.shared.WearEventType
import ai.openclaw.wear.shared.WearMessage
import ai.openclaw.wear.shared.WearProtocolCodec
import ai.openclaw.wear.shared.WearProxyCapability
import ai.openclaw.wear.shared.WearRealtimeTalkSnapshot
import ai.openclaw.wear.shared.WearRpcMethod
import kotlinx.coroutines.test.runTest
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.buildJsonArray
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.put
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertTrue
import org.junit.Test

class WearProxyControllerTest {
  private val json = Json

  @Test
  fun statusDoesNotTouchGateway() =
    runTest {
      var gatewayCalls = 0
      val controller =
        WearProxyController(
          requestGateway = { _, _ ->
            gatewayCalls += 1
            buildJsonObject {}
          },
          isGatewayConnected = { false },
          gatewayStatusText = { "Offline" },
        )

      val response = controller.handle(request(WearRpcMethod.ProxyStatus))

      assertTrue(response.ok)
      assertEquals(0, gatewayCalls)
      val result = checkNotNull(response.result).jsonObject
      assertEquals(
        false,
        result
          .getValue("connected")
          .jsonPrimitive
          .content
          .toBoolean(),
      )
      assertEquals("Offline", result.getValue("status").jsonPrimitive.content)
      assertEquals(
        WearProxyCapability.entries.map(WearProxyCapability::wireValue),
        result.getValue("capabilities").jsonArray.map { it.jsonPrimitive.content },
      )
    }

  @Test
  fun agentsAndGatewayControlsStayOnThePhoneRuntimeBoundary() =
    runTest {
      var gatewayRequests = 0
      var connected = true
      var selectedAgent = "main"
      val controller =
        WearProxyController(
          requestGateway = { _, _ ->
            gatewayRequests += 1
            buildJsonObject {}
          },
          isGatewayConnected = { connected },
          gatewayStatusText = { if (connected) "Connected" else "Offline" },
          activeAgentId = { selectedAgent },
          activeSessionKey = { "agent:$selectedAgent:main" },
          selectedModelRef = { "openai/gpt-test" },
          agents = {
            listOf(
              WearProxyAgent(id = "main", name = "Main", emoji = "*"),
              WearProxyAgent(id = "ops", name = "Ops", emoji = null),
            )
          },
          selectGatewayAgent = { agentId ->
            selectedAgent = agentId
            true
          },
          connectGateway = { connected = true },
          disconnectGateway = { connected = false },
        )

      val status = controller.handle(request(WearRpcMethod.ProxyStatus))
      val agents = controller.handle(request(WearRpcMethod.AgentsList))
      val selected =
        controller.handle(
          request(
            WearRpcMethod.AgentsSelect,
            buildJsonObject { put("agentId", "ops") },
          ),
        )
      val selectedStatus = controller.handle(request(WearRpcMethod.ProxyStatus))
      val disconnected = controller.handle(request(WearRpcMethod.GatewayDisconnect))
      val reconnected = controller.handle(request(WearRpcMethod.GatewayConnect))

      val statusResult = checkNotNull(status.result).jsonObject
      val agentsResult = checkNotNull(agents.result).jsonObject
      val selectedResult = checkNotNull(selected.result).jsonObject
      val selectedStatusResult = checkNotNull(selectedStatus.result).jsonObject
      val disconnectedResult = checkNotNull(disconnected.result).jsonObject
      val reconnectedResult = checkNotNull(reconnected.result).jsonObject

      assertEquals("main", statusResult.getValue("activeAgentId").jsonPrimitive.content)
      assertEquals("agent:main:main", statusResult.getValue("activeSessionKey").jsonPrimitive.content)
      assertEquals("openai/gpt-test", statusResult.getValue("selectedModelRef").jsonPrimitive.content)
      assertEquals(2, agentsResult.getValue("agents").jsonArray.size)
      assertEquals("ops", selectedResult.getValue("activeAgentId").jsonPrimitive.content)
      assertEquals("ops", selectedStatusResult.getValue("activeAgentId").jsonPrimitive.content)
      assertEquals("agent:ops:main", selectedStatusResult.getValue("activeSessionKey").jsonPrimitive.content)
      assertEquals("openai/gpt-test", selectedStatusResult.getValue("selectedModelRef").jsonPrimitive.content)
      assertFalse(
        disconnectedResult
          .getValue("connected")
          .jsonPrimitive.content
          .toBoolean(),
      )
      assertTrue(
        reconnectedResult
          .getValue("connected")
          .jsonPrimitive.content
          .toBoolean(),
      )
      assertEquals(0, gatewayRequests)
    }

  @Test
  fun boundedAgentListPreservesTheActiveAgent() =
    runTest {
      val activeAgentId = "agent-32"
      val controller =
        WearProxyController(
          requestGateway = { _, _ -> buildJsonObject {} },
          isGatewayConnected = { true },
          gatewayStatusText = { "Connected" },
          activeAgentId = { activeAgentId },
          agents = {
            listOf(WearProxyAgent(id = " ", name = "Invalid", emoji = null)) +
              (0..32).map { index ->
                WearProxyAgent(id = "agent-$index", name = "Agent $index", emoji = null)
              }
          },
        )

      val response = controller.handle(request(WearRpcMethod.AgentsList))
      val agents = checkNotNull(response.result).jsonObject.getValue("agents").jsonArray

      assertEquals(32, agents.size)
      assertTrue(
        agents.any { agent ->
          val value = agent.jsonObject
          value.getValue("id").jsonPrimitive.content == activeAgentId &&
            value
              .getValue("selected")
              .jsonPrimitive
              .content
              .toBoolean()
        },
      )
    }

  @Test
  fun modelListAndSelectionStayBoundToTheRequestedSession() =
    runTest {
      var selection: Pair<String, String>? = null
      val controller =
        WearProxyController(
          requestGateway = { _, _ -> buildJsonObject {} },
          isGatewayConnected = { true },
          gatewayStatusText = { "Connected" },
          models = {
            listOf(
              WearProxyModel(ref = "openai/gpt-a", name = "GPT A"),
              WearProxyModel(ref = "openai/gpt-b", name = "GPT B"),
            )
          },
          selectSessionModel = { sessionKey, modelRef ->
            selection = sessionKey to modelRef
            true
          },
        )

      val listed = controller.handle(request(WearRpcMethod.ModelsList))
      val selected =
        controller.handle(
          request(
            WearRpcMethod.ModelsSelect,
            buildJsonObject {
              put("sessionKey", "agent:main:thread-7")
              put("modelRef", "openai/gpt-b")
            },
          ),
        )

      assertEquals(
        listOf("openai/gpt-a", "openai/gpt-b"),
        checkNotNull(listed.result)
          .jsonObject
          .getValue("models")
          .jsonArray
          .map {
            it.jsonObject
              .getValue("ref")
              .jsonPrimitive.content
          },
      )
      assertTrue(selected.ok)
      assertEquals("agent:main:thread-7" to "openai/gpt-b", selection)
      assertEquals(
        "openai/gpt-b",
        checkNotNull(selected.result)
          .jsonObject
          .getValue("selectedModelRef")
          .jsonPrimitive.content,
      )
    }

  @Test
  fun modelReferencesUseOneCanonicalNonLossyValue() =
    runTest {
      var selection: Pair<String, String>? = null
      val overlongRef = "m".repeat(201)
      val controller =
        WearProxyController(
          requestGateway = { _, _ -> buildJsonObject {} },
          isGatewayConnected = { true },
          gatewayStatusText = { "Connected" },
          selectedModelRef = { " openai/gpt-a " },
          models = {
            listOf(
              WearProxyModel(ref = " openai/gpt-a ", name = "GPT A"),
              WearProxyModel(ref = "openai/gpt-a", name = "Duplicate"),
              WearProxyModel(ref = overlongRef, name = "Too long"),
            )
          },
          selectSessionModel = { sessionKey, modelRef ->
            selection = sessionKey to modelRef
            true
          },
        )

      val status = controller.handle(request(WearRpcMethod.ProxyStatus))
      val listed = controller.handle(request(WearRpcMethod.ModelsList))
      val selected =
        controller.handle(
          request(
            WearRpcMethod.ModelsSelect,
            buildJsonObject {
              put("sessionKey", "agent:main:thread-7")
              put("modelRef", "openai/gpt-a")
            },
          ),
        )

      assertEquals(
        "openai/gpt-a",
        checkNotNull(status.result)
          .jsonObject
          .getValue("selectedModelRef")
          .jsonPrimitive
          .content,
      )
      assertEquals(
        listOf("openai/gpt-a"),
        checkNotNull(listed.result)
          .jsonObject
          .getValue("models")
          .jsonArray
          .map {
            it.jsonObject
              .getValue("ref")
              .jsonPrimitive
              .content
          },
      )
      assertTrue(selected.ok)
      assertEquals("agent:main:thread-7" to "openai/gpt-a", selection)
    }

  @Test
  fun modelListCapCentersAWindowOnTheWatchSelectedSessionsModel() =
    runTest {
      val controller =
        WearProxyController(
          requestGateway = { _, _ -> buildJsonObject {} },
          isGatewayConnected = { true },
          gatewayStatusText = { "Connected" },
          selectedModelRef = { "openai/gpt-0" },
          models = {
            (0 until 60).map { index ->
              WearProxyModel(ref = "openai/gpt-$index", name = "GPT $index")
            }
          },
        )

      val listed =
        controller.handle(
          request(
            WearRpcMethod.ModelsList,
            buildJsonObject { put("selectedModelRef", "openai/gpt-59") },
          ),
        )
      val refs =
        checkNotNull(listed.result)
          .jsonObject
          .getValue("models")
          .jsonArray
          .map { model ->
            model.jsonObject
              .getValue("ref")
              .jsonPrimitive
              .content
          }

      assertEquals(50, refs.size)
      assertTrue("openai/gpt-59" in refs)
      assertEquals("openai/gpt-10", refs.first())
      assertEquals("openai/gpt-59", refs.last())
    }

  @Test
  fun modelListWindowKeepsAdjacentModelsReachableAcrossTheCap() =
    runTest {
      val controller =
        WearProxyController(
          requestGateway = { _, _ -> buildJsonObject {} },
          isGatewayConnected = { true },
          gatewayStatusText = { "Connected" },
          models = {
            (0 until 120).map { index ->
              WearProxyModel(ref = "openai/gpt-$index", name = "GPT $index")
            }
          },
        )

      val listed =
        controller.handle(
          request(
            WearRpcMethod.ModelsList,
            buildJsonObject { put("selectedModelRef", "openai/gpt-49") },
          ),
        )
      val refs =
        checkNotNull(listed.result)
          .jsonObject
          .getValue("models")
          .jsonArray
          .map { model ->
            model.jsonObject
              .getValue("ref")
              .jsonPrimitive.content
          }

      val selectedIndex = refs.indexOf("openai/gpt-49")
      assertEquals("openai/gpt-48", refs[selectedIndex - 1])
      assertEquals("openai/gpt-50", refs[selectedIndex + 1])
    }

  @Test
  fun modelSelectionRejectsAStaleModelBeforePatchingTheSession() =
    runTest {
      var selections = 0
      val controller =
        WearProxyController(
          requestGateway = { _, _ -> buildJsonObject {} },
          isGatewayConnected = { true },
          gatewayStatusText = { "Connected" },
          models = { listOf(WearProxyModel(ref = "openai/gpt-a", name = "GPT A")) },
          selectSessionModel = { _, _ ->
            selections += 1
            true
          },
        )

      val response =
        controller.handle(
          request(
            WearRpcMethod.ModelsSelect,
            buildJsonObject {
              put("sessionKey", "agent:main:thread-7")
              put("modelRef", "openai/removed")
            },
          ),
        )

      assertFalse(response.ok)
      assertEquals("not_found", response.error?.code)
      assertEquals(0, selections)
    }

  @Test
  fun talkStartBindsTheWatchNodeAndSelectedSession() =
    runTest {
      var startArgs: List<String?>? = null
      val controller =
        WearProxyController(
          requestGateway = { _, _ -> buildJsonObject {} },
          isGatewayConnected = { true },
          gatewayStatusText = { "Connected" },
          startRealtimeTalk = { nodeId, sessionKey, attemptId, language ->
            startArgs = listOf(nodeId, sessionKey, attemptId, language)
            WearRealtimeTalkSnapshot(attemptId = attemptId, active = true)
          },
        )

      val response =
        controller.handle(
          request(
            WearRpcMethod.TalkStart,
            buildJsonObject {
              put("sessionKey", "agent:main:thread-7")
              put("attemptId", "attempt-7")
              put("language", "DE")
            },
          ),
          sourceNodeId = "watch-a",
        )

      assertTrue(response.ok)
      assertEquals(listOf("watch-a", "agent:main:thread-7", "attempt-7", "de"), startArgs)
      assertTrue(
        checkNotNull(response.result)
          .jsonObject
          .getValue("active")
          .jsonPrimitive
          .content
          .toBoolean(),
      )
    }

  @Test
  fun talkStartRejectsAMissingSessionBeforeStarting() =
    runTest {
      var starts = 0
      val controller =
        WearProxyController(
          requestGateway = { _, _ -> buildJsonObject {} },
          isGatewayConnected = { true },
          gatewayStatusText = { "Connected" },
          startRealtimeTalk = { _, _, _, _ ->
            starts += 1
            WearRealtimeTalkSnapshot(active = true)
          },
        )

      val response = controller.handle(request(WearRpcMethod.TalkStart), sourceNodeId = "watch-a")

      assertFalse(response.ok)
      assertEquals("invalid_request", response.error?.code)
      assertEquals(0, starts)
    }

  @Test
  fun talkStopBindsTheWatchNodeAndAttempt() =
    runTest {
      var stopArgs: List<String>? = null
      val controller =
        WearProxyController(
          requestGateway = { _, _ -> buildJsonObject {} },
          isGatewayConnected = { true },
          gatewayStatusText = { "Connected" },
          stopRealtimeTalk = { nodeId, attemptId ->
            stopArgs = listOf(nodeId, attemptId)
            WearRealtimeTalkSnapshot(attemptId = attemptId)
          },
        )

      val response =
        controller.handle(
          request(WearRpcMethod.TalkStop, buildJsonObject { put("attemptId", "attempt-7") }),
          sourceNodeId = "watch-a",
        )

      assertTrue(response.ok)
      assertEquals(listOf("watch-a", "attempt-7"), stopArgs)
    }

  @Test
  fun sessionsListBuildsFixedGatewayScopeAndProjectsRows() =
    runTest {
      var requestedMethod: String? = null
      var requestedParams: JsonObject? = null
      val controller =
        WearProxyController(
          requestGateway = { method, params ->
            requestedMethod = method
            requestedParams = params
            json.parseToJsonElement(
              """{"sessions":[{"key":"agent:main","displayName":"Main","updatedAt":7,"modelProvider":"openai","model":"gpt-test","lastMessage":"hidden"}],"hasMore":true,"totalCount":9}""",
            )
          },
          isGatewayConnected = { true },
          gatewayStatusText = { "Connected" },
          activeAgentId = { "main" },
        )

      val response =
        controller.handle(
          request(
            WearRpcMethod.SessionsList,
            buildJsonObject { put("limit", 5) },
          ),
        )

      assertEquals("sessions.list", requestedMethod)
      assertEquals(
        json
          .parseToJsonElement("""{"limit":5,"includeGlobal":false,"includeUnknown":false,"agentId":"main"}""")
          .jsonObject,
        requestedParams,
      )
      val result = checkNotNull(response.result).jsonObject
      val session =
        result
          .getValue("sessions")
          .jsonArray
          .single()
          .jsonObject
      assertEquals(setOf("key", "agentId", "displayName", "updatedAt", "modelRef"), session.keys)
      assertEquals("openai/gpt-test", session.getValue("modelRef").jsonPrimitive.content)
      assertEquals("main", result.getValue("activeAgentId").jsonPrimitive.content)
      assertEquals(
        true,
        result
          .getValue("hasMore")
          .jsonPrimitive
          .content
          .toBoolean(),
      )
    }

  @Test
  fun sessionsListValidatesSelectedSessionOutsideBoundedPage() =
    runTest {
      val requestedMethods = mutableListOf<String>()
      val requestedParams = mutableListOf<JsonObject>()
      val controller =
        WearProxyController(
          requestGateway = { method, params ->
            requestedMethods += method
            requestedParams += params
            if (method == "sessions.resolve") {
              json.parseToJsonElement("""{"ok":true,"key":"agent:main:watch-selected"}""")
            } else {
              assertEquals("sessions.list", method)
              json.parseToJsonElement(
                """{"sessions":[{"key":"agent:main:recent","displayName":"Recent"}],"hasMore":true}""",
              )
            }
          },
          isGatewayConnected = { true },
          gatewayStatusText = { "Connected" },
          activeAgentId = { "main" },
        )

      val response =
        controller.handle(
          request(
            WearRpcMethod.SessionsList,
            buildJsonObject {
              put("limit", 5)
              put("selectedSessionKey", "agent:main:watch-selected")
            },
          ),
        )

      assertTrue(response.ok)
      assertEquals(
        listOf("agent:main:recent"),
        checkNotNull(response.result)
          .jsonObject
          .getValue("sessions")
          .jsonArray
          .map {
            it.jsonObject
              .getValue("key")
              .jsonPrimitive.content
          },
      )
      assertEquals(listOf("sessions.list", "sessions.resolve"), requestedMethods)
      assertEquals("agent:main:watch-selected", requestedParams[1].getValue("key").jsonPrimitive.content)
      assertEquals("main", requestedParams[1].getValue("agentId").jsonPrimitive.content)
      assertTrue(
        checkNotNull(response.result)
          .jsonObject
          .getValue("selectedSessionValid")
          .jsonPrimitive.content
          .toBoolean(),
      )
    }

  @Test
  fun historyBoundsGatewayRequestAndDropsBinaryContent() =
    runTest {
      var requestedParams: JsonObject? = null
      val controller =
        controller { method, params ->
          assertEquals("chat.history", method)
          requestedParams = params
          json.parseToJsonElement(
            """{"sessionKey":"main","messages":[{"id":"m1","role":"assistant","content":[{"type":"text","text":"hello 😀"},{"type":"image","base64":"private"}],"timestamp":9}],"sessionInfo":{"model":"${"m".repeat(201)}"},"defaults":{"token":"hidden"},"offset":40,"nextOffset":60,"totalMessages":80,"hasMore":true}""",
          )
        }

      val response =
        controller.handle(
          request(
            WearRpcMethod.ChatHistory,
            buildJsonObject {
              put("sessionKey", "main")
              put("limit", 20)
              put("maxChars", 2_000)
              put("offset", 40)
            },
          ),
        )

      assertEquals(
        json
          .parseToJsonElement("""{"sessionKey":"main","limit":20,"maxChars":2000,"offset":40}""")
          .jsonObject,
        requestedParams,
      )
      val result = checkNotNull(response.result).jsonObject
      assertFalse("defaults" in result)
      assertFalse("selectedModelRef" in result)
      assertEquals(
        40,
        result
          .getValue("offset")
          .jsonPrimitive
          .content
          .toInt(),
      )
      assertEquals(
        60,
        result
          .getValue("nextOffset")
          .jsonPrimitive
          .content
          .toInt(),
      )
      assertEquals(
        80,
        result
          .getValue("totalMessages")
          .jsonPrimitive
          .content
          .toInt(),
      )
      assertTrue(
        result
          .getValue("hasMore")
          .jsonPrimitive
          .content
          .toBoolean(),
      )
      val content =
        result
          .getValue("messages")
          .jsonArray
          .single()
          .jsonObject
          .getValue("content")
          .jsonArray
      assertEquals(1, content.size)
      assertEquals(
        "hello 😀",
        content
          .single()
          .jsonObject
          .getValue("text")
          .jsonPrimitive
          .content,
      )
      assertTrue(WearProtocolCodec.encode(response).isNotEmpty())
    }

  @Test
  fun sendForwardsOnlyApprovedFields() =
    runTest {
      var requestedParams: JsonObject? = null
      val controller =
        controller { method, params ->
          assertEquals("chat.send", method)
          requestedParams = params
          json.parseToJsonElement("""{"runId":"run-1","status":"started","internal":true}""")
        }

      val response =
        controller.handle(
          request(
            WearRpcMethod.ChatSend,
            buildJsonObject {
              put("sessionKey", "main")
              put("message", "reply")
              put("idempotencyKey", "wear-1")
            },
          ),
        )

      assertEquals(
        json
          .parseToJsonElement(
            """{"sessionKey":"main","message":"reply","idempotencyKey":"wear-1","deliver":false}""",
          ).jsonObject,
        requestedParams,
      )
      assertEquals(setOf("runId", "status"), checkNotNull(response.result).jsonObject.keys)
    }

  @Test
  fun rejectsUnknownOrOversizedWatchFieldsBeforeGateway() =
    runTest {
      var gatewayCalls = 0
      val controller =
        controller { _, _ ->
          gatewayCalls += 1
          buildJsonObject {}
        }
      val unknownField =
        controller.handle(
          request(
            WearRpcMethod.ChatSend,
            buildJsonObject {
              put("sessionKey", "main")
              put("message", "reply")
              put("idempotencyKey", "wear-1")
              put("attachments", "not allowed")
            },
          ),
        )
      val oversized =
        controller.handle(
          request(
            WearRpcMethod.ChatSend,
            buildJsonObject {
              put("sessionKey", "main")
              put("message", "x".repeat(4_001))
              put("idempotencyKey", "wear-2")
            },
          ),
        )

      assertEquals(0, gatewayCalls)
      assertEquals("invalid_request", unknownField.error?.code)
      assertEquals("invalid_request", oversized.error?.code)
    }

  @Test
  fun preservesBoundedGatewayError() =
    runTest {
      val controller =
        controller { _, _ -> throw WearProxyGatewayException("INVALID_REQUEST", "session unavailable") }

      val response =
        controller.handle(
          request(
            WearRpcMethod.ChatAbort,
            buildJsonObject { put("sessionKey", "main") },
          ),
        )

      assertFalse(response.ok)
      assertEquals("INVALID_REQUEST", response.error?.code)
      assertEquals("session unavailable", response.error?.message)
      assertNotNull(WearProtocolCodec.encode(response))
    }

  @Test
  fun chatEventPreservesReplacementSemantics() {
    val payload =
      checkNotNull(
        projectWearChatEvent(
          json.parseToJsonElement(
            """{"runId":"run-1","state":"delta","deltaText":"replacement","replace":true,"privateField":"drop"}""",
          ),
        ),
      )

    assertEquals(setOf("runId", "state", "deltaText", "replace"), payload.keys)
    assertTrue(
      payload
        .getValue("replace")
        .jsonPrimitive
        .content
        .toBoolean(),
    )
  }

  @Test
  fun chatEventBoundsAggregateContentAndPreservesTerminalState() {
    val payload =
      checkNotNull(
        projectWearChatEvent(
          buildJsonObject {
            put("runId", "run-1")
            put("state", "final")
            put(
              "message",
              buildJsonObject {
                put("role", "assistant")
                put(
                  "content",
                  buildJsonArray {
                    repeat(100) {
                      add(
                        buildJsonObject {
                          put("type", "text")
                          put("text", "😀".repeat(2_000))
                        },
                      )
                    }
                  },
                )
              },
            )
          },
        ),
      )

    assertEquals("final", payload.getValue("state").jsonPrimitive.content)
    val content =
      payload
        .getValue("message")
        .jsonObject
        .getValue("content")
        .jsonArray
    val projectedBytes =
      content.sumOf { part ->
        part.jsonObject
          .getValue("text")
          .jsonPrimitive.content
          .toByteArray(Charsets.UTF_8)
          .size
      }
    assertTrue(projectedBytes <= 1_024)
    assertTrue(content.size < 100)
    assertTrue(
      WearProtocolCodec
        .encode(
          WearMessage.Event(
            sequence = 1,
            event = WearEventType.Chat,
            payload = payload,
          ),
        ).isNotEmpty(),
    )
  }

  private fun controller(requestGateway: suspend (String, JsonObject) -> JsonElement): WearProxyController =
    WearProxyController(
      requestGateway = requestGateway,
      isGatewayConnected = { true },
      gatewayStatusText = { "Connected" },
    )

  private fun request(
    method: WearRpcMethod,
    params: JsonObject = buildJsonObject {},
  ): WearMessage.Request = WearMessage.Request(requestId = "req-1", method = method, params = params)
}
