package ai.openclaw.app.ui

import ai.openclaw.app.AppearanceThemeFamily
import ai.openclaw.app.GatewayAgentSummary
import ai.openclaw.app.chat.ChatSessionEntry
import ai.openclaw.app.ui.design.clawColorsForTheme
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class SidebarShellLogicTest {
  @Test
  fun sidebarPaletteUsesEveryActiveThemeAndAccentToken() {
    AppearanceThemeFamily.entries.forEach { family ->
      listOf(false, true).forEach { dark ->
        val colors =
          clawColorsForTheme(
            dark = dark,
            family = family,
            accentArgb = 0xFF2563EBL,
          )
        val palette = sidebarPalette(colors)

        assertEquals(colors.canvas, palette.background)
        assertEquals(colors.surfaceRaised, palette.elevated)
        assertEquals(colors.accentSoft, palette.selection)
        assertEquals(colors.text, palette.text)
        assertEquals(colors.textMuted, palette.muted)
        assertEquals(colors.border, palette.hairline)
      }
    }
  }

  @Test
  fun storedSidebarOrderAppendsMissingDestinationsInCanonicalOrder() {
    assertEquals(
      listOf(
        SidebarDestination.Threads,
        SidebarDestination.Home,
        SidebarDestination.Settings,
        SidebarDestination.Work,
        SidebarDestination.Skills,
      ),
      orderedSidebarDestinations(listOf("threads", "home", "threads", "unknown")),
    )
  }

  @Test
  fun reorderMovesOnePositionAndKeepsCanonicalDestinations() {
    val initial = listOf("settings", "work", "home", "skills", "threads")

    assertEquals(
      listOf("work", "settings", "home", "skills", "threads"),
      moveSidebarDestination(initial, destinationId = "work", direction = -1),
    )
    assertEquals(
      listOf("settings", "home", "work", "skills", "threads"),
      moveSidebarDestination(initial, destinationId = "work", direction = 1),
    )
    assertEquals(
      initial,
      moveSidebarDestination(initial, destinationId = "settings", direction = -1),
    )
    assertEquals(
      initial,
      moveSidebarDestination(initial, destinationId = "missing", direction = 1),
    )
  }

  @Test
  fun sessionDragMutatesOnlyTowardARealSidebarDestination() {
    assertEquals(true, sidebarSessionPinnedAfterDrag(SidebarSessionDragSource.Catalog, direction = -1))
    assertNull(sidebarSessionPinnedAfterDrag(SidebarSessionDragSource.Catalog, direction = 1))
    assertEquals(false, sidebarSessionPinnedAfterDrag(SidebarSessionDragSource.Catalog, direction = 1, currentlyPinned = true))
    assertNull(sidebarSessionPinnedAfterDrag(SidebarSessionDragSource.Catalog, direction = -1, currentlyPinned = true))
    assertEquals(false, sidebarSessionPinnedAfterDrag(SidebarSessionDragSource.Pinned, direction = 1))
    assertNull(sidebarSessionPinnedAfterDrag(SidebarSessionDragSource.Pinned, direction = -1))
    assertEquals(true, sidebarSessionPinnedAfterDrag(SidebarSessionDragSource.Recent, direction = -1))
    assertNull(sidebarSessionPinnedAfterDrag(SidebarSessionDragSource.Recent, direction = 1))
  }

  @Test
  fun pinnedItemVisibilityKeepsCanonicalOrderAndAtLeastOnePage() {
    assertEquals(
      listOf("settings", "home", "threads"),
      updateSidebarDestinationVisibility(
        visibleIds = listOf("threads", "home"),
        destination = SidebarDestination.Settings,
        visible = true,
      ),
    )
    assertEquals(
      listOf("home"),
      updateSidebarDestinationVisibility(
        visibleIds = listOf("home"),
        destination = SidebarDestination.Home,
        visible = false,
      ),
    )
  }

  @Test
  fun agentPickerExcludesSystemAgentsDeduplicatesAndKeepsTheSelection() {
    val state =
      agentPickerState(
        agents =
          listOf(
            agent("main"),
            agent("system", kind = "system"),
            agent("ops"),
            agent("main"),
          ),
        selectedAgentId = "ops",
      )

    assertEquals(listOf("main", "ops"), state.agents.map(GatewayAgentSummary::id))
    assertEquals("ops", state.selected?.id)
    assertEquals("ops", state.selectedAgentId)
  }

  @Test
  fun agentPickerFallsBackToTheFirstSelectableAgent() {
    val state = agentPickerState(listOf(agent("main"), agent("ops")), selectedAgentId = "missing")

    assertEquals("main", state.selected?.id)
    assertEquals("main", state.selectedAgentId)
  }

  @Test
  fun emptyAgentPickerHasNoSyntheticSelection() {
    val state = agentPickerState(listOf(agent("system", kind = "system")), selectedAgentId = "main")

    assertNull(state.selected)
    assertNull(state.selectedAgentId)
    assertEquals(emptyList<String>(), state.agents.map(GatewayAgentSummary::id))
  }

  @Test
  fun recentSessionsExcludeArchivedRowsAndPrioritizePinsThenActivity() {
    val rows =
      sidebarRecentSessions(
        sessions =
          listOf(
            session("old-pinned", activity = 1, pinned = true),
            session("fresh", activity = 30),
            session("archived", activity = 50, archived = true),
            session("fresh-pinned", activity = 20, pinned = true),
          ),
      )

    assertEquals(listOf("fresh-pinned", "old-pinned", "fresh"), rows.map(ChatSessionEntry::key))
  }

  @Test
  fun collapsedSessionPresentationKeepsAllPinsAndGroupsEightRecentRows() {
    val presentation =
      sidebarSessionPresentation(
        sessions =
          listOf(
            session("pinned", activity = 1, pinned = true),
            session("archived", activity = 100, archived = true),
          ) +
            (1L..10L).map { activity ->
              session(
                key = "session-$activity",
                activity = activity,
                category = if (activity % 2L == 0L) "Work" else null,
              )
            },
        knownGroups = listOf("Personal"),
        expanded = false,
      )

    val recentKeys = presentation.recentSections.flatMap { it.entries }.map(ChatSessionEntry::key)
    assertEquals(listOf("pinned"), presentation.pinned.map(ChatSessionEntry::key))
    assertEquals(8, recentKeys.size)
    assertEquals(setOf("session-10", "session-9", "session-8", "session-7", "session-6", "session-5", "session-4", "session-3"), recentKeys.toSet())
    assertEquals(listOf("Work", "Ungrouped"), presentation.recentSections.map { it.title })
    assertTrue(presentation.recentSections.all { it.entries.isNotEmpty() })
    assertTrue(presentation.canExpandRecent)
  }

  @Test
  fun expandedSessionPresentationRevealsAllRowsAndCollapsesToTheSameResult() {
    val sessions = (1L..12L).map { activity -> session("session-$activity", activity = activity) }

    val collapsed = sidebarSessionPresentation(sessions, knownGroups = emptyList(), expanded = false)
    val expanded = sidebarSessionPresentation(sessions, knownGroups = emptyList(), expanded = true)

    assertEquals(8, collapsed.recentSections.flatMap { it.entries }.size)
    assertEquals(12, expanded.recentSections.flatMap { it.entries }.size)
    assertFalse(collapsed.recentSections.flatMap { it.entries }.any { it.key == "session-1" })
    assertTrue(expanded.recentSections.flatMap { it.entries }.any { it.key == "session-1" })
    assertTrue(expanded.canExpandRecent)
    assertEquals(collapsed, sidebarSessionPresentation(sessions, knownGroups = emptyList(), expanded = false))
  }

  @Test
  fun catalogSessionsAreExcludedBeforeRecentPagination() {
    val sessions = (1L..10L).map { activity -> session("session-$activity", activity = activity) }

    val presentation =
      sidebarSessionPresentation(
        sessions = sessions,
        knownGroups = emptyList(),
        expanded = false,
        excludedSessionKeys = setOf("session-10", "session-9"),
      )

    assertEquals(
      listOf("session-8", "session-7", "session-6", "session-5", "session-4", "session-3", "session-2", "session-1"),
      presentation.recentSections.flatMap { it.entries }.map(ChatSessionEntry::key),
    )
    assertFalse(presentation.canExpandRecent)
  }

  @Test
  fun catalogPinsRemainVisibleWithoutDuplicatingRecentRows() {
    val presentation =
      sidebarSessionPresentation(
        sessions =
          listOf(
            session("visible-newest-pinned", activity = 50, pinned = true),
            session("catalog-pinned", activity = 40, pinned = true),
            session("visible-pinned", activity = 30, pinned = true),
            session("catalog-recent", activity = 20),
            session("visible-recent", activity = 10),
          ),
        knownGroups = emptyList(),
        expanded = true,
        excludedSessionKeys = setOf("catalog-pinned", "catalog-recent"),
      )

    assertEquals(
      listOf("visible-newest-pinned", "catalog-pinned", "visible-pinned"),
      presentation.pinned.map(ChatSessionEntry::key),
    )
    assertEquals(
      listOf("visible-recent"),
      presentation.recentSections.flatMap { it.entries }.map(ChatSessionEntry::key),
    )
  }

  @Test
  fun sessionActivityUsesCurrentFailureQueueRunAndUnreadPriority() {
    assertEquals(
      SidebarSessionActivity.Failed,
      sidebarSessionActivity(
        status = "running",
        lastRunError = "boom",
        hasActiveRun = true,
        unread = true,
      ),
    )
    assertEquals(
      SidebarSessionActivity.Queued,
      sidebarSessionActivity(
        status = "queued",
        lastRunError = null,
        hasActiveRun = true,
        unread = true,
      ),
    )
    assertEquals(
      SidebarSessionActivity.Running,
      sidebarSessionActivity(
        status = null,
        lastRunError = null,
        hasActiveRun = true,
        unread = true,
      ),
    )
    assertEquals(
      SidebarSessionActivity.Unread,
      sidebarSessionActivity(
        status = "idle",
        lastRunError = null,
        hasActiveRun = false,
        unread = true,
      ),
    )
    assertNull(
      sidebarSessionActivity(
        status = "idle",
        lastRunError = null,
        hasActiveRun = false,
        unread = false,
      ),
    )
  }

  @Test
  fun terminalCatalogStatusesRemainFailuresWithoutALiveSession() {
    listOf("failed", "timeout", "killed", "error").forEach { status ->
      assertEquals(
        SidebarSessionActivity.Failed,
        sidebarSessionActivity(status, lastRunError = null, hasActiveRun = false, unread = false),
      )
    }
  }

  @Test
  fun sessionSubtitleShowsWorkingForActiveRunsAndKeepsTheIdleSourceFallback() {
    val session = ChatSessionEntry(key = "telegram:123", updatedAtMs = 1_000, hasActiveRun = true)

    assertEquals(
      "Working",
      sidebarSessionSubtitle(session, activeRunLabel = "Working", nowMs = 1_000),
    )
    assertEquals(
      "Telegram",
      sidebarSessionSubtitle(session.copy(hasActiveRun = false), activeRunLabel = null, nowMs = 1_000),
    )
    assertEquals(
      "Working",
      sidebarSessionSubtitle(session.copy(hasActiveRun = null, status = " RUNNING "), activeRunLabel = "Working", nowMs = 1_000),
    )
    assertEquals(
      "Telegram",
      sidebarSessionSubtitle(session.copy(hasActiveRun = false, status = "running"), activeRunLabel = "Working", nowMs = 1_000),
    )
    assertNull(sidebarSessionActivity("running", lastRunError = null, hasActiveRun = false, unread = false))
    assertNull(sidebarSessionActivity("done", lastRunError = null, hasActiveRun = true, unread = false))
    assertEquals(SidebarSessionActivity.Running, sidebarSessionActivity("done", null, false, false, continuing = true))
    assertEquals(SidebarSessionActivity.Failed, sidebarSessionActivity("failed", null, false, false, continuing = true))
    assertEquals(SidebarSessionActivity.Running, sidebarSessionActivity("queued", null, false, false, continuing = true))
    assertEquals(SidebarSessionActivity.Queued, sidebarSessionActivity("queued", null, true, false, continuing = true))
    assertEquals(SidebarSessionActivity.Queued, sidebarSessionActivity("queued", null, null, false))
    assertNull(sidebarSessionActivity("queued", null, false, false))
    assertEquals(SidebarSessionActivity.Unread, sidebarSessionActivity("queued", null, false, true))
  }

  private fun agent(
    id: String,
    kind: String? = null,
  ): GatewayAgentSummary =
    GatewayAgentSummary(
      id = id,
      name = id,
      emoji = null,
      kind = kind,
    )

  private fun session(
    key: String,
    activity: Long,
    pinned: Boolean = false,
    archived: Boolean = false,
    displayName: String? = null,
    label: String? = null,
    owner: String? = null,
    category: String? = null,
  ): ChatSessionEntry =
    ChatSessionEntry(
      key = key,
      updatedAtMs = activity,
      lastActivityAt = activity,
      pinned = pinned,
      archived = archived,
      displayName = displayName,
      label = label,
      ownerAgentId = owner,
      category = category,
    )
}
