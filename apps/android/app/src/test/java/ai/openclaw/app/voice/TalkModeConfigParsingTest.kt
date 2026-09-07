package ai.openclaw.app.voice

import kotlinx.serialization.Serializable
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.put
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
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
  fun gatesAndroidRealtimeRelayFromEffectiveModel() {
    val releasedNative =
      json
        .parseToJsonElement(
          """{"talk":{"realtime":{"model":"gpt-live-1-codex"}}}""",
        ).jsonObject
    val browserOnly =
      json
        .parseToJsonElement(
          """{"talk":{"realtime":{"model":"gpt-live-future"}}}""",
        ).jsonObject
    val relayCapable =
      json
        .parseToJsonElement(
          """{"talk":{"realtime":{"model":"gpt-realtime-2.1"}}}""",
        ).jsonObject

    assertFalse(TalkModeGatewayConfigParser.parse(releasedNative).realtimeRelayModelSupported)
    assertFalse(TalkModeGatewayConfigParser.parse(browserOnly).realtimeRelayModelSupported)
    assertTrue(TalkModeGatewayConfigParser.parse(relayCapable).realtimeRelayModelSupported)
  }

  @Test
  fun gatesAndroidRealtimeRelayFromProviderLevelModel() {
    val providerLevelBrowserOnly =
      json
        .parseToJsonElement(
          """{"talk":{"realtime":{"provider":"openai","providers":{"openai":{"model":"gpt-live-test-canary"}}}}}""",
        ).jsonObject
    val topLevelWins =
      json
        .parseToJsonElement(
          """{"talk":{"realtime":{"provider":"openai","model":"gpt-realtime-2.1","providers":{"openai":{"model":"gpt-live-test-canary"}}}}}""",
        ).jsonObject

    assertFalse(TalkModeGatewayConfigParser.parse(providerLevelBrowserOnly).realtimeRelayModelSupported)
    assertTrue(TalkModeGatewayConfigParser.parse(topLevelWins).realtimeRelayModelSupported)
  }

  @Test
  fun preservesGatewayRelayEligibilityWhenModelIsRedacted() {
    val projected =
      json
        .parseToJsonElement(
          """
          {
            "talk": {"realtime": {"provider": "openai"}},
            "clientHints": {"realtime": {"modelSource": "gateway", "gatewayRelaySupported": false}}
          }
          """.trimIndent(),
        ).jsonObject

    assertFalse(TalkModeGatewayConfigParser.parse(projected).realtimeRelayModelSupported)
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
