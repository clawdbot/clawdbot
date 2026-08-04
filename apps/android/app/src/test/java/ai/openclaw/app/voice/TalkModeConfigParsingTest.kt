package ai.openclaw.app.voice

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.put
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
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
  fun derivesRealtimeLanguageFromConfiguredLocale() {
    assertEquals("de", realtimeTranscriptionLanguage("de-DE"))
    assertEquals(null, realtimeTranscriptionLanguage("fil-PH"))
  }

  @Test
  fun gatesAndroidRealtimeRelayFromEffectiveModel() {
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

    assertFalse(TalkModeGatewayConfigParser.parse(browserOnly).realtimeRelayModelSupported)
    assertTrue(TalkModeGatewayConfigParser.parse(relayCapable).realtimeRelayModelSupported)
  }

  @Test
  fun gatesAndroidRealtimeRelayFromProviderLevelModel() {
    val providerLevelBrowserOnly =
      json
        .parseToJsonElement(
          """{"talk":{"realtime":{"provider":"openai","providers":{"openai":{"model":"gpt-live-1-codex"}}}}}""",
        ).jsonObject
    val topLevelWins =
      json
        .parseToJsonElement(
          """{"talk":{"realtime":{"provider":"openai","model":"gpt-realtime-2.1","providers":{"openai":{"model":"gpt-live-1-codex"}}}}}""",
        ).jsonObject

    assertFalse(TalkModeGatewayConfigParser.parse(providerLevelBrowserOnly).realtimeRelayModelSupported)
    assertTrue(TalkModeGatewayConfigParser.parse(topLevelWins).realtimeRelayModelSupported)
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
}
