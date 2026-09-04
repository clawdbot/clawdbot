package ai.openclaw.app.ui.chat

import ai.openclaw.app.GatewayModelSummary
import ai.openclaw.app.GatewayModelUnavailableReason
import ai.openclaw.app.ui.design.providerBrandTintArgb
import ai.openclaw.app.ui.design.providerFallbackLabel
import ai.openclaw.app.ui.design.providerIconSlug
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class ChatModelPickerTest {
  @Test
  fun providerQualifiedRefAddsProviderOnlyWhenNeeded() {
    assertEquals("anthropic/claude-opus-4", model(id = "claude-opus-4", provider = "anthropic").providerQualifiedRef())
    assertEquals("anthropic/claude-opus-4", model(id = "anthropic/claude-opus-4", provider = "anthropic").providerQualifiedRef())
  }

  @Test
  fun sectionsPreservePinAndRecentOrderAndKeepRemainingCatalogOrder() {
    val catalog =
      listOf(
        model(id = "a", provider = "one"),
        model(id = "b", provider = "two"),
        model(id = "c", provider = "one"),
        model(id = "d", provider = "three"),
      )

    val sections =
      chatModelPickerSections(
        catalog = catalog,
        favorites = listOf("one/c", "missing/model", "one/a"),
        recents = listOf("one/a", "three/d", "missing/recent"),
      )

    assertEquals(listOf("one/c", "one/a"), sections.pinned.map { it.providerQualifiedRef() })
    assertEquals(listOf("three/d"), sections.recent.map { it.providerQualifiedRef() })
    assertEquals(listOf("two/b"), sections.remaining.map { it.providerQualifiedRef() })
  }

  @Test
  fun thinkingSupportFailsOpenUnlessMatchedModelDisablesReasoning() {
    val catalog =
      listOf(
        model(id = "reasoning", provider = "openai", supportsReasoning = true),
        model(id = "plain", provider = "openai", supportsReasoning = false),
      )

    assertTrue(thinkingSupportedForSelection(selectedModelRef = null, catalog = catalog))
    assertTrue(thinkingSupportedForSelection(selectedModelRef = "openai/unknown", catalog = catalog))
    assertTrue(thinkingSupportedForSelection(selectedModelRef = "openai/reasoning", catalog = catalog))
    assertFalse(thinkingSupportedForSelection(selectedModelRef = "openai/plain", catalog = catalog))
  }

  @Test
  fun fastModeSupportFollowsTheResolvedProviderAndExistingOverrides() {
    val catalog =
      listOf(
        model(id = "gpt-5.6", provider = "openai"),
        model(id = "claude-opus-4", provider = "anthropic"),
        model(id = "gemini-pro", provider = "google"),
      )

    val openAiSupported =
      fastModeProviderSupportedForSelection(
        selectedModelRef = "openai/gpt-5.6",
        sessionModelProvider = null,
        catalog = catalog,
      )
    val legacyCodexSupported =
      fastModeProviderSupportedForSelection(
        selectedModelRef = "openai-codex/gpt-5.6",
        sessionModelProvider = null,
        catalog = emptyList(),
      )
    val googleSupported =
      fastModeProviderSupportedForSelection(
        selectedModelRef = "google/gemini-pro",
        sessionModelProvider = null,
        catalog = catalog,
      )

    assertTrue(openAiSupported)
    assertTrue(legacyCodexSupported)
    assertFalse(googleSupported)
    assertTrue(
      fastModeSupportedForSelection(
        providerSupported = openAiSupported,
        hasConfiguredFastModeOverride = false,
      ),
    )
    assertTrue(
      fastModeSupportedForSelection(
        providerSupported = legacyCodexSupported,
        hasConfiguredFastModeOverride = false,
      ),
    )
    assertFalse(
      fastModeSupportedForSelection(
        providerSupported = googleSupported,
        hasConfiguredFastModeOverride = false,
      ),
    )
    assertTrue(
      fastModeSupportedForSelection(
        providerSupported = googleSupported,
        hasConfiguredFastModeOverride = true,
      ),
    )
  }

  @Test
  fun providerIconsFollowCanonicalWebAliasesAndSafeFallbacks() {
    mapOf(
      "amazon-bedrock" to "bedrock",
      "anthropic" to "claude",
      "aws-bedrock" to "bedrock",
      "claude-cli" to "claude",
      "cloudflare-ai-gateway" to "cloudflare",
      "copilot-proxy" to "copilot",
      "github-copilot" to "copilot",
      "google" to "gemini",
      "google-gemini-cli" to "gemini",
      "kilocode" to "kilo",
      "kimi-coding" to "kimi",
      "microsoft-foundry" to "microsoft",
      "minimax-portal" to "minimax",
      "moonshot" to "kimi",
      "ollama-cloud" to "ollama",
      "open-router" to "openrouter",
      "openai" to "codex",
      "qwen" to "alibaba",
      "qwen-token-plan" to "alibaba",
      "stepfun-plan" to "stepfun",
      "tencent-tokenhub" to "tencent",
      "tencent-tokenplan" to "tencent",
      "vercel-ai-gateway" to "vercel",
      "vertex-ai" to "vertexai",
      "xAI" to "grok",
      "xiaomi" to "mimo",
      "xiaomi-token-plan" to "mimo",
    ).forEach { (provider, slug) ->
      assertEquals(provider, slug, providerIconSlug(provider))
    }
    assertEquals("O", providerFallbackLabel(" openai"))
    assertEquals("", providerFallbackLabel(" -- "))
    assertEquals(0xFF10A37FL, providerBrandTintArgb("codex"))
    assertEquals(0xFFD97757L, providerBrandTintArgb("claude"))
    assertEquals(0xFF4285F4L, providerBrandTintArgb("gemini"))
    assertEquals(null, providerBrandTintArgb("openrouter"))
  }

  @Test
  fun unavailableReasonRequiresEveryMatchingRouteToBePermanentlyUnavailable() {
    val missing = model(id = "chat", provider = "synthetic", available = false, reason = GatewayModelUnavailableReason.MissingAuth)
    val failed = missing.copy(unavailableReason = GatewayModelUnavailableReason.AuthFailed)
    val cooling = missing.copy(unavailableReason = GatewayModelUnavailableReason.Cooldown)

    assertEquals(GatewayModelUnavailableReason.MissingAuth, selectedChatModelSendUnavailableReason("synthetic/chat", listOf(missing)))
    assertEquals(GatewayModelUnavailableReason.AuthFailed, selectedChatModelSendUnavailableReason("SYNTHETIC/CHAT", listOf(missing, failed)))
    assertEquals(GatewayModelUnavailableReason.Cooldown, selectedChatModelUnavailableReason("synthetic/chat", listOf(failed, cooling)))
    assertEquals(null, selectedChatModelSendUnavailableReason("synthetic/chat", listOf(failed, cooling)))
    assertEquals(null, selectedChatModelUnavailableReason("synthetic/chat", listOf(missing, missing.copy(available = true))))
    assertEquals(null, selectedChatModelUnavailableReason("synthetic/chat", listOf(missing, missing.copy(unavailableReason = null))))
    assertEquals(null, selectedChatModelUnavailableReason("synthetic/unknown", listOf(missing)))
  }

  @Test
  fun pickerRoutesAuthFailuresToProvidersAndDisablesOtherUnavailableRows() {
    assertEquals(ChatModelPickerAction.Select, chatModelPickerAction(model(id = "ready", provider = "synthetic")))
    assertEquals(
      ChatModelPickerAction.OpenProviders,
      chatModelPickerAction(model(id = "missing", provider = "synthetic", available = false, reason = GatewayModelUnavailableReason.MissingAuth)),
    )
    assertEquals(
      ChatModelPickerAction.Disabled,
      chatModelPickerAction(model(id = "cooling", provider = "synthetic", available = false, reason = GatewayModelUnavailableReason.Cooldown)),
    )
    assertEquals(ChatModelPickerAction.Disabled, chatModelPickerAction(model(id = "unknown", provider = "synthetic", available = false)))
  }

  @Test
  fun permanentAuthGateFailsOpenWhenGatewayIsNotReady() {
    val missing = model(id = "chat", provider = "synthetic", available = false, reason = GatewayModelUnavailableReason.MissingAuth)

    assertEquals(
      GatewayModelUnavailableReason.MissingAuth,
      selectedChatModelSendBlockingReason(gatewayReady = true, selectedModelRef = "synthetic/chat", catalog = listOf(missing)),
    )
    assertEquals(
      null,
      selectedChatModelSendBlockingReason(gatewayReady = false, selectedModelRef = "synthetic/chat", catalog = listOf(missing)),
    )
    assertTrue(chatModelSendBlocked(gatewayReady = true, selectedModelRef = "synthetic/chat", catalog = listOf(missing)))
    assertFalse(chatModelSendBlocked(gatewayReady = false, selectedModelRef = "synthetic/chat", catalog = listOf(missing)))
    assertEquals(
      null,
      chatModelUnavailableText(
        selectedChatModelSendBlockingReason(gatewayReady = false, selectedModelRef = "synthetic/chat", catalog = listOf(missing)),
      ),
    )
  }

  private fun model(
    id: String,
    provider: String,
    supportsReasoning: Boolean = false,
    available: Boolean? = true,
    reason: GatewayModelUnavailableReason? = null,
  ): GatewayModelSummary =
    GatewayModelSummary(
      id = id,
      name = id.substringAfterLast('/'),
      provider = provider,
      available = available,
      unavailableReason = reason,
      supportsVision = false,
      supportsAudio = false,
      supportsVideo = false,
      supportsDocuments = false,
      supportsReasoning = supportsReasoning,
      contextTokens = null,
    )
}
