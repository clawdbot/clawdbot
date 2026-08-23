package ai.openclaw.app.ui.chat

import ai.openclaw.app.chat.ChatSessionEntry
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class SessionFiltersTest {
  @Test
  fun sessionChoicesPreferMainAndRecent() {
    val now = 1_700_000_000_000L
    val recent1 = now - 2 * 60 * 60 * 1000L
    val recent2 = now - 5 * 60 * 60 * 1000L
    val stale = now - 26 * 60 * 60 * 1000L
    val sessions =
      listOf(
        ChatSessionEntry(key = "recent-1", updatedAtMs = recent1),
        ChatSessionEntry(key = "main", updatedAtMs = stale),
        ChatSessionEntry(key = "old-1", updatedAtMs = stale),
        ChatSessionEntry(key = "recent-2", updatedAtMs = recent2),
      )

    val result = resolveSessionChoices("main", sessions, mainSessionKey = "main", nowMs = now).map { it.key }
    assertEquals(listOf("main", "recent-1", "recent-2"), result)
  }

  @Test
  fun sessionChoicesIncludeCurrentWhenMissing() {
    val now = 1_700_000_000_000L
    val recent = now - 10 * 60 * 1000L
    val sessions = listOf(ChatSessionEntry(key = "main", updatedAtMs = recent))

    val result = resolveSessionChoices("custom", sessions, mainSessionKey = "main", nowMs = now).map { it.key }
    assertEquals(listOf("main", "custom"), result)
  }

  @Test
  fun compactChoicesKeepMainAndCurrentWhileCappingRecentSessions() {
    val now = 1_700_000_000_000L
    val sessions =
      listOf(
        ChatSessionEntry(key = "recent-1", updatedAtMs = now - 1),
        ChatSessionEntry(key = "recent-2", updatedAtMs = now - 2),
        ChatSessionEntry(key = "recent-3", updatedAtMs = now - 3),
        ChatSessionEntry(key = "recent-4", updatedAtMs = now - 4),
        ChatSessionEntry(key = "main", updatedAtMs = now - 5),
        ChatSessionEntry(key = "active-old", updatedAtMs = now - 30 * 60 * 60 * 1000L),
      )

    val result =
      resolveCompactSessionChoices(
        currentSessionKey = "active-old",
        sessions = sessions,
        mainSessionKey = "main",
        nowMs = now,
        maxOptions = 4,
      ).map { it.key }

    assertEquals(listOf("main", "active-old", "recent-1", "recent-2"), result)
  }

  @Test
  fun sessionChoicesFilterAgentDeviceAndInternalSessions() {
    val now = 1_700_000_000_000L
    val recent = now - 10 * 60 * 1000L
    val sessions =
      listOf(
        ChatSessionEntry(key = "agent:main:node-android", updatedAtMs = recent),
        ChatSessionEntry(key = "agent:main:slack:channel:C1", updatedAtMs = recent),
        ChatSessionEntry(key = "agent:main:main", updatedAtMs = recent),
        ChatSessionEntry(key = "main", updatedAtMs = recent),
      )

    val result =
      resolveSessionChoices(
        "agent:main:node-current",
        sessions,
        mainSessionKey = "main",
        nowMs = now,
      ).map { it.key }

    assertEquals(listOf("main", "agent:main:slack:channel:C1"), result)
  }

  @Test
  fun additionalChoicesIgnoreHiddenSessionsButIncludeStaleChats() {
    val displayed = listOf(ChatSessionEntry(key = "main", updatedAtMs = null))
    val hiddenOnly =
      listOf(
        ChatSessionEntry(key = "main", updatedAtMs = null),
        ChatSessionEntry(key = "agent:main:node-android", updatedAtMs = null),
        ChatSessionEntry(key = "agent:main:onboarding", updatedAtMs = null),
      )
    assertFalse(hasAdditionalSessionChoices(hiddenOnly, displayed, mainSessionKey = "main"))

    val withStaleChat = hiddenOnly + ChatSessionEntry(key = "old-channel", updatedAtMs = 1L)
    assertTrue(hasAdditionalSessionChoices(withStaleChat, displayed, mainSessionKey = "main"))
  }

  @Test
  fun isSelectableChatSession_matchesIosRecentSessionFilter() {
    val hidden =
      listOf(
        "main" to "main",
        "agent:main:main" to "main",
        "agent:rust-claw:main" to "main",
        "agent:main:node-0b88d67b7e42" to "main",
        "agent:main:work" to "work",
        "main" to "agent:rust-claw:work",
        "global" to "agent:rust-claw:work",
        "node-0b88d67b7e42" to "agent:rust-claw:work",
        "work" to "agent:rust-claw:work",
        "agent:main:work" to "agent:rust-claw:work",
        "agent:main:main:thread:42" to "main",
        "agent:support:main:thread:1234:42" to "main",
        "agent:main:node-0b88d67b7e42:thread:42" to "main",
        "agent:main:work:thread:42" to "work",
        "agent:main:work:thread:42" to "agent:rust-claw:work",
        "onboarding" to "main",
        "agent:main:onboarding" to "main",
      )
    for ((key, mainKey) in hidden) {
      assertFalse("expected hidden session: $key (main: $mainKey)", isSelectableChatSession(key, mainKey))
    }

    val selectable =
      listOf(
        "agent:main:signal:direct:+15555550123",
        "agent:rust-claw:mattermost:channel:abc123",
        "agent:rust-claw:cron:3cd2eb6f-b8a5-4db7-b74a-f6a3f7eab3d3",
        "agent:main:slack:channel:c1:thread:123",
      )
    for (key in selectable) {
      assertTrue("expected selectable session: $key", isSelectableChatSession(key, "main"))
    }
  }
}
