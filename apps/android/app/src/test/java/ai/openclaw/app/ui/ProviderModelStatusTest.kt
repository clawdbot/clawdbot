package ai.openclaw.app.ui

import ai.openclaw.app.GatewayModelProviderSummary
import ai.openclaw.app.GatewayModelSummary
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class ProviderModelStatusTest {
  @Test
  fun staticProviderStatusIsReady() {
    assertTrue(modelProviderReady("static"))
  }

  @Test
  fun expiringProviderStatusIsNotFullyReady() {
    assertFalse(modelProviderReady("expiring"))
  }

  @Test
  fun missingProviderStatusIsNotReady() {
    assertFalse(modelProviderReady("missing"))
  }

  @Test
  fun readyModelProviderCountUsesAuthBackedProviderStatuses() {
    val providers =
      listOf(
        GatewayModelProviderSummary(id = "openai", displayName = "OpenAI", status = "missing", profileCount = 0),
        GatewayModelProviderSummary(id = "anthropic", displayName = "Anthropic", status = "ready", profileCount = 1),
        GatewayModelProviderSummary(id = "openai", displayName = "OpenAI", status = "expiring", profileCount = 1),
      )

    assertEquals(1, readyModelProviderCount(providers, emptyList()))
    assertEquals(1, expiringModelProviderCount(providers))
  }

  @Test
  fun readyModelProviderCountUsesAvailableModelsAsServingReadiness() {
    val models =
      listOf(
        model(provider = "anthropic", available = true),
        model(provider = "anthropic", available = true),
        model(provider = "openrouter", available = false),
      )

    assertEquals(1, readyModelProviderCount(emptyList(), models))
  }

  @Test
  fun readyModelProviderCountDoesNotTreatCatalogOnlyModelsAsReady() {
    val providers =
      listOf(
        GatewayModelProviderSummary(id = "openrouter", displayName = "OpenRouter", status = "missing", profileCount = 0),
      )
    val models =
      listOf(
        model(provider = "openrouter", available = false),
      )

    assertEquals(0, readyModelProviderCount(providers, models))
  }

  @Test
  fun readyModelProviderCountPreservesLegacyRowsWhenAvailabilityIsMissing() {
    val models =
      listOf(
        model(provider = "openrouter", available = null),
      )

    assertEquals(1, readyModelProviderCount(emptyList(), models))
  }

  @Test
  fun readyModelProviderCountTreatsExpiringAvailableModelsAsUsableButWarnable() {
    val providers =
      listOf(
        GatewayModelProviderSummary(id = "openai", displayName = "OpenAI", status = "expiring", profileCount = 1),
      )
    val models =
      listOf(
        model(provider = "openai", available = true),
      )

    assertEquals(1, readyModelProviderCount(providers, models))
    assertEquals(1, expiringModelProviderCount(providers))
    assertFalse(modelProviderReady("expiring"))
  }

  @Test
  fun providerCommandSubtitleSurfacesExpiringBeforeReadyModels() {
    val providers =
      listOf(
        GatewayModelProviderSummary(id = "openai", displayName = "OpenAI", status = "expiring", profileCount = 1),
      )
    val models =
      listOf(
        model(provider = "openai", available = true),
      )

    assertEquals("1 providers expiring", providerCommandSubtitle(isConnected = true, providers = providers, models = models))
  }

  @Test
  fun readyModelProviderCountDoesNotTreatUnavailableModelsAsReadyWhenAuthProviderNeedsSetup() {
    val providers =
      listOf(
        GatewayModelProviderSummary(id = "openai", displayName = "OpenAI", status = "missing", profileCount = 0),
      )
    val models =
      listOf(
        model(provider = "openai", available = false),
      )

    assertEquals(0, readyModelProviderCount(providers, models))
  }

  @Test
  fun modelAvailabilityHonorsExplicitUnavailableRows() {
    assertTrue(modelAvailabilityUsable(model(provider = "openai", available = true)))
    assertTrue(modelAvailabilityUsable(model(provider = "openai", available = null)))
    assertFalse(modelAvailabilityUsable(model(provider = "openai", available = false)))
  }

  private fun model(
    provider: String,
    available: Boolean?,
  ): GatewayModelSummary =
    GatewayModelSummary(
      id = "$provider/test-model",
      name = "test-model",
      provider = provider,
      available = available,
      supportsVision = false,
      supportsAudio = false,
      supportsDocuments = false,
      supportsReasoning = false,
      contextTokens = null,
    )
}
