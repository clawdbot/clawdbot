package ai.openclaw.app.ui

import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.saveable.listSaver
import androidx.compose.runtime.setValue

/**
 * Shell navigation state: the visible tab, the open settings route, and where Back
 * returns after a cross-tab detail open. All tab/route transitions go through this
 * class so Back semantics stay consistent across every entry point.
 */
internal class ShellNavigation(
  activeTab: Tab = Tab.Overview,
  settingsRoute: SettingsRoute = SettingsRoute.Home,
  returnTab: Tab? = null,
  settingsRouteFromHome: Boolean = false,
  dashboardSessionKey: String = "main",
) {
  var activeTab by mutableStateOf(activeTab)
    private set
  var settingsRoute by mutableStateOf(settingsRoute)
    private set
  var dashboardSessionKey by mutableStateOf(dashboardSessionKey)
    private set

  // Single-slot origin: Back from a cross-tab detail (settings route, Sessions,
  // Providers) returns to the tab that opened it; deeper history intentionally
  // collapses to Overview so the shell never accumulates a navigation stack.
  private var returnTab by mutableStateOf(returnTab)

  // Distinguishes a detail reached from the Settings Home list (Back unwinds to
  // Home) from one opened cross-tab (Back leaves the Settings tab entirely).
  private var settingsRouteFromHome by mutableStateOf(settingsRouteFromHome)

  /** Tab-bar-style switch: Back from the selected tab returns to Overview. */
  fun selectTab(tab: Tab) {
    if (tab == Tab.Settings) settingsRoute = SettingsRoute.Home
    settingsRouteFromHome = false
    returnTab = null
    activeTab = tab
  }

  /** Opens a settings route from another tab, remembering the origin for Back. */
  fun openSettingsRoute(route: SettingsRoute) {
    settingsRoute = route
    settingsRouteFromHome = false
    openDetailTab(Tab.Settings)
  }

  /** Opens a settings route from the Settings Home list; Back returns to Home. */
  fun openSettingsRouteFromHome(route: SettingsRoute) {
    settingsRoute = route
    settingsRouteFromHome = true
  }

  /** Opens a detail tab (Sessions, Providers) from another tab, remembering the origin for Back. */
  fun openDetailTab(tab: Tab) {
    if (activeTab != tab) returnTab = activeTab
    activeTab = tab
  }

  /** Opens the web dashboard for the chat session that initiated navigation. */
  fun openSessionDashboard(sessionKey: String) {
    dashboardSessionKey = sessionKey
    openDetailTab(Tab.Dashboard)
  }

  /** Unwinds one Back step: settings detail to Home or origin, otherwise tab to origin or Overview. */
  fun back() {
    if (activeTab == Tab.Settings && settingsRoute != SettingsRoute.Home) {
      settingsRoute = SettingsRoute.Home
      if (settingsRouteFromHome) {
        settingsRouteFromHome = false
        return
      }
    }
    if (activeTab == Tab.Dashboard) dashboardSessionKey = "main"
    activeTab = returnTab ?: Tab.Overview
    returnTab = null
  }

  companion object {
    // Android may restore a saved Voice destination from before voice moved into
    // Chat. Normalize it here so runtime navigation only contains live screens.
    private fun restoreTab(name: String): Tab = if (name == "Voice") Tab.Chat else Tab.valueOf(name)

    /** Persists shell navigation across process death for rememberSaveable. */
    val Saver =
      listSaver<ShellNavigation, String>(
        save = { nav ->
          listOf(
            nav.activeTab.name,
            nav.settingsRoute.name,
            nav.returnTab?.name.orEmpty(),
            nav.settingsRouteFromHome.toString(),
            nav.dashboardSessionKey,
          )
        },
        restore = { saved ->
          ShellNavigation(
            activeTab = restoreTab(saved[0]),
            settingsRoute = SettingsRoute.valueOf(saved[1]),
            returnTab = saved[2].takeIf { it.isNotEmpty() }?.let(::restoreTab),
            settingsRouteFromHome = saved[3].toBoolean(),
            dashboardSessionKey = saved.getOrNull(4) ?: "main",
          )
        },
      )
  }
}
