package ai.openclaw.app.ui

import ai.openclaw.app.GatewayConnectionDisplay
import ai.openclaw.app.MainViewModel
import ai.openclaw.app.NodeApp
import ai.openclaw.app.NodeRuntime
import ai.openclaw.app.NodeRuntimeMode
import ai.openclaw.app.SecurePrefs
import ai.openclaw.app.SessionCatalog
import ai.openclaw.app.SessionCatalogEntry
import ai.openclaw.app.SessionCatalogHost
import ai.openclaw.app.SessionCatalogState
import ai.openclaw.app.chat.ChatSessionEntry
import ai.openclaw.app.closeNodeRuntimeTestFixture
import ai.openclaw.app.defaultSidebarPageOrder
import ai.openclaw.app.ui.design.ClawDesignTheme
import android.content.Context
import android.provider.Settings
import androidx.compose.runtime.mutableStateOf
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.semantics.SemanticsProperties
import androidx.compose.ui.test.SemanticsMatcher
import androidx.compose.ui.test.TouchInjectionScope
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.junit4.v2.createComposeRule
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performScrollTo
import androidx.compose.ui.test.performTouchInput
import androidx.compose.ui.unit.dp
import androidx.lifecycle.SavedStateHandle
import androidx.lifecycle.ViewModelStore
import kotlinx.coroutines.flow.MutableStateFlow
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import org.robolectric.annotation.Config
import org.robolectric.util.ReflectionHelpers
import java.util.UUID

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34])
class SidebarCatalogGroupingTest {
  @get:Rule
  val composeRule = createComposeRule()

  @Test
  fun groupingKeepsHostsWorkspacesOtherWorkAndRecencyOrder() {
    val hosts =
      sidebarCatalogHosts(
        listOf(
          SessionCatalog(
            id = "codex",
            label = "Codex",
            hosts =
              listOf(
                SessionCatalogHost(
                  catalogId = "codex",
                  hostId = "desktop",
                  label = "Desktop",
                  kind = "node",
                  connected = true,
                  nextCursor = "next",
                  sessions =
                    listOf(
                      entry("older", cwd = "C:\\work\\openclaw", recency = 10.0),
                      entry("newer", cwd = "C:\\work\\openclaw", recency = 20.0),
                      entry("other", cwd = null, recency = 30.0),
                      entry("named-other", cwd = "/work/Other work", recency = 35.0),
                      entry("archived", cwd = "/work/hidden", recency = 40.0, archived = true),
                    ),
                ),
              ),
          ),
        ),
      )

    assertEquals(1, hosts.size)
    val host = hosts.single()
    assertEquals("Desktop", host.label)
    assertTrue(host.connected)
    assertTrue(host.canLoadMore)
    assertEquals(listOf("openclaw", "Other work", "Other work"), host.workspaces.map(SidebarCatalogWorkspace::label))
    assertEquals(
      listOf("newer", "older"),
      host.workspaces
        .first()
        .sessions
        .map(SessionCatalogEntry::threadId),
    )
    assertNull(host.workspaces.last().path)
    assertFalse(host.workspaces.any { workspace -> workspace.sessions.any(SessionCatalogEntry::archived) })
  }

  @Test
  fun visibleCatalogKeysExcludeArchivedRows() {
    val keys =
      sidebarVisibleCatalogSessionKeys(
        listOf(
          SessionCatalog(
            id = "codex",
            label = "Codex",
            hosts =
              listOf(
                SessionCatalogHost(
                  catalogId = "codex",
                  hostId = "desktop",
                  label = "Desktop",
                  kind = "node",
                  connected = true,
                  sessions =
                    listOf(
                      entry("visible", cwd = "/work/visible", recency = 2.0),
                      entry("archived", cwd = "/work/hidden", recency = 1.0, archived = true),
                    ),
                ),
              ),
          ),
        ),
      )

    assertEquals(setOf("agent:main:visible"), keys)
  }

  @Test
  fun fullyArchivedHostDoesNotLeaveAnEmptyHeading() {
    val hosts =
      sidebarCatalogHosts(
        listOf(
          SessionCatalog(
            id = "codex",
            label = "Codex",
            hosts =
              listOf(
                SessionCatalogHost(
                  catalogId = "codex",
                  hostId = "desktop",
                  label = "Desktop",
                  kind = "node",
                  connected = true,
                  sessions = listOf(entry("archived", cwd = "/work/hidden", recency = 1.0, archived = true)),
                ),
              ),
          ),
        ),
      )

    assertTrue(hosts.isEmpty())
  }

  @Test
  fun fullyArchivedHostKeepsItsRefreshErrorVisible() {
    val hosts =
      sidebarCatalogHosts(
        listOf(
          SessionCatalog(
            id = "codex",
            label = "Codex",
            hosts =
              listOf(
                SessionCatalogHost(
                  catalogId = "codex",
                  hostId = "desktop",
                  label = "Desktop",
                  kind = "node",
                  connected = true,
                  errorText = "Refresh failed",
                  sessions = listOf(entry("archived", cwd = "/work/hidden", recency = 1.0, archived = true)),
                ),
              ),
          ),
        ),
      )

    val host = hosts.single()
    assertTrue(host.workspaces.isEmpty())
    assertEquals("Refresh failed", host.errorText)
    assertFalse(host.canLoadMore)
  }

  @Test
  fun fullyArchivedPageKeepsPaginationForLaterActiveRows() {
    val hosts =
      sidebarCatalogHosts(
        listOf(
          SessionCatalog(
            id = "codex",
            label = "Codex",
            hosts =
              listOf(
                SessionCatalogHost(
                  catalogId = "codex",
                  hostId = "desktop",
                  label = "Desktop",
                  kind = "node",
                  connected = true,
                  nextCursor = "next",
                  sessions = listOf(entry("archived", cwd = "/work/hidden", recency = 1.0, archived = true)),
                ),
              ),
          ),
        ),
      )

    val host = hosts.single()
    assertTrue(host.workspaces.isEmpty())
    assertTrue(host.canLoadMore)
  }

  @Test
  fun catalogSectionsMatchWebVisibilityAndKeepExpansionIndependent() {
    val catalogs =
      listOf(
        SessionCatalog(id = "codex", label = "Codex", hosts = emptyList(), canCreateSession = true),
        SessionCatalog(
          id = "claude",
          label = "Claude Code",
          hosts = listOf(host("claude", sessions = listOf(entry("visible", "/work/claude", 2.0, catalogId = "claude")))),
        ),
        SessionCatalog(id = "pi", label = "Pi", hosts = emptyList()),
        SessionCatalog(id = "catalog-error", label = "Catalog error", hosts = emptyList(), errorText = "Unavailable"),
        SessionCatalog(
          id = "host-error",
          label = "Host error",
          hosts = listOf(host("host-error", errorText = "Unavailable")),
        ),
        SessionCatalog(
          id = "paged",
          label = "Paged",
          hosts = listOf(host("paged", nextCursor = "next")),
        ),
        SessionCatalog(
          id = "archived",
          label = "Archived",
          hosts = listOf(host("archived", sessions = listOf(entry("archived", "/work/hidden", 1.0, archived = true)))),
        ),
      )

    val sections = sidebarCatalogSections(catalogs, expandedCatalogIds = listOf("claude"))

    assertEquals(listOf("codex", "claude", "catalog-error", "host-error", "paged"), sections.map { it.catalog.id })
    assertFalse(sections.first { it.catalog.id == "codex" }.expanded)
    assertTrue(sections.first { it.catalog.id == "claude" }.expanded)
    assertFalse(sections.any { it.catalog.id == "pi" })
    assertFalse(sections.any { it.catalog.id == "archived" })
    assertEquals(
      setOf("codex", "claude"),
      toggleSidebarCatalogExpansion(listOf("claude"), "codex").toSet(),
    )
    assertEquals(emptyList<String>(), toggleSidebarCatalogExpansion(listOf("claude"), "claude"))
  }

  @Test
  fun catalogCreationRequiresAdvertisedCapabilityAndWriteScope() {
    val creatable = SessionCatalog(id = "codex", label = "Codex", hosts = emptyList(), canCreateSession = true)
    val unavailable = creatable.copy(canCreateSession = false)

    assertTrue(sidebarCatalogSessionCreationEnabled(creatable, canMutateSessions = true))
    assertFalse(sidebarCatalogSessionCreationEnabled(creatable, canMutateSessions = false))
    assertFalse(sidebarCatalogSessionCreationEnabled(unavailable, canMutateSessions = true))
  }

  @Test
  fun collapsedCatalogRefreshesWhenSelectedAgentChanges() {
    assertTrue(
      sidebarCatalogRefreshNeeded(
        catalogAgentId = "main",
        selectedAgentId = "jarvis",
        anyCatalogExpanded = false,
        catalogDiscoveryNeeded = false,
      ),
    )
  }

  @Test
  fun collapsedCatalogDoesNotPollWhenOwnerMatches() {
    assertFalse(
      sidebarCatalogRefreshNeeded(
        catalogAgentId = "jarvis",
        selectedAgentId = " jarvis ",
        anyCatalogExpanded = false,
        catalogDiscoveryNeeded = false,
      ),
    )
    assertTrue(
      sidebarCatalogRefreshNeeded(
        catalogAgentId = "jarvis",
        selectedAgentId = "jarvis",
        anyCatalogExpanded = true,
        catalogDiscoveryNeeded = false,
      ),
    )
  }

  @Test
  fun readOnlyCatalogCanOpenAdoptedSessionsButCannotContinueRemoteRows() {
    val adopted = entry("adopted", cwd = "/work/adopted", recency = 2.0)
    val remote = entry("remote", cwd = "/work/remote", recency = 1.0).copy(sessionKey = null)
    val unavailable = remote.copy(canContinue = false)

    assertTrue(sidebarCatalogSessionSelectionEnabled(adopted, canMutateSessions = false))
    assertFalse(sidebarCatalogSessionSelectionEnabled(remote, canMutateSessions = false))
    assertTrue(sidebarCatalogSessionSelectionEnabled(remote, canMutateSessions = true))
    assertFalse(sidebarCatalogSessionSelectionEnabled(unavailable, canMutateSessions = true))
  }

  @Test
  fun inlinePageDragSkipsHiddenPagesWhileEditKeepsTheFullOrder() {
    val app = RuntimeEnvironment.getApplication() as NodeApp
    val originalAnimatorScale = Settings.Global.getString(app.contentResolver, Settings.Global.ANIMATOR_DURATION_SCALE)
    val prefs = SecurePrefs(app, app.getSharedPreferences("sidebar-pages-${UUID.randomUUID()}", Context.MODE_PRIVATE))
    val runtime = NodeRuntime(app, prefs, NodeRuntimeMode.ScreenshotFixture)
    val viewModel = MainViewModel(app, prefs, SavedStateHandle())
    val viewModels = ViewModelStore().apply { put("sidebar", viewModel) }
    val dragStates = mutableListOf<Boolean>()
    val dragOnePageDown: TouchInjectionScope.() -> Unit = {
      down(center)
      advanceEventTime(viewConfiguration.longPressTimeoutMillis + 1L)
      moveBy(Offset(0f, 52.dp.toPx()))
      up()
    }

    try {
      Settings.Global.putFloat(app.contentResolver, Settings.Global.ANIMATOR_DURATION_SCALE, 0f)
      prefs.setSidebarPageOrder(defaultSidebarPageOrder)
      prefs.setSidebarVisiblePages(listOf("settings", "home", "skills", "threads"))
      ReflectionHelpers.getField<MutableStateFlow<NodeRuntime?>>(viewModel, "runtimeRef").value = runtime
      composeRule.setContent {
        ClawDesignTheme {
          OpenClawSidebar(
            viewModel = viewModel,
            agents = emptyList(),
            selectedAgentId = "main",
            sessions = emptyList(),
            activeSessionKey = "main",
            activeDestination = null,
            connection = GatewayConnectionDisplay(false, "Offline", null),
            visible = true,
            showCloseButton = false,
            onClose = {},
            onDragActiveChange = { dragStates += it },
            onNewSession = {},
            onSelectAgent = {},
            onSelectSession = {},
            onSelectCatalogSession = {},
            onCreateCatalogSession = {},
            onSelectDestination = {},
          )
        }
      }
      composeRule.onNodeWithText("Work").assertDoesNotExist()
      composeRule.onNodeWithText("Home").assertIsDisplayed()
      composeRule.onNodeWithText("Settings").assertIsDisplayed().performTouchInput(dragOnePageDown)

      composeRule.runOnIdle {
        assertEquals(listOf(true, false), dragStates)
        assertEquals(listOf("home", "work", "settings", "skills", "threads"), prefs.sidebarPageOrder.value)
      }
      val homeTop =
        composeRule
          .onNodeWithText("Home")
          .fetchSemanticsNode()
          .boundsInRoot.top
      val settingsTop =
        composeRule
          .onNodeWithText("Settings")
          .fetchSemanticsNode()
          .boundsInRoot.top
      assertTrue("One drag must move Settings below the next visible page", homeTop < settingsTop)

      composeRule.onNodeWithTag("sidebar-pages-menu").performClick()
      composeRule.onNodeWithText("Edit pinned items").performClick()
      composeRule.onNodeWithText("EDIT PINNED ITEMS").assertIsDisplayed()
      composeRule.onNodeWithText("Work").assertIsDisplayed().performTouchInput(dragOnePageDown)
      composeRule.runOnIdle {
        assertEquals(listOf("home", "settings", "work", "skills", "threads"), prefs.sidebarPageOrder.value)
        assertEquals(listOf("settings", "home", "skills", "threads"), prefs.sidebarVisiblePages.value)
      }
    } finally {
      viewModels.clear()
      try {
        closeNodeRuntimeTestFixture(runtime)
      } finally {
        Settings.Global.putString(app.contentResolver, Settings.Global.ANIMATOR_DURATION_SCALE, originalAnimatorScale)
      }
    }
  }

  @Test
  fun catalogRefreshKeepsPinnedSessionsWhileDeduplicatingRecent() {
    val app = RuntimeEnvironment.getApplication() as NodeApp
    val originalAnimatorScale = Settings.Global.getString(app.contentResolver, Settings.Global.ANIMATOR_DURATION_SCALE)
    val prefs = SecurePrefs(app, app.getSharedPreferences("sidebar-catalog-${UUID.randomUUID()}", Context.MODE_PRIVATE))
    val runtime = NodeRuntime(app, prefs, NodeRuntimeMode.ScreenshotFixture)
    val viewModel = MainViewModel(app, prefs, SavedStateHandle())
    val viewModels = ViewModelStore().apply { put("sidebar", viewModel) }
    val pinned = entry("catalog-pinned", cwd = "/work/project", recency = 3.0).copy(name = "Pinned catalog session")
    val recent = entry("catalog-recent", cwd = "/work/project", recency = 2.0).copy(name = "Catalog recent session")
    val pinnedKey = requireNotNull(pinned.sessionKey)
    val sessions =
      listOf(
        ChatSessionEntry(key = pinnedKey, updatedAtMs = 3, ownerAgentId = "main", label = pinned.name, pinned = true),
        ChatSessionEntry(key = requireNotNull(recent.sessionKey), updatedAtMs = 2, ownerAgentId = "main", label = recent.name),
        ChatSessionEntry(key = "agent:main:ordinary-recent", updatedAtMs = 1, ownerAgentId = "main", label = "Ordinary recent session"),
      )
    val catalogState = ReflectionHelpers.getField<MutableStateFlow<SessionCatalogState>>(runtime, "_sessionCatalogState")
    var selectedSessionKey: String? = null

    try {
      Settings.Global.putFloat(app.contentResolver, Settings.Global.ANIMATOR_DURATION_SCALE, 0f)
      catalogState.value = SessionCatalogState(agentId = "main", catalogs = emptyList())
      ReflectionHelpers.getField<MutableStateFlow<Boolean>>(runtime, "_sessionCatalogAvailable").value = true
      ReflectionHelpers.getField<MutableStateFlow<NodeRuntime?>>(viewModel, "runtimeRef").value = runtime
      composeRule.setContent {
        ClawDesignTheme {
          OpenClawSidebar(
            viewModel = viewModel,
            agents = emptyList(),
            selectedAgentId = "main",
            sessions = sessions,
            activeSessionKey = pinnedKey,
            activeDestination = null,
            connection = GatewayConnectionDisplay(false, "Offline", null),
            visible = true,
            showCloseButton = false,
            onClose = {},
            onDragActiveChange = {},
            onNewSession = {},
            onSelectAgent = {},
            onSelectSession = { selectedSessionKey = it.key },
            onSelectCatalogSession = {},
            onCreateCatalogSession = {},
            onSelectDestination = {},
          )
        }
      }
      composeRule.onNodeWithText("Pinned").performScrollTo().performClick()
      composeRule.onNodeWithText("Pinned catalog session").performScrollTo().assertIsDisplayed()
      composeRule.onNodeWithText("Recent").performScrollTo().performClick()
      composeRule.onNodeWithText("Catalog recent session").performScrollTo().assertIsDisplayed()

      composeRule.runOnIdle {
        catalogState.value =
          SessionCatalogState(
            agentId = "main",
            catalogs = listOf(SessionCatalog(id = "codex", label = "Codex", hosts = listOf(host("codex", sessions = listOf(pinned, recent))))),
          )
      }
      composeRule.onNodeWithText("Codex").performScrollTo().assertIsDisplayed()
      composeRule.onNodeWithText("Ordinary recent session").performScrollTo().assertIsDisplayed()
      composeRule.onNodeWithText("Catalog recent session").assertDoesNotExist()
      composeRule
        .onNodeWithText("Pinned catalog session")
        .performScrollTo()
        .assertIsDisplayed()
        .performClick()
      composeRule.runOnIdle { assertEquals(pinnedKey, selectedSessionKey) }
    } finally {
      viewModels.clear()
      try {
        closeNodeRuntimeTestFixture(runtime)
      } finally {
        Settings.Global.putString(app.contentResolver, Settings.Global.ANIMATOR_DURATION_SCALE, originalAnimatorScale)
      }
    }
  }

  @Test
  fun adoptedCatalogRowKeepsLiveRenameAcrossCatalogRefresh() {
    val app = RuntimeEnvironment.getApplication() as NodeApp
    val originalAnimatorScale = Settings.Global.getString(app.contentResolver, Settings.Global.ANIMATOR_DURATION_SCALE)
    val prefs = SecurePrefs(app, app.getSharedPreferences("sidebar-catalog-${UUID.randomUUID()}", Context.MODE_PRIVATE))
    val runtime = NodeRuntime(app, prefs, NodeRuntimeMode.ScreenshotFixture)
    val viewModel = MainViewModel(app, prefs, SavedStateHandle())
    val viewModels = ViewModelStore().apply { put("sidebar", viewModel) }
    val adopted =
      entry("adopted", cwd = "/work/project", recency = 2.0).copy(
        name = "Native title",
        gitBranch = "topic/native",
        status = "notLoaded",
      )
    val liveSessions =
      mutableStateOf(
        listOf(
          ChatSessionEntry(
            key = requireNotNull(adopted.sessionKey),
            updatedAtMs = 2,
            ownerAgentId = "main",
            label = "Native title",
            displayName = "Generated title",
          ),
        ),
      )
    val catalogState = ReflectionHelpers.getField<MutableStateFlow<SessionCatalogState>>(runtime, "_sessionCatalogState")
    val catalog = SessionCatalog(id = "codex", label = "Codex", hosts = listOf(host("codex", sessions = listOf(adopted))))

    try {
      Settings.Global.putFloat(app.contentResolver, Settings.Global.ANIMATOR_DURATION_SCALE, 0f)
      catalogState.value = SessionCatalogState(agentId = "main", catalogs = listOf(catalog))
      ReflectionHelpers.getField<MutableStateFlow<Boolean>>(runtime, "_sessionCatalogAvailable").value = true
      ReflectionHelpers.getField<MutableStateFlow<NodeRuntime?>>(viewModel, "runtimeRef").value = runtime
      composeRule.setContent {
        ClawDesignTheme {
          OpenClawSidebar(
            viewModel = viewModel,
            agents = emptyList(),
            selectedAgentId = "main",
            sessions = liveSessions.value,
            activeSessionKey = requireNotNull(adopted.sessionKey),
            activeDestination = null,
            connection = GatewayConnectionDisplay(false, "Offline", null),
            visible = true,
            showCloseButton = false,
            onClose = {},
            onDragActiveChange = {},
            onNewSession = {},
            onSelectAgent = {},
            onSelectSession = {},
            onSelectCatalogSession = {},
            onCreateCatalogSession = {},
            onSelectDestination = {},
          )
        }
      }
      composeRule.onNodeWithText("Codex").performScrollTo().performClick()
      composeRule.onNodeWithText("Native title").performScrollTo().assertIsDisplayed()
      composeRule.onNodeWithText("notLoaded", substring = true).assertDoesNotExist()
      composeRule.onNodeWithText("topic/native").assertIsDisplayed()

      composeRule.runOnIdle {
        liveSessions.value = liveSessions.value.map { it.copy(label = "Renamed in OpenClaw") }
      }
      composeRule.onNodeWithText("Renamed in OpenClaw").performScrollTo().assertIsDisplayed()
      composeRule.onNodeWithText("Native title").assertDoesNotExist()

      composeRule.runOnIdle {
        val refreshedHost = host("codex", sessions = listOf(adopted.copy(name = "Refreshed native title")))
        catalogState.value =
          catalogState.value.copy(
            catalogs = listOf(catalog.copy(hosts = listOf(refreshedHost))),
          )
      }
      composeRule.onNodeWithText("Renamed in OpenClaw").assertIsDisplayed()
      composeRule.onNodeWithText("Refreshed native title").assertDoesNotExist()

      composeRule.runOnIdle {
        liveSessions.value = liveSessions.value.map { it.copy(label = null) }
      }
      composeRule.onNodeWithText("Generated title").assertIsDisplayed()

      composeRule.runOnIdle {
        liveSessions.value = liveSessions.value.map { it.copy(displayName = null) }
      }
      composeRule.onNodeWithText("Refreshed native title").assertIsDisplayed()

      val adoptedLive = liveSessions.value.single()
      val working = composeRule.onNode(SemanticsMatcher.expectValue(SemanticsProperties.StateDescription, "Working"), useUnmergedTree = true)
      composeRule.runOnIdle {
        liveSessions.value = emptyList()
        catalogState.value =
          catalogState.value.copy(
            catalogs = listOf(catalog.copy(hosts = listOf(host("codex", sessions = listOf(adopted.copy(name = "Refreshed native title", status = "active")))))),
          )
      }
      working.assertIsDisplayed()
      for ((status, flag, active) in listOf(
        Triple("running", false, false),
        Triple("done", true, false),
        Triple("running", null, true),
        Triple(null, true, true),
      )) {
        composeRule.runOnIdle { liveSessions.value = listOf(adoptedLive.copy(status = status, hasActiveRun = flag)) }
        composeRule.onNodeWithText("Refreshed native title").assertIsDisplayed()
        if (active) working.assertIsDisplayed() else working.assertDoesNotExist()
      }
    } finally {
      viewModels.clear()
      try {
        closeNodeRuntimeTestFixture(runtime)
      } finally {
        Settings.Global.putString(app.contentResolver, Settings.Global.ANIMATOR_DURATION_SCALE, originalAnimatorScale)
      }
    }
  }

  private fun host(
    catalogId: String,
    sessions: List<SessionCatalogEntry> = emptyList(),
    nextCursor: String? = null,
    errorText: String? = null,
  ): SessionCatalogHost =
    SessionCatalogHost(
      catalogId = catalogId,
      hostId = "desktop",
      label = "Desktop",
      kind = "node",
      connected = true,
      sessions = sessions,
      nextCursor = nextCursor,
      errorText = errorText,
    )

  private fun entry(
    threadId: String,
    cwd: String?,
    recency: Double,
    archived: Boolean = false,
    catalogId: String = "codex",
  ): SessionCatalogEntry =
    SessionCatalogEntry(
      catalogId = catalogId,
      hostId = "desktop",
      threadId = threadId,
      name = threadId,
      cwd = cwd,
      status = "idle",
      recencyAt = recency,
      archived = archived,
      sessionKey = "agent:main:$threadId",
      canContinue = true,
    )
}
