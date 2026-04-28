package ai.openclaw.app.ui

import ai.openclaw.app.HomeDestination
import ai.openclaw.app.MainViewModel
import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.WindowInsetsSides
import androidx.compose.foundation.layout.consumeWindowInsets
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.ime
import androidx.compose.foundation.layout.navigationBars
import androidx.compose.foundation.layout.only
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.safeDrawing
import androidx.compose.foundation.layout.windowInsetsPadding
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ScreenShare
import androidx.compose.material.icons.filled.ChatBubble
import androidx.compose.material.icons.filled.CheckCircle
import androidx.compose.material.icons.filled.RecordVoiceOver
import androidx.compose.material.icons.filled.Settings
import androidx.compose.material3.Icon
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.zIndex

private enum class HomeTab(
  val label: String,
  val icon: ImageVector,
) {
  Connect(label = "Connect", icon = Icons.Default.CheckCircle),
  Chat(label = "Chat", icon = Icons.Default.ChatBubble),
  Voice(label = "Voice", icon = Icons.Default.RecordVoiceOver),
  Screen(label = "Screen", icon = Icons.AutoMirrored.Filled.ScreenShare),
  Settings(label = "Settings", icon = Icons.Default.Settings),
}

private enum class StatusVisual {
  Connected,
  Connecting,
  Warning,
  Error,
  Offline,
}

@Composable
fun PostOnboardingTabs(
  viewModel: MainViewModel,
  modifier: Modifier = Modifier,
) {
  var activeTab by rememberSaveable { mutableStateOf(HomeTab.Connect) }
  var chatTabStarted by rememberSaveable { mutableStateOf(false) }
  var screenTabStarted by rememberSaveable { mutableStateOf(false) }
  val requestedHomeDestination by viewModel.requestedHomeDestination.collectAsState()

  LaunchedEffect(requestedHomeDestination) {
    val destination = requestedHomeDestination ?: return@LaunchedEffect
    activeTab =
      when (destination) {
        HomeDestination.Connect -> HomeTab.Connect
        HomeDestination.Chat -> HomeTab.Chat
        HomeDestination.Voice -> HomeTab.Voice
        HomeDestination.Screen -> HomeTab.Screen
        HomeDestination.Settings -> HomeTab.Settings
      }
    viewModel.clearRequestedHomeDestination()
  }

  // Stop TTS when user navigates away from voice tab, and lazily keep the Chat/Screen tabs
  // alive after the first visit so repeated tab switches do not rebuild their UI trees.
  LaunchedEffect(activeTab) {
    viewModel.setVoiceScreenActive(activeTab == HomeTab.Voice)
    if (activeTab == HomeTab.Chat) {
      chatTabStarted = true
    }
    if (activeTab == HomeTab.Screen) {
      screenTabStarted = true
    }
  }

  val statusText by viewModel.statusText.collectAsState()
  val isConnected by viewModel.isConnected.collectAsState()

  val statusVisual =
    remember(statusText, isConnected) {
      val lower = statusText.lowercase()
      when {
        isConnected -> StatusVisual.Connected
        lower.contains("connecting") || lower.contains("reconnecting") -> StatusVisual.Connecting
        lower.contains("pairing") || lower.contains("approval") || lower.contains("auth") -> StatusVisual.Warning
        lower.contains("error") || lower.contains("failed") -> StatusVisual.Error
        else -> StatusVisual.Offline
      }
    }

  val density = LocalDensity.current
  val imeVisible = WindowInsets.ime.getBottom(density) > 0
  val hideBottomTabBar = activeTab == HomeTab.Chat && imeVisible

  Scaffold(
    modifier = modifier,
    containerColor = Color.Transparent,
    contentWindowInsets = WindowInsets(0, 0, 0, 0),
    topBar = {
      TopStatusBar(
        statusText = statusText,
        statusVisual = statusVisual,
      )
    },
    bottomBar = {
      if (!hideBottomTabBar) {
        BottomTabBar(
          activeTab = activeTab,
          onSelect = { activeTab = it },
        )
      }
    },
  ) { innerPadding ->
    Box(
      modifier =
        Modifier
          .fillMaxSize()
          .padding(innerPadding)
          .consumeWindowInsets(innerPadding)
          .background(mobileBackgroundGradient),
    ) {
      if (chatTabStarted) {
        Box(
          modifier =
            Modifier
              .matchParentSize()
              .alpha(if (activeTab == HomeTab.Chat) 1f else 0f)
              .zIndex(if (activeTab == HomeTab.Chat) 1f else 0f),
        ) {
          ChatSheet(viewModel = viewModel)
        }
      }

      if (screenTabStarted) {
        ScreenTabScreen(
          viewModel = viewModel,
          visible = activeTab == HomeTab.Screen,
          modifier =
            Modifier
              .matchParentSize()
              .alpha(if (activeTab == HomeTab.Screen) 1f else 0f)
              .zIndex(if (activeTab == HomeTab.Screen) 1f else 0f),
        )
      }

      when (activeTab) {
        HomeTab.Connect -> ConnectTabScreen(viewModel = viewModel)
        HomeTab.Chat -> if (!chatTabStarted) ChatSheet(viewModel = viewModel)
        HomeTab.Voice -> VoiceTabScreen(viewModel = viewModel)
        HomeTab.Screen -> Unit
        HomeTab.Settings -> SettingsSheet(viewModel = viewModel)
      }
    }
  }
}

@Composable
private fun ScreenTabScreen(
  viewModel: MainViewModel,
  visible: Boolean,
  modifier: Modifier = Modifier,
) {
  val isConnected by viewModel.isConnected.collectAsState()
  var refreshedForCurrentConnection by rememberSaveable(isConnected) { mutableStateOf(false) }

  LaunchedEffect(isConnected, visible, refreshedForCurrentConnection) {
    if (visible && isConnected && !refreshedForCurrentConnection) {
      viewModel.refreshHomeCanvasOverviewIfConnected()
      refreshedForCurrentConnection = true
    }
  }

  Box(modifier = modifier.fillMaxSize()) {
    CanvasScreen(viewModel = viewModel, visible = visible, modifier = Modifier.fillMaxSize())
  }
}

@Composable
private fun TopStatusBar(
  statusText: String,
  statusVisual: StatusVisual,
) {
  val safeInsets = WindowInsets.safeDrawing.only(WindowInsetsSides.Top + WindowInsetsSides.Horizontal)

  val (chipBg, chipDot, chipText, chipBorder) =
    when (statusVisual) {
      StatusVisual.Connected ->
        listOf(
          mobileSuccessSoft,
          mobileSuccess,
          mobileSuccess,
          LocalMobileColors.current.chipBorderConnected,
        )
      StatusVisual.Connecting ->
        listOf(
          mobileAccentSoft,
          mobileAccent,
          mobileAccent,
          LocalMobileColors.current.chipBorderConnecting,
        )
      StatusVisual.Warning ->
        listOf(
          mobileWarningSoft,
          mobileWarning,
          mobileWarning,
          LocalMobileColors.current.chipBorderWarning,
        )
      StatusVisual.Error ->
        listOf(
          mobileDangerSoft,
          mobileDanger,
          mobileDanger,
          LocalMobileColors.current.chipBorderError,
        )
      StatusVisual.Offline ->
        listOf(
          mobileSurface,
          mobileTextTertiary,
          mobileTextSecondary,
          mobileBorder,
        )
    }

  Surface(
    modifier = Modifier.fillMaxWidth().windowInsetsPadding(safeInsets),
    color = Color.Transparent,
    shadowElevation = 0.dp,
  ) {
    Row(
      modifier = Modifier.fillMaxWidth().padding(horizontal = 18.dp, vertical = 12.dp),
      verticalAlignment = Alignment.CenterVertically,
      horizontalArrangement = Arrangement.SpaceBetween,
    ) {
      Text(
        text = "OpenClaw",
        style = mobileTitle2,
        color = mobileText,
      )
      Surface(
        shape = RoundedCornerShape(999.dp),
        color = chipBg,
        border = androidx.compose.foundation.BorderStroke(1.dp, chipBorder),
      ) {
        Row(
          modifier = Modifier.padding(horizontal = 10.dp, vertical = 5.dp),
          horizontalArrangement = Arrangement.spacedBy(6.dp),
          verticalAlignment = Alignment.CenterVertically,
        ) {
          Surface(
            modifier = Modifier.padding(top = 1.dp),
            color = chipDot,
            shape = RoundedCornerShape(999.dp),
          ) {
            Box(modifier = Modifier.padding(4.dp))
          }
          Text(
            text = statusText.trim().ifEmpty { "Offline" },
            style = mobileCaption1,
            color = chipText,
            maxLines = 1,
          )
        }
      }
    }
  }
}

@Composable
private fun BottomTabBar(
  activeTab: HomeTab,
  onSelect: (HomeTab) -> Unit,
) {
  val safeInsets = WindowInsets.navigationBars.only(WindowInsetsSides.Bottom + WindowInsetsSides.Horizontal)

  Box(
    modifier =
      Modifier
        .fillMaxWidth(),
  ) {
    Surface(
      modifier = Modifier.fillMaxWidth(),
      color = mobileCardSurface.copy(alpha = 0.97f),
      shape = RoundedCornerShape(topStart = 24.dp, topEnd = 24.dp),
      border = BorderStroke(1.dp, mobileBorder),
      shadowElevation = 6.dp,
    ) {
      Row(
        modifier =
          Modifier
            .fillMaxWidth()
            .windowInsetsPadding(safeInsets)
            .padding(horizontal = 10.dp, vertical = 10.dp),
        horizontalArrangement = Arrangement.spacedBy(6.dp),
        verticalAlignment = Alignment.CenterVertically,
      ) {
        HomeTab.entries.forEach { tab ->
          val active = tab == activeTab
          Surface(
            onClick = { onSelect(tab) },
            modifier = Modifier.weight(1f).heightIn(min = 58.dp),
            shape = RoundedCornerShape(16.dp),
            color = if (active) mobileAccentSoft else Color.Transparent,
            border = if (active) BorderStroke(1.dp, LocalMobileColors.current.chipBorderConnecting) else null,
            shadowElevation = 0.dp,
          ) {
            Column(
              modifier = Modifier.fillMaxWidth().padding(horizontal = 6.dp, vertical = 7.dp),
              horizontalAlignment = Alignment.CenterHorizontally,
              verticalArrangement = Arrangement.spacedBy(2.dp),
            ) {
              Icon(
                imageVector = tab.icon,
                contentDescription = tab.label,
                tint = if (active) mobileAccent else mobileTextTertiary,
              )
              Text(
                text = tab.label,
                color = if (active) mobileAccent else mobileTextSecondary,
                style = mobileCaption2.copy(fontWeight = if (active) FontWeight.Bold else FontWeight.Medium),
              )
            }
          }
        }
      }
    }
  }
}
