package ai.openclaw.app.gateway

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class GatewayProtocolGeneratedTest {
  private val json =
    Json {
      ignoreUnknownKeys = true
      encodeDefaults = true
      explicitNulls = false
    }

  @Test
  fun requestFrameEncodingIncludesTheDiscriminatorAndOmitsNullParams() {
    val encoded =
      json
        .encodeToJsonElement(
          GatewayRequestFrame.serializer(),
          GatewayRequestFrame(id = "request-1", method = GatewayMethod.Health.rawValue),
        ).jsonObject

    assertEquals("req", encoded.getValue("type").jsonPrimitive.content)
    assertEquals("request-1", encoded.getValue("id").jsonPrimitive.content)
    assertEquals(GatewayMethod.Health.rawValue, encoded.getValue("method").jsonPrimitive.content)
    assertNull(encoded["params"])
  }

  @Test
  fun nodeInvokeRequestUsesTheSchemaWireNames() {
    val decoded =
      json.decodeFromString(
        GatewayNodeInvokeRequest.serializer(),
        """{"id":"invoke-1","nodeId":"node-1","command":"device.info","paramsJSON":"{}","timeoutMs":5000}""",
      )

    assertEquals("invoke-1", decoded.id)
    assertEquals("node-1", decoded.nodeId)
    assertEquals("device.info", decoded.command)
    assertEquals("{}", decoded.paramsJson)
    assertEquals(5_000L, decoded.timeoutMs)
  }

  @Test
  fun generatedGatewayCatalogsAreCompleteAndUnique() {
    val methods = GatewayMethod.entries.map { it.rawValue }
    val events = GatewayEvent.entries.map { it.rawValue }

    assertTrue(methods.size > 200)
    assertTrue(events.size > 20)
    assertEquals(methods.size, methods.toSet().size)
    assertEquals(events.size, events.toSet().size)
  }
}
