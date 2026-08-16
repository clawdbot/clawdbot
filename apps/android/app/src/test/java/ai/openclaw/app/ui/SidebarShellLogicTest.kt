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
  fun agentRosterExcludesSystemAgentsAndKeepsTheSelectedAgentFirst() {
    val roster =
      sidebarAgentRoster(
        agents =
          listOf(
            agent("main"),
            agent("system", kind = "system"),
            agent("ops"),
            agent("main"),
          ),
        selectedAgentId = "ops",
      )

    assertEquals("ops", roster.selected?.id)
    assertEquals(listOf("main"), roster.others.map(GatewayAgentSummary::id))
  }

  @Test
  fun emptySelectableAgentRosterHasNoSyntheticSelection() {
    val roster = sidebarAgentRoster(listOf(agent("system", kind = "system")), selectedAgentId = "main")

    assertNull(roster.selected)
    assertEquals(emptyList<String>(), roster.others.map(GatewayAgentSummary::id))
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
        query = "",
      )

    assertEquals(listOf("fresh-pinned", "old-pinned", "fresh"), rows.map(ChatSessionEntry::key))
  }

  @Test
  fun recentSessionSearchCoversTitleLabelKeyAndOwnerWithoutApplyingRecentLimit() {
    val rows =
      sidebarRecentSessions(
        sessions =
          listOf(
            session("agent:main:title", activity = 1, displayName = "Ops planning"),
            session("agent:main:label", activity = 2, label = "Ops handoff"),
            session("agent:ops:key", activity = 3),
            session("agent:main:owner", activity = 4, owner = "ops"),
            session("agent:main:other", activity = 5, displayName = "Product notes"),
          ),
        query = "ops",
        limit = 1,
      )

    assertEquals(
      listOf("agent:main:owner", "agent:ops:key", "agent:main:label", "agent:main:title"),
      rows.map(ChatSessionEntry::key),
    )
  }

  @Test
  fun activeSearchReturnsAllMatchesBeyondTheRecentSessionLimit() {
    val rows =
      sidebarRecentSessions(
        sessions = (1L..12L).map { activity -> session("ops-session-$activity", activity = activity) },
        query = "ops",
      )

    assertEquals(12, rows.size)
  }

  @Test
  fun recentSessionsStayBoundedInsideTheSharedScrollableSidebar() {
    val rows =
      sidebarRecentSessions(
        sessions = (1L..12L).map { activity -> session("session-$activity", activity = activity) },
        query = "",
      )

    assertEquals(8, rows.size)
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
    )
}
