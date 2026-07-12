package ai.openclaw.app.ui

import ai.openclaw.app.GatewayModelProviderSummary
import ai.openclaw.app.GatewayModelSummary
import ai.openclaw.app.parseGatewayModels
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.jsonArray
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
    assertEquals(listOf("gpt-5.5"), rows.first { it.id == "openai" }.models.map { it.id })
    assertEquals(listOf("seed-1-8-251228"), rows.first { it.id == "byteplus" }.models.map { it.id })
    assertEquals(ProviderAvailability.Unknown, rows.first { it.id == "byteplus" }.availability)
    assertFalse(rows.first { it.id == "byteplus" }.ready)
  }

  @Test
  fun providerRowsPreserveReadyAuthProvidersWithoutConfiguredModels() {
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
        models = emptyList(),
      )

    assertEquals(ProviderAvailability.Available, rows.single().availability)
    assertTrue(rows.single().ready)
    assertTrue(rows.single().models.isEmpty())
  }

  @Test
  fun unknownModelAvailabilityIsNotUpgradedByProviderAuth() {
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
        models = listOf(model(provider = "openai", id = "gpt-5.5")),
      )

    assertEquals(ProviderAvailability.Unknown, rows.single().availability)
    assertEquals("Unknown", rows.single().status)
    assertFalse(rows.single().ready)
  }

  @Test
  fun unavailableModelsOverrideReadyProviderAuth() {
    val rows =
      providerRows(
        providers =
          listOf(
            GatewayModelProviderSummary(
              id = "custom",
              displayName = "Custom",
              status = "ok",
              profileCount = 1,
            ),
          ),
        models = listOf(model(provider = "custom", id = "offline-model", available = false)),
      )

    assertEquals(ProviderAvailability.Unavailable, rows.single().availability)
    assertEquals("Needs attention", rows.single().status)
    assertFalse(rows.single().ready)
  }

  @Test
  fun oneAvailableRouteMakesProviderReadyAndModelsSortByName() {
    val rows =
      providerRows(
        providers = emptyList(),
        models =
          listOf(
            model(provider = "custom", id = "zeta", name = "Zeta", available = null),
            model(provider = "custom", id = "alpha", name = "Alpha", available = true),
          ),
      )

    assertEquals(ProviderAvailability.Available, rows.single().availability)
    assertEquals(listOf("alpha", "zeta"), rows.single().models.map { it.id })
    assertTrue(rows.single().ready)
  }

  @Test
  fun commandSubtitleDoesNotReportUnknownModelsAsReady() {
    val providers =
      listOf(
        GatewayModelProviderSummary(
          id = "openai",
          displayName = "OpenAI",
          status = "ok",
          profileCount = 1,
        ),
      )

    assertEquals(
      "Provider availability unknown",
      providerCommandSubtitle(
        isConnected = true,
        providers = providers,
        models = listOf(model(provider = "openai", id = "gpt-5.5")),
      ),
    )
  }

  @Test
  fun videoCapabilitySurvivesGatewayParsingAndRendering() {
    val payload =
      Json
        .parseToJsonElement(
          """[{"id":"video-model","name":"Video Model","provider":"openai","input":["text","video"]}]""",
        ).jsonArray
    val model = parseGatewayModels(payload).single()

    assertTrue(model.supportsVideo)
    assertEquals("video", modelCapabilities(model))
  }

  private fun model(
    provider: String,
    id: String,
    name: String = id,
    available: Boolean? = null,
  ): GatewayModelSummary =
    GatewayModelSummary(
      id = id,
      name = name,
      provider = provider,
      supportsVision = false,
      supportsAudio = false,
      supportsVideo = false,
      supportsDocuments = false,
      supportsReasoning = false,
      contextTokens = null,
      available = available,
    )
}
