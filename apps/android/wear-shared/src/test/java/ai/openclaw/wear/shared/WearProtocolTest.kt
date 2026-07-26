package ai.openclaw.wear.shared

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.put
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertThrows
import org.junit.Test

class WearProtocolTest {
  @Test
  fun realtimeTalkSnapshotCarriesAttemptCorrelation() {
    val snapshot =
      WearRealtimeTalkSnapshot(
        attemptId = "attempt-7",
        active = true,
        listening = true,
        status = WearRealtimeTalkStatus.LISTENING,
      )

    assertEquals(snapshot, WearRealtimeTalkCodec.decode(WearRealtimeTalkCodec.encode(snapshot)))
  }

  @Test
  fun roundTripsEveryEnvelopeKind() {
    val messages =
      listOf(
        WearMessage.Request(
          requestId = "req-1",
          method = WearRpcMethod.ChatHistory,
          params = buildJsonObject { put("sessionKey", "main") },
        ),
        WearMessage.Response(
          requestId = "req-1",
          ok = true,
          result = buildJsonObject { put("count", 2) },
          eventStreamId = "phone-process-1",
          eventSequence = 7,
        ),
        WearMessage.Response(
          requestId = "req-2",
          ok = false,
          error = WearRpcError(code = "unavailable", message = "Phone offline"),
        ),
        WearMessage.Event(
          streamId = "phone-process-1",
          sequence = 7,
          event = WearEventType.Chat,
          payload = buildJsonObject { put("state", "delta") },
        ),
      )

    messages.forEach { message ->
      assertEquals(WearDecodeResult.Success(message), WearProtocolCodec.decode(WearProtocolCodec.encode(message)))
    }
  }

  @Test
  fun usesStableWireNamesAndPaths() {
    val methodNames =
      mapOf(
        WearRpcMethod.ProxyStatus to "proxy.status",
        WearRpcMethod.SessionsList to "sessions.list",
        WearRpcMethod.AgentsList to "agents.list",
        WearRpcMethod.AgentsSelect to "agents.select",
        WearRpcMethod.ModelsList to "models.list",
        WearRpcMethod.ModelsSelect to "models.select",
        WearRpcMethod.GatewayConnect to "gateway.connect",
        WearRpcMethod.GatewayDisconnect to "gateway.disconnect",
        WearRpcMethod.ChatHistory to "chat.history",
        WearRpcMethod.ChatSend to "chat.send",
        WearRpcMethod.ChatAbort to "chat.abort",
        WearRpcMethod.TalkStart to "talk.start",
        WearRpcMethod.TalkStop to "talk.stop",
      )
    methodNames.forEach { (method, wireName) ->
      val request = WearMessage.Request(requestId = "req-1", method = method)
      val root = Json.parseToJsonElement(WearProtocolCodec.encode(request).decodeToString()).jsonObject
      assertEquals("request", root.getValue("type").jsonPrimitive.content)
      assertEquals(wireName, root.getValue("method").jsonPrimitive.content)
    }

    val eventNames =
      mapOf(
        WearEventType.Chat to "chat",
        WearEventType.Connection to "connection",
        WearEventType.Resync to "resync",
        WearEventType.Talk to "talk",
      )
    eventNames.forEach { (event, wireName) ->
      val message = WearMessage.Event(sequence = 1, event = event)
      val root = Json.parseToJsonElement(WearProtocolCodec.encode(message).decodeToString()).jsonObject
      assertEquals("event", root.getValue("type").jsonPrimitive.content)
      assertEquals(wireName, root.getValue("event").jsonPrimitive.content)
    }

    assertEquals("/openclaw/wear/v1/request", WearProtocol.REQUEST_PATH)
    assertEquals("/openclaw/wear/v1/response", WearProtocol.RESPONSE_PATH)
    assertEquals("/openclaw/wear/v1/event", WearProtocol.EVENT_PATH)
    assertEquals("/openclaw/wear/v1/realtime/audio", WearProtocol.REALTIME_AUDIO_CHANNEL_PATH)
    assertEquals("openclaw_phone_proxy_v1", WearProtocol.PHONE_CAPABILITY)
    assertEquals("openclaw_wear_companion_v1", WearProtocol.WATCH_CAPABILITY)
    assertEquals("gateway_offline", WearConnectionFailure.GatewayOffline.wireValue)
    assertEquals("incompatible", WearConnectionFailure.Incompatible.wireValue)
    assertEquals(
      WearConnectionFailure.Incompatible,
      WearConnectionFailure.fromWireValue("incompatible"),
    )
    assertEquals(null, WearConnectionFailure.fromWireValue("future-failure"))
    assertEquals("agent-controls", WearProxyCapability.AgentControls.wireValue)
    assertEquals("gateway-controls", WearProxyCapability.GatewayControls.wireValue)
    assertEquals("model-controls", WearProxyCapability.ModelControls.wireValue)
    assertEquals("session-selection-lookup", WearProxyCapability.SessionSelectionLookup.wireValue)
    assertEquals(WearProxyCapability.AgentControls, WearProxyCapability.fromWireValue("agent-controls"))
    assertEquals(null, WearProxyCapability.fromWireValue("future-capability"))
  }

  @Test
  fun ignoresUnknownFieldsWithinCurrentVersion() {
    val bytes =
      """{"type":"request","version":1,"requestId":"req-1","method":"proxy.status","params":{},"future":true}"""
        .encodeToByteArray()

    assertEquals(
      WearDecodeResult.Success(
        WearMessage.Request(requestId = "req-1", method = WearRpcMethod.ProxyStatus),
      ),
      WearProtocolCodec.decode(bytes),
    )
  }

  @Test
  fun rejectsMalformedUnsupportedAndInvalidMessages() {
    assertEquals(
      WearDecodeResult.Failure(WearDecodeFailureReason.Empty),
      WearProtocolCodec.decode(byteArrayOf()),
    )
    assertEquals(
      WearDecodeResult.Failure(WearDecodeFailureReason.Malformed),
      WearProtocolCodec.decode("not-json".encodeToByteArray()),
    )
    val invalidUtf8 =
      """{"type":"request","version":1,"requestId":"""".encodeToByteArray() +
        byteArrayOf(0xc3.toByte(), 0x28) +
        """","method":"proxy.status","params":{}}""".encodeToByteArray()
    assertEquals(
      WearDecodeResult.Failure(WearDecodeFailureReason.Malformed),
      WearProtocolCodec.decode(invalidUtf8),
    )
    assertEquals(
      WearDecodeResult.Failure(WearDecodeFailureReason.UnsupportedVersion),
      WearProtocolCodec.decode(
        """{"type":"future-message","version":2,"futureRequiredField":true}"""
          .encodeToByteArray(),
      ),
    )
    assertEquals(
      WearDecodeResult.Failure(WearDecodeFailureReason.InvalidEnvelope),
      WearProtocolCodec.decode(
        """{"type":"response","version":1,"requestId":"req-1","ok":false}""".encodeToByteArray(),
      ),
    )
    assertEquals(
      WearDecodeResult.Failure(WearDecodeFailureReason.InvalidEnvelope),
      WearProtocolCodec.decode(
        """{"type":"event","version":1,"streamId":"","sequence":1,"event":"connection"}"""
          .encodeToByteArray(),
      ),
    )
    assertEquals(
      WearDecodeResult.Failure(WearDecodeFailureReason.InvalidEnvelope),
      WearProtocolCodec.decode(
        """{"type":"response","version":1,"requestId":"req-1","ok":true,"eventSequence":-1}"""
          .encodeToByteArray(),
      ),
    )
  }

  @Test
  fun rejectsOversizedMessagesOnEncodeAndDecode() {
    val oversizedBytes = ByteArray(WearProtocol.MAX_MESSAGE_BYTES + 1)
    assertEquals(
      WearDecodeResult.Failure(WearDecodeFailureReason.TooLarge),
      WearProtocolCodec.decode(oversizedBytes),
    )

    val oversizedMessage =
      WearMessage.Request(
        requestId = "req-1",
        method = WearRpcMethod.ChatSend,
        params = buildJsonObject { put("message", "x".repeat(WearProtocol.MAX_MESSAGE_BYTES)) },
      )
    assertThrows(IllegalArgumentException::class.java) {
      WearProtocolCodec.encode(oversizedMessage)
    }
  }

  @Test
  fun rejectsExcessiveJsonDepthBeforeParsing() {
    val nesting = WearProtocol.MAX_JSON_DEPTH + 1
    val deeplyNested =
      """{"type":"request","version":1,"requestId":"req-1","method":"chat.send","params":{"payload":${"[".repeat(nesting)}0${"]".repeat(nesting)}}}"""

    assertEquals(
      WearDecodeResult.Failure(WearDecodeFailureReason.TooDeep),
      WearProtocolCodec.decode(deeplyNested.encodeToByteArray()),
    )

    val bracketsInString =
      WearMessage.Request(
        requestId = "req-2",
        method = WearRpcMethod.ChatSend,
        params = buildJsonObject { put("message", "[".repeat(WearProtocol.MAX_JSON_DEPTH + 1)) },
      )
    assertEquals(
      WearDecodeResult.Success(bracketsInString),
      WearProtocolCodec.decode(WearProtocolCodec.encode(bracketsInString)),
    )

    var nestedPayload: JsonElement = JsonPrimitive(0)
    repeat(4_096) {
      nestedPayload = JsonArray(listOf(nestedPayload))
    }
    val deeplyNestedMessage =
      WearMessage.Request(
        requestId = "req-3",
        method = WearRpcMethod.ChatSend,
        params = buildJsonObject { put("payload", nestedPayload) },
      )
    assertThrows(IllegalArgumentException::class.java) {
      WearProtocolCodec.encode(deeplyNestedMessage)
    }
  }

  @Test
  fun encodingIsDeterministic() {
    val message = WearMessage.Request(requestId = "req-1", method = WearRpcMethod.SessionsList)
    assertArrayEquals(WearProtocolCodec.encode(message), WearProtocolCodec.encode(message))
  }
}
