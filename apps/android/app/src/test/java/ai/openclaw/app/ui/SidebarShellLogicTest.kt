package ai.openclaw.app.ui

import ai.openclaw.app.GatewayAgentSummary
import ai.openclaw.app.chat.ChatSessionEntry
import androidx.compose.material3.adaptive.navigationsuite.NavigationSuiteType
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class SidebarShellLogicTest {
  @Test
  fun compactWidthUsesNavigationBarAcrossTheSixHundredDpBoundary() {
    assertEquals(AdaptiveNavigationMode.Bar, adaptiveNavigationMode(599f, 800f))
    assertEquals(AdaptiveNavigationMode.Rail, adaptiveNavigationMode(600f, 800f))
  }

  @Test
  fun expandedWidthUsesPermanentDrawerAcrossTheEightHundredFortyDpBoundary() {
    assertEquals(AdaptiveNavigationMode.Rail, adaptiveNavigationMode(839f, 800f))
    assertEquals(AdaptiveNavigationMode.Drawer, adaptiveNavigationMode(840f, 800f))
  }

  @Test
  fun compactHeightUsesNavigationBarAcrossTheFourHundredEightyDpBoundary() {
    assertEquals(AdaptiveNavigationMode.Bar, adaptiveNavigationMode(840f, 479f))
    assertEquals(AdaptiveNavigationMode.Drawer, adaptiveNavigationMode(840f, 480f))
  }

  @Test
  fun representativeAndroidWindowSizesMapToMaterialPatterns() {
    assertEquals(AdaptiveNavigationMode.Bar, adaptiveNavigationMode(360f, 800f))
    assertEquals(AdaptiveNavigationMode.Bar, adaptiveNavigationMode(800f, 360f))
    assertEquals(AdaptiveNavigationMode.Rail, adaptiveNavigationMode(600f, 480f))
    assertEquals(AdaptiveNavigationMode.Rail, adaptiveNavigationMode(839f, 899f))
    assertEquals(AdaptiveNavigationMode.Drawer, adaptiveNavigationMode(841f, 701f))
    assertEquals(AdaptiveNavigationMode.Drawer, adaptiveNavigationMode(1024f, 640f))
    assertEquals(AdaptiveNavigationMode.Drawer, adaptiveNavigationMode(1280f, 800f))
    assertEquals(AdaptiveNavigationMode.Drawer, adaptiveNavigationMode(1600f, 900f))
  }

  @Test
  fun tabletopPostureAlwaysUsesReachableBottomNavigation() {
    assertEquals(AdaptiveNavigationMode.Bar, adaptiveNavigationMode(1280f, 800f, tabletop = true))
  }

  @Test
  fun hiddenCompactNavigationDoesNotHideRailOrPermanentDrawer() {
    assertEquals(
      NavigationSuiteType.None,
      adaptiveNavigationSuiteType(AdaptiveNavigationMode.Bar, compactNavigationVisible = false),
    )
    assertEquals(
      NavigationSuiteType.NavigationBar,
      adaptiveNavigationSuiteType(AdaptiveNavigationMode.Bar, compactNavigationVisible = true),
    )
    assertEquals(
      NavigationSuiteType.NavigationRail,
      adaptiveNavigationSuiteType(AdaptiveNavigationMode.Rail, compactNavigationVisible = false),
    )
    assertEquals(
      NavigationSuiteType.NavigationDrawer,
      adaptiveNavigationSuiteType(AdaptiveNavigationMode.Drawer, compactNavigationVisible = false),
    )
  }

  @Test
  fun compactNavigationUsesShortDistinctLabels() {
    val labels = SidebarDestination.entries.map(SidebarDestination::compactLabelSource)

    assertEquals(listOf("Chat", "Status", "Usage", "Cron", "Threads"), labels)
    assertEquals(labels.size, labels.distinct().size)
    assertTrue(labels.all { it.length <= 7 })
  }

  @Test
  fun compactNavigationOnlyShowsTheSelectedLabel() {
    assertFalse(alwaysShowAdaptiveNavigationLabel(AdaptiveNavigationMode.Bar))
    assertTrue(alwaysShowAdaptiveNavigationLabel(AdaptiveNavigationMode.Rail))
    assertTrue(alwaysShowAdaptiveNavigationLabel(AdaptiveNavigationMode.Drawer))
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
  fun collapsedSessionPresentationGroupsOnlyTheEightHighestPriorityActiveRows() {
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

    val keys = presentation.sections.flatMap { it.entries }.map(ChatSessionEntry::key)
    assertEquals(8, keys.size)
    assertEquals(setOf("pinned", "session-10", "session-9", "session-8", "session-7", "session-6", "session-5", "session-4"), keys.toSet())
    assertEquals(listOf("Pinned", "Work", "Ungrouped"), presentation.sections.map { it.title })
    assertTrue(presentation.sections.all { it.entries.isNotEmpty() })
    assertTrue(presentation.canExpand)
  }

  @Test
  fun expandedSessionPresentationRevealsAllRowsAndCollapsesToTheSameResult() {
    val sessions = (1L..12L).map { activity -> session("session-$activity", activity = activity) }

    val collapsed = sidebarSessionPresentation(sessions, knownGroups = emptyList(), expanded = false)
    val expanded = sidebarSessionPresentation(sessions, knownGroups = emptyList(), expanded = true)

    assertEquals(8, collapsed.sections.flatMap { it.entries }.size)
    assertEquals(12, expanded.sections.flatMap { it.entries }.size)
    assertFalse(collapsed.sections.flatMap { it.entries }.any { it.key == "session-1" })
    assertTrue(expanded.sections.flatMap { it.entries }.any { it.key == "session-1" })
    assertTrue(expanded.canExpand)
    assertEquals(collapsed, sidebarSessionPresentation(sessions, knownGroups = emptyList(), expanded = false))
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
