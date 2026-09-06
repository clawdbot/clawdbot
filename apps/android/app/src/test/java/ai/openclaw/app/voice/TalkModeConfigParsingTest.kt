package ai.openclaw.app.voice

import kotlinx.serialization.Serializable
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.put
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test
import java.io.File

@Serializable
private data class TalkConfigContractFixture(
  val selectionCases: List<SelectionCase>,
  val timeoutCases: List<TimeoutCase>,
) {
  @Serializable
  data class SelectionCase(
    val id: String,
    val talk: JsonObject,
  )

  @Serializable
  data class TimeoutCase(
    val id: String,
    val fallback: Long,
    val expectedTimeoutMs: Long,
    val talk: JsonObject,
  )
}

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
              "speechLocale": "de_DE",
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
    assertEquals("de-DE", parsed.speechLocale)
    assertEquals(true, parsed.interruptOnSpeech)
    assertEquals(1800L, parsed.silenceTimeoutMs)
  }

  @Test
  fun selectionFixtures() {
    for (fixture in loadContractFixtures().selectionCases) {
      val parsed = parseTalkConfig(fixture.talk)

      assertNull("${fixture.id}: speechLocale", parsed.speechLocale)
      assertNull("${fixture.id}: interruptOnSpeech", parsed.interruptOnSpeech)
      assertEquals(
        "${fixture.id}: silenceTimeoutMs",
        TalkDefaults.defaultSilenceTimeoutMs,
        parsed.silenceTimeoutMs,
      )
    }
  }

  @Test
  fun timeoutFixtures() {
    for (fixture in loadContractFixtures().timeoutCases) {
      val parsed = parseTalkConfig(fixture.talk)

      assertNull("${fixture.id}: speechLocale", parsed.speechLocale)
      assertNull("${fixture.id}: interruptOnSpeech", parsed.interruptOnSpeech)
      assertEquals("${fixture.id}: fallback", fixture.fallback, TalkDefaults.defaultSilenceTimeoutMs)
      assertEquals("${fixture.id}: silenceTimeoutMs", fixture.expectedTimeoutMs, parsed.silenceTimeoutMs)
    }
  }

  @Test
  fun derivesRealtimeLanguageFromConfiguredLocale() {
    assertEquals("de", realtimeTranscriptionLanguage("de-DE"))
    assertEquals(null, realtimeTranscriptionLanguage("fil-PH"))
  }

  @Test
  fun readsGatewayTransportWithoutInferringFromModelNames() {
    for (model in listOf("gpt-live-1-codex", "gpt-realtime-2.1")) {
      val config = json.parseToJsonElement("""{"talk":{"realtime":{"model":"$model","transport":"webrtc"}}}""").jsonObject
      assertEquals("webrtc", TalkModeGatewayConfigParser.parse(config).realtimeTransport)
      assertNull(TalkModeGatewayConfigParser.parse(config).realtimeMode)
    }
  }

  @Test
  fun selectsOnlySupportedTransportsFromGatewayCapabilities() {
    fun catalog(transports: String) = json.parseToJsonElement("""{"realtime":{"activeProvider":"example","providers":[{"id":"example","transports":[$transports]}]}}""").jsonObject
    assertEquals(AndroidRealtimeRoute.WebRtcWithRelayRecovery, resolveAndroidRealtimeRoute(null, catalog("\"webrtc\",\"gateway-relay\""), emptySet()))
    assertEquals(AndroidRealtimeRoute.GatewayRelay, resolveAndroidRealtimeRoute(null, catalog("\"provider-websocket\",\"gateway-relay\""), emptySet()))
    assertEquals(AndroidRealtimeRoute.GatewayRelay, resolveAndroidRealtimeRoute("provider-websocket", null, emptySet()))
    assertEquals(AndroidRealtimeRoute.GatewayRelay, resolveAndroidRealtimeRoute("gateway-relay", null, emptySet()))
    assertEquals(AndroidRealtimeRoute.WebRtc, resolveAndroidRealtimeRoute("webrtc", null, emptySet()))
    assertEquals(true, runCatching { resolveAndroidRealtimeRoute("managed-room", null, emptySet()) }.isFailure)
    assertEquals(true, runCatching { resolveAndroidRealtimeRoute(null, catalog("\"provider-websocket\""), emptySet()) }.isFailure)
    assertEquals(true, runCatching { resolveAndroidRealtimeRoute(null, null, emptySet()) }.isFailure)
    for (routing in listOf(null, "provider-direct", "force-agent-consult")) {
      for ((transport, expected) in listOf(null to AndroidRealtimeRoute.WebRtcWithRelayRecovery, "webrtc" to AndroidRealtimeRoute.WebRtc, "gateway-relay" to AndroidRealtimeRoute.GatewayRelay, "provider-websocket" to AndroidRealtimeRoute.GatewayRelay)) {
        val parsed =
          parseTalkConfig(
            buildJsonObject {
              put(
                "realtime",
                buildJsonObject {
                  transport?.let { put("transport", it) }
                  routing?.let { put("consultRouting", it) }
                },
              )
            },
          )
        assertEquals(
          "routing=$routing, transport=$transport",
          if (routing == "force-agent-consult") AndroidRealtimeRoute.GatewayRelay else expected,
          resolveAndroidRealtimeRoute(parsed.realtimeTransport, catalog("\"webrtc\",\"gateway-relay\""), parsed.strictAuthProviders),
        )
      }
    }
  }

  @Test
  fun resolvesRealtimeLanguageFromConfigThenWatchThenPhone() {
    assertEquals(
      "de",
      resolveRealtimeTranscriptionLanguageHint(
        configuredLocaleTag = "de-DE",
        requestedLanguage = "en",
        deviceLocaleTag = "fr-FR",
      ),
    )
    assertEquals(
      "en",
      resolveRealtimeTranscriptionLanguageHint(
        configuredLocaleTag = null,
        requestedLanguage = "en",
        deviceLocaleTag = "fr-FR",
      ),
    )
    assertEquals(
      "fr",
      resolveRealtimeTranscriptionLanguageHint(
        configuredLocaleTag = null,
        requestedLanguage = null,
        deviceLocaleTag = "fr-FR",
      ),
    )
  }

  @Test
  fun authScopeFollowsTheSelectedProviderAndAliases() {
    val catalog = json.parseToJsonElement("""{"realtime":{"activeProvider":"example-alias","providers":[{"id":"example","aliases":["example-alias"],"transports":["webrtc","gateway-relay"]}]}}""").jsonObject
    // Providerless legacy projections and normalized provider selections both use
    // the catalog's active row; unrelated inherited rows never choose auth policy.
    for (provider in listOf(null, "example")) {
      for (auth in listOf("oauth", "api-key")) {
        for (strictProvider in listOf(null, "inactive", "example")) {
          val parsed =
            parseTalkConfig(
              buildJsonObject {
                put(
                  "realtime",
                  buildJsonObject {
                    provider?.let { put("provider", it) }
                    put(
                      "providers",
                      buildJsonObject {
                        put("example", buildJsonObject { put("model", "synthetic-realtime") })
                        strictProvider?.let { put(it, buildJsonObject { put("authMethod", auth) }) }
                      },
                    )
                  },
                )
              },
            )
          assertEquals(
            "provider=$provider, strictProvider=$strictProvider, auth=$auth",
            if (strictProvider == "example") AndroidRealtimeRoute.WebRtc else AndroidRealtimeRoute.WebRtcWithRelayRecovery,
            resolveAndroidRealtimeRoute(parsed.realtimeTransport, catalog, parsed.strictAuthProviders),
          )
        }
      }
    }
  }

  private fun parseTalkConfig(talk: JsonObject): TalkModeGatewayConfigState = TalkModeGatewayConfigParser.parse(buildJsonObject { put("talk", talk) })

  private fun loadContractFixtures(): TalkConfigContractFixture = json.decodeFromString(findContractFixture().readText())

  private fun findContractFixture(): File {
    val startDir = System.getProperty("user.dir") ?: error("user.dir unavailable")
    var current = File(startDir).absoluteFile
    while (true) {
      val candidate = File(current, "test/fixtures/talk-config-contract.json")
      if (candidate.isFile) return candidate
      current = current.parentFile ?: break
    }
    error("test/fixtures/talk-config-contract.json not found from $startDir")
  }
}
