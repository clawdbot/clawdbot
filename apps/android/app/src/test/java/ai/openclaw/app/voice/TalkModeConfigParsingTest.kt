package ai.openclaw.app.voice

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.put
import org.junit.Assert.assertEquals
import org.junit.Test

class TalkModeConfigParsingTest {
  private val json = Json { ignoreUnknownKeys = true }

  @Test
  fun readsMainSessionKeyAndInterruptFlag() {
    val config =
      json
        .parseToJsonElement(
          """
          {
            "talk": {
              "interruptOnSpeech": true,
              "silenceTimeoutMs": 1800
            },
            "session": {
              "mainKey": "voice-main"
            }
          }
          """.trimIndent(),
        ).jsonObject

    val parsed = TalkModeGatewayConfigParser.parse(config)

    assertEquals("voice-main", parsed.mainSessionKey)
    assertEquals(true, parsed.interruptOnSpeech)
    assertEquals(1800L, parsed.silenceTimeoutMs)
  }

  @Test
  fun defaultsSilenceTimeoutMsWhenMissing() {
    assertEquals(
      TalkDefaults.defaultSilenceTimeoutMs,
      TalkModeGatewayConfigParser.resolvedSilenceTimeoutMs(null),
    )
  }

  @Test
  fun defaultsSilenceTimeoutMsWhenInvalid() {
    val talk = buildJsonObject { put("silenceTimeoutMs", 0) }

    assertEquals(
      TalkDefaults.defaultSilenceTimeoutMs,
      TalkModeGatewayConfigParser.resolvedSilenceTimeoutMs(talk),
    )
  }

  @Test
  fun defaultsSilenceTimeoutMsWhenString() {
    val talk = buildJsonObject { put("silenceTimeoutMs", "1500") }

    assertEquals(
      TalkDefaults.defaultSilenceTimeoutMs,
      TalkModeGatewayConfigParser.resolvedSilenceTimeoutMs(talk),
    )
  }

  @Test
  fun defaultsToNativeTalkMode() {
    val talk =
      buildJsonObject {
        put("realtime", buildJsonObject { put("transport", "webrtc") })
      }

    assertEquals(
      TalkModeExecutionMode.Native,
      TalkModeGatewayConfigParser.resolvedExecutionMode(talk),
    )
  }

  @Test
  fun usesRealtimeRelayWhenGatewayRelayIsConfigured() {
    val talk =
      buildJsonObject {
        put(
          "realtime",
          buildJsonObject {
            put("mode", "realtime")
            put("transport", "gateway-relay")
            put("brain", "agent-consult")
          },
        )
      }

    assertEquals(
      TalkModeExecutionMode.RealtimeRelay,
      TalkModeGatewayConfigParser.resolvedExecutionMode(talk),
    )
  }
}
