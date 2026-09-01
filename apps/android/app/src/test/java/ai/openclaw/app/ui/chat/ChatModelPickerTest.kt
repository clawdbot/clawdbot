package ai.openclaw.app.ui.chat

import ai.openclaw.app.GatewayModelSummary
import ai.openclaw.app.GatewayModelUnavailableReason
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
