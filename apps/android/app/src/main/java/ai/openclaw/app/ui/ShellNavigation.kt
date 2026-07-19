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
) {
  var activeTab by mutableStateOf(activeTab.unifiedChatTab())
    private set
  var settingsRoute by mutableStateOf(settingsRoute)
    private set

  // Single-slot origin: Back from a cross-tab detail (settings route, Sessions,
  // Providers) returns to the tab that opened it; deeper history intentionally
  // collapses to Overview so the shell never accumulates a navigation stack.
  private var returnTab by mutableStateOf(returnTab?.unifiedChatTab())

  // Distinguishes a detail reached from the Settings Home list (Back unwinds to
  // Home) from one opened cross-tab (Back leaves the Settings tab entirely).
  private var settingsRouteFromHome by mutableStateOf(settingsRouteFromHome)

  /** Tab-bar-style switch: Back from the selected tab returns to Overview. */
  fun selectTab(tab: Tab) {
    val destination = tab.unifiedChatTab()
    if (destination == Tab.Settings) settingsRoute = SettingsRoute.Home
    settingsRouteFromHome = false
    returnTab = null
    activeTab = destination
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
    val destination = tab.unifiedChatTab()
    if (activeTab != destination) returnTab = activeTab
    activeTab = destination
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
    activeTab = returnTab ?: Tab.Overview
    returnTab = null
  }

  companion object {
    /** Persists shell navigation across process death for rememberSaveable. */
    val Saver =
      listSaver<ShellNavigation, String>(
        save = { nav ->
          listOf(nav.activeTab.name, nav.settingsRoute.name, nav.returnTab?.name.orEmpty(), nav.settingsRouteFromHome.toString())
        },
        restore = { saved ->
          ShellNavigation(
            activeTab = Tab.valueOf(saved[0]),
            settingsRoute = SettingsRoute.valueOf(saved[1]),
            returnTab = saved[2].takeIf { it.isNotEmpty() }?.let(Tab::valueOf),
            settingsRouteFromHome = saved[3].toBoolean(),
          )
        },
      )
  }
}

/** Keeps saved state and legacy deep links compatible after Voice moved into Chat. */
private fun Tab.unifiedChatTab(): Tab = if (this == Tab.Voice) Tab.Chat else this
