package ai.openclaw.app.ui

import ai.openclaw.app.chat.ChatSessionAgentStatus
import ai.openclaw.app.chat.ChatSessionEntry
import kotlinx.coroutines.runBlocking
import org.junit.Assert.assertEquals
import org.junit.Test

class SessionsScreenGroupingTest {
  @Test
  fun sessionPresentationTitlePrefersExplicitNamesAndKeepsDashboardPlaceholdersLocal() {
    val dashboardKey = "agent:main:dashboard:fresh"

    assertEquals(
      "Manual name",
      sessionPresentationTitle(
        ChatSessionEntry(
          key = dashboardKey,
          updatedAtMs = null,
          label = "Manual name",
          displayName = "Generated title",
        ),
      ) { "Main thread" },
    )
    assertEquals(
      "Generated title",
      sessionPresentationTitle(
        ChatSessionEntry(key = dashboardKey, updatedAtMs = null, displayName = "Generated title"),
      ) { "Main thread" },
    )
    assertEquals(
      "New chat",
      sessionPresentationTitle(ChatSessionEntry(key = dashboardKey, updatedAtMs = null)) { "Main thread" },
    )
    assertEquals(
      "Main thread",
      sessionPresentationTitle(ChatSessionEntry(key = "agent:main:main", updatedAtMs = null)) { "Main thread" },
    )
    assertEquals(
      "New chat",
      sessionPresentationTitle(ChatSessionEntry(key = "agent:main:main", updatedAtMs = null)) { "New chat" },
    )
  }

  @Test
  fun relativeTimeUsesCatalogBackedCompactLabels() {
    val now = 10_000_000L

    assertEquals("now", relativeSessionTime(updatedAtMs = now, nowMs = now))
    assertEquals("5m", relativeSessionTime(updatedAtMs = now - 5 * 60_000L, nowMs = now))
    assertEquals("3h", relativeSessionTime(updatedAtMs = now - 3 * 60 * 60_000L, nowMs = now))
    assertEquals("2d", relativeSessionTime(updatedAtMs = now - 2 * 24 * 60 * 60_000L, nowMs = now))
  }

  @Test
  fun sessionActionTargetKeepsTheOwnerCapturedWhenTheDialogOpened() {
    val target =
      ChatSessionEntry(
        key = "custom",
        updatedAtMs = null,
        ownerAgentId = "agent-a",
        label = "Original",
      ).toActionTarget("gateway-a")
    val refreshed =
      ChatSessionEntry(
        key = "custom",
        updatedAtMs = null,
        ownerAgentId = "agent-b",
        label = "Replacement",
      )

    assertEquals("gateway-a", target.gatewayStableId)
    assertEquals("agent-a", target.ownerAgentId)
    assertEquals("Original", target.label)
    assertEquals("gateway-a:agent-a:custom", target.stateKey)
    assertEquals(true, target.matchesGateway("gateway-a"))
    assertEquals(false, target.matchesGateway("gateway-b"))
    assertEquals("agent-b", refreshed.ownerAgentId)
  }

  @Test
  fun sessionActionTargetSavedStatePreservesOwnerAndNullableLabels() {
    val full = SessionActionTarget("gateway-a", "custom", "agent-a", "", "Display")
    val sparse = SessionActionTarget(null, "agent:main:device", null, null, null)

    assertEquals(full, sessionActionTargetFromSavedState(full.toSavedState()))
    assertEquals(sparse, sessionActionTargetFromSavedState(sparse.toSavedState()))
  }

  @Test
  fun sessionActionTargetSavedStateRejectsMissingIdentity() {
    assertEquals(null, sessionActionTargetFromSavedState(emptyList()))
    assertEquals(
      null,
      sessionActionTargetFromSavedState(listOf("1", "gateway-a", "", "0", "", "0", "", "0", "")),
    )
  }

  @Test
  fun groupsPinnedThenAlphabeticalCategoriesThenUngrouped() {
    val sections =
      groupSessionEntries(
        listOf(
          session("loose"),
          session("zeta", category = "Zeta"),
          session("pinned-grouped", category = "Alpha", pinned = true),
          session("alpha", category = "Alpha"),
          session("pinned", pinned = true),
        ),
      )

    assertEquals(listOf("Pinned", "Alpha", "Zeta", "Ungrouped"), sections.map { it.title })
    assertEquals(listOf("pinned-grouped", "pinned"), sections[0].entries.map { it.key })
    assertEquals(listOf("alpha"), sections[1].entries.map { it.key })
    assertEquals(listOf("zeta"), sections[2].entries.map { it.key })
    assertEquals(listOf("loose"), sections[3].entries.map { it.key })
  }

  @Test
  fun omitsUngroupedHeaderWhenNoCategoriesExist() {
    val sections = groupSessionEntries(listOf(session("one"), session("two")))

    assertEquals(listOf<String?>(null), sections.map { it.title })
    assertEquals(listOf("one", "two"), sections.single().entries.map { it.key })
  }

  @Test
  fun pinnedSessionsAppearOnlyInPinnedSection() {
    val sections = groupSessionEntries(listOf(session("pinned", category = "Work", pinned = true)))

    assertEquals(listOf("Pinned"), sections.map { it.title })
    assertEquals(listOf("pinned"), sections.single().entries.map { it.key })
  }

  @Test
  fun knownGroupsRenderEmptyCategorySectionsInAlphabeticalMerge() {
    val sections =
      groupSessionEntries(
        listOf(session("alpha", category = "Alpha"), session("loose")),
        knownGroups = listOf(" Beta ", "beta", "alpha", "", "  "),
      )

    // Blank names drop, "beta" dedupes against " Beta ", and "alpha" merges into the populated section.
    assertEquals(listOf("Alpha", "Beta", "Ungrouped"), sections.map { it.title })
    assertEquals(listOf(true, true, false), sections.map { it.isCategory })
    assertEquals(listOf("alpha"), sections[0].entries.map { it.key })
    assertEquals(emptyList<String>(), sections[1].entries.map { it.key })
    assertEquals(listOf("loose"), sections[2].entries.map { it.key })
  }

  @Test
  fun knownGroupsAloneDoNotCreateSectionsWithoutSessions() {
    assertEquals(emptyList<SessionSection>(), groupSessionEntries(emptyList(), knownGroups = listOf("Beta")))
  }

  @Test
  fun pinnedAndUngroupedSectionsAreNotCategories() {
    val sections =
      groupSessionEntries(
        listOf(session("pinned", pinned = true), session("grouped", category = "Work"), session("loose")),
      )

    assertEquals(listOf("Pinned", "Work", "Ungrouped"), sections.map { it.title })
    assertEquals(listOf(false, true, false), sections.map { it.isCategory })
  }

  @Test
  fun projectsVisibleChildrenUnderParentsAndPrefersParentSessionKey() {
    val rows =
      buildSessionTreeSections(
        listOf(
          session("parent"),
          session("child", parentSessionKey = "parent", spawnedBy = "controller-parent"),
          session("grandchild", spawnedBy = "child"),
          session("controller-parent"),
        ),
      ).single()
        .entries

    assertEquals(listOf("parent", "child", "grandchild", "controller-parent"), rows.map { it.session.key })
    assertEquals(listOf(0, 1, 2, 0), rows.map { it.depth })
    assertEquals(listOf(true, true, false, false), rows.map { it.hasChildren })
  }

  @Test
  fun collapsedParentHidesOnlyItsDescendants() {
    val entries = listOf(session("parent"), session("child", spawnedBy = "parent"), session("sibling"))

    val collapsed = buildSessionTreeSections(entries, collapsedSessionKeys = setOf("parent")).single().entries
    val expanded = buildSessionTreeSections(entries).single().entries

    assertEquals(listOf("parent", "sibling"), collapsed.map { it.session.key })
    assertEquals(listOf(true, false), collapsed.map { it.hasChildren })
    assertEquals(listOf("parent", "child", "sibling"), expanded.map { it.session.key })
  }

  @Test
  fun collapsedParentRetainsTransitiveActionableDescendantState() {
    val rows =
      buildSessionTreeSections(
        entries =
          listOf(
            session("parent"),
            session("current", spawnedBy = "parent"),
            session("running", spawnedBy = "current", hasActiveRun = true),
            session("unread", spawnedBy = "parent", unread = true),
            session("failed", spawnedBy = "parent", status = "timeout"),
            session("attention", spawnedBy = "parent", attention = "approval", attentionExpiresAt = 20_000L),
            session("expired-attention", spawnedBy = "parent", attention = "question", attentionExpiresAt = 5_000L),
          ),
        collapsedSessionKeys = setOf("parent"),
        currentSessionKey = "current",
        nowMs = 10_000L,
      ).single()
        .entries

    assertEquals(listOf("parent"), rows.map { it.session.key })
    assertEquals(
      SessionDescendantState(
        containsCurrent = true,
        hasRunning = true,
        hasUnread = true,
        hasFailure = true,
        hasAttention = true,
      ),
      rows.single().descendantState,
    )
    assertEquals(
      "Needs attention · Thread failed · Current thread · Running · Unread",
      rows.single().descendantState.presentationLabel(),
    )
  }

  @Test
  fun sessionStatusExpiryReschedulesAfterEarlyWakeAndSelectsTheNextExpiry() =
    runBlocking {
      val entries =
        listOf(
          session("first", attention = "question", attentionExpiresAt = 100L),
          session("second", attention = "approval", attentionExpiresAt = 200L),
        )
      var nowMs = 90L
      val waits = mutableListOf<Long>()

      assertEquals(100L, nextSessionStatusExpiry(entries, nowMs))
      val reachedAt =
        awaitSessionStatusExpiry(
          expiry = 100L,
          nowMs = { nowMs },
          wait = { duration ->
            waits += duration
            nowMs += if (waits.size == 1) duration - 1L else duration
          },
        )

      assertEquals(listOf(10L, 1L), waits)
      assertEquals(100L, reachedAt)
      assertEquals(200L, nextSessionStatusExpiry(entries, reachedAt))
    }

  @Test
  fun collapsedParentRetainsGatewayRunningDescendantSignalBeforeChildrenLoad() {
    val parent =
      buildSessionTreeSections(
        entries = listOf(session("parent", hasActiveSubagentRun = true)),
        collapsedSessionKeys = setOf("parent"),
      ).single()
        .entries
        .single()

    assertEquals(true, parent.descendantState.hasRunning)
  }

  @Test
  fun pinnedAndCategorizedChildrenRemainSectionRoots() {
    val sections =
      buildSessionTreeSections(
        listOf(
          session("parent"),
          session("pinned-child", pinned = true, spawnedBy = "parent"),
          session("grouped-child", category = "Work", spawnedBy = "parent"),
          session("plain-child", spawnedBy = "parent"),
        ),
      )

    assertEquals(listOf("Pinned", "Work", "Ungrouped"), sections.map { it.title })
    assertEquals(listOf("pinned-child"), sections[0].entries.map { it.session.key })
    assertEquals(listOf("grouped-child"), sections[1].entries.map { it.session.key })
    assertEquals(listOf("parent", "plain-child"), sections[2].entries.map { it.session.key })
    assertEquals(listOf(0, 1), sections[2].entries.map { it.depth })
  }

  @Test
  fun danglingAndCyclicParentsRemainVisibleExactlyOnce() {
    val rows =
      buildSessionTreeSections(
        listOf(
          session("dangling", spawnedBy = "missing"),
          session("self", parentSessionKey = "self"),
          session("cycle-a", spawnedBy = "cycle-b"),
          session("cycle-b", spawnedBy = "cycle-a"),
        ),
      ).single()
        .entries

    assertEquals(listOf("dangling", "self", "cycle-a", "cycle-b"), rows.map { it.session.key })
    assertEquals(listOf(0, 0, 0, 0), rows.map { it.depth })
    assertEquals(listOf(false, false, false, false), rows.map { it.hasChildren })
  }

  private fun session(
    key: String,
    category: String? = null,
    pinned: Boolean? = null,
    parentSessionKey: String? = null,
    spawnedBy: String? = null,
    hasActiveRun: Boolean? = null,
    hasActiveSubagentRun: Boolean? = null,
    unread: Boolean? = null,
    status: String? = null,
    attention: String? = null,
    attentionExpiresAt: Long = 0L,
  ): ChatSessionEntry =
    ChatSessionEntry(
      key = key,
      updatedAtMs = null,
      category = category,
      pinned = pinned,
      parentSessionKey = parentSessionKey,
      spawnedBy = spawnedBy,
      hasActiveRun = hasActiveRun,
      hasActiveSubagentRun = hasActiveSubagentRun,
      unread = unread,
      status = status,
      agentStatus = attention?.let { ChatSessionAgentStatus("Waiting", attentionExpiresAt, it) },
    )
}
