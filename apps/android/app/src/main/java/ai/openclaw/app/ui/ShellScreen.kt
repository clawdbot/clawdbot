package ai.openclaw.app.ui

import ai.openclaw.app.BuildConfig
import ai.openclaw.app.GatewayChannelsSummary
import ai.openclaw.app.GatewayDreamingSummary
import ai.openclaw.app.GatewayNodesDevicesSummary
import ai.openclaw.app.GatewaySkillSummary
import ai.openclaw.app.HomeDestination
import ai.openclaw.app.MainViewModel
import ai.openclaw.app.NodeRuntime
import ai.openclaw.app.ui.chat.ChatScreen
import ai.openclaw.app.ui.design.ClawBottomNav
import ai.openclaw.app.ui.design.ClawDesignTheme
import ai.openclaw.app.ui.design.ClawEmptyState
import ai.openclaw.app.ui.design.ClawNavItem
import ai.openclaw.app.ui.design.ClawPanel
import ai.openclaw.app.ui.design.ClawPrimaryButton
import ai.openclaw.app.ui.design.ClawScaffold
import ai.openclaw.app.ui.design.ClawSecondaryButton
import ai.openclaw.app.ui.design.ClawTheme
import androidx.activity.compose.BackHandler
import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.isSystemInDarkTheme
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.WindowInsetsSides
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.ime
import androidx.compose.foundation.layout.only
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.safeDrawing
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.automirrored.filled.ExitToApp
import androidx.compose.material.icons.automirrored.filled.KeyboardArrowRight
import androidx.compose.material.icons.automirrored.filled.ScreenShare
import androidx.compose.material.icons.filled.Cloud
import androidx.compose.material.icons.filled.Home
import androidx.compose.material.icons.filled.Lock
import androidx.compose.material.icons.filled.Mic
import androidx.compose.material.icons.filled.Notifications
import androidx.compose.material.icons.filled.Palette
import androidx.compose.material.icons.filled.Person
import androidx.compose.material.icons.filled.Search
import androidx.compose.material.icons.filled.Settings
import androidx.compose.material.icons.filled.Storage
import androidx.compose.material.icons.outlined.AccessTime
import androidx.compose.material.icons.outlined.ChatBubbleOutline
import androidx.compose.material.icons.outlined.Inventory2
import androidx.compose.material.icons.outlined.MicNone
import androidx.compose.material.icons.outlined.Settings
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp

internal enum class Tab(
  val key: String,
  val label: String,
  val icon: ImageVector,
) {
  Overview(key = "overview", label = "Home", icon = Icons.Default.Home),
  Chat(key = "chat", label = "Chat", icon = Icons.Outlined.ChatBubbleOutline),
  Voice(key = "voice", label = "Voice", icon = Icons.Outlined.MicNone),
  Sessions(key = "sessions", label = "Sessions", icon = Icons.Outlined.AccessTime),
  Settings(key = "settings", label = "Settings", icon = Icons.Outlined.Settings),
  ProvidersModels(key = "providers-models", label = "Providers", icon = Icons.Outlined.Inventory2),
}

private val shellNavTabs = listOf(Tab.Overview, Tab.Chat, Tab.Voice, Tab.Settings)

private val shellContentInsets: WindowInsets
  @Composable get() = WindowInsets.safeDrawing.only(WindowInsetsSides.Top + WindowInsetsSides.Horizontal)

internal fun shellBottomNavVisible(
  keyboardVisible: Boolean,
  commandOpen: Boolean,
): Boolean = !keyboardVisible && !commandOpen

/** Main post-onboarding shell that owns top-level Android navigation state. */
@Composable
fun ShellScreen(
  viewModel: MainViewModel,
  modifier: Modifier = Modifier,
) {
  val appearanceThemeMode by viewModel.appearanceThemeMode.collectAsState()
  val shellDark = appearanceThemeMode.isDark(systemDark = isSystemInDarkTheme())
  OpenClawSystemBarAppearance(lightAppearance = !shellDark)
  ClawDesignTheme(dark = shellDark) {
    var activeTab by rememberSaveable { mutableStateOf(Tab.Overview) }
    var settingsRoute by rememberSaveable { mutableStateOf(SettingsRoute.Home) }
    var returnToOverviewFromSettings by rememberSaveable { mutableStateOf(false) }
    var commandOpen by rememberSaveable { mutableStateOf(false) }
    var voiceScreenWasActive by rememberSaveable { mutableStateOf(false) }
    val requestedHomeDestination by viewModel.requestedHomeDestination.collectAsState()
    val pendingTrust by viewModel.pendingGatewayTrust.collectAsState()
    val runtimeInitialized by viewModel.runtimeInitialized.collectAsState()

    LaunchedEffect(requestedHomeDestination) {
      val destination = requestedHomeDestination ?: return@LaunchedEffect
      // HomeDestination is a one-shot command from launch intents and settings
      // actions; consume it after translating to local shell state.
      activeTab =
        when (destination) {
          HomeDestination.Connect -> Tab.Overview
          HomeDestination.Chat -> Tab.Chat
          HomeDestination.Voice -> Tab.Voice
          HomeDestination.Screen -> Tab.Chat
          HomeDestination.Settings -> Tab.Settings
        }
      if (destination == HomeDestination.Settings) {
        settingsRoute = SettingsRoute.Home
        returnToOverviewFromSettings = false
      }
      viewModel.clearRequestedHomeDestination()
    }

    LaunchedEffect(activeTab, runtimeInitialized) {
      val voiceScreenActive = activeTab == Tab.Voice
      if (voiceScreenActive || voiceScreenWasActive || runtimeInitialized) {
        viewModel.setVoiceScreenActive(voiceScreenActive)
      }
      voiceScreenWasActive = voiceScreenActive
    }

    BackHandler(enabled = activeTab != Tab.Overview) {
      activeTab = Tab.Overview
    }

    BackHandler(enabled = commandOpen) {
      commandOpen = false
    }

    val density = LocalDensity.current
    val keyboardVisible = WindowInsets.ime.getBottom(density) > 0
    val showBottomNav = shellBottomNavVisible(keyboardVisible = keyboardVisible, commandOpen = commandOpen)

    Scaffold(
      modifier = modifier.fillMaxSize(),
      containerColor = ClawTheme.colors.canvas,
      contentWindowInsets = WindowInsets(0, 0, 0, 0),
      bottomBar = {
        if (showBottomNav) {
          ClawBottomNav(
            items = shellNavTabs.map { ClawNavItem(key = it.key, label = it.label, icon = it.icon) },
            selectedKey = if (activeTab in shellNavTabs) activeTab.key else Tab.Overview.key,
            onSelect = { key ->
              val next = shellNavTabs.firstOrNull { it.key == key } ?: Tab.Overview
              if (next == Tab.Settings) {
                settingsRoute = SettingsRoute.Home
                returnToOverviewFromSettings = false
              }
              activeTab = next
            },
          )
        }
      },
    ) { shellPadding ->
      Box(modifier = Modifier.fillMaxSize().padding(shellPadding)) {
        when (activeTab) {
          Tab.Overview ->
            OverviewScreen(
              viewModel = viewModel,
              onSelectTab = { activeTab = it },
              onOpenSettingsRoute = {
                settingsRoute = it
                returnToOverviewFromSettings = true
                activeTab = Tab.Settings
              },
              onOpenCommand = { commandOpen = true },
            )
          Tab.Chat ->
            ChatShellScreen(
              viewModel = viewModel,
              onVoice = { activeTab = Tab.Voice },
              onOpenSessions = { activeTab = Tab.Sessions },
            )
          Tab.Voice ->
            VoiceShellScreen(
              viewModel = viewModel,
              onOpenCommand = { commandOpen = true },
              onOpenGatewaySettings = {
                settingsRoute = SettingsRoute.Gateway
                returnToOverviewFromSettings = false
                activeTab = Tab.Settings
              },
              onOpenVoiceSettings = {
                settingsRoute = SettingsRoute.Voice
                returnToOverviewFromSettings = false
                activeTab = Tab.Settings
              },
            )
          Tab.ProvidersModels ->
            ProvidersModelsScreen(
              viewModel = viewModel,
              onBack = { activeTab = Tab.Overview },
            )
          Tab.Sessions ->
            SessionsScreen(
              viewModel = viewModel,
              onOpenCommand = { commandOpen = true },
              onOpenChat = { activeTab = Tab.Chat },
            )
          Tab.Settings ->
            SettingsShellScreen(
              viewModel = viewModel,
              route = settingsRoute,
              onRouteChange = {
                settingsRoute = it
                returnToOverviewFromSettings = false
              },
              onRouteBack = {
                settingsRoute = SettingsRoute.Home
                if (returnToOverviewFromSettings) {
                  returnToOverviewFromSettings = false
                  activeTab = Tab.Overview
                }
              },
              onBackHome = { activeTab = Tab.Overview },
              onOpenCommand = { commandOpen = true },
            )
        }

        if (commandOpen) {
          CommandPalette(
            viewModel = viewModel,
            onDismiss = { commandOpen = false },
            onOpenChat = {
              activeTab = Tab.Chat
              commandOpen = false
            },
            onOpenVoice = {
              activeTab = Tab.Voice
              commandOpen = false
            },
            onOpenSessions = {
              activeTab = Tab.Sessions
              commandOpen = false
            },
            onOpenProviders = {
              activeTab = Tab.ProvidersModels
              commandOpen = false
            },
            onOpenSettings = {
              settingsRoute = SettingsRoute.Home
              returnToOverviewFromSettings = false
              activeTab = Tab.Settings
              commandOpen = false
            },
            onOpenSession = { sessionKey ->
              viewModel.switchChatSession(sessionKey)
              activeTab = Tab.Chat
              commandOpen = false
            },
          )
        }

        pendingTrust?.let { prompt ->
          // Gateway certificate trust is modal across the shell so navigation
          // cannot hide a changed TLS identity prompt.
          GatewayTrustDialog(
            prompt = prompt,
            onAccept = viewModel::acceptGatewayTrustPrompt,
            onDecline = viewModel::declineGatewayTrustPrompt,
          )
        }
      }
    }
  }
}

/** Modal trust decision for first-seen or changed gateway TLS fingerprints. */
@Composable
private fun GatewayTrustDialog(
  prompt: NodeRuntime.GatewayTrustPrompt,
  onAccept: () -> Unit,
  onDecline: () -> Unit,
) {
  val message =
    if (prompt.previousFingerprintSha256.isNullOrBlank()) {
      "Verify the certificate fingerprint before trusting this gateway.\n\n${prompt.fingerprintSha256}"
    } else {
      "The gateway certificate changed. Continue only if you expected this.\n\nOld SHA-256:\n${prompt.previousFingerprintSha256}\n\nNew SHA-256:\n${prompt.fingerprintSha256}"
    }

  AlertDialog(
    onDismissRequest = onDecline,
    containerColor = ClawTheme.colors.surfaceRaised,
    title = { Text("Trust this gateway?", style = ClawTheme.type.section, color = ClawTheme.colors.text) },
    text = { Text(message, style = ClawTheme.type.body, color = ClawTheme.colors.textMuted) },
    confirmButton = {
      TextButton(onClick = onAccept) {
        Text("Trust")
      }
    },
    dismissButton = {
      TextButton(onClick = onDecline) {
        Text("Cancel")
      }
    },
  )
}

@Composable
private fun OverviewScreen(
  viewModel: MainViewModel,
  onSelectTab: (Tab) -> Unit,
  onOpenSettingsRoute: (SettingsRoute) -> Unit,
  onOpenCommand: () -> Unit,
) {
  val isConnected by viewModel.isConnected.collectAsState()
  val sessions by viewModel.chatSessions.collectAsState()
  val pendingRunCount by viewModel.pendingRunCount.collectAsState()
  val statusText by viewModel.statusText.collectAsState()
  val models by viewModel.modelCatalog.collectAsState()
  val providers by viewModel.modelAuthProviders.collectAsState()
  val pendingToolCalls by viewModel.chatPendingToolCalls.collectAsState()
  val cronStatus by viewModel.cronStatus.collectAsState()
  val nodesDevicesSummary by viewModel.nodesDevicesSummary.collectAsState()
  val channelsSummary by viewModel.channelsSummary.collectAsState()
  val readyProviderCount = providerRows(providers = providers, models = models).count { it.ready }
  val attentionRows =
    homeAttentionRows(
      isConnected = isConnected,
      pendingApprovals = pendingToolCalls.size,
      channelsSummary = channelsSummary,
      nodesDevicesSummary = nodesDevicesSummary,
      readyProviderCount = readyProviderCount,
    )

  LaunchedEffect(isConnected) {
    if (isConnected) {
      viewModel.refreshChatSessions(limit = 20)
      viewModel.refreshModelCatalog()
      viewModel.refreshCronJobs()
      viewModel.refreshNodesDevices()
      viewModel.refreshChannels()
    }
  }

  ClawScaffold(
    contentPadding = PaddingValues(start = 20.dp, top = 14.dp, end = 20.dp, bottom = 6.dp),
    contentWindowInsets = shellContentInsets,
  ) {
    Box(modifier = Modifier.fillMaxSize()) {
      LazyColumn(modifier = Modifier.fillMaxSize(), verticalArrangement = Arrangement.spacedBy(12.dp), contentPadding = PaddingValues(bottom = 4.dp)) {
        item {
          Row(
            modifier = Modifier.fillMaxWidth(),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(9.dp),
          ) {
            Text(
              text = "O P E N C L A W",
              style = ClawTheme.type.title.copy(fontSize = 16.sp, lineHeight = 20.sp),
              color = ClawTheme.colors.text,
              modifier = Modifier.weight(1f),
            )
            PlainIconButton(icon = Icons.Default.Search, contentDescription = "Search", onClick = onOpenCommand)
            OverviewAvatar(text = "OC")
          }
        }

        item {
          CompanionHeroPanel(
            statusText = gatewaySummary(statusText, isConnected),
            isConnected = isConnected,
            pendingRunCount = pendingRunCount,
            onOpenChat = { onSelectTab(Tab.Chat) },
            onOpenVoice = { onSelectTab(Tab.Voice) },
            onOpenGateway = { onOpenSettingsRoute(SettingsRoute.Gateway) },
          )
        }

        if (attentionRows.isNotEmpty()) {
          item {
            HomeAttentionPanel(rows = attentionRows, onSelectTab = onSelectTab, onOpenSettingsRoute = onOpenSettingsRoute)
          }
        }

        item {
          SectionLabel(
            title = "Recent Sessions",
            action = {
              Text(
                text = "View all",
                modifier = Modifier.clickable { onSelectTab(Tab.Sessions) },
                style = ClawTheme.type.caption,
                color = ClawTheme.colors.textMuted,
              )
            },
          )
        }

        if (sessions.isEmpty()) {
          item {
            ClawEmptyState(
              title = "No recent sessions",
              body = "Start a chat and your active OpenClaw conversations will appear here.",
              action = { ClawPrimaryButton(text = "Start Chat", onClick = { onSelectTab(Tab.Chat) }) },
            )
          }
        } else {
          item {
            RecentSessionList(
              rows =
                sessions.take(5).map { session ->
                  RecentSessionListItem(
                    key = session.key,
                    title = displaySessionTitle(session.displayName),
                    subtitle = if (pendingRunCount > 0) "Assistant working" else "OpenClaw session",
                    metadata = session.updatedAtMs?.let(::relativeSessionTime) ?: "",
                  )
                },
              onOpen = { sessionKey ->
                viewModel.switchChatSession(sessionKey)
                onSelectTab(Tab.Chat)
              },
            )
          }
        }

        item {
          SectionLabel(title = "Control center")
        }

        item {
          ModuleList(
            rows =
              listOf(
                ModuleRow("Sessions", "Conversation history", if (sessions.isEmpty()) "Empty" else "${sessions.size} recent", Icons.Outlined.AccessTime, Tab.Sessions),
                ModuleRow(
                  title = "Providers & Models",
                  subtitle = "Provider readiness",
                  metadata =
                    when {
                      !isConnected -> "Offline"
                      readyProviderCount > 0 -> "$readyProviderCount ready"
                      else -> "No ready"
                    },
                  icon = Icons.Outlined.Inventory2,
                  tab = Tab.ProvidersModels,
                ),
                ModuleRow("Channels", "Connected messengers", channelsSummaryText(channelsSummary), Icons.Default.Notifications, Tab.Settings, SettingsRoute.Channels),
                ModuleRow("Nodes & Devices", "Phone and node health", nodesDevicesSummaryText(nodesDevicesSummary), Icons.Default.Cloud, Tab.Settings, SettingsRoute.NodesDevices),
                ModuleRow("Approvals", "Tool decisions", approvalsSummary(pendingToolCalls.size), Icons.Default.Lock, Tab.Settings, SettingsRoute.Approvals),
                ModuleRow("Settings", "More runtime controls", null, Icons.Outlined.Settings, Tab.Settings, SettingsRoute.Home),
              ),
            onSelectTab = onSelectTab,
            onOpenSettingsRoute = onOpenSettingsRoute,
          )
        }
      }
    }
  }
}

private data class ModuleRow(
  val title: String,
  val subtitle: String?,
  val metadata: String?,
  val icon: ImageVector,
  val tab: Tab,
  val settingsRoute: SettingsRoute? = null,
)

@Composable
private fun CompanionHeroPanel(
  statusText: String,
  isConnected: Boolean,
  pendingRunCount: Int,
  onOpenChat: () -> Unit,
  onOpenVoice: () -> Unit,
  onOpenGateway: () -> Unit,
) {
  ClawPanel(contentPadding = PaddingValues(16.dp)) {
    Column(verticalArrangement = Arrangement.spacedBy(14.dp)) {
      Row(modifier = Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(10.dp)) {
        Surface(
          modifier = Modifier.size(38.dp),
          shape = CircleShape,
          color = if (isConnected) ClawTheme.colors.successSoft else ClawTheme.colors.surfacePressed,
          border = BorderStroke(1.dp, if (isConnected) ClawTheme.colors.success else ClawTheme.colors.border),
        ) {
          Box(contentAlignment = Alignment.Center) {
            Icon(imageVector = Icons.Outlined.ChatBubbleOutline, contentDescription = null, modifier = Modifier.size(19.dp), tint = if (isConnected) ClawTheme.colors.success else ClawTheme.colors.text)
          }
        }
        Column(modifier = Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(3.dp)) {
          Text(text = if (pendingRunCount > 0) "OpenClaw is working" else "Ready when you are", style = ClawTheme.type.title.copy(fontSize = 20.sp, lineHeight = 24.sp), color = ClawTheme.colors.text)
          Text(text = statusText, style = ClawTheme.type.body, color = ClawTheme.colors.textMuted, maxLines = 1, overflow = TextOverflow.Ellipsis)
        }
      }
      Row(modifier = Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(9.dp)) {
        ClawPrimaryButton(text = "Start chat", icon = Icons.Outlined.ChatBubbleOutline, onClick = onOpenChat, modifier = Modifier.weight(1f))
        ClawSecondaryButton(text = "Voice", icon = Icons.Outlined.MicNone, onClick = onOpenVoice, modifier = Modifier.weight(1f))
      }
      if (!isConnected) {
        ClawSecondaryButton(text = "Reconnect gateway", icon = Icons.Default.Cloud, onClick = onOpenGateway, modifier = Modifier.fillMaxWidth())
      }
    }
  }
}

internal data class HomeAttentionRow(
  val title: String,
  val subtitle: String,
  val icon: ImageVector,
  val tab: Tab,
  val settingsRoute: SettingsRoute? = null,
)

internal fun homeAttentionRows(
  isConnected: Boolean,
  pendingApprovals: Int,
  channelsSummary: GatewayChannelsSummary,
  nodesDevicesSummary: GatewayNodesDevicesSummary,
  readyProviderCount: Int,
  expiringProviderCount: Int = 0,
): List<HomeAttentionRow> =
  listOfNotNull(
    if (!isConnected) {
      HomeAttentionRow("Gateway", "Connect before chat, voice, and live status.", Icons.Default.Cloud, Tab.Settings, SettingsRoute.Gateway)
    } else {
      null
    },
    if (pendingApprovals > 0) {
      HomeAttentionRow("Approvals", approvalsSummary(pendingApprovals), Icons.Default.Lock, Tab.Settings, SettingsRoute.Approvals)
    } else {
      null
    },
    if (channelsSummary.channels.any { it.error != null }) {
      HomeAttentionRow("Channels", channelsSummaryText(channelsSummary), Icons.Default.Notifications, Tab.Settings, SettingsRoute.Channels)
    } else {
      null
    },
    if (nodesDevicesSummary.pendingDevices.isNotEmpty()) {
      HomeAttentionRow("Nodes & Devices", nodesDevicesSummaryText(nodesDevicesSummary), Icons.Default.Cloud, Tab.Settings, SettingsRoute.NodesDevices)
    } else {
      null
    },
    if (isConnected && readyProviderCount == 0) {
      HomeAttentionRow("Providers", "No ready providers", Icons.Outlined.Inventory2, Tab.Settings, SettingsRoute.Gateway)
    } else {
      null
    },
  )

@Composable
private fun HomeAttentionPanel(
  rows: List<HomeAttentionRow>,
  onSelectTab: (Tab) -> Unit,
  onOpenSettingsRoute: (SettingsRoute) -> Unit,
) {
  ClawPanel(contentPadding = PaddingValues(horizontal = 14.dp, vertical = 8.dp)) {
    Column(verticalArrangement = Arrangement.spacedBy(4.dp)) {
      Text(text = "Needs attention", style = ClawTheme.type.caption.copy(fontSize = 12.5.sp, lineHeight = 16.sp), color = ClawTheme.colors.warning)
      rows.forEach { row ->
        ModuleListRow(
          row = ModuleRow(row.title, row.subtitle, null, row.icon, row.tab, row.settingsRoute),
          onClick = {
            val route = row.settingsRoute
            if (route == null) {
              onSelectTab(row.tab)
            } else {
              onOpenSettingsRoute(route)
            }
          },
        )
      }
    }
  }
}

@Composable
private fun OverviewAvatar(text: String) {
  Surface(
    modifier = Modifier.size(34.dp),
    shape = CircleShape,
    color = ClawTheme.colors.surfaceRaised,
    contentColor = ClawTheme.colors.text,
    border = BorderStroke(1.dp, ClawTheme.colors.border),
  ) {
    Box(contentAlignment = Alignment.Center) {
      Text(text = text.take(2).uppercase(), style = ClawTheme.type.label)
    }
  }
}

@Composable
private fun SectionLabel(
  title: String,
  action: (@Composable () -> Unit)? = null,
) {
  Row(
    modifier = Modifier.fillMaxWidth(),
    verticalAlignment = Alignment.CenterVertically,
    horizontalArrangement = Arrangement.SpaceBetween,
  ) {
    Text(text = title.uppercase(), style = ClawTheme.type.caption.copy(fontSize = 12.5.sp, lineHeight = 16.sp), color = ClawTheme.colors.textMuted)
    action?.invoke()
  }
}

@Composable
private fun ModuleList(
  rows: List<ModuleRow>,
  onSelectTab: (Tab) -> Unit,
  onOpenSettingsRoute: (SettingsRoute) -> Unit,
) {
  ClawPanel(contentPadding = PaddingValues(horizontal = 14.dp, vertical = 4.dp)) {
    Column(verticalArrangement = Arrangement.spacedBy(0.dp)) {
      rows.forEachIndexed { index, row ->
        ModuleListRow(
          row = row,
          onClick = {
            val route = row.settingsRoute
            if (route == null) {
              onSelectTab(row.tab)
            } else {
              onOpenSettingsRoute(route)
            }
          },
        )
        if (index != rows.lastIndex) {
          HorizontalDivider(color = ClawTheme.colors.border.copy(alpha = 0.82f), thickness = 1.dp)
        }
      }
    }
  }
}

@Composable
private fun ModuleListRow(
  row: ModuleRow,
  onClick: () -> Unit,
) {
  Surface(color = Color.Transparent, contentColor = ClawTheme.colors.text) {
    Row(
      modifier =
        Modifier
          .fillMaxWidth()
          .heightIn(min = 54.dp)
          .clip(RoundedCornerShape(ClawTheme.radii.row))
          .clickable(onClick = onClick)
          .padding(horizontal = 0.dp, vertical = 6.dp),
      verticalAlignment = Alignment.CenterVertically,
      horizontalArrangement = Arrangement.spacedBy(9.dp),
    ) {
      Icon(imageVector = row.icon, contentDescription = null, modifier = Modifier.size(20.dp), tint = ClawTheme.colors.text)
      Column(modifier = Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(1.dp)) {
        Text(
          text = row.title,
          style = ClawTheme.type.body,
          color = ClawTheme.colors.text,
          maxLines = 1,
          overflow = TextOverflow.Ellipsis,
        )
        row.subtitle?.let {
          Text(text = it, style = ClawTheme.type.caption.copy(fontSize = 12.5.sp, lineHeight = 16.sp), color = ClawTheme.colors.textSubtle, maxLines = 1, overflow = TextOverflow.Ellipsis)
        }
      }
      row.metadata?.let {
        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(6.dp)) {
          Box(modifier = Modifier.size(4.5.dp).clip(CircleShape).background(statusDotColor(it)))
          Text(text = it, style = ClawTheme.type.caption.copy(fontSize = 13.sp, lineHeight = 17.sp), color = ClawTheme.colors.textMuted, maxLines = 1, overflow = TextOverflow.Ellipsis)
        }
      }
      Icon(
        imageVector = Icons.AutoMirrored.Filled.KeyboardArrowRight,
        contentDescription = "Open ${row.title}",
        modifier = Modifier.size(17.dp),
        tint = ClawTheme.colors.textMuted,
      )
    }
  }
}

@Composable
private fun RecentSessionRow(
  title: String,
  subtitle: String,
  metadata: String,
  onClick: () -> Unit,
) {
  RecentSessionRowContent(title = title, subtitle = subtitle, metadata = metadata, onClick = onClick)
}

private data class RecentSessionListItem(
  val key: String,
  val title: String,
  val subtitle: String,
  val metadata: String,
)

/** Recent sessions panel that preserves the session key behind display labels. */
@Composable
private fun RecentSessionList(
  rows: List<RecentSessionListItem>,
  onOpen: (String) -> Unit,
) {
  ClawPanel(contentPadding = PaddingValues(horizontal = 14.dp, vertical = 4.dp)) {
    Column {
      rows.forEachIndexed { index, row ->
        RecentSessionRowContent(
          title = row.title,
          subtitle = row.subtitle,
          metadata = row.metadata,
          onClick = { onOpen(row.key) },
        )
        if (index != rows.lastIndex) {
          HorizontalDivider(color = ClawTheme.colors.border.copy(alpha = 0.82f), thickness = 1.dp)
        }
      }
    }
  }
}

@Composable
private fun RecentSessionRowContent(
  title: String,
  subtitle: String,
  metadata: String,
  onClick: () -> Unit,
) {
  Surface(color = Color.Transparent, contentColor = ClawTheme.colors.text) {
    Row(
      modifier =
        Modifier
          .fillMaxWidth()
          .heightIn(min = 58.dp)
          .clip(RoundedCornerShape(ClawTheme.radii.row))
          .clickable(onClick = onClick)
          .padding(horizontal = 0.dp, vertical = 7.dp),
      verticalAlignment = Alignment.CenterVertically,
      horizontalArrangement = Arrangement.spacedBy(8.dp),
    ) {
      Surface(
        modifier = Modifier.size(30.dp),
        shape = CircleShape,
        color = ClawTheme.colors.canvas,
        border = BorderStroke(1.dp, ClawTheme.colors.borderStrong),
      ) {
        Box(contentAlignment = Alignment.Center) {
          Icon(imageVector = Icons.Outlined.ChatBubbleOutline, contentDescription = null, modifier = Modifier.size(15.dp), tint = ClawTheme.colors.text)
        }
      }
      Column(modifier = Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(1.dp)) {
        Text(text = title, style = ClawTheme.type.body, color = ClawTheme.colors.text, maxLines = 1)
        Text(text = subtitle, style = ClawTheme.type.caption.copy(fontSize = 13.sp, lineHeight = 17.sp), color = ClawTheme.colors.textSubtle, maxLines = 1)
      }
      Text(text = metadata, style = ClawTheme.type.caption.copy(fontSize = 13.sp, lineHeight = 17.sp), color = ClawTheme.colors.textMuted)
      Icon(
        imageVector = Icons.AutoMirrored.Filled.KeyboardArrowRight,
        contentDescription = "Open session",
        modifier = Modifier.size(14.dp),
        tint = ClawTheme.colors.textMuted,
      )
    }
  }
}

@Composable
private fun ChatShellScreen(
  viewModel: MainViewModel,
  onVoice: () -> Unit,
  onOpenSessions: () -> Unit,
) {
  ClawScaffold(
    contentPadding = PaddingValues(start = 0.dp, top = 8.dp, end = 0.dp, bottom = 0.dp),
    contentWindowInsets = shellContentInsets,
  ) {
    ChatScreen(
      viewModel = viewModel,
      onVoice = onVoice,
      onOpenSessions = onOpenSessions,
    )
  }
}

@Composable
private fun VoiceShellScreen(
  viewModel: MainViewModel,
  onOpenCommand: () -> Unit,
  onOpenGatewaySettings: () -> Unit,
  onOpenVoiceSettings: () -> Unit,
) {
  ClawScaffold(
    contentPadding = PaddingValues(start = 0.dp, top = 8.dp, end = 0.dp, bottom = 0.dp),
    contentWindowInsets = shellContentInsets,
  ) {
    VoiceScreen(
      viewModel = viewModel,
      onOpenCommand = onOpenCommand,
      onOpenGatewaySettings = onOpenGatewaySettings,
      onOpenVoiceSettings = onOpenVoiceSettings,
    )
  }
}

@Composable
private fun SettingsShellScreen(
  viewModel: MainViewModel,
  route: SettingsRoute,
  onRouteChange: (SettingsRoute) -> Unit,
  onRouteBack: () -> Unit,
  onBackHome: () -> Unit,
  onOpenCommand: () -> Unit,
) {
  val displayName by viewModel.displayName.collectAsState()
  val isConnected by viewModel.isConnected.collectAsState()
  val statusText by viewModel.statusText.collectAsState()
  val cameraEnabled by viewModel.cameraEnabled.collectAsState()
  val notificationForwardingEnabled by viewModel.notificationForwardingEnabled.collectAsState()
  val speakerEnabled by viewModel.speakerEnabled.collectAsState()
  val agents by viewModel.gatewayAgents.collectAsState()
  val pendingToolCalls by viewModel.chatPendingToolCalls.collectAsState()
  val cronStatus by viewModel.cronStatus.collectAsState()
  val usageSummary by viewModel.usageSummary.collectAsState()
  val skillsSummary by viewModel.skillsSummary.collectAsState()
  val nodesDevicesSummary by viewModel.nodesDevicesSummary.collectAsState()
  val channelsSummary by viewModel.channelsSummary.collectAsState()
  val dreamingSummary by viewModel.dreamingSummary.collectAsState()
  val appearanceThemeMode by viewModel.appearanceThemeMode.collectAsState()

  LaunchedEffect(isConnected) {
    if (isConnected) {
      viewModel.refreshAgents()
      viewModel.refreshCronJobs()
      viewModel.refreshUsage()
      viewModel.refreshSkills()
      viewModel.refreshNodesDevices()
      viewModel.refreshChannels()
      viewModel.refreshDreaming()
    }
  }

  BackHandler(enabled = route != SettingsRoute.Home) {
    onRouteBack()
  }

  if (route != SettingsRoute.Home) {
    SettingsDetailScreen(viewModel = viewModel, route = route, onBack = onRouteBack)
    return
  }

  ClawScaffold(
    contentPadding = PaddingValues(start = 20.dp, top = 14.dp, end = 20.dp, bottom = 6.dp),
    contentWindowInsets = shellContentInsets,
  ) {
    LazyColumn(modifier = Modifier.fillMaxSize(), verticalArrangement = Arrangement.spacedBy(13.dp), contentPadding = PaddingValues(bottom = 4.dp)) {
      item {
        Row(
          modifier = Modifier.fillMaxWidth(),
          verticalAlignment = Alignment.CenterVertically,
          horizontalArrangement = Arrangement.spacedBy(9.dp),
        ) {
          PlainIconButton(icon = Icons.AutoMirrored.Filled.ArrowBack, contentDescription = "Back to home", onClick = onBackHome)
          Text(text = "Settings", style = ClawTheme.type.title.copy(fontSize = 16.sp, lineHeight = 20.sp), color = ClawTheme.colors.text, modifier = Modifier.weight(1f))
          SettingsSearchButton(onClick = onOpenCommand)
        }
      }

      item {
        ProfilePanel(displayName = displayName.ifBlank { "OpenClaw" }, onClick = { onRouteChange(SettingsRoute.Profile) })
      }

      item {
        SettingsGroup(
          rows =
            listOf(
              SettingsRow("Profile", displayName.ifBlank { "Local device" }, Icons.Default.Person, route = SettingsRoute.Profile),
              SettingsRow("Voice", if (speakerEnabled) "Speaker on" else "Speaker muted", Icons.Default.Mic, route = SettingsRoute.Voice),
              SettingsRow("Agents", if (agents.isEmpty()) "Load from gateway" else "${agents.size} available", Icons.Default.Person, status = agents.isNotEmpty(), route = SettingsRoute.Agents),
              SettingsRow("Approvals", approvalsSummary(pendingToolCalls.size), Icons.Default.Lock, status = approvalsStatus(pendingToolCalls.size), route = SettingsRoute.Approvals),
              SettingsRow("Cron Jobs", cronJobsSummary(cronStatus.jobs), Icons.Outlined.AccessTime, status = if (cronStatus.jobs > 0) cronStatus.enabled else null, route = SettingsRoute.CronJobs),
              SettingsRow("Usage", usageSummaryText(usageSummary.providers.size), Icons.Default.Storage, status = if (usageSummary.providers.isNotEmpty()) true else null, route = SettingsRoute.Usage),
              SettingsRow("Skills", skillsSummaryText(skillsSummary.skills), Icons.Default.Settings, status = skillsStatus(skillsSummary.skills), route = SettingsRoute.Skills),
              SettingsRow("Nodes & Devices", nodesDevicesSummaryText(nodesDevicesSummary), Icons.Default.Cloud, status = nodesDevicesStatus(nodesDevicesSummary), route = SettingsRoute.NodesDevices),
              SettingsRow("Channels", channelsSummaryText(channelsSummary), Icons.Default.Notifications, status = channelsStatus(channelsSummary), route = SettingsRoute.Channels),
              SettingsRow("Dreaming", dreamingSummaryText(dreamingSummary), Icons.Default.Storage, status = dreamingStatus(dreamingSummary), route = SettingsRoute.Dreaming),
              SettingsRow("Canvas", "Screen surface", Icons.AutoMirrored.Filled.ScreenShare, status = isConnected, route = SettingsRoute.Canvas),
              SettingsRow("Notifications", if (notificationForwardingEnabled) "Smart delivery" else "Off", Icons.Default.Notifications, route = SettingsRoute.Notifications),
              SettingsRow("Phone Capabilities", if (cameraEnabled) "Camera enabled" else "Locked", Icons.Default.Lock, status = !cameraEnabled, route = SettingsRoute.PhoneCapabilities),
              SettingsRow("Gateway", gatewaySummary(statusText, isConnected), Icons.Default.Cloud, status = isConnected, route = SettingsRoute.Gateway),
              SettingsRow("Appearance", appearanceThemeSummary(appearanceThemeMode), Icons.Default.Palette, route = SettingsRoute.Appearance),
              SettingsRow("Health", "Diagnostics", Icons.Default.Settings, status = isConnected, route = SettingsRoute.Health),
              SettingsRow("About", "Version and update", Icons.Default.Storage, route = SettingsRoute.About),
            ),
          onOpen = onRouteChange,
        )
      }

      item {
        SettingsGroup(
          rows = listOf(SettingsRow("Sign Out", "Disconnect", Icons.AutoMirrored.Filled.ExitToApp)),
          onOpen = { },
          onAction = { viewModel.disconnect() },
        )
      }

      item {
        Column(
          modifier = Modifier.fillMaxWidth().padding(top = 14.dp),
          horizontalAlignment = Alignment.CenterHorizontally,
          verticalArrangement = Arrangement.spacedBy(3.dp),
        ) {
          Text(text = "OpenClaw ${BuildConfig.VERSION_NAME} (${BuildConfig.VERSION_CODE})", style = ClawTheme.type.caption.copy(fontSize = 12.5.sp, lineHeight = 16.sp), color = ClawTheme.colors.textMuted)
          Row(horizontalArrangement = Arrangement.spacedBy(5.dp), verticalAlignment = Alignment.CenterVertically) {
            Text(
              text = if (isConnected) "All systems operational" else "Gateway not connected",
              style = ClawTheme.type.caption.copy(fontSize = 12.5.sp, lineHeight = 16.sp),
              color = ClawTheme.colors.textSubtle,
            )
            Box(modifier = Modifier.size(4.5.dp).clip(CircleShape).background(if (isConnected) ClawTheme.colors.success else ClawTheme.colors.textSubtle))
          }
        }
      }
    }
  }
}

private fun approvalsSummary(count: Int): String =
  when (count) {
    0 -> "No pending approvals"
    1 -> "1 pending"
    else -> "$count pending"
  }

private fun approvalsStatus(count: Int): Boolean? = if (count > 0) true else null

/** Summarizes scheduled gateway jobs for overview and settings rows. */
private fun cronJobsSummary(count: Int): String =
  when (count) {
    0 -> "No scheduled jobs"
    1 -> "1 scheduled"
    else -> "$count scheduled"
  }

/** Summarizes provider usage buckets without exposing detailed billing data. */
private fun usageSummaryText(count: Int): String =
  when (count) {
    0 -> "No provider usage"
    1 -> "1 provider"
    else -> "$count providers"
  }

/** Reports how many gateway skills are enabled, eligible, and dependency-complete. */
private fun skillsSummaryText(skills: List<GatewaySkillSummary>): String {
  val ready = skills.count { !it.disabled && it.eligible && it.missingCount == 0 }
  return if (skills.isEmpty()) "No skills" else "$ready/${skills.size} ready"
}

/** Converts gateway skill health into a tri-state settings status dot. */
private fun skillsStatus(skills: List<GatewaySkillSummary>): Boolean? =
  when {
    skills.isEmpty() -> null
    skills.any { it.blockedByAllowlist || (!it.disabled && (!it.eligible || it.missingCount > 0)) } -> false
    else -> true
  }

/** Prioritizes pending pairings over online counts for compact node/device summaries. */
private fun nodesDevicesSummaryText(summary: GatewayNodesDevicesSummary): String {
  val online = summary.nodes.count { it.connected }
  val devices = summary.pairedDevices.size
  return when {
    summary.pendingDevices.isNotEmpty() -> "${summary.pendingDevices.size} pending"
    summary.nodes.isNotEmpty() -> "$online/${summary.nodes.size} online"
    devices > 0 -> "$devices paired"
    else -> "No devices"
  }
}

/** Maps node/device state to a settings status dot, treating pending pairings as attention-needed. */
private fun nodesDevicesStatus(summary: GatewayNodesDevicesSummary): Boolean? =
  when {
    summary.pendingDevices.isNotEmpty() -> false
    summary.nodes.any { it.connected } -> true
    summary.pairedDevices.isNotEmpty() -> true
    else -> null
  }

/** Summarizes channel connection state, surfacing errors before connected counts. */
private fun channelsSummaryText(summary: GatewayChannelsSummary): String {
  val connected = summary.channels.count { it.connected }
  return when {
    summary.channels.any { it.error != null } -> "${summary.channels.count { it.error != null }} issue"
    summary.channels.isNotEmpty() -> "$connected/${summary.channels.size} connected"
    else -> "No channels"
  }
}

/** Maps channel health to the settings status dot shown in the shell. */
private fun channelsStatus(summary: GatewayChannelsSummary): Boolean? =
  when {
    summary.channels.any { it.error != null } -> false
    summary.channels.any { it.connected || it.running } -> true
    summary.channels.any { it.configured || it.linked } -> true
    else -> null
  }

/** Summarizes dreaming memory health before enabled/off state. */
private fun dreamingSummaryText(summary: GatewayDreamingSummary): String =
  when {
    !summary.storeHealthy || !summary.phaseSignalHealthy -> "Needs attention"
    summary.enabled -> "${summary.shortTermCount} waiting"
    else -> "Off"
  }

/** Maps dreaming store/phase health and enabled state to a settings status dot. */
private fun dreamingStatus(summary: GatewayDreamingSummary): Boolean? =
  when {
    !summary.storeHealthy || !summary.phaseSignalHealthy -> false
    summary.enabled -> true
    else -> null
  }

private data class SettingsRow(
  val title: String,
  val value: String,
  val icon: ImageVector,
  val status: Boolean? = null,
  val route: SettingsRoute? = null,
)

@Composable
private fun ProfilePanel(
  displayName: String,
  onClick: () -> Unit,
) {
  ClawPanel(contentPadding = PaddingValues(horizontal = 10.dp, vertical = 8.dp)) {
    Row(
      modifier =
        Modifier
          .fillMaxWidth()
          .clip(RoundedCornerShape(ClawTheme.radii.row))
          .clickable(onClick = onClick),
      verticalAlignment = Alignment.CenterVertically,
      horizontalArrangement = Arrangement.spacedBy(8.dp),
    ) {
      Surface(
        modifier = Modifier.size(32.dp),
        shape = CircleShape,
        color = ClawTheme.colors.surfacePressed,
        border = BorderStroke(1.dp, ClawTheme.colors.borderStrong),
      ) {
        Box(contentAlignment = Alignment.Center) {
          Text(
            text = displayName.firstOrNull()?.uppercase() ?: "O",
            style = ClawTheme.type.title.copy(fontSize = 14.sp, lineHeight = 17.sp),
            color = ClawTheme.colors.text,
            textAlign = TextAlign.Center,
          )
        }
      }
      Column(modifier = Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(2.dp)) {
        Text(text = displayName, style = ClawTheme.type.section, color = ClawTheme.colors.text, maxLines = 1)
        Text(text = "OpenClaw mobile", style = ClawTheme.type.caption.copy(fontSize = 12.5.sp, lineHeight = 16.sp), color = ClawTheme.colors.textMuted, maxLines = 1)
      }
      Icon(
        imageVector = Icons.AutoMirrored.Filled.KeyboardArrowRight,
        contentDescription = "Open profile",
        modifier = Modifier.size(15.dp),
        tint = ClawTheme.colors.text,
      )
    }
  }
}

@Composable
private fun SettingsGroup(
  rows: List<SettingsRow>,
  onOpen: (SettingsRoute) -> Unit,
  onAction: (() -> Unit)? = null,
) {
  ClawPanel(contentPadding = PaddingValues(horizontal = 12.dp, vertical = 4.dp)) {
    Column {
      rows.forEachIndexed { index, row ->
        SettingsListRow(
          row = row,
          onClick = {
            val rowRoute = row.route
            if (rowRoute == null) {
              onAction?.invoke()
            } else {
              onOpen(rowRoute)
            }
          },
        )
        if (index != rows.lastIndex) {
          HorizontalDivider(color = ClawTheme.colors.border.copy(alpha = 0.82f), thickness = 1.dp)
        }
      }
    }
  }
}

@Composable
private fun SettingsListRow(
  row: SettingsRow,
  onClick: () -> Unit,
) {
  Row(
    modifier =
      Modifier
        .fillMaxWidth()
        .heightIn(min = 54.dp)
        .clip(RoundedCornerShape(ClawTheme.radii.row))
        .clickable(onClick = onClick)
        .padding(horizontal = 0.dp, vertical = 7.dp),
    verticalAlignment = Alignment.CenterVertically,
    horizontalArrangement = Arrangement.spacedBy(10.dp),
  ) {
    Icon(imageVector = row.icon, contentDescription = null, modifier = Modifier.size(20.dp), tint = ClawTheme.colors.text)
    Text(text = row.title, style = ClawTheme.type.body, color = ClawTheme.colors.text, modifier = Modifier.weight(1f), maxLines = 1)
    Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(5.dp)) {
      Text(text = row.value, style = ClawTheme.type.caption.copy(fontSize = 13.sp, lineHeight = 17.sp), color = ClawTheme.colors.textMuted, maxLines = 1, overflow = TextOverflow.Ellipsis)
      row.status?.let { active ->
        Box(modifier = Modifier.size(4.5.dp).clip(CircleShape).background(if (active) ClawTheme.colors.success else ClawTheme.colors.textSubtle))
      }
      if (row.route != null) {
        Icon(
          imageVector = Icons.AutoMirrored.Filled.KeyboardArrowRight,
          contentDescription = "Open ${row.title}",
          modifier = Modifier.size(17.dp),
          tint = ClawTheme.colors.text,
        )
      }
    }
  }
}

@Composable
private fun SettingsSearchButton(onClick: () -> Unit) {
  Surface(onClick = onClick, modifier = Modifier.size(ClawTheme.spacing.touchTarget), shape = CircleShape, color = Color.Transparent, contentColor = ClawTheme.colors.text) {
    Box(contentAlignment = Alignment.Center) {
      Icon(imageVector = Icons.Default.Search, contentDescription = "Search settings", modifier = Modifier.size(18.dp))
    }
  }
}

@Composable
private fun PlainIconButton(
  icon: ImageVector,
  contentDescription: String,
  onClick: () -> Unit,
) {
  Surface(onClick = onClick, modifier = Modifier.size(ClawTheme.spacing.touchTarget), shape = CircleShape, color = Color.Transparent, contentColor = ClawTheme.colors.text) {
    Box(contentAlignment = Alignment.Center) {
      Icon(imageVector = icon, contentDescription = contentDescription, modifier = Modifier.size(18.dp))
    }
  }
}

private fun relativeSessionTime(updatedAtMs: Long): String {
  val deltaMs = (System.currentTimeMillis() - updatedAtMs).coerceAtLeast(0L)
  val minutes = deltaMs / 60_000L
  if (minutes < 1) return "now"
  if (minutes < 60) return "${minutes}m"
  val hours = minutes / 60
  if (hours < 24) return "${hours}h"
  return "${hours / 24}d"
}

private fun displaySessionTitle(displayName: String?): String = displayName?.takeIf { it.isNotBlank() } ?: "Main session"

private fun statusDotColor(status: String): Color {
  val normalized = status.trim().lowercase()
  return when {
    normalized.contains("offline") || normalized.contains("not connected") -> Color(0xFFFF6B6B)
    normalized.contains("ready") || normalized.contains("active") || normalized.contains("online") -> Color(0xFF3EDB82)
    else -> Color(0xFF707070)
  }
}

private fun gatewaySummary(
  statusText: String,
  isConnected: Boolean,
): String {
  if (isConnected) return "Online and ready"
  val status = statusText.trim().lowercase()
  return when {
    status.contains("connecting") || status.contains("reconnecting") -> "Connecting..."
    status.contains("pairing") -> "Waiting for pairing"
    status.contains("auth") -> "Authentication needed"
    status.contains("certificate") || status.contains("tls") -> "Certificate review needed"
    else -> "Not connected"
  }
}
