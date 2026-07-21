package ai.openclaw.wear

import ai.openclaw.wear.shared.WearDecodeResult
import ai.openclaw.wear.shared.WearEventType
import ai.openclaw.wear.shared.WearMessage
import ai.openclaw.wear.shared.WearProtocol
import ai.openclaw.wear.shared.WearProtocolCodec
import ai.openclaw.wear.shared.WearProxyCapability
import ai.openclaw.wear.shared.WearRpcMethod
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.TimeoutCancellationException
import kotlinx.coroutines.async
import kotlinx.coroutines.awaitCancellation
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.test.advanceUntilIdle
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.runTest
import kotlinx.coroutines.withTimeout
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

@OptIn(ExperimentalCoroutinesApi::class)
class WearProxyClientTest {
  @Test
  fun requestUsesReachablePhoneAndCorrelatesResponse() =
    runTest {
      lateinit var client: WearProxyClient
      var sentNode: String? = null
      client =
        WearProxyClient.createForTests(
          nodeResolver = WearNodeResolver { "phone-nearby" },
          transport =
            WearMessageTransport { nodeId, path, data ->
              sentNode = nodeId
              assertEquals(WearProtocol.REQUEST_PATH, path)
              val request = (WearProtocolCodec.decode(data) as WearDecodeResult.Success).message as WearMessage.Request
              val response =
                WearProtocolCodec.encode(
                  WearMessage.Response(
                    requestId = request.requestId,
                    ok = true,
                    result = buildJsonObject { put("connected", JsonPrimitive(true)) },
                    eventStreamId = "stream-1",
                    eventSequence = 12,
                  ),
                )
              client.handleMessage(
                sourceNodeId = "phone-nearby",
                path = WearProtocol.RESPONSE_PATH,
                data = response,
              )
            },
        )

      val response = client.request(WearRpcMethod.ProxyStatus, buildJsonObject {}, expectedNodeId = null)

      assertEquals("phone-nearby", sentNode)
      assertTrue(
        response.payload
          .jsonObject
          .getValue("connected")
          .jsonPrimitive
          .content
          .toBoolean(),
      )
      assertEquals(12L, response.eventSequence)
      assertEquals("stream-1", response.eventStreamId)
      assertEquals("phone-nearby", response.sourceNodeId)
    }

  @Test
  fun responseWithoutWatermarkKeepsLegacyBaselineUnknown() =
    runTest {
      lateinit var client: WearProxyClient
      client =
        WearProxyClient.createForTests(
          nodeResolver = WearNodeResolver { "phone-nearby" },
          transport =
            WearMessageTransport { _, _, data ->
              val request = (WearProtocolCodec.decode(data) as WearDecodeResult.Success).message as WearMessage.Request
              val response =
                WearProtocolCodec.encode(
                  WearMessage.Response(
                    requestId = request.requestId,
                    ok = true,
                    result = buildJsonObject { put("connected", JsonPrimitive(true)) },
                  ),
                )
              client.handleMessage(
                sourceNodeId = "phone-nearby",
                path = WearProtocol.RESPONSE_PATH,
                data = response,
              )
            },
        )

      val response = client.request(WearRpcMethod.ProxyStatus, buildJsonObject {}, expectedNodeId = null)

      assertEquals(null, response.eventSequence)

      val tracker = WearEventSequenceTracker()
      tracker.adoptSnapshot(response.eventStreamId, response.eventSequence)
      assertEquals(WearSequenceDecision.Accepted, tracker.accept(null, 37))
      assertEquals(WearSequenceDecision.Accepted, tracker.accept(null, 38))
    }

  @Test
  fun inboundMessagesStayBoundToTheSelectedPhone() =
    runTest {
      var preferredNode = "phone-1"
      lateinit var client: WearProxyClient
      client =
        WearProxyClient.createForTests(
          nodeResolver = WearNodeResolver { preferredNode },
          transport =
            WearMessageTransport { nodeId, _, data ->
              val request = (WearProtocolCodec.decode(data) as WearDecodeResult.Success).message as WearMessage.Request
              val response = WearProtocolCodec.encode(WearMessage.Response(requestId = request.requestId, ok = true))
              client.handleMessage("wrong-phone", WearProtocol.RESPONSE_PATH, response)
              client.handleMessage(nodeId, WearProtocol.RESPONSE_PATH, response)
            },
        )

      client.request(WearRpcMethod.ProxyStatus, buildJsonObject {}, expectedNodeId = null)
      val event = WearProtocolCodec.encode(WearMessage.Event(sequence = 1, event = WearEventType.Connection))

      assertEquals(null, client.handleMessage("phone-2", WearProtocol.EVENT_PATH, event))
      assertEquals("phone-1", client.handleMessage("phone-1", WearProtocol.EVENT_PATH, event)?.sourceNodeId)

      preferredNode = "phone-2"
      client.updatePreferredPhoneNodeId("phone-2")
      assertEquals(null, client.handleMessage("phone-1", WearProtocol.EVENT_PATH, event))
      assertEquals("phone-2", client.handleMessage("phone-2", WearProtocol.EVENT_PATH, event)?.sourceNodeId)
    }

  @Test
  fun snapshotRequestRejectsOldPhoneAfterPreferredPhoneChanges() =
    runTest {
      lateinit var client: WearProxyClient
      lateinit var request: WearMessage.Request
      client =
        WearProxyClient.createForTests(
          nodeResolver = WearNodeResolver { "phone-1" },
          transport =
            WearMessageTransport { _, _, data ->
              request = (WearProtocolCodec.decode(data) as WearDecodeResult.Success).message as WearMessage.Request
            },
        )

      client.updatePreferredPhoneNodeId("phone-1")
      val pending =
        async {
          runCatching {
            client.request(WearRpcMethod.SessionsList, buildJsonObject {}, expectedNodeId = "phone-1")
          }
        }
      runCurrent()
      client.updatePreferredPhoneNodeId("phone-2")
      client.handleMessage(
        sourceNodeId = "phone-1",
        path = WearProtocol.RESPONSE_PATH,
        data = WearProtocolCodec.encode(WearMessage.Response(requestId = request.requestId, ok = true)),
      )

      assertEquals("phone_changed", (pending.await().exceptionOrNull() as WearProxyException).code)
    }

  @Test
  fun statefulRequestStaysOnItsExpectedPhoneWithoutRediscovery() =
    runTest {
      lateinit var client: WearProxyClient
      var discoveries = 0
      var sentNode: String? = null
      client =
        WearProxyClient.createForTests(
          nodeResolver =
            WearNodeResolver {
              discoveries += 1
              "different-phone"
            },
          transport =
            WearMessageTransport { nodeId, _, data ->
              sentNode = nodeId
              val request = (WearProtocolCodec.decode(data) as WearDecodeResult.Success).message as WearMessage.Request
              client.handleMessage(
                sourceNodeId = nodeId,
                path = WearProtocol.RESPONSE_PATH,
                data = WearProtocolCodec.encode(WearMessage.Response(requestId = request.requestId, ok = true)),
              )
            },
        )

      val result = client.request(WearRpcMethod.ChatAbort, buildJsonObject {}, expectedNodeId = "state-phone")

      assertEquals(0, discoveries)
      assertEquals("state-phone", sentNode)
      assertEquals("state-phone", result.sourceNodeId)
    }

  @Test
  fun statefulRequestDoesNotReplaceResolverSelectedEventSource() =
    runTest {
      lateinit var client: WearProxyClient
      client =
        WearProxyClient.createForTests(
          nodeResolver = WearNodeResolver { "preferred-phone" },
          transport =
            WearMessageTransport { nodeId, _, data ->
              val request = (WearProtocolCodec.decode(data) as WearDecodeResult.Success).message as WearMessage.Request
              client.handleMessage(
                sourceNodeId = nodeId,
                path = WearProtocol.RESPONSE_PATH,
                data = WearProtocolCodec.encode(WearMessage.Response(requestId = request.requestId, ok = true)),
              )
            },
        )

      client.request(WearRpcMethod.ProxyStatus, buildJsonObject {}, expectedNodeId = null)
      client.request(WearRpcMethod.ChatAbort, buildJsonObject {}, expectedNodeId = "notification-phone")
      val event = WearProtocolCodec.encode(WearMessage.Event(sequence = 1, event = WearEventType.Connection))

      assertEquals(null, client.handleMessage("notification-phone", WearProtocol.EVENT_PATH, event))
      assertEquals("preferred-phone", client.handleMessage("preferred-phone", WearProtocol.EVENT_PATH, event)?.sourceNodeId)
    }

  @Test
  fun capabilitySelectionRoutesSnapshotsAndRejectsOldStatefulActions() =
    runTest {
      lateinit var client: WearProxyClient
      var discoveries = 0
      val sentNodes = mutableListOf<String>()
      client =
        WearProxyClient.createForTests(
          nodeResolver =
            WearNodeResolver {
              discoveries += 1
              "resolver-phone"
            },
          transport =
            WearMessageTransport { nodeId, _, data ->
              sentNodes += nodeId
              val request = (WearProtocolCodec.decode(data) as WearDecodeResult.Success).message as WearMessage.Request
              client.handleMessage(
                sourceNodeId = nodeId,
                path = WearProtocol.RESPONSE_PATH,
                data = WearProtocolCodec.encode(WearMessage.Response(requestId = request.requestId, ok = true)),
              )
            },
        )
      val changed = async { client.preferredPhoneChanges.first() }
      runCurrent()

      client.updatePreferredPhoneNodeId("phone-2")
      val status = client.request(WearRpcMethod.ProxyStatus, buildJsonObject {}, expectedNodeId = null)
      val stale =
        runCatching {
          client.request(
            WearRpcMethod.ChatAbort,
            buildJsonObject {},
            expectedNodeId = "phone-1",
            requirePreferredNode = true,
          )
        }.exceptionOrNull()

      assertEquals("phone-2", changed.await())
      assertEquals("phone-2", status.sourceNodeId)
      assertEquals("phone_changed", (stale as WearProxyException).code)
      assertEquals(0, discoveries)
      assertEquals(listOf("phone-2"), sentNodes)
    }

  @Test
  fun preferredActionResolvesCapabilityBeforeSendingToStoredPhone() =
    runTest {
      var sends = 0
      val client =
        WearProxyClient.createForTests(
          nodeResolver = WearNodeResolver { "phone-current" },
          transport = WearMessageTransport { _, _, _ -> sends += 1 },
        )

      val stale =
        runCatching {
          client.request(
            WearRpcMethod.ChatSend,
            buildJsonObject {},
            expectedNodeId = "phone-old",
            requirePreferredNode = true,
          )
        }.exceptionOrNull()

      assertEquals("phone_changed", (stale as WearProxyException).code)
      assertEquals(0, sends)
    }

  @Test
  fun missingPhoneFailsWithoutSending() =
    runTest {
      var sends = 0
      val client =
        WearProxyClient.createForTests(
          nodeResolver = WearNodeResolver { null },
          transport = WearMessageTransport { _, _, _ -> sends += 1 },
        )

      var code: String? = null
      try {
        client.request(WearRpcMethod.ProxyStatus, buildJsonObject {}, expectedNodeId = null)
      } catch (err: WearProxyException) {
        code = err.code
      }

      assertEquals("phone_unavailable", code)
      assertEquals(0, sends)
    }

  @Test
  fun discoveryTaskCancellationUsesConnectivityError() =
    runTest {
      val client =
        WearProxyClient.createForTests(
          nodeResolver = WearNodeResolver { throw CancellationException("task canceled") },
          transport = WearMessageTransport { _, _, _ -> error("must not send") },
        )

      val failure = runCatching { client.request(WearRpcMethod.ProxyStatus, buildJsonObject {}, null) }.exceptionOrNull()

      assertEquals("phone_unavailable", (failure as WearProxyException).code)
    }

  @Test
  fun sendTaskCancellationUsesConnectivityError() =
    runTest {
      val client =
        WearProxyClient.createForTests(
          nodeResolver = WearNodeResolver { "phone-nearby" },
          transport = WearMessageTransport { _, _, _ -> throw CancellationException("task canceled") },
        )

      val failure = runCatching { client.request(WearRpcMethod.ProxyStatus, buildJsonObject {}, null) }.exceptionOrNull()

      assertEquals("phone_unavailable", (failure as WearProxyException).code)
    }

  @Test
  fun shorterCallerTimeoutPropagatesWithoutInvalidatingPhone() =
    runTest {
      var discoveries = 0
      var respond = false
      lateinit var client: WearProxyClient
      client =
        WearProxyClient.createForTests(
          nodeResolver =
            WearNodeResolver {
              discoveries += 1
              "resolver-phone"
            },
          transport =
            WearMessageTransport { nodeId, _, data ->
              if (!respond) awaitCancellation()
              val request = (WearProtocolCodec.decode(data) as WearDecodeResult.Success).message as WearMessage.Request
              client.handleMessage(
                sourceNodeId = nodeId,
                path = WearProtocol.RESPONSE_PATH,
                data = WearProtocolCodec.encode(WearMessage.Response(requestId = request.requestId, ok = true)),
              )
            },
        )
      client.updatePreferredPhoneNodeId("phone-current")

      val failure =
        runCatching {
          withTimeout(1_000L) {
            client.request(WearRpcMethod.ProxyStatus, buildJsonObject {}, null)
          }
        }.exceptionOrNull()
      respond = true

      assertTrue(failure is TimeoutCancellationException)
      assertEquals("phone-current", client.request(WearRpcMethod.ProxyStatus, buildJsonObject {}, null).sourceNodeId)
      assertEquals(0, discoveries)
    }

  @Test
  fun sendFailureInvalidatesCachedPhoneAndRediscoversNextRequest() =
    runTest {
      var resolvedNode = "phone-old"
      var discoveries = 0
      var sends = 0
      val sentNodes = mutableListOf<String>()
      lateinit var client: WearProxyClient
      client =
        WearProxyClient.createForTests(
          nodeResolver =
            WearNodeResolver {
              discoveries += 1
              resolvedNode
            },
          transport =
            WearMessageTransport { nodeId, _, data ->
              sends += 1
              sentNodes += nodeId
              if (sends == 1) error("stale node")
              val request = (WearProtocolCodec.decode(data) as WearDecodeResult.Success).message as WearMessage.Request
              client.handleMessage(
                sourceNodeId = nodeId,
                path = WearProtocol.RESPONSE_PATH,
                data = WearProtocolCodec.encode(WearMessage.Response(requestId = request.requestId, ok = true)),
              )
            },
        )

      val first = runCatching { client.request(WearRpcMethod.ProxyStatus, buildJsonObject {}, null) }.exceptionOrNull()
      resolvedNode = "phone-new"
      val second = client.request(WearRpcMethod.ProxyStatus, buildJsonObject {}, null)

      assertEquals("phone_unavailable", (first as WearProxyException).code)
      assertEquals("phone-new", second.sourceNodeId)
      assertEquals(2, discoveries)
      assertEquals(listOf("phone-old", "phone-new"), sentNodes)
    }

  @Test
  fun responseTimeoutInvalidatesCachedPhoneAndRediscoversNextRequest() =
    runTest {
      var resolvedNode = "phone-old"
      var discoveries = 0
      var sends = 0
      lateinit var client: WearProxyClient
      client =
        WearProxyClient.createForTests(
          nodeResolver =
            WearNodeResolver {
              discoveries += 1
              resolvedNode
            },
          transport =
            WearMessageTransport { nodeId, _, data ->
              sends += 1
              if (sends > 1) {
                val request = (WearProtocolCodec.decode(data) as WearDecodeResult.Success).message as WearMessage.Request
                client.handleMessage(
                  sourceNodeId = nodeId,
                  path = WearProtocol.RESPONSE_PATH,
                  data = WearProtocolCodec.encode(WearMessage.Response(requestId = request.requestId, ok = true)),
                )
              }
            },
        )

      val first = runCatching { client.request(WearRpcMethod.ProxyStatus, buildJsonObject {}, null) }.exceptionOrNull()
      resolvedNode = "phone-new"
      val second = client.request(WearRpcMethod.ProxyStatus, buildJsonObject {}, null)

      assertEquals("timeout", (first as WearProxyException).code)
      assertEquals("phone-new", second.sourceNodeId)
      assertEquals(2, discoveries)
    }

  @Test
  fun staleSendFailureDoesNotInvalidateNewerSamePhoneGeneration() =
    runTest {
      var discoveries = 0
      var sends = 0
      lateinit var client: WearProxyClient
      client =
        WearProxyClient.createForTests(
          nodeResolver =
            WearNodeResolver {
              discoveries += 1
              "resolver-phone"
            },
          transport =
            WearMessageTransport { nodeId, _, data ->
              sends += 1
              if (sends == 1) {
                client.updatePreferredPhoneNodeId(nodeId)
                error("stale send")
              }
              val request = (WearProtocolCodec.decode(data) as WearDecodeResult.Success).message as WearMessage.Request
              client.handleMessage(
                sourceNodeId = nodeId,
                path = WearProtocol.RESPONSE_PATH,
                data = WearProtocolCodec.encode(WearMessage.Response(requestId = request.requestId, ok = true)),
              )
            },
        )
      client.updatePreferredPhoneNodeId("phone-current")

      val first = runCatching { client.request(WearRpcMethod.ProxyStatus, buildJsonObject {}, null) }.exceptionOrNull()
      val second = client.request(WearRpcMethod.ProxyStatus, buildJsonObject {}, null)

      assertEquals("phone_unavailable", (first as WearProxyException).code)
      assertEquals("phone-current", second.sourceNodeId)
      assertEquals(0, discoveries)
    }

  @Test
  fun staleResponseTimeoutDoesNotInvalidateNewerSamePhoneGeneration() =
    runTest {
      var discoveries = 0
      var sends = 0
      lateinit var client: WearProxyClient
      client =
        WearProxyClient.createForTests(
          nodeResolver =
            WearNodeResolver {
              discoveries += 1
              "resolver-phone"
            },
          transport =
            WearMessageTransport { nodeId, _, data ->
              sends += 1
              if (sends == 1) {
                client.updatePreferredPhoneNodeId(nodeId)
              } else {
                val request = (WearProtocolCodec.decode(data) as WearDecodeResult.Success).message as WearMessage.Request
                client.handleMessage(
                  sourceNodeId = nodeId,
                  path = WearProtocol.RESPONSE_PATH,
                  data = WearProtocolCodec.encode(WearMessage.Response(requestId = request.requestId, ok = true)),
                )
              }
            },
        )
      client.updatePreferredPhoneNodeId("phone-current")

      val first = runCatching { client.request(WearRpcMethod.ProxyStatus, buildJsonObject {}, null) }.exceptionOrNull()
      val second = client.request(WearRpcMethod.ProxyStatus, buildJsonObject {}, null)

      assertEquals("timeout", (first as WearProxyException).code)
      assertEquals("phone-current", second.sourceNodeId)
      assertEquals(0, discoveries)
    }

  @Test
  fun successfulParallelResponseProtectsPhoneFromOlderTimeout() =
    runTest {
      var discoveries = 0
      var sends = 0
      lateinit var client: WearProxyClient
      client =
        WearProxyClient.createForTests(
          nodeResolver =
            WearNodeResolver {
              discoveries += 1
              "resolver-phone"
            },
          transport =
            WearMessageTransport { nodeId, _, data ->
              sends += 1
              if (sends > 1) {
                val request = (WearProtocolCodec.decode(data) as WearDecodeResult.Success).message as WearMessage.Request
                client.handleMessage(
                  sourceNodeId = nodeId,
                  path = WearProtocol.RESPONSE_PATH,
                  data = WearProtocolCodec.encode(WearMessage.Response(requestId = request.requestId, ok = true)),
                )
              }
            },
        )
      client.updatePreferredPhoneNodeId("phone-current")

      val older = async { runCatching { client.request(WearRpcMethod.ProxyStatus, buildJsonObject {}, null) } }
      runCurrent()
      val newer = async { client.request(WearRpcMethod.ProxyStatus, buildJsonObject {}, null) }
      runCurrent()

      assertEquals("phone-current", newer.await().sourceNodeId)
      assertEquals("timeout", (older.await().exceptionOrNull() as WearProxyException).code)
      assertEquals("phone-current", client.request(WearRpcMethod.ProxyStatus, buildJsonObject {}, null).sourceNodeId)
      assertEquals(0, discoveries)
    }

  @Test
  fun correlatedResponseProtectsPhoneBeforeRequesterResumes() =
    runTest {
      var discoveries = 0
      var respond = false
      val requests = mutableListOf<WearMessage.Request>()
      lateinit var client: WearProxyClient
      client =
        WearProxyClient.createForTests(
          nodeResolver =
            WearNodeResolver {
              discoveries += 1
              "resolver-phone"
            },
          transport =
            WearMessageTransport { nodeId, _, data ->
              val request = (WearProtocolCodec.decode(data) as WearDecodeResult.Success).message as WearMessage.Request
              requests += request
              if (respond) {
                client.handleMessage(
                  sourceNodeId = nodeId,
                  path = WearProtocol.RESPONSE_PATH,
                  data = WearProtocolCodec.encode(WearMessage.Response(requestId = request.requestId, ok = true)),
                )
              }
            },
        )
      client.updatePreferredPhoneNodeId("phone-current")

      val older = async { runCatching { client.request(WearRpcMethod.ProxyStatus, buildJsonObject {}, null) } }
      val newer = async { runCatching { client.request(WearRpcMethod.ProxyStatus, buildJsonObject {}, null) } }
      runCurrent()
      assertEquals(2, requests.size)

      client.handleMessage(
        sourceNodeId = "phone-current",
        path = WearProtocol.RESPONSE_PATH,
        data = WearProtocolCodec.encode(WearMessage.Response(requestId = requests[1].requestId, ok = true)),
      )
      newer.cancel()
      advanceUntilIdle()

      assertTrue(newer.isCancelled)
      assertEquals("timeout", (older.await().exceptionOrNull() as WearProxyException).code)
      respond = true
      assertEquals("phone-current", client.request(WearRpcMethod.ProxyStatus, buildJsonObject {}, null).sourceNodeId)
      assertEquals(0, discoveries)
    }

  @Test
  fun ambiguousCapabilityCallbackForcesReachableRediscovery() =
    runTest {
      var discoveries = 0
      lateinit var client: WearProxyClient
      client =
        WearProxyClient.createForTests(
          nodeResolver =
            WearNodeResolver {
              discoveries += 1
              "phone-reachable"
            },
          transport =
            WearMessageTransport { nodeId, _, data ->
              val request = (WearProtocolCodec.decode(data) as WearDecodeResult.Success).message as WearMessage.Request
              client.handleMessage(
                sourceNodeId = nodeId,
                path = WearProtocol.RESPONSE_PATH,
                data = WearProtocolCodec.encode(WearMessage.Response(requestId = request.requestId, ok = true)),
              )
            },
        )
      client.updatePreferredPhoneNodeId("phone-stale")

      client.invalidatePreferredPhoneNode()
      val result = client.request(WearRpcMethod.ProxyStatus, buildJsonObject {}, null)

      assertEquals("phone-reachable", result.sourceNodeId)
      assertEquals(1, discoveries)
    }

  @Test
  fun inFlightDiscoveryCannotRestoreInvalidatedPhone() =
    runTest {
      val discoveryStarted = CompletableDeferred<Unit>()
      val releaseDiscovery = CompletableDeferred<Unit>()
      var resolvedNode = "phone-old"
      var discoveries = 0
      val sentNodes = mutableListOf<String>()
      lateinit var client: WearProxyClient
      client =
        WearProxyClient.createForTests(
          nodeResolver =
            WearNodeResolver {
              val result = resolvedNode
              discoveries += 1
              if (discoveries == 1) {
                discoveryStarted.complete(Unit)
                releaseDiscovery.await()
              }
              result
            },
          transport =
            WearMessageTransport { nodeId, _, data ->
              sentNodes += nodeId
              val request = (WearProtocolCodec.decode(data) as WearDecodeResult.Success).message as WearMessage.Request
              client.handleMessage(
                sourceNodeId = nodeId,
                path = WearProtocol.RESPONSE_PATH,
                data = WearProtocolCodec.encode(WearMessage.Response(requestId = request.requestId, ok = true)),
              )
            },
        )

      val first = async { runCatching { client.request(WearRpcMethod.ProxyStatus, buildJsonObject {}, null) } }
      discoveryStarted.await()
      client.invalidatePreferredPhoneNode()
      resolvedNode = "phone-new"
      releaseDiscovery.complete(Unit)

      assertEquals("phone_unavailable", (first.await().exceptionOrNull() as WearProxyException).code)
      assertEquals("phone-new", client.request(WearRpcMethod.ProxyStatus, buildJsonObject {}, null).sourceNodeId)
      assertEquals(2, discoveries)
      assertEquals(listOf("phone-new"), sentNodes)
    }

  @Test
  fun reachablePhoneSelectionPrefersOneNearbyNodeAndRejectsAmbiguity() {
    val nearby = WearReachablePhoneNode(id = "phone-nearby", isNearby = true)
    val nearbyTwo = WearReachablePhoneNode(id = "phone-nearby-2", isNearby = true)
    val cloud = WearReachablePhoneNode(id = "phone-cloud", isNearby = false)
    val cloudTwo = WearReachablePhoneNode(id = "phone-cloud-2", isNearby = false)

    assertEquals("phone-nearby", selectReachablePhoneNodeId(listOf(cloud, nearby)))
    assertEquals("phone-cloud", selectReachablePhoneNodeId(listOf(cloud)))
    assertEquals(null, selectReachablePhoneNodeId(listOf(nearby, nearbyTwo, cloud)))
    assertEquals(null, selectReachablePhoneNodeId(listOf(cloud, cloudTwo)))
  }

  @Test
  fun eventGapAndResetRequireCanonicalRefresh() {
    val tracker = WearEventSequenceTracker()

    assertEquals(WearSequenceDecision.Accepted, tracker.accept(null, 5))
    assertEquals(WearSequenceDecision.Accepted, tracker.accept(null, 6))
    assertEquals(WearSequenceDecision.GapOrReset, tracker.accept(null, 9))
    assertEquals(WearSequenceDecision.AwaitingSnapshot, tracker.accept(null, 10))
    tracker.adoptSnapshot(null, 9)
    assertEquals(WearSequenceDecision.GapOrReset, tracker.accept(null, 8))
    assertEquals(WearSequenceDecision.AwaitingSnapshot, tracker.accept(null, 8))
    tracker.adoptSnapshot(null, 8)
    assertEquals(WearSequenceDecision.GapOrReset, tracker.accept(null, 1))
    tracker.adoptSnapshot(null, 1)
    assertEquals(WearSequenceDecision.Accepted, tracker.accept(null, 2))
  }

  @Test
  fun phoneProcessEpochForcesRefreshEvenWhenSequenceLooksContiguous() {
    val tracker = WearEventSequenceTracker()

    tracker.adoptSnapshot("old-process", 5)

    assertEquals(WearSequenceDecision.GapOrReset, tracker.accept("new-process", 6))
    assertEquals(WearSequenceDecision.AwaitingSnapshot, tracker.accept("new-process", 7))
    tracker.adoptSnapshot("new-process", 7)
    assertEquals(WearSequenceDecision.Accepted, tracker.accept("new-process", 8))
  }

  @Test
  fun snapshotWatermarkMakesTheFirstMissingEventVisible() {
    val tracker = WearEventSequenceTracker()

    tracker.adoptSnapshot("stream", 10)
    assertEquals(WearSequenceDecision.GapOrReset, tracker.accept("stream", 12))
    tracker.adoptSnapshot("stream", 12)
    assertEquals(WearSequenceDecision.Accepted, tracker.accept("stream", 13))
  }

  @Test
  fun rpcResponseMustMatchTheCurrentStreamAndWatermark() {
    val tracker = WearEventSequenceTracker()

    tracker.adoptSnapshot("stream", 10)

    assertTrue(tracker.isResponseCurrent(tracker.beginResponseRequest(), "stream", 10))
    assertFalse(tracker.isResponseCurrent(tracker.beginResponseRequest(), "stream", 11))
    assertFalse(tracker.isResponseCurrent(tracker.beginResponseRequest(), "stream", 9))
    assertFalse(tracker.isResponseCurrent(tracker.beginResponseRequest(), "new-stream", 11))
    val pendingSnapshot = tracker.beginResponseRequest()
    tracker.requireSnapshot()
    assertFalse(tracker.isResponseCurrent(pendingSnapshot, "stream", 11))
  }

  @Test
  fun legacyRpcResponseWithoutWatermarkRequiresUnchangedEvents() {
    val tracker = WearEventSequenceTracker()

    tracker.adoptSnapshot(null, 10)

    assertTrue(tracker.isResponseCurrent(tracker.beginResponseRequest(), null, null))
    val staleRequest = tracker.beginResponseRequest()
    assertEquals(WearSequenceDecision.Accepted, tracker.accept(null, 11))
    assertFalse(tracker.isResponseCurrent(staleRequest, null, null))
  }

  @Test
  fun newerRpcRequestInvalidatesAnOlderCompletion() {
    val tracker = WearEventSequenceTracker()

    tracker.adoptSnapshot("stream", 10)
    val olderRequest = tracker.beginResponseRequest()
    val newerRequest = tracker.beginResponseRequest()

    assertFalse(tracker.isResponseCurrent(olderRequest, "stream", 12))
    assertTrue(tracker.isResponseCurrent(newerRequest, "stream", 10))
  }

  @Test
  fun resyncBufferReplaysEventsNewerThanTheSnapshotWatermark() {
    val tracker = WearEventSequenceTracker()
    val buffer = WearEventResyncBuffer()
    val missed =
      WearInboundEvent(sourceNodeId = "phone", sequence = 5, event = WearEventType.Chat, payload = null)
    val raced =
      WearInboundEvent(sourceNodeId = "phone", sequence = 6, event = WearEventType.Chat, payload = null)

    tracker.adoptSnapshot(null, 3)
    assertEquals(WearSequenceDecision.GapOrReset, tracker.accept(missed.streamId, missed.sequence))
    buffer.start(missed)
    assertEquals(WearSequenceDecision.AwaitingSnapshot, tracker.accept(raced.streamId, raced.sequence))
    buffer.append(raced)

    val replay = buffer.drainAfterSnapshot(null, 4)
    tracker.adoptSnapshot(null, 4)

    assertEquals(listOf(5L, 6L), replay.map(WearInboundEvent::sequence))
    assertTrue(replay.all { tracker.accept(it.streamId, it.sequence) == WearSequenceDecision.Accepted })
  }

  @Test
  fun resyncBufferDiscardsEventsAlreadyCoveredByTheSnapshot() {
    val buffer = WearEventResyncBuffer()
    buffer.start(
      WearInboundEvent(sourceNodeId = "phone", sequence = 5, event = WearEventType.Chat, payload = null),
    )
    buffer.append(
      WearInboundEvent(sourceNodeId = "phone", sequence = 6, event = WearEventType.Chat, payload = null),
    )

    assertTrue(buffer.drainAfterSnapshot(null, 6).isEmpty())
  }

  @Test
  fun resyncBufferDoesNotReplayAnOldProcessEpoch() {
    val buffer = WearEventResyncBuffer()
    buffer.start(
      WearInboundEvent(sourceNodeId = "phone", streamId = "old", sequence = 6, event = WearEventType.Chat, payload = null),
    )
    buffer.append(
      WearInboundEvent(sourceNodeId = "phone", streamId = "new", sequence = 1, event = WearEventType.Chat, payload = null),
    )

    val replay = buffer.drainAfterSnapshot("new", 0)

    assertEquals(listOf(1L), replay.map(WearInboundEvent::sequence))
  }

  @Test
  fun legacySnapshotWithoutWatermarkDoesNotReplayAmbiguousEvents() {
    val buffer = WearEventResyncBuffer()
    buffer.start(
      WearInboundEvent(sourceNodeId = "phone", sequence = 5, event = WearEventType.Chat, payload = null),
    )
    buffer.append(
      WearInboundEvent(sourceNodeId = "phone", sequence = 6, event = WearEventType.Chat, payload = null),
    )

    assertTrue(buffer.drainAfterSnapshot(null, null).isEmpty())
  }

  @Test
  fun eventSourceTrackerRequiresResyncOnlyWhenThePhoneChanges() {
    val tracker = WearEventSourceTracker()

    assertTrue(!tracker.changed("phone-1"))
    assertTrue(!tracker.changed("phone-1"))
    assertTrue(tracker.changed("phone-2"))

    tracker.adopt("snapshot-phone")
    assertTrue(!tracker.changed("snapshot-phone"))
    assertTrue(tracker.changed("other-phone"))
  }

  @Test
  fun phoneChangeClearsPhoneLocalSessionState() {
    val selected = WearSession(key = "main", title = "Main", updatedAt = null, hasActiveRun = true, phoneNodeId = "phone-1")
    val state =
      WearUiState(
        loading = false,
        connected = true,
        proxyCapabilities = WearProxyCapability.entries.toSet(),
        sessions = listOf(selected),
        selectedSession = selected,
        messages = listOf(WearChatMessage(id = "m1", role = "assistant", text = "old", timestamp = 1)),
        streamText = "typing",
        activeRunId = "run-1",
        sending = true,
        failure = WearConversationFailure.INTERNAL_ERROR,
      )

    val reset = state.resetForPhoneChange()

    assertTrue(reset.loading)
    assertTrue(!reset.connected)
    assertTrue(reset.proxyCapabilities.isEmpty())
    assertTrue(reset.sessions.isEmpty())
    assertEquals(null, reset.selectedSession)
    assertTrue(reset.messages.isEmpty())
    assertEquals(null, reset.streamText)
    assertEquals(null, reset.activeRunId)
    assertTrue(reset.sending)
    assertEquals(null, reset.failure)
  }

  @Test
  fun requestDeadlineIncludesPhoneDiscovery() =
    runTest {
      val client =
        WearProxyClient.createForTests(
          nodeResolver = WearNodeResolver { awaitCancellation() },
          transport = WearMessageTransport { _, _, _ -> error("must not send") },
        )

      val failure =
        async {
          runCatching { client.request(WearRpcMethod.ProxyStatus, buildJsonObject {}, null) }.exceptionOrNull()
        }
      advanceUntilIdle()

      assertEquals("timeout", (failure.await() as WearProxyException).code)
    }

  @Test
  fun discoveryFailureUsesConnectivityError() =
    runTest {
      val client =
        WearProxyClient.createForTests(
          nodeResolver = WearNodeResolver { error("Play services failed") },
          transport = WearMessageTransport { _, _, _ -> error("must not send") },
        )

      val failure = runCatching { client.request(WearRpcMethod.ProxyStatus, buildJsonObject {}, null) }.exceptionOrNull()

      assertEquals("phone_unavailable", (failure as WearProxyException).code)
    }
}
