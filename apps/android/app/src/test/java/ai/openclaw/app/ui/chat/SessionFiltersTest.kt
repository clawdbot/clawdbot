package ai.openclaw.app.ui.chat

import ai.openclaw.app.chat.ChatSessionEntry
import org.junit.Assert.assertEquals
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
}
