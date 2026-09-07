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
  fun agentPulseRequiresNegotiatedCapabilityBeforeSendingItsRpc() =
    runTest {
      val requester = RecordingRequester { method, _ -> error("unexpected $method") }
      val repository = WearGatewayRepository(requester)

      val failure =
        runCatching {
          repository.agentPulse(
            expectedNodeId = "phone-a",
            capabilities = emptySet(),
            selectedSessionKey = "agent:main",
          )
        }.exceptionOrNull()

      assertEquals("unsupported_peer", (failure as? WearProxyException)?.code)
      assertTrue(requester.calls.isEmpty())
    }

  @Test
  fun agentPulseParsesOnlyAggregateCountsAndRequiresThePreferredPhone() =
    runTest {
      val requester =
        RecordingRequester { method, _ ->
          assertEquals(WearRpcMethod.AgentPulse, method)
          json.parseToJsonElement(
            """{"tasks":{"state":"ready","scope":"bounded","queued":2,"running":3,"completed":5,"failed":1,"activeAtLimit":false,"recentAtLimit":true},"swarm":{"state":"active","scope":"selected-session","groups":2,"running":4,"done":6,"failed":1,"phases":[{"queued":1,"running":2,"done":3,"failed":0,"hidden":4}],"morePhases":false},"approvals":{"state":"ready","pending":2}}""",
          )
        }
      val repository = WearGatewayRepository(requester)

      val pulse =
        repository.agentPulse(
          expectedNodeId = "phone-a",
          capabilities = setOf(WearProxyCapability.AgentPulse),
          selectedSessionKey = "agent:main",
        )

      assertEquals(WearAgentPulseTaskState.Ready, pulse.tasks.state)
      assertEquals(2, pulse.tasks.queued)
      assertEquals(3, pulse.tasks.running)
      assertEquals(5, pulse.tasks.completed)
      assertEquals(1, pulse.tasks.failed)
      assertEquals(false, pulse.tasks.activeAtLimit)
      assertEquals(true, pulse.tasks.recentAtLimit)
      assertEquals(WearAgentPulseSwarmState.Active, pulse.swarm.state)
      assertEquals(2, pulse.swarm.groups)
      assertEquals(4, pulse.swarm.running)
      assertEquals(6, pulse.swarm.done)
      assertEquals(1, pulse.swarm.failed)
      assertEquals(WearAgentPulsePhase(1, 2, 3, 0, 4), pulse.swarm.phases.single())
      assertEquals(false, pulse.swarm.morePhases)
      assertEquals(WearAgentPulseApprovalsState.Ready, pulse.approvals.state)
      assertEquals(2, pulse.approvals.pending)
      assertEquals(7L, pulse.eventSequence)
      assertEquals("phone-a", pulse.phoneNodeId)
      assertEquals(
        json.parseToJsonElement("""{"sessionKey":"agent:main"}""").jsonObject,
        requester.calls.single().second,
      )
      assertEquals("phone-a", requester.expectedNodeIds.single())
      assertTrue(requester.requirePreferredNodes.single())
    }

  @Test
  fun agentPulseKeepsUnavailableIdleAndRefreshingDistinctWithoutInventingZeroes() =
    runTest {
      val requester =
        RecordingRequester { _, _ ->
          json.parseToJsonElement(
            """{"tasks":{"state":"unavailable"},"swarm":{"state":"idle","scope":"selected-session"},"approvals":{"state":"refreshing"}}""",
          )
        }

      val pulse =
        WearGatewayRepository(requester).agentPulse(
          expectedNodeId = "phone-a",
          capabilities = setOf(WearProxyCapability.AgentPulse),
          selectedSessionKey = " ",
        )

      assertEquals(WearAgentPulseTaskState.Unavailable, pulse.tasks.state)
      assertNull(pulse.tasks.running)
      assertEquals(WearAgentPulseSwarmState.Idle, pulse.swarm.state)
      assertNull(pulse.swarm.groups)
      assertEquals(WearAgentPulseApprovalsState.Refreshing, pulse.approvals.state)
      assertNull(pulse.approvals.pending)
      assertTrue(
        requester.calls
          .single()
          .second
          .isEmpty(),
      )
    }

  @Test
  fun agentPulseRejectsUnknownStatesNegativeCountsAndOversizedPhaseLists() =
    runTest {
      val invalidPayloads =
        listOf(
          """{"tasks":{"state":"future"},"swarm":{"state":"unavailable"},"approvals":{"state":"unavailable"}}""",
          """{"tasks":{"state":"ready","scope":"bounded","queued":-1,"running":0,"completed":0,"failed":0,"activeAtLimit":false,"recentAtLimit":false},"swarm":{"state":"unavailable"},"approvals":{"state":"unavailable"}}""",
          """{"tasks":{"state":"unavailable"},"swarm":{"state":"active","scope":"selected-session","groups":1,"running":0,"done":0,"failed":0,"phases":[{"queued":0,"running":0,"done":0,"failed":0,"hidden":-1}],"morePhases":false},"approvals":{"state":"unavailable"}}""",
          """{"tasks":{"state":"unavailable"},"swarm":{"state":"unavailable"},"approvals":{"state":"ready","pending":-1}}""",
          """{"tasks":{"state":"unavailable"},"swarm":{"state":"active","scope":"selected-session","groups":1,"running":0,"done":0,"failed":0,"phases":[{},{},{},{},{},{},{},{},{}],"morePhases":true},"approvals":{"state":"unavailable"}}""",
        )

      invalidPayloads.forEach { payload ->
        val requester = RecordingRequester { _, _ -> json.parseToJsonElement(payload) }
        val failure =
          runCatching {
            WearGatewayRepository(requester).agentPulse(
              expectedNodeId = "phone-a",
              capabilities = setOf(WearProxyCapability.AgentPulse),
            )
          }.exceptionOrNull()

        assertEquals("invalid_response", (failure as? WearProxyException)?.code)
      }
    }

  @Test
  fun sessionsAndHistoryParseOnlyProjectedContract() =
    runTest {
      val requester =
        RecordingRequester { method, _ ->
          when (method) {
            WearRpcMethod.SessionsList -> {
              json.parseToJsonElement(
                """{"sessions":[{"key":"agent:main","agentId":"main","displayName":"Main","updatedAt":7,"hasActiveRun":true,"modelRef":"openai/gpt-test"}],"activeAgentId":"main","selectedSessionValid":true,"hasMore":true,"nextOffset":35}""",
              )
            }

            WearRpcMethod.ChatHistory -> {
              json.parseToJsonElement(
                """{"sessionKey":"agent:main","selectedModelRef":"openai/gpt-test","messages":[{"id":"m1","role":"assistant","content":[{"type":"text","text":"hello 😀"}],"timestamp":9}],"inFlightRun":{"runId":"run-1","text":"working"}}""",
              )
            }

            else -> {
              error("unexpected $method")
            }
          }
        }
      val repository = WearGatewayRepository(requester)

      val sessions =
        repository.sessions(
          selectedSessionKey = "agent:main",
          offset = 5,
          search = "older",
          capabilities =
            setOf(
              WearProxyCapability.SessionSelectionLookup,
              WearProxyCapability.SessionSearchPagination,
            ),
        )
      val history = repository.history("agent:main", sessions.phoneNodeId)

      assertEquals("Main", sessions.sessions.single().title)
      assertTrue(sessions.sessions.single().hasActiveRun)
      assertEquals(7L, sessions.eventSequence)
      assertEquals("phone", sessions.phoneNodeId)
      assertEquals("phone", sessions.sessions.single().phoneNodeId)
      assertEquals("main", sessions.sessions.single().agentId)
      assertEquals("openai/gpt-test", sessions.sessions.single().modelRef)
      assertEquals("main", sessions.activeAgentId)
      assertTrue(sessions.selectedSessionValid)
      assertEquals("hello 😀", history.messages.single().text)
      assertEquals("run-1", history.activeRunId)
      assertEquals("working", history.activeText)
      assertEquals("openai/gpt-test", history.selectedModelRef)
      assertEquals(7L, history.eventSequence)
      assertTrue(sessions.hasMore)
      assertEquals(35, sessions.nextOffset)
      assertEquals(setOf("limit", "offset", "search", "selectedSessionKey"), requester.calls[0].second.keys)
      assertEquals(setOf("sessionKey", "limit", "maxChars"), requester.calls[1].second.keys)
    }

  @Test
  fun agentsAndGatewayControlsRequireThePreferredPhone() =
    runTest {
      val capabilities = WearProxyCapability.entries.toSet()
      val requester =
        RecordingRequester { method, _ ->
          when (method) {
            WearRpcMethod.AgentsList -> {
              json.parseToJsonElement(
                """{"agents":[{"id":"main","name":"Main","emoji":"*","selected":true}]}""",
              )
            }

            WearRpcMethod.AgentsSelect -> {
              JsonObject(emptyMap())
            }

            WearRpcMethod.GatewayDisconnect -> {
              json.parseToJsonElement(
                """{"connected":false,"status":"Offline","activeAgentId":"main","selectedModelRef":"openai/gpt-test","capabilities":["agent-controls","gateway-controls","model-controls","model-catalog-search","session-selection-lookup","session-search-pagination","agent-pulse","attempt-scoped-realtime-audio"]}""",
              )
            }

            else -> {
              error("unexpected $method")
            }
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
      assertFalse(status.connected)
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
      val modelsFailure = runCatching { repository.models(status.phoneNodeId, status.capabilities) }.exceptionOrNull()

      assertTrue(status.capabilities.isEmpty())
      assertEquals("unsupported_peer", (agentsFailure as? WearProxyException)?.code)
      assertEquals("unsupported_peer", (gatewayFailure as? WearProxyException)?.code)
      assertEquals("unsupported_peer", (modelsFailure as? WearProxyException)?.code)
      assertEquals(listOf(WearRpcMethod.ProxyStatus), requester.calls.map(Pair<WearRpcMethod, JsonObject>::first))
    }

  @Test
  fun newPhoneStatusNegotiatesKnownCapabilitiesAndIgnoresFutureOnes() =
    runTest {
      val requester =
        RecordingRequester { _, _ ->
          json.parseToJsonElement(
            """{"connected":true,"status":"Connected","capabilities":["agent-controls","future-capability","gateway-controls","model-controls","model-catalog-search","session-selection-lookup","session-search-pagination","agent-pulse","attempt-scoped-realtime-audio"]}""",
          )
        }

      val status = WearGatewayRepository(requester).status()

      assertEquals(WearProxyCapability.entries.toSet(), status.capabilities)
    }

  @Test
  fun modelSelectionKeepsTheSelectedSessionAndUsesThePreferredPhone() =
    runTest {
      val capabilities =
        setOf(WearProxyCapability.ModelControls, WearProxyCapability.ModelCatalogSearch)
      val requester =
        RecordingRequester { method, params ->
          when (method) {
            WearRpcMethod.ModelsList -> {
              assertEquals("openai/gpt-a", params.getValue("selectedModelRef").jsonPrimitive.content)
              assertEquals("anthropic", params.getValue("query").jsonPrimitive.content)
              json.parseToJsonElement(
                """{"models":[{"ref":"openai/gpt-a","name":"GPT A"},{"ref":"openai/gpt-b","name":"GPT B"}]}""",
              )
            }

            WearRpcMethod.ModelsSelect -> {
              assertEquals("agent:main:thread-7", params.getValue("sessionKey").jsonPrimitive.content)
              assertEquals("openai/gpt-b", params.getValue("modelRef").jsonPrimitive.content)
              json.parseToJsonElement(
                """{"sessionKey":"agent:main:thread-7","selectedModelRef":"openai/gpt-b"}""",
              )
            }

            else -> {
              error("unexpected $method")
            }
          }
        }
      val repository = WearGatewayRepository(requester)

      val models =
        repository.models(
          "phone-a",
          capabilities,
          selectedModelRef = "openai/gpt-a",
          query = "anthropic",
        )
      val selected =
        repository.selectModel(
          sessionKey = "agent:main:thread-7",
          modelRef = "openai/gpt-b",
          phoneNodeId = "phone-a",
          capabilities = capabilities,
        )

      assertEquals(listOf("openai/gpt-a", "openai/gpt-b"), models.models.map(WearModel::ref))
      assertEquals("openai/gpt-b", selected.selectedModelRef)
      assertEquals(7L, selected.eventSequence)
      assertEquals("phone-a", selected.phoneNodeId)
      assertEquals(listOf(WearRpcMethod.ModelsList, WearRpcMethod.ModelsSelect), requester.calls.map { it.first })
      assertTrue(requester.expectedNodeIds.all { it == "phone-a" })
      assertTrue(requester.requirePreferredNodes.all { it })
    }

  @Test
  fun oldPhoneCapabilitiesDoNotReceivePickerSearchFields() =
    runTest {
      val requester =
        RecordingRequester { method, params ->
          when (method) {
            WearRpcMethod.ModelsList -> {
              assertEquals(setOf("selectedModelRef"), params.keys)
              json.parseToJsonElement("""{"models":[]}""")
            }

            WearRpcMethod.SessionsList -> {
              assertEquals(setOf("limit", "selectedSessionKey"), params.keys)
              json.parseToJsonElement("""{"sessions":[]}""")
            }

            else -> {
              error("unexpected $method")
            }
          }
        }
      val repository = WearGatewayRepository(requester)

      repository.models(
        expectedNodeId = "phone-a",
        capabilities = setOf(WearProxyCapability.ModelControls),
        selectedModelRef = "openai/gpt-a",
        query = "anthropic",
      )
      repository.sessions(
        expectedNodeId = "phone-a",
        selectedSessionKey = "agent:main",
        capabilities = setOf(WearProxyCapability.SessionSelectionLookup),
        offset = 50,
        search = "older",
      )
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
          attemptScopedAudio = true,
        )

      assertTrue(snapshot.active)
      assertEquals(
        json
          .parseToJsonElement(
            """{"sessionKey":"agent:main:thread-7","attemptId":"attempt-7","language":"de","attemptScopedAudio":true}""",
          ).jsonObject,
        requester.calls.single().second,
      )
      assertEquals("phone-a", requester.expectedNodeIds.single())
      assertTrue(requester.requirePreferredNodes.single())
    }

  @Test
  fun realtimeTalkStartOmitsAttemptScopedAudioForLegacyPhones() =
    runTest {
      val requester =
        RecordingRequester { _, _ ->
          json.parseToJsonElement("""{"active":true}""")
        }

      WearGatewayRepository(requester).startRealtimeTalk(
        sessionKey = "agent:main:thread-7",
        attemptId = "attempt-7",
        language = null,
        phoneNodeId = "phone-a",
        attemptScopedAudio = false,
      )

      assertEquals(
        json
          .parseToJsonElement(
            """{"sessionKey":"agent:main:thread-7","attemptId":"attempt-7"}""",
          ).jsonObject,
        requester.calls.single().second,
      )
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
