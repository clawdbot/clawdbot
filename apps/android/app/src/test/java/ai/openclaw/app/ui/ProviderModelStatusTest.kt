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
  fun providerRowsIncludeConfiguredModelProvidersWithoutAuthRows() {
    val rows =
      providerRows(
        providers =
          listOf(
            GatewayModelProviderSummary(
              id = "openai",
              displayName = "OpenAI",
              status = "ok",
              profileCount = 1,
            ),
          ),
        models =
          listOf(
            model(provider = "openai", id = "gpt-5.5"),
            model(provider = "byteplus", id = "seed-1-8-251228"),
          ),
      )

    assertEquals(listOf("openai", "byteplus"), rows.map { it.id })
    assertEquals(1, rows.first { it.id == "openai" }.modelCount)
    assertEquals(1, rows.first { it.id == "byteplus" }.modelCount)
    assertTrue(rows.first { it.id == "byteplus" }.ready)
  }

  private fun model(
    provider: String,
    id: String,
  ): GatewayModelSummary =
    GatewayModelSummary(
      id = id,
      name = id,
      provider = provider,
      supportsVision = false,
      supportsAudio = false,
      supportsDocuments = false,
      supportsReasoning = false,
      contextTokens = null,
      available = null,
    )
}
