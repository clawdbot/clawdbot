package ai.openclaw.app.ui

import ai.openclaw.app.chat.ChatSessionEntry
import org.junit.Assert.assertEquals
import org.junit.Test

class SessionsScreenGroupingTest {
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

  private fun session(
    key: String,
    category: String? = null,
    pinned: Boolean? = null,
  ): ChatSessionEntry =
    ChatSessionEntry(
      key = key,
      updatedAtMs = null,
      category = category,
      pinned = pinned,
    )
}
