package ai.openclaw.app

import ai.openclaw.app.i18n.NativeText
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.jsonObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class GatewayTalkSetupReadinessTest {
  @Test
  fun targetTitlesStayNestedLocalizedPresentation() {
    val targets =
      listOf(
        GatewayTalkSetupTarget.REALTIME_TALK to "Realtime Talk",
        GatewayTalkSetupTarget.DICTATION to "Dictation",
      )

    for ((target, source) in targets) {
      val title = NativeText.Resource(source = source, formatArgs = emptyList())
      assertEquals(title, target.title)
      val issueCases =
        listOf(
          GatewayTalkSetupIssue.GroupMissing(target) to "Gateway did not return \${issue.target.title} setup",
          GatewayTalkSetupIssue.NoProvider(target) to
            "No \${issue.target.title} provider is configured on the Gateway",
          GatewayTalkSetupIssue.MissingReadiness(target) to
            "Gateway did not return \${issue.target.title} readiness",
          GatewayTalkSetupIssue.ConfigureProvider(target) to
            "Configure a \${issue.target.title} provider on the Gateway",
          GatewayTalkSetupIssue.MissingActiveProvider(target) to
            "Gateway did not identify the active \${issue.target.title} provider",
          GatewayTalkSetupIssue.UnsupportedProvider(target) to
            "Choose a supported \${issue.target.title} provider on the Gateway",
        )
      for ((issue, template) in issueCases) {
        assertEquals(
          NativeText.Resource(source = template, formatArgs = listOf(title)),
          gatewayTalkSetupIssueDescriptionText(issue),
        )
      }
    }
  }

  @Test
  fun gatewayTechnicalLabelsStayVerbatimInsideLocalizedPresentation() {
    assertEquals(
      NativeText.Resource(
        source = "\${state.provider.label} via Gateway relay",
        formatArgs = listOf(NativeText.Verbatim("Future Realtime")),
      ),
      gatewayTalkSetupDescriptionText(
        GatewayTalkSetupState.Ready(GatewayTalkProvider(id = "future-provider", label = "Future Realtime")),
      ),
    )
    assertEquals(
      NativeText.Resource(
        source = "Gateway selected unknown provider \${issue.providerId}",
        formatArgs = listOf(NativeText.Verbatim("future-provider")),
      ),
      gatewayTalkSetupIssueDescriptionText(
        GatewayTalkSetupIssue.UnknownProvider(
          target = GatewayTalkSetupTarget.REALTIME_TALK,
          providerId = "future-provider",
        ),
      ),
    )
    assertEquals(
      NativeText.Resource(
        source = "Configure \${issue.providerLabel} on the Gateway",
        formatArgs = listOf(NativeText.Verbatim("Future Provider")),
      ),
      gatewayTalkSetupIssueDescriptionText(
        GatewayTalkSetupIssue.ConfigureSelectedProvider(providerLabel = "Future Provider"),
      ),
    )
  }

  @Test
  fun mixedProviderStatesRemainDistinct() {
    val readiness =
      parseGatewayTalkSetupReadiness(
        catalog(
          realtime = providerGroup(id = "openai", label = "OpenAI Realtime", configured = false),
          transcription = providerGroup(id = "deepgram", label = "Deepgram", configured = true),
        ),
      )

    val realtime = readiness.realtimeTalk as GatewayTalkSetupState.NeedsSetup
    val dictation = readiness.dictation as GatewayTalkSetupState.Ready
    assertEquals("OpenAI Realtime", realtime.provider?.label)
    assertEquals("Deepgram", dictation.provider.label)
  }

  @Test
  fun activeProviderAliasSelectsCanonicalCatalogEntry() {
    val readiness =
      parseGatewayTalkSetupReadiness(
        catalog(
          realtime = providerGroup(id = "google", label = "Google Live", configured = true),
          transcription =
            providerGroup(
              id = "openai",
              label = "OpenAI Realtime Transcription",
              configured = true,
              activeProvider = "openai-realtime",
              aliases = listOf("openai-realtime"),
            ),
        ),
      )

    val dictation = readiness.dictation as GatewayTalkSetupState.Ready
    assertEquals("openai", dictation.provider.id)
  }

  @Test
  fun canonicalProviderIdWinsOverAnEarlierAliasCollision() {
    val readiness =
      parseGatewayTalkSetupReadiness(
        json(
          """
          {
            "realtime": {
              "ready": true,
              "activeProvider": "google",
              "providers": [
                {"id":"bridge","aliases":["google"],"label":"Bridge","configured":false},
                {"id":"google","label":"Google Live","configured":true}
              ]
            },
            "transcription": ${providerGroup(id = "deepgram", label = "Deepgram", configured = true)}
          }
          """.trimIndent(),
        ),
      )

    val realtime = readiness.realtimeTalk as GatewayTalkSetupState.Ready
    assertEquals("google", realtime.provider.id)
  }

  @Test
  fun missingActiveProviderStaysUnverifiedInsteadOfGuessingFromRowOrder() {
    val readiness =
      parseGatewayTalkSetupReadiness(
        json(
          """
          {
            "realtime": {
              "providers": [
                {"id":"google","label":"Google Live","configured":false},
                {"id":"openai","label":"OpenAI Realtime","configured":true}
              ]
            },
            "transcription": ${providerGroup(id = "deepgram", label = "Deepgram", configured = true)}
          }
          """.trimIndent(),
        ),
      )

    assertTrue(readiness.realtimeTalk is GatewayTalkSetupState.Unverified)
    assertTrue(!readiness.realtimeTalk.requiresSetup)
  }

  @Test
  fun authoritativeUnconfiguredProvidersRequireSetupWithoutAnActiveProvider() {
    val readiness =
      parseGatewayTalkSetupReadiness(
        catalog(
          realtime =
            providerGroup(
              id = "openai",
              label = "OpenAI Realtime",
              configured = false,
              activeProvider = null,
              ready = false,
            ),
          transcription = providerGroup(id = "deepgram", label = "Deepgram", configured = true),
        ),
      )

    assertTrue(readiness.realtimeTalk is GatewayTalkSetupState.NeedsSetup)
    assertTrue(readiness.realtimeTalk.requiresSetup)
  }

  @Test
  fun olderCatalogRowStateStaysUnverified() {
    val readiness =
      parseGatewayTalkSetupReadiness(
        catalog(
          realtime =
            providerGroup(
              id = "openai",
              label = "OpenAI Realtime",
              configured = false,
              ready = null,
            ),
          transcription = providerGroup(id = "deepgram", label = "Deepgram", configured = true),
        ),
      )

    assertTrue(readiness.realtimeTalk is GatewayTalkSetupState.Unverified)
    assertTrue(!readiness.realtimeTalk.requiresSetup)
  }

  @Test
  fun unknownActiveProviderStaysUnverifiedInsteadOfBlockingStartup() {
    val readiness =
      parseGatewayTalkSetupReadiness(
        catalog(
          realtime = providerGroup(id = "google", label = "Google Live", configured = true, activeProvider = "future-alias"),
          transcription = providerGroup(id = "deepgram", label = "Deepgram", configured = true),
        ),
      )

    assertTrue(readiness.realtimeTalk is GatewayTalkSetupState.Unverified)
    assertTrue(!readiness.realtimeTalk.requiresSetup)
  }

  @Test
  fun authoritativeUnknownActiveProviderRequiresSetup() {
    val readiness =
      parseGatewayTalkSetupReadiness(
        catalog(
          realtime =
            providerGroup(
              id = "google",
              label = "Google Live",
              configured = true,
              activeProvider = "removed-provider",
              ready = false,
            ),
          transcription = providerGroup(id = "deepgram", label = "Deepgram", configured = true),
        ),
      )

    val realtime = readiness.realtimeTalk as GatewayTalkSetupState.NeedsSetup
    assertEquals("Choose a supported Realtime Talk provider on the Gateway", gatewayTalkSetupDescription(realtime))
    assertTrue(readiness.realtimeTalk.requiresSetup)
  }

  @Test
  fun unknownActiveProviderWithEmptyRegistryStaysUnverified() {
    val readiness =
      parseGatewayTalkSetupReadiness(
        json(
          """
          {
            "realtime": {"activeProvider":"custom-id","providers":[]},
            "transcription": ${providerGroup(id = "deepgram", label = "Deepgram", configured = true)}
          }
          """.trimIndent(),
        ),
      )

    assertTrue(readiness.realtimeTalk is GatewayTalkSetupState.Unverified)
    assertTrue(!readiness.realtimeTalk.requiresSetup)
  }

  @Test
  fun missingCatalogIsUnverifiedForBothActions() {
    val readiness = parseGatewayTalkSetupReadiness(null)

    assertTrue(readiness.realtimeTalk is GatewayTalkSetupState.Unverified)
    assertTrue(readiness.dictation is GatewayTalkSetupState.Unverified)
  }

  private fun catalog(
    realtime: String,
    transcription: String,
  ) = json("""{"realtime":$realtime,"transcription":$transcription}""")

  private fun providerGroup(
    id: String,
    label: String,
    configured: Boolean,
    activeProvider: String? = id,
    aliases: List<String> = emptyList(),
    ready: Boolean? = configured,
  ): String {
    val active = activeProvider?.let { "\"activeProvider\":\"$it\"," }.orEmpty()
    val readiness = ready?.let { "\"ready\":$it," }.orEmpty()
    val aliasJson = aliases.joinToString(prefix = "[", postfix = "]") { "\"$it\"" }
    return """{$readiness$active"providers":[{"id":"$id","label":"$label","configured":$configured,"aliases":$aliasJson}]}"""
  }

  private fun json(value: String) = Json.parseToJsonElement(value).jsonObject
}
