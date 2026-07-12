package ai.openclaw.app.ui.chat

import ai.openclaw.app.chat.ChatSessionEntry
import ai.openclaw.app.chat.ChatThinkingLevelOption
import ai.openclaw.app.chat.ChatThinkingLevelSelection
import ai.openclaw.app.i18n.NativeText
import ai.openclaw.app.i18n.resolveNativeText
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class ChatContextMeterTest {
  @Test
  fun starterPromptsKeepCatalogSourcesThroughTheSendBoundary() {
    assertTrue(starterPrompts.all { it.title is NativeText.Resource })
    assertTrue(starterPrompts.all { it.subtitle is NativeText.Resource })
    assertTrue(starterPrompts.all { it.message is NativeText.Resource })
    assertEquals(
      "Catch me up on my recent OpenClaw sessions and suggest next steps.",
      starterPrompts.first().message.resolveNativeText(),
    )
  }

  @Test
  fun contextMeterUsesActiveSessionTokenBudget() {
    val sessions =
      listOf(
        ChatSessionEntry(key = "main", updatedAtMs = 1L, displayName = "Main", totalTokens = 8_000L, totalTokensFresh = true, contextTokens = 10_000L),
        ChatSessionEntry(
          key = "agent:main:mobile:test-device",
          updatedAtMs = 2L,
          displayName = "Phone",
          totalTokens = 1_250L,
          totalTokensFresh = true,
          contextTokens = 5_000L,
        ),
      )

    val usage =
      resolveChatContextUsage(
        sessionKey = "agent:main:mobile:test-device",
        mainSessionKey = "main",
        sessions = sessions,
      )

    assertEquals(ChatContextUsage(totalTokens = 1_250L, totalTokensFresh = true, contextTokens = 5_000L), usage)
    assertEquals(0.25f, contextMeterWidth(usage))
    assertEquals("Context 25% · High", contextMeterLabel(usage, "high"))
  }

  @Test
  fun contextMeterResolvesCanonicalMainAlias() {
    val sessions =
      listOf(
        ChatSessionEntry(
          key = "agent:main:node-phone",
          updatedAtMs = 1L,
          displayName = "Main",
          totalTokens = 41_000L,
          totalTokensFresh = true,
          contextTokens = 100_000L,
        ),
      )

    val usage =
      resolveChatContextUsage(
        sessionKey = "main",
        mainSessionKey = "agent:main:node-phone",
        sessions = sessions,
      )

    assertEquals(ChatContextUsage(totalTokens = 41_000L, totalTokensFresh = true, contextTokens = 100_000L), usage)
    assertEquals("Context 41% · Off", contextMeterLabel(usage, "off"))
  }

  @Test
  fun contextMeterDoesNotInventPercentWhenBudgetIsMissing() {
    val usage = ChatContextUsage(totalTokens = 8_200L, totalTokensFresh = true, contextTokens = null)

    assertNull(contextMeterWidth(usage))
    assertEquals("Context -- · Medium", contextMeterLabel(usage, "medium"))
  }

  @Test
  fun contextMeterClampsOverfullSessions() {
    val usage = ChatContextUsage(totalTokens = 150_000L, totalTokensFresh = true, contextTokens = 100_000L)

    assertEquals(1.0f, contextMeterWidth(usage))
    assertEquals("Context 100% · Low", contextMeterLabel(usage, "low"))
  }

  @Test
  fun contextMeterDoesNotDisplayStaleTokenUsage() {
    val usage = ChatContextUsage(totalTokens = 82_000L, totalTokensFresh = false, contextTokens = 100_000L)

    assertNull(contextMeterWidth(usage))
    assertEquals("Context -- · High", contextMeterLabel(usage, "high"))
  }

  @Test
  fun contextMeterHidesThinkingLabelWhenUnsupported() {
    val usage = ChatContextUsage(totalTokens = 2_500L, totalTokensFresh = true, contextTokens = 10_000L)

    assertEquals("Context 25%", contextMeterLabel(usage, "high", thinkingSupported = false))
  }

  @Test
  fun contextMeterPreservesGatewayThinkingLevelIds() {
    val usage = ChatContextUsage(totalTokens = null, totalTokensFresh = null, contextTokens = null)

    assertEquals("Context -- · xhigh", contextMeterLabel(usage, "xhigh"))
    assertEquals("Context -- · adaptive", contextMeterLabel(usage, "adaptive"))
    assertEquals("Context -- · ultra", contextMeterLabel(usage, "ultra"))
  }

  @Test
  fun gatewayThinkingOptionsAreAuthoritativeForSupport() {
    val offOnly =
      ChatThinkingLevelSelection(
        options = listOf(ChatThinkingLevelOption(id = "off", label = "off")),
        isGatewayProvided = true,
      )
    val max =
      ChatThinkingLevelSelection(
        options =
          listOf(
            ChatThinkingLevelOption(id = "off", label = "off"),
            ChatThinkingLevelOption(id = "max", label = "max"),
          ),
        isGatewayProvided = true,
      )
    val fallback =
      ChatThinkingLevelSelection(
        options = emptyList(),
        isGatewayProvided = false,
      )

    assertFalse(chatThinkingSupported(offOnly, fallbackSupported = true))
    assertTrue(chatThinkingSupported(max, fallbackSupported = false))
    assertTrue(chatThinkingSupported(fallback, fallbackSupported = true))
  }

  @Test
  fun largeThinkingProfilesSplitIntoBalancedInlineRows() {
    val options =
      listOf("off", "minimal", "low", "medium", "high", "xhigh", "adaptive", "max")
        .map { ChatThinkingLevelOption(id = it, label = it) }

    val rows = chatThinkingOptionRows(options)

    assertEquals(listOf(4, 4), rows.map { it.size })
    assertEquals("Minimal", chatThinkingOptionLabel(options[1]))
    assertEquals("Xhigh", chatThinkingOptionLabel(options[5]))
    assertEquals("Adaptive", chatThinkingOptionLabel(options[6]))
    assertEquals("Max", chatThinkingOptionLabel(options.last()))
  }
}
