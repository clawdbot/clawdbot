package ai.openclaw.app.ui.chat

import ai.openclaw.app.chat.ChatMessage
import ai.openclaw.app.chat.ChatMessageContent
import ai.openclaw.app.chat.ChatMessageCost
import ai.openclaw.app.chat.ChatMessageUsage
import ai.openclaw.app.chat.ChatSessionEntry
import ai.openclaw.app.chat.ChatThinkingLevelOption
import ai.openclaw.app.chat.ChatThinkingLevelSelection
import ai.openclaw.app.chat.ChatTranscriptMarker
import ai.openclaw.app.i18n.NativeText
import ai.openclaw.app.i18n.resolveNativeText
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.util.Locale

class ChatContextMeterTest {
  @Test
  fun starterPromptsKeepCatalogSourcesThroughTheSendBoundary() {
    assertTrue(starterPrompts.all { it.title is NativeText.Resource })
    assertTrue(starterPrompts.all { it.subtitle is NativeText.Resource })
    assertTrue(starterPrompts.all { it.message is NativeText.Resource })
    assertEquals(
      "Catch me up on my recent OpenClaw threads and suggest next steps.",
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
  }

  @Test
  fun contextMeterDoesNotInventPercentWhenBudgetIsMissing() {
    val usage = ChatContextUsage(totalTokens = 8_200L, totalTokensFresh = true, contextTokens = null)

    assertNull(contextMeterWidth(usage))
  }

  @Test
  fun contextMeterClampsOverfullSessions() {
    val usage = ChatContextUsage(totalTokens = 150_000L, totalTokensFresh = true, contextTokens = 100_000L)

    assertEquals(1.0f, contextMeterWidth(usage))
  }

  @Test
  fun contextMeterKeepsApproximateWidthForStaleTokenUsage() {
    val usage = ChatContextUsage(totalTokens = 82_000L, totalTokensFresh = false, contextTokens = 100_000L)

    assertEquals(0.82f, contextMeterWidth(usage))
  }

  @Test
  fun contextSummaryMarksStaleUsage() {
    val fresh =
      requireNotNull(
        chatContextSummary(
          ChatContextUsage(totalTokens = 109_800L, totalTokensFresh = true, contextTokens = 272_000L),
          Locale.US,
        ),
      )
    val stale =
      requireNotNull(
        chatContextSummary(
          ChatContextUsage(totalTokens = 82_000L, totalTokensFresh = false, contextTokens = 100_000L),
          Locale.US,
        ),
      )

    assertEquals("109.8k / 272k \u00b7 40%", fresh.detail)
    assertFalse(fresh.approximate)
    assertEquals("~82k / 100k \u00b7 ~82%", stale.detail)
    assertTrue(stale.approximate)
  }

  @Test
  fun contextDetailsFormatGatewayUsageWithoutInventingData() {
    assertEquals("18.4k", formatContextUsageTokens(18_420L, Locale.US))
    assertEquals("\u2014", formatContextUsageTokens(null, Locale.US))
    assertEquals("\u00240.0063", formatContextEstimatedCost(0.0063))
    assertEquals("\u00240.063", formatContextEstimatedCost(0.063))
    assertEquals("\u00241.25", formatContextEstimatedCost(1.25))
    assertEquals("\u2014", formatContextEstimatedCost(null))
    assertEquals("\u2014", formatContextEstimatedCost(Double.NaN))
    assertEquals("\u2014", formatContextEstimatedCost(-0.5))
  }

  @Test
  fun optionalUsageUsesNewestRealAssistantAndOnlyObservedValues() {
    val costs =
      ChatMessageCost(
        input = 0.003456,
        output = 0.018,
        cacheRead = 0.0015,
        cacheWrite = 0.0,
      )
    val usage = ChatMessageUsage(input = 18_420, output = 840, cacheRead = 76_500)
    val messages =
      listOf(
        message(role = "user"),
        message(role = "assistant", usage = usage, cost = costs),
        message(role = "assistant", provider = "openclaw", model = "gateway-injected", cost = ChatMessageCost()),
      )

    assertEquals(usage, latestChatMessageUsage(messages))
    assertEquals(costs, latestChatMessageCost(messages))
    assertEquals(
      listOf("Input cost" to 0.003456, "Output cost" to 0.018, "Cache read cost" to 0.0015, "Cache write cost" to 0.0),
      availableChatCostStats(costs),
    )
    assertEquals(listOf("Est. cost" to 0.0225), availableChatCostStats(ChatMessageCost(total = 0.0225)))
    assertEquals(costs, latestChatMessageCost(messages + message(role = "user")))

    val withoutSessionCost =
      resolveChatContextUsage(
        "main",
        "main",
        listOf(ChatSessionEntry(key = "main", updatedAtMs = 1L)),
      )
    assertNull(withoutSessionCost.estimatedCostUsd)
    assertEquals(0.0225, latestChatMessageCost(listOf(message(role = "assistant", cost = ChatMessageCost(total = 0.0225))))?.total)
  }

  @Test
  fun latestRunUsesSessionTotalsBeforeTranscriptLoads() {
    val session =
      ChatSessionEntry(
        key = "main",
        updatedAtMs = 2L,
        inputTokens = 18_420L,
        outputTokens = 840L,
        estimatedCostUsd = 0.022956,
      )

    assertEquals(
      ChatContextUsage(
        totalTokens = null,
        totalTokensFresh = null,
        contextTokens = null,
        inputTokens = 18_420L,
        outputTokens = 840L,
        estimatedCostUsd = 0.022956,
      ),
      resolveChatContextUsage("main", "main", listOf(session)),
    )
  }

  @Test
  fun latestRunUsesCumulativeSessionTotalsAcrossModelCalls() {
    val session =
      ChatSessionEntry(
        key = "main",
        updatedAtMs = 2L,
        inputTokens = 18_420L,
        outputTokens = 840L,
        estimatedCostUsd = 0.022956,
      )
    val finalModelCall =
      message(
        role = "assistant",
        usage = ChatMessageUsage(input = 2_100L, output = 160L, cacheRead = 76_500L),
        cost = ChatMessageCost(input = 0.003, output = 0.004, cacheRead = 0.0015, total = 0.0085),
      )

    val usage = resolveChatContextUsage("main", "main", listOf(session))

    assertEquals(18_420L, usage.inputTokens)
    assertEquals(840L, usage.outputTokens)
    assertEquals(0.022956, usage.estimatedCostUsd)
    assertEquals(76_500L, latestChatMessageUsage(listOf(finalModelCall))?.cacheRead)
    assertEquals(0.0085, latestChatMessageCost(listOf(finalModelCall))?.total)
  }

  @Test
  fun modelCallDetailsClearAtBoundariesWithoutInheritingOlderUsage() {
    val old = message("assistant", usage = ChatMessageUsage(input = 1200L), cost = ChatMessageCost(total = 0.01))
    for (kind in listOf("compaction", "reset")) {
      val boundary = message("system").copy(transcriptMarker = ChatTranscriptMarker(kind = kind))
      assertNull(latestChatMessageUsage(listOf(old, boundary)))
      assertNull(latestChatMessageCost(listOf(old, boundary)))
      val next = message("assistant", usage = ChatMessageUsage(output = 160L))
      assertEquals(ChatMessageUsage(output = 160L), latestChatMessageUsage(listOf(old, boundary, next)))
      assertNull(latestChatMessageCost(listOf(old, boundary, next)))
      assertNull(latestChatMessageUsage(listOf(old, boundary, message("assistant"))))
    }
  }

  private fun message(
    role: String,
    provider: String? = null,
    model: String? = null,
    usage: ChatMessageUsage? = null,
    cost: ChatMessageCost? = null,
  ) = ChatMessage(
    id = "$role-${provider.orEmpty()}-${model.orEmpty()}",
    role = role,
    content = listOf(ChatMessageContent(text = role)),
    timestampMs = null,
    provider = provider,
    model = model,
    usage = usage,
    cost = cost,
  )

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
  fun thinkingOptionsKeepLocalizedKnownLevelsAndGatewayLabels() {
    listOf("Off", "Minimal", "Low", "Medium", "High", "Xhigh", "Adaptive", "Max", "Ultra").forEach { label ->
      assertEquals(label, chatThinkingOptionLabel(ChatThinkingLevelOption(id = label.lowercase(), label = label.lowercase())))
    }
    assertEquals("Custom effort", chatThinkingOptionLabel(ChatThinkingLevelOption(id = "custom", label = "Custom effort")))
  }
}
