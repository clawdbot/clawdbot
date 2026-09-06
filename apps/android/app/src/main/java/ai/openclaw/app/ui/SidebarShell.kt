package ai.openclaw.app.ui

import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.widthIn
import androidx.compose.material3.DrawerState
import androidx.compose.material3.ModalDrawerSheet
import androidx.compose.material3.ModalNavigationDrawer
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.unit.dp

/**
 * Pages share one drawer at every window size, keeping compact layouts free
 * of a second navigation bar.
 */
@Composable
internal fun SidebarNavigationShell(
  drawerState: DrawerState,
  gesturesEnabled: Boolean = true,
  drawerContent: @Composable () -> Unit,
  content: @Composable () -> Unit,
) {
  ModalNavigationDrawer(
    drawerState = drawerState,
    gesturesEnabled = gesturesEnabled,
    drawerContent = {
      ModalDrawerSheet(
        drawerState = drawerState,
        modifier = Modifier.widthIn(max = 360.dp).testTag("sidebar-drawer"),
      ) {
        drawerContent()
      }
    },
  ) {
    Box(modifier = Modifier.fillMaxSize()) {
      content()
    }
  }
}
