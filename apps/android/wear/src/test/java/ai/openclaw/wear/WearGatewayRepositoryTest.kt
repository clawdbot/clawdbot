package ai.openclaw.wear

import ai.openclaw.wear.shared.WearProxyCapability
import ai.openclaw.wear.shared.WearRealtimeTalkSnapshot
import ai.openclaw.wear.shared.WearRpcMethod
import kotlinx.coroutines.test.runTest
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class WearGatewayRepositoryTest {
  private val json = Json

  @Test
  fun talkEventsMatchOnlyTheirCurrentAttempt() {
    val current = WearRealtimeTalkSnapshot(attemptId = "attempt-current", active = true)
    val stale = WearRealtimeTalkSnapshot(attemptId = "attempt-stale")

    assertTrue(shouldAcceptWearTalkSnapshot(current, "attempt-current"))
    assertFalse(shouldAcceptWearTalkSnapshot(stale, "attempt-current"))
    assertFalse(shouldAcceptWearTalkSnapshot(WearRealtimeTalkSnapshot(), "attempt-current"))
  }

  @Test
  fun sessionsAndHistoryParseOnlyProjectedContract() =
    runTest {
      val requester =
        RecordingRequester { method, _ ->
          when (method) {
            WearRpcMethod.SessionsList ->
              json.parseToJsonElement(
                """{"sessions":[{"key":"agent:main","agentId":"main","displayName":"Main","updatedAt":7,"hasActiveRun":true}],"activeAgentId":"main","selectedSessionValid":true}""",
              )
            WearRpcMethod.ChatHistory ->
              json.parseToJsonElement(
                """{"sessionKey":"agent:main","messages":[{"id":"m1","role":"assistant","content":[{"type":"text","text":"hello 😀"}],"timestamp":9}],"inFlightRun":{"runId":"run-1","text":"working"}}""",
              )
            else -> error("unexpected $method")
          }
        }
      val repository = WearGatewayRepository(requester)

      val sessions =
        repository.sessions(
          selectedSessionKey = "agent:main",
          capabilities = setOf(WearProxyCapability.SessionSelectionLookup),
        )
      val history = repository.history("agent:main", sessions.phoneNodeId)

      assertEquals("Main", sessions.sessions.single().title)
      assertTrue(sessions.sessions.single().hasActiveRun)
      assertEquals(7L, sessions.eventSequence)
      assertEquals("phone", sessions.phoneNodeId)
      assertEquals("phone", sessions.sessions.single().phoneNodeId)
      assertEquals("main", sessions.sessions.single().agentId)
      assertEquals("main", sessions.activeAgentId)
      assertTrue(sessions.selectedSessionValid)
      assertEquals("hello 😀", history.messages.single().text)
      assertEquals("run-1", history.activeRunId)
      assertEquals("working", history.activeText)
      assertEquals(7L, history.eventSequence)
      assertEquals(setOf("limit", "selectedSessionKey"), requester.calls[0].second.keys)
      assertEquals(setOf("sessionKey", "limit", "maxChars"), requester.calls[1].second.keys)
    }

  @Test
  fun agentsAndGatewayControlsRequireThePreferredPhone() =
    runTest {
      val capabilities = WearProxyCapability.entries.toSet()
      val requester =
        RecordingRequester { method, _ ->
          when (method) {
            WearRpcMethod.AgentsList ->
              json.parseToJsonElement(
                """{"agents":[{"id":"main","name":"Main","emoji":"*","selected":true}]}""",
              )
            WearRpcMethod.AgentsSelect -> JsonObject(emptyMap())
            WearRpcMethod.GatewayDisconnect ->
              json.parseToJsonElement(
                """{"connected":false,"status":"Offline","activeAgentId":"main","selectedModelRef":"openai/gpt-test","capabilities":["agent-controls","gateway-controls","session-selection-lookup"]}""",
              )
            else -> error("unexpected $method")
          }
        }
      val repository = WearGatewayRepository(requester)

      val agents = repository.agents("phone-a", capabilities)
      repository.selectAgent("main", "phone-a", capabilities)
      val status =
        repository.setGatewayEnabled(
          enabled = false,
          phoneNodeId = "phone-a",
          capabilities = capabilities,
        )

      assertEquals("Main", agents.agents.single().name)
      assertTrue(agents.agents.single().selected)
      assertEquals("Offline", status.detail)
      assertEquals("main", status.activeAgentId)
      assertEquals("openai/gpt-test", status.selectedModelRef)
      assertEquals(capabilities, status.capabilities)
      assertEquals(
        listOf(WearRpcMethod.AgentsList, WearRpcMethod.AgentsSelect, WearRpcMethod.GatewayDisconnect),
        requester.calls.map(Pair<WearRpcMethod, JsonObject>::first),
      )
      assertEquals(setOf("agentId"), requester.calls[1].second.keys)
      assertTrue(requester.expectedNodeIds.all { it == "phone-a" })
      assertTrue(requester.requirePreferredNodes.all { it })
    }

  @Test
  fun oldPhoneStatusBlocksUnsupportedControlsBeforeSendingTheirRpc() =
    runTest {
      val requester =
        RecordingRequester { method, _ ->
          assertEquals(WearRpcMethod.ProxyStatus, method)
          json.parseToJsonElement(
            """{"connected":true,"status":"Connected","activeSessionKey":"agent:main"}""",
          )
        }
      val repository = WearGatewayRepository(requester)

      val status = repository.status()
      val agentsFailure = runCatching { repository.agents(status.phoneNodeId, status.capabilities) }.exceptionOrNull()
      val gatewayFailure =
        runCatching {
          repository.setGatewayEnabled(
            enabled = false,
            phoneNodeId = status.phoneNodeId,
            capabilities = status.capabilities,
          )
        }.exceptionOrNull()

      assertTrue(status.capabilities.isEmpty())
      assertEquals("unsupported_peer", (agentsFailure as? WearProxyException)?.code)
      assertEquals("unsupported_peer", (gatewayFailure as? WearProxyException)?.code)
      assertEquals(listOf(WearRpcMethod.ProxyStatus), requester.calls.map(Pair<WearRpcMethod, JsonObject>::first))
    }

  @Test
  fun newPhoneStatusNegotiatesKnownCapabilitiesAndIgnoresFutureOnes() =
    runTest {
      val requester =
        RecordingRequester { _, _ ->
          json.parseToJsonElement(
            """{"connected":true,"status":"Connected","capabilities":["agent-controls","future-capability","gateway-controls","session-selection-lookup"]}""",
          )
        }

      val status = WearGatewayRepository(requester).status()

      assertEquals(WearProxyCapability.entries.toSet(), status.capabilities)
    }

  @Test
  fun chatEventPreservesReplaceAndTextOnlyMessage() {
    val event =
      parseWearChatEvent(
        json.parseToJsonElement(
          """{"sessionKey":"main","runId":"run-1","state":"delta","deltaText":"new","replace":true,"streamText":"done","streamTextComplete":true,"message":{"role":"assistant","content":"done"}}""",
        ),
      )

    assertEquals("main", event?.sessionKey)
    assertEquals("new", event?.deltaText)
    assertTrue(event?.replace == true)
    assertEquals("done", event?.streamText)
    assertTrue(event?.streamTextComplete == true)
    assertEquals("done", event?.message?.text)
  }

  @Test
  fun nonTextOrEmptyMessagesAreDropped() {
    val binaryOnly =
      parseChatMessage(
        json.parseToJsonElement(
          """{"role":"assistant","content":[{"type":"image"}]}""",
        ),
      )

    assertNull(binaryOnly)
  }

  @Test
  fun ambiguousSendRetryReusesItsIdempotencyKeyUntilSuccess() =
    runTest {
      val generatedIds = ArrayDeque(listOf("first", "second"))
      val tracker = WearSendAttemptTracker(newId = { generatedIds.removeFirst() })
      val first = tracker.begin("session-1", "hello", "phone-1")
      tracker.markAmbiguous(first)
      val retry = tracker.begin("session-1", "hello", "phone-1")

      assertEquals(first, retry)

      val requester = RecordingRequester { _, _ -> JsonObject(emptyMap()) }
      WearGatewayRepository(requester).send(retry)
      assertEquals(
        "wear-first",
        requester.calls
          .single()
          .second
          .getValue("idempotencyKey")
          .jsonPrimitive
          .content,
      )

      tracker.markSucceeded(retry)
      assertEquals("wear-second", tracker.begin("session-1", "hello", "phone-1").idempotencyKey)
    }

  @Test
  fun differentMessageExpiresAnAbandonedAmbiguousAttempt() {
    val generatedIds = ArrayDeque(listOf("first", "second", "third"))
    val tracker = WearSendAttemptTracker(newId = { generatedIds.removeFirst() })
    val abandoned = tracker.begin("session-1", "hello", "phone-1")
    tracker.markAmbiguous(abandoned)

    val different = tracker.begin("session-1", "different", "phone-1")
    tracker.markSucceeded(different)
    val laterHello = tracker.begin("session-1", "hello", "phone-1")

    assertEquals("wear-second", different.idempotencyKey)
    assertEquals("wear-third", laterHello.idempotencyKey)
  }

  @Test
  fun realtimeTalkStartCarriesTheSelectedSessionAndPhone() =
    runTest {
      val requester =
        RecordingRequester { method, _ ->
          assertEquals(WearRpcMethod.TalkStart, method)
          json.parseToJsonElement("""{"active":true}""")
        }

      val snapshot =
        WearGatewayRepository(requester).startRealtimeTalk(
          sessionKey = "agent:main:thread-7",
          attemptId = "attempt-7",
          language = "de",
          phoneNodeId = "phone-a",
        )

      assertTrue(snapshot.active)
      assertEquals(
        json
          .parseToJsonElement(
            """{"sessionKey":"agent:main:thread-7","attemptId":"attempt-7","language":"de"}""",
          ).jsonObject,
        requester.calls.single().second,
      )
      assertEquals("phone-a", requester.expectedNodeIds.single())
      assertTrue(requester.requirePreferredNodes.single())
    }

  @Test
  fun observedFinalMessageSurvivesAnOlderSnapshotWithoutDuplication() {
    val older = WearChatMessage(id = "m1", role = "assistant", text = "older", timestamp = 1)
    val final = WearChatMessage(id = "m2", role = "assistant", text = "done", timestamp = 2)

    val merged = mergeEventMessage(listOf(older), final)
    val deduplicated = mergeEventMessage(merged, final.copy(text = "done!"))

    assertEquals(listOf(older, final.copy(text = "done!")), deduplicated)
  }

  @Test
  fun eventMergeReplacesIdentifiedRowsInPlaceAndPreservesUnknownDuplicates() {
    val identified = WearChatMessage(id = "m1", role = "assistant", text = "old", timestamp = 1)
    val newer = WearChatMessage(id = "m2", role = "user", text = "later", timestamp = 2)
    val unknown = WearChatMessage(id = null, role = "assistant", text = "same", timestamp = null)

    val replaced = mergeEventMessage(listOf(identified, newer), identified.copy(text = "updated"))
    val duplicates = mergeEventMessage(listOf(unknown), unknown)

    assertEquals(listOf(identified.copy(text = "updated"), newer), replaced)
    assertEquals(listOf(unknown, unknown), duplicates)
  }

  @Test
  fun canonicalSnapshotDeduplicatesItsIdentityLessObservedFinal() {
    val canonical = WearChatMessage(id = "m1", role = "assistant", text = "done", timestamp = 7)
    val observed = WearChatMessage(id = null, role = "assistant", text = "done", timestamp = null)

    assertEquals(listOf(canonical), mergeObservedMessageIntoSnapshot(listOf(canonical), observed))
  }

  @Test
  fun canonicalSnapshotDeduplicatesObservedFinalThatOnlyHasTimestamp() {
    val canonical = WearChatMessage(id = "m1", role = "assistant", text = "done", timestamp = 7)
    val observed = WearChatMessage(id = null, role = "assistant", text = "done", timestamp = 7)
    val other = observed.copy(timestamp = 8)

    assertEquals(listOf(canonical), mergeObservedMessageIntoSnapshot(listOf(canonical), observed))
    assertEquals(listOf(canonical, other), mergeObservedMessageIntoSnapshot(listOf(canonical), other))
  }

  @Test
  fun historyLoadCarriesRacedCanonicalStreamIntoItsSnapshot() {
    val tracker = WearHistoryLoadTracker()
    val token = tracker.start("session-1")

    tracker.observeDelta("other-session", text = "wrong", complete = true, runId = "other")
    tracker.observeDelta("session-1", text = "Hello world", complete = true, runId = "run-1")

    assertTrue(tracker.isCurrent(token))
    assertEquals(
      WearLiveStreamSnapshot(text = "Hello world", complete = true, runId = "run-1"),
      tracker.finish(token).liveStream,
    )
    assertNull(tracker.finish(token).liveStream)
  }

  @Test
  fun stableHistoryLoadCanApplyItsCanonicalSnapshot() {
    val tracker = WearHistoryLoadTracker()
    val token = tracker.start("session-1")

    assertNull(tracker.finish(token).liveStream)
  }

  @Test
  fun racedStreamReconcilesCanonicalPrefixWithoutDuplication() {
    assertEquals("Hello world", reconcileWearStreamSnapshot("Hello", "Hello world", liveComplete = true))
    assertEquals("Hello world", reconcileWearStreamSnapshot("Hello world", "Hello", liveComplete = true))
    assertEquals("Hello", reconcileWearStreamSnapshot("Hello", "He", liveComplete = false))
    assertEquals("Hello", reconcileWearStreamSnapshot("Hello", "Hel", liveComplete = false))
    assertEquals("Hello world!", reconcileWearStreamSnapshot("Hello world", " world!", liveComplete = false))
  }

  @Test
  fun liveStreamCapPreservesWholeUnicodeCodePoints() {
    val oversized = "x".repeat(2_000) + "😀"

    val bounded = updateWearStreamText(current = null, delta = oversized, replace = true)

    assertEquals(2_000, bounded?.codePointCount(0, bounded.length))
    assertTrue(bounded?.endsWith("😀") == true)
  }
}

private class RecordingRequester(
  private val handler: suspend (WearRpcMethod, JsonObject) -> JsonElement,
) : WearRpcRequester {
  val calls = mutableListOf<Pair<WearRpcMethod, JsonObject>>()
  val expectedNodeIds = mutableListOf<String?>()
  val requirePreferredNodes = mutableListOf<Boolean>()

  override suspend fun request(
    method: WearRpcMethod,
    params: JsonObject,
    expectedNodeId: String?,
    requirePreferredNode: Boolean,
  ): WearRpcResult {
    calls += method to params
    expectedNodeIds += expectedNodeId
    requirePreferredNodes += requirePreferredNode
    return WearRpcResult(payload = handler(method, params), eventSequence = 7, sourceNodeId = expectedNodeId ?: "phone")
  }
}
