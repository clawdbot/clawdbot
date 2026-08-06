package ai.openclaw.app.ui.chat

import ai.openclaw.app.GatewayModelSummary
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

  private fun model(
    id: String,
    provider: String,
    supportsReasoning: Boolean = false,
  ): GatewayModelSummary =
    GatewayModelSummary(
      id = id,
      name = id.substringAfterLast('/'),
      provider = provider,
      available = true,
      supportsVision = false,
      supportsAudio = false,
      supportsVideo = false,
      supportsDocuments = false,
      supportsReasoning = supportsReasoning,
      contextTokens = null,
    )
}
