package ai.openclaw.app.ui

import ai.openclaw.app.BuildConfig
import ai.openclaw.app.GatewayAgentSummary
import ai.openclaw.app.GatewayChannelsSummary
import ai.openclaw.app.GatewayConnectionDisplay
import ai.openclaw.app.GatewayConnectionProblem
import ai.openclaw.app.GatewayDreamingSummary
import ai.openclaw.app.GatewayNodeApprovalState
import ai.openclaw.app.GatewayNodesDevicesSummary
import ai.openclaw.app.GatewaySkillSummary
import ai.openclaw.app.GatewaySkillWorkshopSummary
import ai.openclaw.app.HomeDestination
import ai.openclaw.app.MainViewModel
import ai.openclaw.app.NodeRuntime
import ai.openclaw.app.R
import ai.openclaw.app.chat.ChatSessionEntry
import ai.openclaw.app.ui.chat.ChatScreen
import ai.openclaw.app.ui.design.ClawBottomNav
import ai.openclaw.app.ui.design.ClawDesignTheme
import ai.openclaw.app.ui.design.ClawEmptyState
import ai.openclaw.app.ui.design.ClawNavItem
import ai.openclaw.app.ui.design.ClawPanel
import ai.openclaw.app.ui.design.ClawPlainIconButton
import ai.openclaw.app.ui.design.ClawPrimaryButton
import ai.openclaw.app.ui.design.ClawScaffold
import ai.openclaw.app.ui.design.ClawSecondaryButton
import ai.openclaw.app.ui.design.ClawStatus
import ai.openclaw.app.ui.design.ClawTheme
import ai.openclaw.app.ui.design.OpenClawMascot
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
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.WindowInsetsSides
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.ime
import androidx.compose.foundation.layout.only
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.safeDrawing
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.automirrored.filled.ExitToApp
import androidx.compose.material.icons.automirrored.filled.KeyboardArrowRight
import androidx.compose.material.icons.automirrored.filled.ScreenShare
import androidx.compose.material.icons.filled.ArrowDropDown
import androidx.compose.material.icons.filled.Cloud
import androidx.compose.material.icons.filled.Favorite
import androidx.compose.material.icons.filled.GraphicEq
import androidx.compose.material.icons.filled.Groups
import androidx.compose.material.icons.filled.Home
import androidx.compose.material.icons.filled.Lock
import androidx.compose.material.icons.filled.Mic
import androidx.compose.material.icons.filled.Notifications
import androidx.compose.material.icons.filled.Palette
import androidx.compose.material.icons.filled.Person
import androidx.compose.material.icons.filled.Search
import androidx.compose.material.icons.filled.Security
import androidx.compose.material.icons.filled.Settings
import androidx.compose.material.icons.filled.Storage
import androidx.compose.material.icons.filled.Tune
import androidx.compose.material.icons.outlined.AccessTime
import androidx.compose.material.icons.outlined.ChatBubbleOutline
import androidx.compose.material.icons.outlined.Folder
import androidx.compose.material.icons.outlined.Inventory2
import androidx.compose.material.icons.outlined.MicNone
import androidx.compose.material.icons.outlined.Settings
import androidx.compose.material.icons.outlined.Terminal
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
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.res.stringResource
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
  Files(key = "files", label = "Files", icon = Icons.Outlined.Folder),
}

private val shellNavTabs = listOf(Tab.Overview, Tab.Chat, Tab.Voice, Tab.Settings)

private val shellContentInsets: WindowInsets
  @Composable get() = WindowInsets.safeDrawing.only(WindowInsetsSides.Top + WindowInsetsSides.Horizontal)

private val overviewMetricTileMinHeight = 96.dp
private val overviewTalkPanelMinHeight = 72.dp
private val overviewListRowMinHeight = 54.dp
private const val overviewRecentSessionLimit = 50
private const val overviewRecentSessionVisibleLimit = 3

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
    val nav = rememberSaveable(saver = ShellNavigation.Saver) { ShellNavigation() }
    var commandOpen by rememberSaveable { mutableStateOf(false) }
    var voiceScreenWasActive by rememberSaveable { mutableStateOf(false) }
    val requestedHomeDestination by viewModel.requestedHomeDestination.collectAsState()
    val pendingTrust by viewModel.pendingGatewayTrust.collectAsState()
    val runtimeInitialized by viewModel.runtimeInitialized.collectAsState()

    LaunchedEffect(requestedHomeDestination) {
      val destination = requestedHomeDestination ?: return@LaunchedEffect
      // HomeDestination is a one-shot command from launch intents and settings
      // actions; consume it after translating to local shell state.
      nav.selectTab(
        when (destination) {
          HomeDestination.Connect -> Tab.Overview
          HomeDestination.Chat -> Tab.Chat
          HomeDestination.Voice -> Tab.Voice
          HomeDestination.Screen -> Tab.Chat
          HomeDestination.Settings -> Tab.Settings
        },
      )
      viewModel.clearRequestedHomeDestination()
    }

    LaunchedEffect(nav.activeTab, runtimeInitialized) {
      val voiceScreenActive = nav.activeTab == Tab.Voice
      if (voiceScreenActive || voiceScreenWasActive || runtimeInitialized) {
        viewModel.setVoiceScreenActive(voiceScreenActive)
      }
      voiceScreenWasActive = voiceScreenActive
    }

    BackHandler(enabled = nav.activeTab != Tab.Overview) {
      nav.back()
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
            selectedKey = if (nav.activeTab in shellNavTabs) nav.activeTab.key else Tab.Overview.key,
            onSelect = { key ->
              nav.selectTab(shellNavTabs.firstOrNull { it.key == key } ?: Tab.Overview)
            },
          )
        }
      },
    ) { shellPadding ->
      Box(modifier = Modifier.fillMaxSize().padding(shellPadding)) {
        when (nav.activeTab) {
          Tab.Overview ->
            OverviewScreen(
              viewModel = viewModel,
              onSelectTab = nav::selectTab,
              onOpenSettingsRoute = nav::openSettingsRoute,
              onOpenCommand = { commandOpen = true },
            )
          Tab.Chat ->
            ChatShellScreen(
              viewModel = viewModel,
              onVoice = { nav.selectTab(Tab.Voice) },
              onOpenSessions = { nav.openDetailTab(Tab.Sessions) },
              onOpenGatewaySettings = { nav.openSettingsRoute(SettingsRoute.Gateway) },
            )
          Tab.Voice ->
            VoiceShellScreen(
              viewModel = viewModel,
              onOpenCommand = { commandOpen = true },
              onOpenGatewaySettings = { nav.openSettingsRoute(SettingsRoute.Gateway) },
              onOpenVoiceSettings = { nav.openSettingsRoute(SettingsRoute.Voice) },
            )
          Tab.ProvidersModels ->
            ProvidersModelsScreen(
              viewModel = viewModel,
              onBack = nav::back,
            )
          Tab.Sessions ->
            SessionsScreen(
              viewModel = viewModel,
              onOpenCommand = { commandOpen = true },
              onOpenChat = { nav.selectTab(Tab.Chat) },
            )
          Tab.Files ->
            WorkspaceFilesScreen(
              viewModel = viewModel,
              onBack = nav::back,
            )
          Tab.Settings ->
            SettingsShellScreen(
              viewModel = viewModel,
              route = nav.settingsRoute,
              onRouteChange = nav::openSettingsRouteFromHome,
              onBack = nav::back,
              onOpenCommand = { commandOpen = true },
            )
        }

        if (commandOpen) {
          CommandPalette(
            viewModel = viewModel,
            onDismiss = { commandOpen = false },
            onOpenChat = {
              nav.selectTab(Tab.Chat)
              commandOpen = false
            },
            onOpenVoice = {
              nav.selectTab(Tab.Voice)
              commandOpen = false
            },
            onOpenSessions = {
              nav.openDetailTab(Tab.Sessions)
              commandOpen = false
            },
            onOpenProviders = {
              nav.openDetailTab(Tab.ProvidersModels)
              commandOpen = false
            },
            onOpenSettings = {
              nav.openSettingsRoute(SettingsRoute.Home)
              commandOpen = false
            },
            onOpenSession = { sessionKey ->
              viewModel.switchChatSession(sessionKey)
              nav.selectTab(Tab.Chat)
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
      stringResource(R.string.gateway_trust_first_seen, prompt.fingerprintSha256)
    } else {
      stringResource(
        R.string.gateway_trust_changed,
        prompt.previousFingerprintSha256,
        prompt.fingerprintSha256,
      )
    }

  AlertDialog(
    onDismissRequest = onDecline,
    containerColor = ClawTheme.colors.surfaceRaised,
    title = {
      Text(
        stringResource(R.string.trust_this_gateway),
        style = ClawTheme.type.section,
        color = ClawTheme.colors.text,
      )
    },
    text = { Text(message, style = ClawTheme.type.body, color = ClawTheme.colors.textMuted) },
    confirmButton = {
      TextButton(onClick = onAccept) {
        Text(stringResource(R.string.trust_and_continue))
      }
    },
    dismissButton = {
      TextButton(onClick = onDecline) {
        Text(stringResource(R.string.cancel))
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
  val sessions by viewModel.chatSessions.collectAsState()
  val pendingRunCount by viewModel.pendingRunCount.collectAsState()
  val gatewayConnectionDisplay by viewModel.gatewayConnectionDisplay.collectAsState()
  val isConnected = gatewayConnectionDisplay.isConnected
  val models by viewModel.modelCatalog.collectAsState()
  val providers by viewModel.modelAuthProviders.collectAsState()
  val execApprovals by viewModel.execApprovals.collectAsState()
  val pendingToolCalls by viewModel.chatPendingToolCalls.collectAsState()
  val cronStatus by viewModel.cronStatus.collectAsState()
  val nodesDevicesSummary by viewModel.nodesDevicesSummary.collectAsState()
  val channelsSummary by viewModel.channelsSummary.collectAsState()
  val agents by viewModel.gatewayAgents.collectAsState()
  val defaultAgentId by viewModel.gatewayDefaultAgentId.collectAsState()
  val readyProviderCount = providerRows(providers = providers, models = models).count { it.ready }
  val pendingApprovalsCount = execApprovals.size + pendingToolCalls.size
  val attentionRows =
    homeAttentionRows(
      isConnected = isConnected,
      pendingApprovals = pendingApprovalsCount,
      channelsSummary = channelsSummary,
      nodesDevicesSummary = nodesDevicesSummary,
      readyProviderCount = readyProviderCount,
    )
  val secondaryAttentionRows =
    if (nodesDevicesSummary.hasNodeCapabilityApprovalPending()) {
      attentionRows.filterNot { it.title == "Nodes & Devices" }
    } else {
      attentionRows
    }
  val headerState = overviewHeaderState(isConnected = isConnected, hasAttention = attentionRows.isNotEmpty())
  val headerRoute = overviewHeaderRoute(attentionRows)
  val activeAgentName = overviewAgentName(agents = agents, defaultAgentId = defaultAgentId)
  val activeAgentBadge = overviewAgentBadgeText(agents = agents, defaultAgentId = defaultAgentId)
  val overviewSessions = overviewRecentSessions(sessions)
  val overviewSessionCount = overviewSessions.size
  val candidateRecentRows =
    remember(overviewSessions, channelsSummary) {
      overviewRecentSessionRows(sessions = overviewSessions, channelsSummary = channelsSummary)
    }
  var recentRows by remember { mutableStateOf<List<RecentSessionListItem>>(emptyList()) }
  val visibleRecentRows = recentRows.ifEmpty { candidateRecentRows }
  val metricCards =
    overviewMetricCards(
      isConnected = isConnected,
      hasAttention = attentionRows.isNotEmpty(),
      nodesDevicesSummary = nodesDevicesSummary,
      pendingApprovals = pendingApprovalsCount,
      sessionCount = overviewSessionCount,
    )

  LaunchedEffect(candidateRecentRows) {
    recentRows =
      stableOverviewRecentRows(
        previousRows = recentRows,
        candidateRows = candidateRecentRows,
      )
  }

  LaunchedEffect(isConnected) {
    if (isConnected) {
      viewModel.refreshChatSessions(limit = 20)
      viewModel.refreshAgents()
      viewModel.refreshModelCatalog()
      viewModel.refreshCronJobs()
      viewModel.refreshNodesDevices()
      viewModel.refreshChannels()
      viewModel.refreshExecApprovals()
    }
  }

  ClawScaffold(
    contentPadding = PaddingValues(start = 16.dp, top = 10.dp, end = 16.dp, bottom = 4.dp),
    contentWindowInsets = shellContentInsets,
  ) {
    Box(modifier = Modifier.fillMaxSize()) {
      LazyColumn(modifier = Modifier.fillMaxSize(), verticalArrangement = Arrangement.spacedBy(10.dp), contentPadding = PaddingValues(bottom = 6.dp)) {
        item {
          OverviewHeader(status = headerState, onOpenStatus = { onOpenSettingsRoute(headerRoute) }, onOpenCommand = onOpenCommand)
        }

        item {
          Text(
            text = "Overview",
            style = ClawTheme.type.display.copy(fontSize = 24.sp, lineHeight = 28.sp),
            color = ClawTheme.colors.text,
          )
        }

        item {
          OverviewPrimaryPanel(
            agentName = activeAgentName,
            agentBadge = activeAgentBadge,
            statusText = gatewaySummary(gatewayConnectionDisplay),
            isConnected = gatewayConnectionDisplay.isConnected,
            pendingRunCount = pendingRunCount,
            sessionCount = overviewSessionCount,
            cronJobCount = cronStatus.jobs,
            onOpenChat = { onSelectTab(Tab.Chat) },
            onOpenVoice = { onSelectTab(Tab.Voice) },
            onOpenAgent = { onOpenSettingsRoute(SettingsRoute.Agents) },
            onOpenGateway = { onOpenSettingsRoute(SettingsRoute.Gateway) },
          )
        }

        item {
          OverviewMetricGrid(
            cards = metricCards,
            onOpen = { card ->
              val route = card.settingsRoute
              if (route == null) {
                onSelectTab(card.tab)
              } else {
                onOpenSettingsRoute(route)
              }
            },
          )
        }

        item {
          TalkEntryPanel(onOpenVoice = { onSelectTab(Tab.Voice) }, onOpenVoiceSettings = { onOpenSettingsRoute(SettingsRoute.Voice) })
        }

        item { RecentSessionsHeader(onOpenSessions = { onSelectTab(Tab.Sessions) }) }

        if (visibleRecentRows.isEmpty()) {
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
              rows = visibleRecentRows,
              onOpen = { sessionKey ->
                viewModel.switchChatSession(sessionKey)
                onSelectTab(Tab.Chat)
              },
            )
          }
        }

        if (secondaryAttentionRows.isNotEmpty()) {
          item {
            HomeAttentionPanel(rows = secondaryAttentionRows, onSelectTab = onSelectTab, onOpenSettingsRoute = onOpenSettingsRoute)
          }
        }
      }
    }
  }
}

private data class ModuleRow(
  val title: String,
  val subtitle: String?,
  val icon: ImageVector,
  val tab: Tab,
  val settingsRoute: SettingsRoute? = null,
)

@Composable
private fun OverviewHeader(
  status: OverviewHeaderState,
  onOpenStatus: () -> Unit,
  onOpenCommand: () -> Unit,
) {
  Row(
    modifier = Modifier.fillMaxWidth(),
    verticalAlignment = Alignment.CenterVertically,
    horizontalArrangement = Arrangement.spacedBy(10.dp),
  ) {
    OpenClawMascot(modifier = Modifier.size(25.dp), tint = ClawTheme.colors.text)
    Text(
      text = "OpenClaw",
      style = ClawTheme.type.title.copy(fontSize = 17.sp, lineHeight = 21.sp),
      color = ClawTheme.colors.text,
      modifier = Modifier.weight(1f),
      maxLines = 1,
      overflow = TextOverflow.Ellipsis,
    )
    OverviewStatusPill(status = status, onClick = onOpenStatus)
    ClawPlainIconButton(icon = Icons.Default.Search, contentDescription = "Search", onClick = onOpenCommand)
  }
}

@Composable
private fun OverviewStatusPill(
  status: OverviewHeaderState,
  onClick: () -> Unit,
) {
  val colors = ClawTheme.colors
  val (dotColor, backgroundColor) =
    when (status.status) {
      ClawStatus.Success -> colors.success to colors.successSoft
      ClawStatus.Warning -> colors.warning to colors.warningSoft
      ClawStatus.Danger -> colors.danger to colors.dangerSoft
      ClawStatus.Neutral -> colors.textSubtle to colors.surfaceRaised
    }
  Surface(
    onClick = onClick,
    modifier = Modifier.heightIn(min = ClawTheme.spacing.touchTarget),
    shape = RoundedCornerShape(ClawTheme.radii.control),
    color = backgroundColor.copy(alpha = 0.82f),
    border = BorderStroke(1.dp, ClawTheme.colors.border.copy(alpha = 0.32f)),
  ) {
    Row(
      modifier = Modifier.padding(horizontal = 9.dp, vertical = 5.dp),
      verticalAlignment = Alignment.CenterVertically,
      horizontalArrangement = Arrangement.spacedBy(6.dp),
    ) {
      Box(modifier = Modifier.size(6.dp).clip(CircleShape).background(dotColor))
      Text(text = status.label, style = ClawTheme.type.caption.copy(fontSize = 13.sp, lineHeight = 17.sp), color = ClawTheme.colors.text, maxLines = 1)
      Icon(imageVector = Icons.Default.ArrowDropDown, contentDescription = null, modifier = Modifier.size(15.dp), tint = ClawTheme.colors.textMuted)
    }
  }
}

@Composable
private fun OverviewPrimaryPanel(
  agentName: String,
  agentBadge: String,
  statusText: String,
  isConnected: Boolean,
  pendingRunCount: Int,
  sessionCount: Int,
  cronJobCount: Int,
  onOpenChat: () -> Unit,
  onOpenVoice: () -> Unit,
  onOpenAgent: () -> Unit,
  onOpenGateway: () -> Unit,
) {
  OverviewLayeredPanel(contentPadding = PaddingValues(ClawTheme.spacing.sm), elevated = true) {
    Column(verticalArrangement = Arrangement.spacedBy(ClawTheme.spacing.xs)) {
      Text(text = "ACTIVE AGENT", style = ClawTheme.type.caption.copy(fontSize = 12.sp, lineHeight = 15.sp), color = ClawTheme.colors.textMuted)
      Row(modifier = Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(9.dp)) {
        OverviewAgentBadge(text = agentBadge, active = isConnected)
        Column(modifier = Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(3.dp)) {
          Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(5.dp)) {
            Text(text = if (pendingRunCount > 0) "$agentName is working" else agentName, style = ClawTheme.type.title.copy(fontSize = 19.sp, lineHeight = 23.sp), color = ClawTheme.colors.text, maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.weight(1f, fill = false))
          }
          Text(text = overviewAgentActivityText(isConnected = isConnected, pendingRunCount = pendingRunCount, sessionCount = sessionCount, cronJobCount = cronJobCount, statusText = statusText), style = ClawTheme.type.caption.copy(fontSize = 13.5.sp, lineHeight = 17.sp), color = ClawTheme.colors.textMuted, maxLines = 1, overflow = TextOverflow.Ellipsis)
        }
        ClawSecondaryButton(text = "View", onClick = onOpenAgent)
      }
      Row(modifier = Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(10.dp)) {
        OverviewStateChip(label = "Runs", value = if (pendingRunCount > 0) "$pendingRunCount active" else "Idle", modifier = Modifier.weight(1f))
        OverviewStateChip(label = "Sessions", value = if (sessionCount == 0) "None" else "$sessionCount recent", modifier = Modifier.weight(1f))
        OverviewStateChip(label = "Cron", value = cronJobsSummary(cronJobCount), modifier = Modifier.weight(1f))
      }
      Row(modifier = Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(10.dp)) {
        OverviewActionPill(text = "Chat", icon = Icons.Outlined.ChatBubbleOutline, emphasized = true, onClick = onOpenChat, modifier = Modifier.weight(1f))
        OverviewActionPill(text = "Talk", icon = Icons.Outlined.MicNone, emphasized = false, onClick = onOpenVoice, modifier = Modifier.weight(1f))
      }
      if (!isConnected) {
        ClawSecondaryButton(text = "Reconnect gateway", icon = Icons.Default.Cloud, onClick = onOpenGateway, modifier = Modifier.fillMaxWidth())
      }
    }
  }
}

@Composable
private fun OverviewActionPill(
  text: String,
  icon: ImageVector,
  emphasized: Boolean,
  onClick: () -> Unit,
  modifier: Modifier = Modifier,
) {
  Surface(
    onClick = onClick,
    modifier = modifier.heightIn(min = ClawTheme.spacing.touchTarget),
    shape = RoundedCornerShape(ClawTheme.radii.control),
    color =
      if (emphasized) {
        ClawTheme.colors.surfacePressed.copy(alpha = 0.9f)
      } else {
        ClawTheme.colors.surfaceRaised.copy(alpha = 0.72f)
      },
    contentColor = ClawTheme.colors.text,
    border =
      if (emphasized) {
        null
      } else {
        BorderStroke(1.dp, ClawTheme.colors.borderStrong.copy(alpha = 0.7f))
      },
    tonalElevation = if (emphasized) 2.dp else 0.dp,
  ) {
    Row(
      modifier = Modifier.padding(horizontal = 12.dp, vertical = 9.dp),
      verticalAlignment = Alignment.CenterVertically,
      horizontalArrangement = Arrangement.Center,
    ) {
      Icon(imageVector = icon, contentDescription = null, modifier = Modifier.size(17.dp))
      Spacer(modifier = Modifier.width(8.dp))
      Text(text = text, style = ClawTheme.type.body, maxLines = 1, overflow = TextOverflow.Ellipsis)
    }
  }
}

@Composable
private fun OverviewLayeredPanel(
  modifier: Modifier = Modifier,
  contentPadding: PaddingValues = PaddingValues(14.dp),
  elevated: Boolean = false,
  content: @Composable () -> Unit,
) {
  Surface(
    modifier = modifier.fillMaxWidth(),
    shape = RoundedCornerShape(ClawTheme.radii.button),
    color = if (elevated) ClawTheme.colors.surfaceRaised.copy(alpha = 0.98f) else ClawTheme.colors.surfaceRaised.copy(alpha = 0.86f),
    contentColor = ClawTheme.colors.text,
    tonalElevation = if (elevated) 4.dp else 1.dp,
    shadowElevation = if (elevated) 9.dp else 2.dp,
  ) {
    Column(modifier = Modifier.padding(contentPadding)) {
      content()
    }
  }
}

@Composable
private fun OverviewAgentBadge(
  text: String,
  active: Boolean,
) {
  Surface(
    modifier = Modifier.size(42.dp),
    shape = CircleShape,
    color = if (active) ClawTheme.colors.successSoft else ClawTheme.colors.surfacePressed,
    contentColor = if (active) ClawTheme.colors.success else ClawTheme.colors.textMuted,
    tonalElevation = if (active) 3.dp else 1.dp,
    shadowElevation = if (active) 5.dp else 1.dp,
  ) {
    Box(contentAlignment = Alignment.Center) {
      Text(
        text = text,
        style = ClawTheme.type.title.copy(fontSize = 16.sp, lineHeight = 20.sp),
        maxLines = 1,
      )
    }
  }
}

@Composable
private fun OverviewStateChip(
  label: String,
  value: String,
  modifier: Modifier = Modifier,
) {
  Surface(
    modifier = modifier.heightIn(min = ClawTheme.spacing.touchTarget),
    shape = RoundedCornerShape(ClawTheme.radii.control),
    color = ClawTheme.colors.surfacePressed.copy(alpha = 0.58f),
  ) {
    Column(
      modifier = Modifier.padding(horizontal = 10.dp, vertical = 7.dp),
      verticalArrangement = Arrangement.spacedBy(1.dp),
    ) {
      Text(text = label.uppercase(), style = ClawTheme.type.caption.copy(fontSize = 10.5.sp, lineHeight = 13.sp), color = ClawTheme.colors.textSubtle, maxLines = 1)
      Text(text = value, style = ClawTheme.type.caption.copy(fontSize = 14.sp, lineHeight = 17.sp), color = ClawTheme.colors.text, maxLines = 1, overflow = TextOverflow.Ellipsis)
    }
  }
}

@Composable
private fun OverviewMetricGrid(
  cards: List<OverviewMetricCard>,
  onOpen: (OverviewMetricCard) -> Unit,
) {
  Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
    cards.chunked(2).forEach { row ->
      Row(modifier = Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
        row.forEach { card ->
          OverviewMetricTile(card = card, onClick = { onOpen(card) }, modifier = Modifier.weight(1f))
        }
        if (row.size == 1) {
          Box(modifier = Modifier.weight(1f))
        }
      }
    }
  }
}

@Composable
private fun OverviewMetricTile(
  card: OverviewMetricCard,
  onClick: () -> Unit,
  modifier: Modifier = Modifier,
) {
  Surface(
    onClick = onClick,
    modifier = modifier.heightIn(min = overviewMetricTileMinHeight),
    shape = RoundedCornerShape(ClawTheme.radii.button),
    color = ClawTheme.colors.surfaceRaised.copy(alpha = 0.84f),
    contentColor = ClawTheme.colors.text,
    tonalElevation = 2.dp,
    shadowElevation = 3.dp,
  ) {
    Column(modifier = Modifier.padding(ClawTheme.spacing.xs), verticalArrangement = Arrangement.spacedBy(6.dp)) {
      Row(modifier = Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
        Icon(imageVector = card.icon, contentDescription = null, modifier = Modifier.size(17.dp), tint = card.tint)
        Text(text = card.title.uppercase(), style = ClawTheme.type.caption.copy(fontSize = 10.5.sp, lineHeight = 13.sp), color = ClawTheme.colors.textMuted, maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.weight(1f))
        Icon(imageVector = Icons.AutoMirrored.Filled.KeyboardArrowRight, contentDescription = "Open ${card.title}", modifier = Modifier.size(15.dp), tint = ClawTheme.colors.textMuted)
      }
      Text(text = card.value, style = ClawTheme.type.title.copy(fontSize = 22.sp, lineHeight = 25.sp), color = ClawTheme.colors.text, maxLines = 1, overflow = TextOverflow.Ellipsis)
      Text(text = card.subtitle, style = ClawTheme.type.caption.copy(fontSize = 12.5.sp, lineHeight = 16.sp), color = ClawTheme.colors.textSubtle, maxLines = 2, overflow = TextOverflow.Ellipsis)
      card.progressFraction?.let { progress ->
        OverviewProgressBar(progress = progress, tint = card.tint)
      }
    }
  }
}

@Composable
private fun OverviewProgressBar(
  progress: Float,
  tint: Color,
) {
  val visualProgress =
    if (progress <= 0f) {
      0f
    } else {
      progress.coerceIn(0.16f, 1f)
    }
  Box(
    modifier =
      Modifier
        .fillMaxWidth()
        .height(4.dp)
        .clip(RoundedCornerShape(2.dp))
        .background(ClawTheme.colors.surfacePressed),
  ) {
    Box(
      modifier =
        Modifier
          .fillMaxWidth(visualProgress)
          .height(4.dp)
          .clip(RoundedCornerShape(2.dp))
          .background(tint),
    )
  }
}

@Composable
private fun TalkEntryPanel(
  onOpenVoice: () -> Unit,
  onOpenVoiceSettings: () -> Unit,
) {
  Surface(
    onClick = onOpenVoice,
    modifier = Modifier.fillMaxWidth().heightIn(min = overviewTalkPanelMinHeight),
    shape = RoundedCornerShape(ClawTheme.radii.button),
    color = ClawTheme.colors.surfaceRaised.copy(alpha = 0.9f),
    contentColor = ClawTheme.colors.text,
    tonalElevation = 2.dp,
    shadowElevation = 3.dp,
  ) {
    Row(modifier = Modifier.fillMaxWidth().padding(horizontal = 14.dp, vertical = 12.dp), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(12.dp)) {
      Surface(
        modifier = Modifier.size(44.dp),
        shape = CircleShape,
        color = Color(0xFF1976D2),
        tonalElevation = 2.dp,
        shadowElevation = 5.dp,
      ) {
        Box(contentAlignment = Alignment.Center) {
          Icon(imageVector = Icons.Default.GraphicEq, contentDescription = null, modifier = Modifier.size(25.dp), tint = Color.White)
        }
      }
      Column(modifier = Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(2.dp)) {
        Text(text = "Talk", style = ClawTheme.type.caption.copy(fontSize = 12.sp, lineHeight = 15.sp), color = ClawTheme.colors.textMuted)
        Text(text = "Open Talk", style = ClawTheme.type.body, color = ClawTheme.colors.text, maxLines = 1, overflow = TextOverflow.Ellipsis)
      }
      ClawPlainIconButton(icon = Icons.Default.Tune, contentDescription = "Talk settings", onClick = onOpenVoiceSettings)
    }
  }
}

@Composable
private fun RecentSessionsHeader(onOpenSessions: () -> Unit) {
  SectionLabel(
    title = "Recent Sessions",
    action = {
      Surface(
        onClick = onOpenSessions,
        modifier = Modifier.heightIn(min = ClawTheme.spacing.touchTarget),
        color = Color.Transparent,
        contentColor = ClawTheme.colors.textMuted,
      ) {
        Box(contentAlignment = Alignment.Center) {
          Text(
            text = "View all",
            style = ClawTheme.type.caption,
            color = ClawTheme.colors.textMuted,
          )
        }
      }
    },
  )
}

internal data class OverviewHeaderState(
  val label: String,
  val status: ClawStatus,
)

internal fun overviewHeaderState(
  isConnected: Boolean,
  hasAttention: Boolean,
): OverviewHeaderState =
  when {
    !isConnected -> OverviewHeaderState("Offline", ClawStatus.Neutral)
    hasAttention -> OverviewHeaderState("Needs attention", ClawStatus.Warning)
    else -> OverviewHeaderState("Online", ClawStatus.Success)
  }

internal fun overviewHeaderRoute(attentionRows: List<HomeAttentionRow>): SettingsRoute = attentionRows.firstNotNullOfOrNull { it.settingsRoute } ?: SettingsRoute.Gateway

internal fun overviewRecentSessionCount(sessions: List<ChatSessionEntry>): Int = overviewRecentSessions(sessions).size

internal fun overviewRecentSessions(sessions: List<ChatSessionEntry>): List<ChatSessionEntry> =
  sessions
    .withIndex()
    .groupBy { entry -> entry.value.key }
    .values
    .map { entries ->
      entries
        .sortedWith(
          compareByDescending<IndexedValue<ChatSessionEntry>> { entry -> entry.value.overviewRecentSessionRecencyMs() }
            .thenBy { entry -> entry.index },
        ).first()
    }.sortedWith(
      compareByDescending<IndexedValue<ChatSessionEntry>> { entry -> entry.value.overviewRecentSessionRecencyMs() }
        .thenBy { entry -> entry.value.key },
    ).take(overviewRecentSessionLimit)
    .map { entry -> entry.value }

private fun ChatSessionEntry.overviewRecentSessionRecencyMs(): Long = lastActivityAt ?: updatedAtMs ?: Long.MIN_VALUE

internal data class OverviewMetricCard(
  val title: String,
  val value: String,
  val subtitle: String,
  val icon: ImageVector,
  val tint: Color,
  val tab: Tab,
  val settingsRoute: SettingsRoute? = null,
  val progressFraction: Float? = null,
)

@Composable
private fun overviewMetricCards(
  isConnected: Boolean,
  hasAttention: Boolean,
  nodesDevicesSummary: GatewayNodesDevicesSummary,
  pendingApprovals: Int,
  sessionCount: Int,
): List<OverviewMetricCard> =
  overviewMetricCardSpecs(
    isConnected = isConnected,
    hasAttention = hasAttention,
    nodesDevicesSummary = nodesDevicesSummary,
    pendingApprovals = pendingApprovals,
    sessionCount = sessionCount,
  ).map { spec ->
    OverviewMetricCard(
      title = spec.title,
      value = spec.value,
      subtitle = spec.subtitle,
      icon = spec.icon,
      tint =
        when (spec.status) {
          ClawStatus.Success -> ClawTheme.colors.success
          ClawStatus.Warning -> ClawTheme.colors.warning
          ClawStatus.Danger -> ClawTheme.colors.danger
          ClawStatus.Neutral -> ClawTheme.colors.textMuted
        },
      tab = spec.tab,
      settingsRoute = spec.settingsRoute,
      progressFraction = spec.progressFraction,
    )
  }

internal data class OverviewMetricCardSpec(
  val title: String,
  val value: String,
  val subtitle: String,
  val icon: ImageVector,
  val status: ClawStatus,
  val tab: Tab,
  val settingsRoute: SettingsRoute? = null,
  val progressFraction: Float? = null,
)

internal fun overviewMetricCardSpecs(
  isConnected: Boolean,
  hasAttention: Boolean,
  nodesDevicesSummary: GatewayNodesDevicesSummary,
  pendingApprovals: Int,
  sessionCount: Int,
): List<OverviewMetricCardSpec> {
  val onlineNodes = nodesDevicesSummary.nodes.count { it.connected }
  val nodeCount = nodesDevicesSummary.nodes.size
  return listOf(
    OverviewMetricCardSpec(
      title = "Gateway",
      value =
        when {
          !isConnected -> "Offline"
          hasAttention -> "Online"
          else -> "Healthy"
        },
      subtitle =
        when {
          !isConnected -> "Reconnect to continue"
          hasAttention -> "Review highlighted items"
          else -> "All systems nominal"
        },
      icon = Icons.Default.Favorite,
      status =
        when {
          !isConnected -> ClawStatus.Neutral
          hasAttention -> ClawStatus.Warning
          else -> ClawStatus.Success
        },
      tab = Tab.Settings,
      settingsRoute = SettingsRoute.Gateway,
    ),
    OverviewMetricCardSpec(
      title = "Nodes",
      value = if (nodeCount == 0) "None" else "$onlineNodes/$nodeCount",
      subtitle =
        if (nodesDevicesSummary.hasNodeCapabilityApprovalPending()) {
          "Review node access"
        } else if (nodeCount > 0) {
          "${nodeOnlinePercent(onlineNodes = onlineNodes, nodeCount = nodeCount)}% online"
        } else {
          nodesDevicesSummaryText(nodesDevicesSummary)
        },
      icon = Icons.Default.Cloud,
      status =
        when {
          nodesDevicesSummary.pendingDevices.isNotEmpty() || nodesDevicesSummary.hasNodeCapabilityApprovalPending() -> ClawStatus.Warning
          onlineNodes > 0 -> ClawStatus.Success
          else -> ClawStatus.Neutral
        },
      tab = Tab.Settings,
      settingsRoute = SettingsRoute.NodesDevices,
      progressFraction = if (nodeCount > 0) onlineNodes.toFloat() / nodeCount.toFloat() else null,
    ),
    OverviewMetricCardSpec(
      title = "Approvals",
      value = pendingApprovals.toString(),
      subtitle = approvalsSummary(pendingApprovals),
      icon = Icons.Default.Security,
      status = if (pendingApprovals > 0) ClawStatus.Warning else ClawStatus.Neutral,
      tab = Tab.Settings,
      settingsRoute = SettingsRoute.Approvals,
    ),
    OverviewMetricCardSpec(
      title = "Sessions",
      value = sessionCount.toString(),
      subtitle = if (sessionCount == 0) "No recent sessions" else "Recent conversations",
      icon = Icons.Default.Groups,
      status = if (sessionCount > 0) ClawStatus.Success else ClawStatus.Neutral,
      tab = Tab.Sessions,
    ),
    OverviewMetricCardSpec(
      title = "Files",
      value = if (isConnected) "Browse" else "Offline",
      subtitle = "Agent workspace files",
      icon = Icons.Outlined.Folder,
      status = if (isConnected) ClawStatus.Success else ClawStatus.Neutral,
      tab = Tab.Files,
    ),
  )
}

internal fun overviewAgentName(
  agents: List<GatewayAgentSummary>,
  defaultAgentId: String?,
): String {
  val agent = overviewAgent(agents = agents, defaultAgentId = defaultAgentId)
  return agent?.name?.takeIf { it.isNotBlank() } ?: agent?.id?.takeIf { it.isNotBlank() } ?: "OpenClaw"
}

internal fun overviewAgentBadgeText(
  agents: List<GatewayAgentSummary>,
  defaultAgentId: String?,
): String {
  val agent = overviewAgent(agents = agents, defaultAgentId = defaultAgentId)
  agent
    ?.emoji
    ?.trim()
    ?.takeIf { it.isNotEmpty() }
    ?.let { return it }
  if (agent == null) return "OC"
  val source = agent.name?.takeIf { it.isNotBlank() } ?: agent.id.takeIf { it.isNotBlank() } ?: "OpenClaw"
  return agentInitials(source)
}

private fun overviewAgent(
  agents: List<GatewayAgentSummary>,
  defaultAgentId: String?,
): GatewayAgentSummary? {
  val defaultId = defaultAgentId?.trim().orEmpty()
  return if (defaultId.isBlank()) {
    agents.firstOrNull()
  } else {
    agents.firstOrNull { it.id == defaultId } ?: agents.firstOrNull()
  }
}

internal fun overviewAgentActivityText(
  isConnected: Boolean,
  pendingRunCount: Int,
  sessionCount: Int,
  cronJobCount: Int,
  statusText: String,
): String {
  if (!isConnected) return statusText
  if (pendingRunCount > 0) return "Working · $pendingRunCount active ${pluralize("run", pendingRunCount)}"
  return when {
    sessionCount > 0 -> "Monitoring · $sessionCount ${pluralize("session", sessionCount)}"
    cronJobCount > 0 -> "Monitoring · ${cronJobsSummary(cronJobCount)}"
    else -> statusText
  }
}

internal fun nodeOnlinePercent(
  onlineNodes: Int,
  nodeCount: Int,
): Int =
  if (nodeCount <= 0) {
    0
  } else {
    ((onlineNodes.coerceAtLeast(0) * 100) + (nodeCount / 2)) / nodeCount
  }

private fun pluralize(
  noun: String,
  count: Int,
): String = if (count == 1) noun else "${noun}s"

private fun agentInitials(name: String): String =
  name
    .split(' ', '-', '_')
    .filter { it.isNotBlank() }
    .take(2)
    .mapNotNull { it.firstOrNull()?.uppercaseChar()?.toString() }
    .joinToString("")
    .ifBlank { "OC" }

private val sessionSourceLabels =
  mapOf(
    "cron" to "Cron",
    "discord" to "Discord",
    "guildchat" to "Guildchat",
    "imessage" to "iMessage",
    "matrix" to "Matrix",
    "slack" to "Slack",
    "telegram" to "Telegram",
    "whatsapp" to "WhatsApp",
    "workspace" to "Workspace",
  )

internal fun sessionSourceLabel(sessionKey: String): String = sessionSourceLabel(sessionKey, GatewayChannelsSummary(channels = emptyList()))

internal fun sessionSourceLabel(
  sessionKey: String,
  channelsSummary: GatewayChannelsSummary,
): String {
  val normalized = sessionKey.trim()
  val scopedKey =
    if (normalized.startsWith("agent:", ignoreCase = true)) {
      normalized.substringAfter(':', missingDelimiterValue = "").substringAfter(':', missingDelimiterValue = "")
    } else {
      normalized
    }
  if (!scopedKey.contains(':') && !scopedKey.contains('#')) return "OpenClaw"
  val source = scopedKey.substringBefore(':').substringBefore('#').lowercase()
  val channelLabel =
    channelsSummary.channels
      .firstOrNull { channel ->
        channel.id.equals(source, ignoreCase = true)
      }?.label
      ?.takeIf { it.isNotBlank() }
  if (channelLabel != null) return channelLabel
  return sessionSourceLabels[source] ?: "OpenClaw"
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
    if (nodesDevicesSummary.pendingDevices.isNotEmpty() || nodesDevicesSummary.hasNodeCapabilityApprovalPending()) {
      HomeAttentionRow("Nodes & Devices", nodesDevicesSummaryText(nodesDevicesSummary), Icons.Default.Cloud, Tab.Settings, SettingsRoute.NodesDevices)
    } else {
      null
    },
    if (isConnected && readyProviderCount == 0) {
      HomeAttentionRow("Providers", "No ready providers", Icons.Outlined.Inventory2, Tab.Settings, SettingsRoute.ProvidersModels)
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
  OverviewLayeredPanel(contentPadding = PaddingValues(horizontal = 14.dp, vertical = 8.dp)) {
    Column(verticalArrangement = Arrangement.spacedBy(4.dp)) {
      Text(text = "Needs attention", style = ClawTheme.type.caption.copy(fontSize = 12.5.sp, lineHeight = 16.sp), color = ClawTheme.colors.warning)
      rows.forEach { row ->
        ModuleListRow(
          row = ModuleRow(row.title, row.subtitle, row.icon, row.tab, row.settingsRoute),
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
      Icon(
        imageVector = Icons.AutoMirrored.Filled.KeyboardArrowRight,
        contentDescription = "Open ${row.title}",
        modifier = Modifier.size(17.dp),
        tint = ClawTheme.colors.textMuted,
      )
    }
  }
}

internal data class RecentSessionListItem(
  val key: String,
  val title: String,
  val source: String,
  val metadata: String,
)

internal fun overviewRecentSessionRows(
  sessions: List<ChatSessionEntry>,
  channelsSummary: GatewayChannelsSummary,
): List<RecentSessionListItem> =
  sessions
    .take(overviewRecentSessionVisibleLimit)
    .map { session ->
      val title = displaySessionTitle(session.displayName)
      RecentSessionListItem(
        key = session.key,
        title = title,
        source = sessionSourceLabel(session.key, channelsSummary),
        metadata = (session.lastActivityAt ?: session.updatedAtMs)?.let(::relativeSessionTime) ?: "",
      )
    }

internal fun stableOverviewRecentRows(
  previousRows: List<RecentSessionListItem>,
  candidateRows: List<RecentSessionListItem>,
): List<RecentSessionListItem> {
  val previousRowsByKey = previousRows.associateBy { row -> row.key }
  return candidateRows.map { candidateRow ->
    val previousRow = previousRowsByKey[candidateRow.key]
    if (previousRow == null) candidateRow else candidateRow.withStableFieldsFrom(previousRow)
  }
}

private fun RecentSessionListItem.withStableFieldsFrom(previousRow: RecentSessionListItem): RecentSessionListItem =
  copy(
    title = title.ifBlank { previousRow.title },
    source = source.ifBlank { previousRow.source },
    metadata = metadata.ifBlank { previousRow.metadata },
  )

/** Recent sessions panel that preserves the session key behind display labels. */
@Composable
private fun RecentSessionList(
  rows: List<RecentSessionListItem>,
  onOpen: (String) -> Unit,
) {
  OverviewLayeredPanel(contentPadding = PaddingValues(horizontal = 12.dp, vertical = 4.dp)) {
    Column {
      rows.forEachIndexed { index, row ->
        RecentSessionRowContent(
          title = row.title,
          source = row.source,
          metadata = row.metadata,
          onClick = { onOpen(row.key) },
        )
        if (index != rows.lastIndex) {
          HorizontalDivider(color = ClawTheme.colors.border.copy(alpha = 0.48f), thickness = 1.dp)
        }
      }
    }
  }
}

@Composable
private fun RecentSessionRowContent(
  title: String,
  source: String,
  metadata: String,
  onClick: () -> Unit,
) {
  Surface(color = Color.Transparent, contentColor = ClawTheme.colors.text) {
    Row(
      modifier =
        Modifier
          .fillMaxWidth()
          .heightIn(min = overviewListRowMinHeight)
          .clip(RoundedCornerShape(ClawTheme.radii.row))
          .clickable(onClick = onClick)
          .padding(horizontal = 0.dp, vertical = 5.dp),
      verticalAlignment = Alignment.CenterVertically,
      horizontalArrangement = Arrangement.spacedBy(8.dp),
    ) {
      Surface(
        modifier = Modifier.size(30.dp),
        shape = CircleShape,
        color = ClawTheme.colors.canvas,
        border = BorderStroke(1.dp, ClawTheme.colors.border.copy(alpha = 0.7f)),
      ) {
        Box(contentAlignment = Alignment.Center) {
          Icon(imageVector = Icons.Outlined.ChatBubbleOutline, contentDescription = null, modifier = Modifier.size(14.dp), tint = ClawTheme.colors.text)
        }
      }
      Column(modifier = Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(1.dp)) {
        Text(text = title, style = ClawTheme.type.body, color = ClawTheme.colors.text, maxLines = 1, overflow = TextOverflow.Ellipsis)
        Text(text = source, style = ClawTheme.type.caption.copy(fontSize = 12.5.sp, lineHeight = 16.sp), color = ClawTheme.colors.textSubtle, maxLines = 1, overflow = TextOverflow.Ellipsis)
      }
      Text(text = metadata, style = ClawTheme.type.caption.copy(fontSize = 12.5.sp, lineHeight = 16.sp), color = ClawTheme.colors.textMuted)
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
  onOpenGatewaySettings: () -> Unit,
) {
  ClawScaffold(
    contentPadding = PaddingValues(start = 0.dp, top = 8.dp, end = 0.dp, bottom = 0.dp),
    contentWindowInsets = shellContentInsets,
  ) {
    ChatScreen(
      viewModel = viewModel,
      onVoice = onVoice,
      onOpenSessions = onOpenSessions,
      onOpenGatewaySettings = onOpenGatewaySettings,
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
  onBack: () -> Unit,
  onOpenCommand: () -> Unit,
) {
  val displayName by viewModel.displayName.collectAsState()
  val gatewayConnectionDisplay by viewModel.gatewayConnectionDisplay.collectAsState()
  val isConnected = gatewayConnectionDisplay.isConnected
  val models by viewModel.modelCatalog.collectAsState()
  val providers by viewModel.modelAuthProviders.collectAsState()
  val cameraEnabled by viewModel.cameraEnabled.collectAsState()
  val notificationForwardingEnabled by viewModel.notificationForwardingEnabled.collectAsState()
  val speakerEnabled by viewModel.speakerEnabled.collectAsState()
  val agents by viewModel.gatewayAgents.collectAsState()
  val execApprovals by viewModel.execApprovals.collectAsState()
  val pendingToolCalls by viewModel.chatPendingToolCalls.collectAsState()
  val cronStatus by viewModel.cronStatus.collectAsState()
  val usageSummary by viewModel.usageSummary.collectAsState()
  val skillsSummary by viewModel.skillsSummary.collectAsState()
  val skillWorkshopSummary by viewModel.skillWorkshopSummary.collectAsState()
  val nodesDevicesSummary by viewModel.nodesDevicesSummary.collectAsState()
  val channelsSummary by viewModel.channelsSummary.collectAsState()
  val dreamingSummary by viewModel.dreamingSummary.collectAsState()
  val appearanceThemeMode by viewModel.appearanceThemeMode.collectAsState()
  val readyProviderCount = providerRows(providers = providers, models = models).count { it.ready }
  val pendingApprovalsCount = execApprovals.size + pendingToolCalls.size

  LaunchedEffect(isConnected) {
    if (isConnected) {
      viewModel.refreshAgents()
      viewModel.refreshModelCatalog()
      viewModel.refreshCronJobs()
      viewModel.refreshUsage()
      viewModel.refreshSkills()
      viewModel.refreshSkillWorkshopProposals()
      viewModel.refreshNodesDevices()
      viewModel.refreshChannels()
      viewModel.refreshDreaming()
      viewModel.refreshExecApprovals()
    }
  }

  // System Back for settings routes is owned by the shell-level BackHandler, which
  // unwinds cross-tab opens to their originating tab via ShellNavigation. A local
  // BackHandler here would shadow it and strand cross-tab opens on Settings Home.
  if (route != SettingsRoute.Home) {
    SettingsDetailScreen(viewModel = viewModel, route = route, onBack = onBack)
    return
  }

  ClawScaffold(
    contentPadding = PaddingValues(start = 16.dp, top = 10.dp, end = 16.dp, bottom = 4.dp),
    contentWindowInsets = shellContentInsets,
  ) {
    LazyColumn(modifier = Modifier.fillMaxSize(), verticalArrangement = Arrangement.spacedBy(9.dp), contentPadding = PaddingValues(bottom = 4.dp)) {
      item {
        Row(
          modifier = Modifier.fillMaxWidth(),
          verticalAlignment = Alignment.CenterVertically,
          horizontalArrangement = Arrangement.spacedBy(9.dp),
        ) {
          ClawPlainIconButton(
            icon = Icons.AutoMirrored.Filled.ArrowBack,
            contentDescription = "Back",
            onClick = onBack,
          )
          Text(text = "Settings", style = ClawTheme.type.display.copy(fontSize = 24.sp, lineHeight = 28.sp), color = ClawTheme.colors.text, modifier = Modifier.weight(1f))
          ClawPlainIconButton(
            icon = Icons.Default.Search,
            contentDescription = "Search settings",
            onClick = onOpenCommand,
          )
        }
      }

      item {
        ProfilePanel(displayName = displayName.ifBlank { "OpenClaw" }, onClick = { onRouteChange(SettingsRoute.Profile) })
      }

      val settingsRows =
        listOf(
          SettingsRow(
            "Gateway",
            gatewaySummary(gatewayConnectionDisplay),
            Icons.Default.Cloud,
            status = gatewayConnectionDisplay.isConnected,
            route = SettingsRoute.Gateway,
          ),
          SettingsRow("Nodes & Devices", nodesDevicesSummaryText(nodesDevicesSummary), Icons.Default.Cloud, status = nodesDevicesStatus(nodesDevicesSummary), route = SettingsRoute.NodesDevices),
          SettingsRow("Channels", channelsSummaryText(channelsSummary), Icons.Default.Notifications, status = channelsStatus(channelsSummary), route = SettingsRoute.Channels),
          SettingsRow("Agents", if (agents.isEmpty()) "Load from gateway" else "${agents.size} available", Icons.Default.Person, status = agents.isNotEmpty(), route = SettingsRoute.Agents),
          SettingsRow(
            "Providers & Models",
            if (readyProviderCount > 0) "$readyProviderCount ready" else "Review readiness",
            Icons.Outlined.Inventory2,
            status = if (isConnected) readyProviderCount > 0 else false,
            route = SettingsRoute.ProvidersModels,
          ),
          SettingsRow("Approvals", approvalsSummary(pendingApprovalsCount), Icons.Default.Lock, status = approvalsStatus(pendingApprovalsCount), route = SettingsRoute.Approvals),
          SettingsRow("Cron Jobs", cronJobsSummary(cronStatus.jobs), Icons.Outlined.AccessTime, status = if (cronStatus.jobs > 0) cronStatus.enabled else null, route = SettingsRoute.CronJobs),
          SettingsRow("Usage", usageSummaryText(usageSummary.providers.size), Icons.Default.Storage, status = if (usageSummary.providers.isNotEmpty()) true else null, route = SettingsRoute.Usage),
          SettingsRow("Skills", skillsSummaryText(skillsSummary.skills), Icons.Default.Settings, status = skillsStatus(skillsSummary.skills), route = SettingsRoute.Skills),
          SettingsRow(
            "Skill Workshop",
            skillWorkshopSummaryText(skillWorkshopSummary),
            Icons.Default.Settings,
            status = skillWorkshopStatus(skillWorkshopSummary),
            route = SettingsRoute.SkillWorkshop,
          ),
          SettingsRow("Dreaming", dreamingSummaryText(dreamingSummary), Icons.Default.Storage, status = dreamingStatus(dreamingSummary), route = SettingsRoute.Dreaming),
          SettingsRow("Terminal", "Shell in the agent workspace", Icons.Outlined.Terminal, status = isConnected, route = SettingsRoute.Terminal),
          SettingsRow("Voice", if (speakerEnabled) "Speaker on" else "Speaker muted", Icons.Default.Mic, route = SettingsRoute.Voice),
          SettingsRow("Canvas", "Screen surface", Icons.AutoMirrored.Filled.ScreenShare, status = isConnected, route = SettingsRoute.Canvas),
          SettingsRow("Notifications", if (notificationForwardingEnabled) "Smart delivery" else "Off", Icons.Default.Notifications, route = SettingsRoute.Notifications),
          SettingsRow("Phone Capabilities", if (cameraEnabled) "Camera enabled" else "Locked", Icons.Default.Lock, status = !cameraEnabled, route = SettingsRoute.PhoneCapabilities),
          SettingsRow("Appearance", appearanceThemeSummary(appearanceThemeMode), Icons.Default.Palette, route = SettingsRoute.Appearance),
          SettingsRow("About", "Version and update", Icons.Default.Storage, route = SettingsRoute.About),
          SettingsRow("Health", "Diagnostics", Icons.Default.Settings, status = isConnected, route = SettingsRoute.Health),
        )

      settingsSections(settingsRows).forEach { section ->
        item {
          SettingsSectionTitle(section.title)
        }
        item {
          SettingsGroup(rows = section.rows, onOpen = onRouteChange)
        }
      }

      item {
        SettingsSectionTitle("Account")
      }
      item {
        SettingsGroup(
          rows = listOf(SettingsRow("Sign Out", "Return to setup", Icons.AutoMirrored.Filled.ExitToApp)),
          onOpen = { },
          onAction = { viewModel.pairNewGateway() },
        )
      }

      item {
        SettingsSectionTitle("Licenses")
      }
      item {
        SettingsGroup(
          rows = listOf(SettingsRow("Licenses", "", Icons.Default.Storage, route = SettingsRoute.Licenses)),
          onOpen = onRouteChange,
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

/** Mirrors the Skill Workshop review queue in one compact Settings row. */
internal fun skillWorkshopSummaryText(summary: GatewaySkillWorkshopSummary): String {
  val pending = summary.proposals.count { it.status == "pending" }
  if (pending > 0) return if (pending == 1) "1 pending" else "$pending pending"
  val held = summary.proposals.count { it.status == "quarantined" || it.status == "stale" }
  val applied = summary.proposals.count { it.status == "applied" }
  return when {
    summary.proposals.isEmpty() -> "No proposals"
    held > 0 -> if (held == 1) "1 held" else "$held held"
    applied > 0 -> if (applied == 1) "1 applied" else "$applied applied"
    else -> "${summary.proposals.size} proposals"
  }
}

internal fun skillWorkshopStatus(summary: GatewaySkillWorkshopSummary): Boolean? =
  when {
    summary.proposals.any { it.status == "pending" } -> false
    summary.proposals.any { it.status == "quarantined" || it.status == "stale" } -> false
    summary.proposals.any { it.status == "applied" } -> true
    else -> null
  }

/** Prioritizes pending pairings over online counts for compact node/device summaries. */
private fun nodesDevicesSummaryText(summary: GatewayNodesDevicesSummary): String {
  val online = summary.nodes.count { it.connected }
  val devices = summary.pairedDevices.size
  return when {
    summary.pendingDevices.isNotEmpty() -> "${summary.pendingDevices.size} pending"
    summary.hasNodeCapabilityApprovalPending() -> "Node approval pending"
    summary.nodes.isNotEmpty() -> "$online/${summary.nodes.size} online"
    devices > 0 -> "$devices paired"
    else -> "No devices"
  }
}

/** Maps node/device state to a settings status dot, treating pending pairings as attention-needed. */
private fun nodesDevicesStatus(summary: GatewayNodesDevicesSummary): Boolean? =
  when {
    summary.pendingDevices.isNotEmpty() -> false
    summary.hasNodeCapabilityApprovalPending() -> false
    summary.nodes.any { it.connected } -> true
    summary.pairedDevices.isNotEmpty() -> true
    else -> null
  }

private fun GatewayNodesDevicesSummary.hasNodeCapabilityApprovalPending(): Boolean =
  nodes.any { node ->
    node.approvalState == GatewayNodeApprovalState.PendingApproval ||
      node.approvalState == GatewayNodeApprovalState.PendingReapproval ||
      node.approvalState == GatewayNodeApprovalState.Unapproved
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

internal data class SettingsRow(
  val title: String,
  val value: String,
  val icon: ImageVector,
  val status: Boolean? = null,
  val route: SettingsRoute? = null,
)

internal data class SettingsSection(
  val title: String,
  val rows: List<SettingsRow>,
)

internal fun settingsSections(rows: List<SettingsRow>): List<SettingsSection> =
  settingsSectionOrder.mapNotNull { title ->
    val sectionRows = rows.filter { row -> row.route?.let(::settingsSectionTitleForRoute) == title }
    if (sectionRows.isEmpty()) null else SettingsSection(title = title, rows = sectionRows)
  }

private val settingsSectionOrder =
  listOf(
    "Connection",
    "Agents & automation",
    "Phone context & privacy",
    "Profile & device",
    "Diagnostics",
  )

internal fun settingsSectionTitleForRoute(route: SettingsRoute): String =
  when (route) {
    SettingsRoute.Gateway,
    SettingsRoute.NodesDevices,
    SettingsRoute.Channels,
    -> "Connection"

    SettingsRoute.Agents,
    SettingsRoute.ProvidersModels,
    SettingsRoute.Approvals,
    SettingsRoute.CronJobs,
    SettingsRoute.Usage,
    SettingsRoute.Skills,
    SettingsRoute.SkillWorkshop,
    SettingsRoute.Dreaming,
    SettingsRoute.Terminal,
    -> "Agents & automation"

    SettingsRoute.Voice,
    SettingsRoute.Canvas,
    SettingsRoute.Notifications,
    SettingsRoute.PhoneCapabilities,
    -> "Phone context & privacy"

    SettingsRoute.Profile,
    SettingsRoute.Appearance,
    SettingsRoute.About,
    SettingsRoute.Licenses,
    -> "Profile & device"

    SettingsRoute.Health -> "Diagnostics"
    SettingsRoute.Home -> "Diagnostics"
  }

@Composable
private fun SettingsSectionTitle(title: String) {
  Text(
    text = title.uppercase(),
    style = ClawTheme.type.caption.copy(fontSize = 12.sp, lineHeight = 16.sp),
    color = ClawTheme.colors.textMuted,
  )
}

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
          showDisclosure = row.route != null || onAction != null,
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
  showDisclosure: Boolean,
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
      if (row.value.isNotBlank()) {
        Text(text = row.value, style = ClawTheme.type.caption.copy(fontSize = 13.sp, lineHeight = 17.sp), color = ClawTheme.colors.textMuted, maxLines = 1, overflow = TextOverflow.Ellipsis)
      }
      row.status?.let { active ->
        Box(modifier = Modifier.size(4.5.dp).clip(CircleShape).background(if (active) ClawTheme.colors.success else ClawTheme.colors.textSubtle))
      }
      if (showDisclosure) {
        Icon(
          imageVector = Icons.AutoMirrored.Filled.KeyboardArrowRight,
          contentDescription = if (row.route != null) "Open ${row.title}" else row.title,
          modifier = Modifier.size(17.dp),
          tint = ClawTheme.colors.text,
        )
      }
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

internal fun gatewaySummary(
  statusText: String,
  isConnected: Boolean,
  gatewayConnectionProblem: GatewayConnectionProblem? = null,
): String {
  if (isConnected) return "Online and ready"
  val status = statusText.trim().lowercase()
  return when {
    status.contains("connecting") || status.contains("reconnecting") -> "Connecting..."
    status.contains("pairing") -> "Waiting for pairing"
    status.contains("auth") || status.contains("device identity") -> gatewayAuthRecoveryLabel(gatewayConnectionProblem) ?: "Authentication needed"
    status.contains("fingerprint verification timed out") -> "TLS timed out"
    status.contains("no tls endpoint") -> "No TLS endpoint"
    status.contains("certificate") || status.contains("tls") -> "Certificate review needed"
    else -> "Not connected"
  }
}

internal fun gatewaySummary(display: GatewayConnectionDisplay): String = gatewaySummary(display.statusText, display.isConnected, display.problem)
