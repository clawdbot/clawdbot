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
import ai.openclaw.app.currentAppLanguage
import ai.openclaw.app.i18n.NativeText
import ai.openclaw.app.i18n.joinedNativeText
import ai.openclaw.app.i18n.nativeString
import ai.openclaw.app.i18n.nativeText
import ai.openclaw.app.i18n.resolveNativeTextResource
import ai.openclaw.app.i18n.verbatimText
import ai.openclaw.app.node.CanvasController
import ai.openclaw.app.ui.chat.ChatScreen
import ai.openclaw.app.ui.design.AgentAvatarSource
import ai.openclaw.app.ui.design.ClawAgentAvatar
import ai.openclaw.app.ui.design.ClawBottomNav
import ai.openclaw.app.ui.design.ClawDesignTheme
import ai.openclaw.app.ui.design.ClawEmptyState
import ai.openclaw.app.ui.design.ClawIconButton
import ai.openclaw.app.ui.design.ClawNavItem
import ai.openclaw.app.ui.design.ClawPanel
import ai.openclaw.app.ui.design.ClawPlainIconButton
import ai.openclaw.app.ui.design.ClawPrimaryButton
import ai.openclaw.app.ui.design.ClawScaffold
import ai.openclaw.app.ui.design.ClawSecondaryButton
import ai.openclaw.app.ui.design.ClawStatus
import ai.openclaw.app.ui.design.ClawTheme
import ai.openclaw.app.ui.design.OpenClawMascot
import ai.openclaw.app.ui.design.agentAvatarSource
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
import androidx.compose.foundation.layout.windowInsetsPadding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.automirrored.filled.ExitToApp
import androidx.compose.material.icons.automirrored.filled.KeyboardArrowRight
import androidx.compose.material.icons.automirrored.filled.ScreenShare
import androidx.compose.material.icons.filled.ArrowDropDown
import androidx.compose.material.icons.filled.Close
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
import java.util.Locale

internal enum class Tab(
  val key: String,
  val label: NativeText,
  val icon: ImageVector,
) {
  Overview(key = "overview", label = nativeText("Home"), icon = Icons.Default.Home),
  Chat(key = "chat", label = nativeText("Chat"), icon = Icons.Outlined.ChatBubbleOutline),
  Voice(key = "voice", label = nativeText("Voice"), icon = Icons.Outlined.MicNone),
  Sessions(key = "sessions", label = nativeText("Sessions"), icon = Icons.Outlined.AccessTime),
  Settings(key = "settings", label = nativeText("Settings"), icon = Icons.Outlined.Settings),
  ProvidersModels(key = "providers-models", label = nativeText("Providers"), icon = Icons.Outlined.Inventory2),
  Files(key = "files", label = nativeText("Files"), icon = Icons.Outlined.Folder),
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
    val canvasPresentationState by viewModel.canvasPresentationState.collectAsState()
    val canvasVisible = canvasPresentationState == CanvasController.PresentationState.Visible

    LaunchedEffect(requestedHomeDestination) {
      val destination = requestedHomeDestination ?: return@LaunchedEffect
      if (destination == HomeDestination.Screen) {
        viewModel.showCanvas()
        viewModel.clearRequestedHomeDestination()
        return@LaunchedEffect
      }
      // HomeDestination is a one-shot command from launch intents and settings
      // actions; consume it after translating to local shell state.
      nav.selectTab(
        when (destination) {
          HomeDestination.Connect -> Tab.Overview
          HomeDestination.Chat -> Tab.Chat
          HomeDestination.Voice -> Tab.Voice
          HomeDestination.Screen -> Tab.Overview
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
    val showBottomNav =
      shellBottomNavVisible(keyboardVisible = keyboardVisible, commandOpen = commandOpen) && !canvasVisible

    Scaffold(
      modifier = modifier.fillMaxSize(),
      containerColor = ClawTheme.colors.canvas,
      contentWindowInsets = WindowInsets(0, 0, 0, 0),
      bottomBar = {
        if (showBottomNav) {
          ClawBottomNav(
            items =
              shellNavTabs.map {
                ClawNavItem(key = it.key, label = it.label.resolveNativeTextResource(), icon = it.icon)
              },
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

        if (canvasPresentationState != CanvasController.PresentationState.Unmounted) {
          CanvasOverlay(
            viewModel = viewModel,
            visible = canvasVisible,
            onClose = viewModel::hideCanvas,
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

@Composable
private fun CanvasOverlay(
  viewModel: MainViewModel,
  visible: Boolean,
  onClose: () -> Unit,
) {
  BackHandler(enabled = visible, onBack = onClose)
  val overlayColor = if (visible) ClawTheme.colors.canvas else Color.Transparent
  Box(modifier = Modifier.fillMaxSize().background(overlayColor)) {
    // The shell owns system-bar avoidance; arbitrary Canvas pages cannot know Android insets.
    CanvasScreen(
      viewModel = viewModel,
      visible = visible,
      modifier = Modifier.fillMaxSize().windowInsetsPadding(WindowInsets.safeDrawing),
    )
    if (visible) {
      ClawIconButton(
        icon = Icons.Default.Close,
        contentDescription = nativeString("Close Canvas"),
        onClick = onClose,
        modifier =
          Modifier
            .align(Alignment.TopEnd)
            .windowInsetsPadding(WindowInsets.safeDrawing.only(WindowInsetsSides.Top + WindowInsetsSides.Horizontal))
            .padding(top = 12.dp, end = 12.dp),
      )
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
  val models by viewModel.providerModelCatalog.collectAsState()
  val providers by viewModel.modelAuthProviders.collectAsState()
  val execApprovals by viewModel.execApprovals.collectAsState()
  val pendingToolCalls by viewModel.chatPendingToolCalls.collectAsState()
  val cronStatus by viewModel.cronStatus.collectAsState()
  val nodesDevicesSummary by viewModel.nodesDevicesSummary.collectAsState()
  val channelsSummary by viewModel.channelsSummary.collectAsState()
  val agents by viewModel.gatewayAgents.collectAsState()
  val defaultAgentId by viewModel.gatewayDefaultAgentId.collectAsState()
  val providerRows = providerRows(providers = providers, models = models)
  val readyProviderCount = providerRows.count { it.ready }
  val unknownProviderCount = providerRows.count { it.availability == ProviderAvailability.Unknown }
  val pendingApprovalsCount = execApprovals.size + pendingToolCalls.size
  val attentionRows =
    homeAttentionRows(
      isConnected = isConnected,
      pendingApprovals = pendingApprovalsCount,
      channelsSummary = channelsSummary,
      nodesDevicesSummary = nodesDevicesSummary,
      readyProviderCount = readyProviderCount,
      unknownProviderCount = unknownProviderCount,
    )
  val secondaryAttentionRows =
    if (nodesDevicesSummary.hasNodeCapabilityApprovalPending()) {
      attentionRows.filterNot { it.settingsRoute == SettingsRoute.NodesDevices }
    } else {
      attentionRows
    }
  val headerState = overviewHeaderState(isConnected = isConnected, hasAttention = attentionRows.isNotEmpty())
  val headerRoute = overviewHeaderRoute(attentionRows)
  val activeAgentName = overviewAgentName(agents = agents, defaultAgentId = defaultAgentId)
  val activeAgentBadge = overviewAgentBadgeText(agents = agents, defaultAgentId = defaultAgentId)
  val activeAgentAvatar = overviewAgentAvatar(agents = agents, defaultAgentId = defaultAgentId)
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
      viewModel.refreshProviderModels()
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
            text = nativeString("Overview"),
            style = ClawTheme.type.display.copy(fontSize = 24.sp, lineHeight = 28.sp),
            color = ClawTheme.colors.text,
          )
        }

        item {
          OverviewPrimaryPanel(
            agentName = activeAgentName,
            agentBadge = activeAgentBadge,
            agentAvatarSource = activeAgentAvatar,
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
              title = nativeString("No recent sessions"),
              body = nativeString("Start a chat and your active OpenClaw conversations will appear here."),
              action = { ClawPrimaryButton(text = nativeString("Start Chat"), onClick = { onSelectTab(Tab.Chat) }) },
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
      text = nativeString("OpenClaw"),
      style = ClawTheme.type.title.copy(fontSize = 17.sp, lineHeight = 21.sp),
      color = ClawTheme.colors.text,
      modifier = Modifier.weight(1f),
      maxLines = 1,
      overflow = TextOverflow.Ellipsis,
    )
    OverviewStatusPill(status = status, onClick = onOpenStatus)
    ClawPlainIconButton(icon = Icons.Default.Search, contentDescription = nativeString("Search"), onClick = onOpenCommand)
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
      Text(text = nativeString(status.label), style = ClawTheme.type.caption.copy(fontSize = 13.sp, lineHeight = 17.sp), color = ClawTheme.colors.text, maxLines = 1)
      Icon(imageVector = Icons.Default.ArrowDropDown, contentDescription = null, modifier = Modifier.size(15.dp), tint = ClawTheme.colors.textMuted)
    }
  }
}

@Composable
private fun OverviewPrimaryPanel(
  agentName: String,
  agentBadge: String,
  agentAvatarSource: AgentAvatarSource?,
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
      Text(text = nativeString("ACTIVE AGENT"), style = ClawTheme.type.caption.copy(fontSize = 12.sp, lineHeight = 15.sp), color = ClawTheme.colors.textMuted)
      Row(modifier = Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(9.dp)) {
        OverviewAgentBadge(text = agentBadge, active = isConnected, avatarSource = agentAvatarSource)
        Column(modifier = Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(3.dp)) {
          Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(5.dp)) {
            Text(text = if (pendingRunCount > 0) nativeString("\$agentName is working", agentName) else agentName, style = ClawTheme.type.title.copy(fontSize = 19.sp, lineHeight = 23.sp), color = ClawTheme.colors.text, maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.weight(1f, fill = false))
          }
          Text(text = overviewAgentActivityText(isConnected = isConnected, pendingRunCount = pendingRunCount, sessionCount = sessionCount, cronJobCount = cronJobCount, statusText = statusText), style = ClawTheme.type.caption.copy(fontSize = 13.5.sp, lineHeight = 17.sp), color = ClawTheme.colors.textMuted, maxLines = 1, overflow = TextOverflow.Ellipsis)
        }
        ClawSecondaryButton(text = nativeString("View"), onClick = onOpenAgent)
      }
      Row(modifier = Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(10.dp)) {
        OverviewStateChip(label = nativeString("Runs"), value = if (pendingRunCount > 0) nativeString("\$pendingRunCount active", pendingRunCount) else nativeString("Idle"), modifier = Modifier.weight(1f))
        OverviewStateChip(label = nativeString("Sessions"), value = if (sessionCount == 0) nativeString("None") else nativeString("\$sessionCount recent", sessionCount), modifier = Modifier.weight(1f))
        OverviewStateChip(label = nativeString("Cron"), value = cronJobsSummary(cronJobCount), modifier = Modifier.weight(1f))
      }
      Row(modifier = Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(10.dp)) {
        OverviewActionPill(text = nativeString("Chat"), icon = Icons.Outlined.ChatBubbleOutline, emphasized = true, onClick = onOpenChat, modifier = Modifier.weight(1f))
        OverviewActionPill(text = nativeString("Talk"), icon = Icons.Outlined.MicNone, emphasized = false, onClick = onOpenVoice, modifier = Modifier.weight(1f))
      }
      if (!isConnected) {
        ClawSecondaryButton(text = nativeString("Reconnect gateway"), icon = Icons.Default.Cloud, onClick = onOpenGateway, modifier = Modifier.fillMaxWidth())
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
  avatarSource: AgentAvatarSource?,
) {
  Surface(
    modifier = Modifier.size(42.dp),
    shape = CircleShape,
    color = if (active) ClawTheme.colors.successSoft else ClawTheme.colors.surfacePressed,
    contentColor = if (active) ClawTheme.colors.success else ClawTheme.colors.textMuted,
    tonalElevation = if (active) 3.dp else 1.dp,
    shadowElevation = if (active) 5.dp else 1.dp,
  ) {
    ClawAgentAvatar(source = avatarSource, size = 42.dp) {
      Box(contentAlignment = Alignment.Center) {
        Text(
          text = text,
          style = ClawTheme.type.title.copy(fontSize = 16.sp, lineHeight = 20.sp),
          maxLines = 1,
        )
      }
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
      Text(text = localizedUppercase(label, currentAppLanguage().languageTag), style = ClawTheme.type.caption.copy(fontSize = 10.5.sp, lineHeight = 13.sp), color = ClawTheme.colors.textSubtle, maxLines = 1)
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
        Text(text = localizedUppercase(card.title, currentAppLanguage().languageTag), style = ClawTheme.type.caption.copy(fontSize = 10.5.sp, lineHeight = 13.sp), color = ClawTheme.colors.textMuted, maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.weight(1f))
        Icon(imageVector = Icons.AutoMirrored.Filled.KeyboardArrowRight, contentDescription = nativeString("Open \${card.title}", card.title), modifier = Modifier.size(15.dp), tint = ClawTheme.colors.textMuted)
      }
      Text(text = card.value, style = ClawTheme.type.title.copy(fontSize = 22.sp, lineHeight = 25.sp), color = ClawTheme.colors.text, maxLines = 1, overflow = TextOverflow.Ellipsis)
      Text(text = card.subtitle, style = ClawTheme.type.caption.copy(fontSize = 12.5.sp, lineHeight = 16.sp), color = ClawTheme.colors.textSubtle, maxLines = 2, overflow = TextOverflow.Ellipsis)
      card.progressFraction?.let { progress ->
        OverviewProgressBar(progress = progress, tint = card.tint)
      }
    }
  }
}

internal fun localizedUppercase(
  value: String,
  languageTag: String?,
  fallbackLocale: Locale = Locale.getDefault(),
): String = value.uppercase(languageTag?.let(Locale::forLanguageTag) ?: fallbackLocale)

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
        Text(text = nativeString("Talk"), style = ClawTheme.type.caption.copy(fontSize = 12.sp, lineHeight = 15.sp), color = ClawTheme.colors.textMuted)
        Text(text = nativeString("Open Talk"), style = ClawTheme.type.body, color = ClawTheme.colors.text, maxLines = 1, overflow = TextOverflow.Ellipsis)
      }
      ClawPlainIconButton(icon = Icons.Default.Tune, contentDescription = nativeString("Talk settings"), onClick = onOpenVoiceSettings)
    }
  }
}

@Composable
private fun RecentSessionsHeader(onOpenSessions: () -> Unit) {
  SectionLabel(
    title = nativeString("Recent Sessions"),
    action = {
      Surface(
        onClick = onOpenSessions,
        modifier = Modifier.heightIn(min = ClawTheme.spacing.touchTarget),
        color = Color.Transparent,
        contentColor = ClawTheme.colors.textMuted,
      ) {
        Box(contentAlignment = Alignment.Center) {
          Text(
            text = nativeString("View all"),
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
      title = nativeString("Gateway"),
      value =
        when {
          !isConnected -> nativeString("Offline")
          hasAttention -> nativeString("Online")
          else -> nativeString("Healthy")
        },
      subtitle =
        when {
          !isConnected -> nativeString("Reconnect to continue")
          hasAttention -> nativeString("Review highlighted items")
          else -> nativeString("All systems nominal")
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
      title = nativeString("Nodes"),
      value = if (nodeCount == 0) nativeString("None") else nativeString("\$onlineNodes/\$nodeCount", onlineNodes, nodeCount),
      subtitle =
        if (nodesDevicesSummary.hasNodeCapabilityApprovalPending()) {
          nativeString("Review node access")
        } else if (nodeCount > 0) {
          nativeString(
            "\${nodeOnlinePercent(onlineNodes = onlineNodes, nodeCount = nodeCount)}% online",
            nodeOnlinePercent(onlineNodes = onlineNodes, nodeCount = nodeCount),
          )
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
      title = nativeString("Approvals"),
      value = pendingApprovals.toString(),
      subtitle = approvalsSummary(pendingApprovals),
      icon = Icons.Default.Security,
      status = if (pendingApprovals > 0) ClawStatus.Warning else ClawStatus.Neutral,
      tab = Tab.Settings,
      settingsRoute = SettingsRoute.Approvals,
    ),
    OverviewMetricCardSpec(
      title = nativeString("Sessions"),
      value = sessionCount.toString(),
      subtitle = if (sessionCount == 0) nativeString("No recent sessions") else nativeString("Recent conversations"),
      icon = Icons.Default.Groups,
      status = if (sessionCount > 0) ClawStatus.Success else ClawStatus.Neutral,
      tab = Tab.Sessions,
    ),
    OverviewMetricCardSpec(
      title = nativeString("Files"),
      value = if (isConnected) nativeString("Browse") else nativeString("Offline"),
      subtitle = nativeString("Agent workspace files"),
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
  return agent?.name?.takeIf { it.isNotBlank() } ?: agent?.id?.takeIf { it.isNotBlank() } ?: nativeString("OpenClaw")
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
  val source = agent.name?.takeIf { it.isNotBlank() } ?: agent.id.takeIf { it.isNotBlank() } ?: nativeString("OpenClaw")
  return agentInitials(source)
}

internal fun overviewAgentAvatar(
  agents: List<GatewayAgentSummary>,
  defaultAgentId: String?,
): AgentAvatarSource? = overviewAgent(agents = agents, defaultAgentId = defaultAgentId)?.let(::agentAvatarSource)

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
  if (pendingRunCount > 0) {
    return if (pendingRunCount == 1) {
      nativeString("Working · 1 active run")
    } else {
      nativeString("Working · \$pendingRunCount active runs", pendingRunCount)
    }
  }
  return when {
    sessionCount == 1 -> nativeString("Monitoring · 1 session")
    sessionCount > 1 -> nativeString("Monitoring · \$sessionCount sessions", sessionCount)
    cronJobCount == 1 -> nativeString("Monitoring · 1 scheduled job")
    cronJobCount > 1 -> nativeString("Monitoring · \$cronJobCount scheduled jobs", cronJobCount)
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

private fun agentInitials(name: String): String =
  name
    .split(' ', '-', '_')
    .filter { it.isNotBlank() }
    .take(2)
    .mapNotNull { part -> part.firstOrNull()?.let { localizedUppercase(it.toString(), currentAppLanguage().languageTag) } }
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
  if (!scopedKey.contains(':') && !scopedKey.contains('#')) return nativeString("OpenClaw")
  val source = scopedKey.substringBefore(':').substringBefore('#').lowercase()
  val channelLabel =
    channelsSummary.channels
      .firstOrNull { channel ->
        channel.id.equals(source, ignoreCase = true)
      }?.label
      ?.takeIf { it.isNotBlank() }
  if (channelLabel != null) return channelLabel
  return nativeString(sessionSourceLabels[source] ?: "OpenClaw")
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
  unknownProviderCount: Int = 0,
): List<HomeAttentionRow> =
  listOfNotNull(
    if (!isConnected) {
      HomeAttentionRow(
        nativeString("Gateway"),
        nativeString("Connect before chat, voice, and live status."),
        Icons.Default.Cloud,
        Tab.Settings,
        SettingsRoute.Gateway,
      )
    } else {
      null
    },
    if (pendingApprovals > 0) {
      HomeAttentionRow(nativeString("Approvals"), approvalsSummary(pendingApprovals), Icons.Default.Lock, Tab.Settings, SettingsRoute.Approvals)
    } else {
      null
    },
    if (channelsSummary.channels.any { it.error != null }) {
      HomeAttentionRow(nativeString("Channels"), channelsSummaryText(channelsSummary), Icons.Default.Notifications, Tab.Settings, SettingsRoute.Channels)
    } else {
      null
    },
    if (nodesDevicesSummary.pendingDevices.isNotEmpty() || nodesDevicesSummary.hasNodeCapabilityApprovalPending()) {
      HomeAttentionRow(nativeString("Nodes & Devices"), nodesDevicesSummaryText(nodesDevicesSummary), Icons.Default.Cloud, Tab.Settings, SettingsRoute.NodesDevices)
    } else {
      null
    },
    if (isConnected && readyProviderCount == 0 && unknownProviderCount == 0) {
      HomeAttentionRow(nativeString("Providers"), nativeString("No ready providers"), Icons.Outlined.Inventory2, Tab.Settings, SettingsRoute.ProvidersModels)
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
      Text(text = nativeString("Needs attention"), style = ClawTheme.type.caption.copy(fontSize = 12.5.sp, lineHeight = 16.sp), color = ClawTheme.colors.warning)
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
  val localizedTitle = nativeString(title)
  Row(
    modifier = Modifier.fillMaxWidth(),
    verticalAlignment = Alignment.CenterVertically,
    horizontalArrangement = Arrangement.SpaceBetween,
  ) {
    Text(
      text = localizedUppercase(localizedTitle, currentAppLanguage().languageTag),
      style = ClawTheme.type.caption.copy(fontSize = 12.5.sp, lineHeight = 16.sp),
      color = ClawTheme.colors.textMuted,
    )
    action?.invoke()
  }
}

@Composable
private fun ModuleListRow(
  row: ModuleRow,
  onClick: () -> Unit,
) {
  val localizedTitle = nativeString(row.title)
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
          text = localizedTitle,
          style = ClawTheme.type.body,
          color = ClawTheme.colors.text,
          maxLines = 1,
          overflow = TextOverflow.Ellipsis,
        )
        row.subtitle?.let {
          Text(text = nativeString(it), style = ClawTheme.type.caption.copy(fontSize = 12.5.sp, lineHeight = 16.sp), color = ClawTheme.colors.textSubtle, maxLines = 1, overflow = TextOverflow.Ellipsis)
        }
      }
      Icon(
        imageVector = Icons.AutoMirrored.Filled.KeyboardArrowRight,
        contentDescription = settingsRowDisclosureDescription(localizedTitle, opensRoute = true),
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
        metadata = (session.lastActivityAt ?: session.updatedAtMs)?.let(::overviewRelativeSessionTime) ?: "",
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
        contentDescription = nativeString("Open session"),
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
  val models by viewModel.providerModelCatalog.collectAsState()
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
  val providerRows = providerRows(providers = providers, models = models)
  val readyProviderCount = providerRows.count { it.ready }
  val unknownProviderCount = providerRows.count { it.availability == ProviderAvailability.Unknown }
  val pendingApprovalsCount = execApprovals.size + pendingToolCalls.size

  LaunchedEffect(isConnected) {
    if (isConnected) {
      viewModel.refreshAgents()
      viewModel.refreshModelCatalog()
      viewModel.refreshProviderModels()
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
  val appLanguage = currentAppLanguage()

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
            contentDescription = nativeString("Back"),
            onClick = onBack,
          )
          Text(text = nativeString("Settings"), style = ClawTheme.type.display.copy(fontSize = 24.sp, lineHeight = 28.sp), color = ClawTheme.colors.text, modifier = Modifier.weight(1f))
          ClawPlainIconButton(
            icon = Icons.Default.Search,
            contentDescription = nativeString("Search settings"),
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
            nativeText("Gateway"),
            verbatimText(gatewaySummary(gatewayConnectionDisplay)),
            Icons.Default.Cloud,
            status = gatewayConnectionDisplay.isConnected,
            route = SettingsRoute.Gateway,
          ),
          SettingsRow(nativeText("Nodes & Devices"), verbatimText(nodesDevicesSummaryText(nodesDevicesSummary)), Icons.Default.Cloud, status = nodesDevicesStatus(nodesDevicesSummary), route = SettingsRoute.NodesDevices),
          SettingsRow(nativeText("Channels"), verbatimText(channelsSummaryText(channelsSummary)), Icons.Default.Notifications, status = channelsStatus(channelsSummary), route = SettingsRoute.Channels),
          SettingsRow(nativeText("Agents"), if (agents.isEmpty()) nativeText("Load from gateway") else nativeText("\${agents.size} available", agents.size), Icons.Default.Person, status = agents.isNotEmpty(), route = SettingsRoute.Agents),
          SettingsRow(
            nativeText("Providers & Models"),
            when {
              readyProviderCount > 0 -> nativeText("\$readyProviderCount ready", readyProviderCount)
              unknownProviderCount > 0 -> nativeText("Availability unknown")
              else -> nativeText("Review readiness")
            },
            Icons.Outlined.Inventory2,
            status =
              when {
                !isConnected -> false
                readyProviderCount > 0 -> true
                unknownProviderCount > 0 -> null
                else -> false
              },
            route = SettingsRoute.ProvidersModels,
          ),
          SettingsRow(nativeText("Approvals"), verbatimText(approvalsSummary(pendingApprovalsCount)), Icons.Default.Lock, status = approvalsStatus(pendingApprovalsCount), route = SettingsRoute.Approvals),
          SettingsRow(nativeText("Cron Jobs"), verbatimText(cronJobsSummary(cronStatus.jobs)), Icons.Outlined.AccessTime, status = if (cronStatus.jobs > 0) cronStatus.enabled else null, route = SettingsRoute.CronJobs),
          SettingsRow(nativeText("Usage"), verbatimText(usageSummaryText(usageSummary.providers.size)), Icons.Default.Storage, status = if (usageSummary.providers.isNotEmpty()) true else null, route = SettingsRoute.Usage),
          SettingsRow(nativeText("Skills"), verbatimText(skillsSummaryText(skillsSummary.skills)), Icons.Default.Settings, status = skillsStatus(skillsSummary.skills), route = SettingsRoute.Skills),
          SettingsRow(
            nativeText("Skill Workshop"),
            verbatimText(skillWorkshopSummaryText(skillWorkshopSummary)),
            Icons.Default.Settings,
            status = skillWorkshopStatus(skillWorkshopSummary),
            route = SettingsRoute.SkillWorkshop,
          ),
          SettingsRow(nativeText("Dreaming"), verbatimText(dreamingSummaryText(dreamingSummary)), Icons.Default.Storage, status = dreamingStatus(dreamingSummary), route = SettingsRoute.Dreaming),
          SettingsRow(nativeText("Terminal"), nativeText("Shell in the agent workspace"), Icons.Outlined.Terminal, status = isConnected, route = SettingsRoute.Terminal),
          SettingsRow(nativeText("Voice"), if (speakerEnabled) nativeText("Speaker on") else nativeText("Speaker muted"), Icons.Default.Mic, route = SettingsRoute.Voice),
          SettingsRow(nativeText("Canvas"), nativeText("Screen surface"), Icons.AutoMirrored.Filled.ScreenShare, status = isConnected, route = SettingsRoute.Canvas),
          SettingsRow(nativeText("Notifications"), if (notificationForwardingEnabled) nativeText("Smart delivery") else nativeText("Off"), Icons.Default.Notifications, route = SettingsRoute.Notifications),
          SettingsRow(nativeText("Phone Capabilities"), if (cameraEnabled) nativeText("Camera enabled") else nativeText("Locked"), Icons.Default.Lock, status = !cameraEnabled, route = SettingsRoute.PhoneCapabilities),
          SettingsRow(
            nativeText("Appearance"),
            joinedNativeText(
              separator = " · ",
              parts = listOf(verbatimText(appearanceThemeSummary(appearanceThemeMode)), verbatimText(appLanguage.displayName)),
            ),
            Icons.Default.Palette,
            route = SettingsRoute.Appearance,
          ),
          SettingsRow(nativeText("About"), nativeText("Version and update"), Icons.Default.Storage, route = SettingsRoute.About),
          SettingsRow(nativeText("Health"), nativeText("Diagnostics"), Icons.Default.Settings, status = isConnected, route = SettingsRoute.Health),
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
        SettingsSectionTitle(nativeText("Account"))
      }
      item {
        SettingsGroup(
          rows = listOf(SettingsRow(nativeText("Sign Out"), nativeText("Return to setup"), Icons.AutoMirrored.Filled.ExitToApp)),
          onOpen = { },
          onAction = { viewModel.pairNewGateway() },
        )
      }

      item {
        SettingsSectionTitle(nativeText("Licenses"))
      }
      item {
        SettingsGroup(
          rows = listOf(SettingsRow(nativeText("Licenses"), verbatimText(""), Icons.Default.Storage, route = SettingsRoute.Licenses)),
          onOpen = onRouteChange,
        )
      }

      item {
        Column(
          modifier = Modifier.fillMaxWidth().padding(top = 14.dp),
          horizontalAlignment = Alignment.CenterHorizontally,
          verticalArrangement = Arrangement.spacedBy(3.dp),
        ) {
          Text(text = nativeString("OpenClaw \${BuildConfig.VERSION_NAME} (\${BuildConfig.VERSION_CODE})", BuildConfig.VERSION_NAME, BuildConfig.VERSION_CODE), style = ClawTheme.type.caption.copy(fontSize = 12.5.sp, lineHeight = 16.sp), color = ClawTheme.colors.textMuted)
          Row(horizontalArrangement = Arrangement.spacedBy(5.dp), verticalAlignment = Alignment.CenterVertically) {
            Text(
              text = if (isConnected) nativeString("All systems operational") else nativeString("Gateway not connected"),
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
    0 -> nativeString("No pending approvals")
    1 -> nativeString("1 pending")
    else -> nativeString("\$count pending", count)
  }

private fun approvalsStatus(count: Int): Boolean? = if (count > 0) true else null

/** Summarizes scheduled gateway jobs for overview and settings rows. */
private fun cronJobsSummary(count: Int): String =
  when (count) {
    0 -> nativeString("No scheduled jobs")
    1 -> nativeString("1 scheduled")
    else -> nativeString("\$count scheduled", count)
  }

/** Summarizes provider usage buckets without exposing detailed billing data. */
private fun usageSummaryText(count: Int): String =
  when (count) {
    0 -> nativeString("No provider usage")
    1 -> nativeString("1 provider")
    else -> nativeString("\$count providers", count)
  }

/** Reports how many gateway skills are enabled, eligible, and dependency-complete. */
private fun skillsSummaryText(skills: List<GatewaySkillSummary>): String {
  val ready =
    skills.count {
      !it.disabled && it.eligible && !it.blockedByAllowlist && !it.blockedByAgentFilter && it.missingCount == 0
    }
  return if (skills.isEmpty()) {
    nativeString("No skills")
  } else {
    nativeString("\$ready/\${skills.size} ready", ready, skills.size)
  }
}

/** Converts gateway skill health into a tri-state settings status dot. */
private fun skillsStatus(skills: List<GatewaySkillSummary>): Boolean? =
  when {
    skills.isEmpty() -> null
    skills.any {
      it.blockedByAllowlist ||
        it.blockedByAgentFilter ||
        (!it.disabled && (!it.eligible || it.missingCount > 0))
    } -> false
    else -> true
  }

/** Mirrors the Skill Workshop review queue in one compact Settings row. */
internal fun skillWorkshopSummaryText(summary: GatewaySkillWorkshopSummary): String {
  val pending = summary.proposals.count { it.status == "pending" }
  if (pending > 0) return if (pending == 1) nativeString("1 pending") else nativeString("\$pending pending", pending)
  val held = summary.proposals.count { it.status == "quarantined" || it.status == "stale" }
  val applied = summary.proposals.count { it.status == "applied" }
  return when {
    summary.proposals.isEmpty() -> nativeString("No proposals")
    held > 0 -> if (held == 1) nativeString("1 held") else nativeString("\$held held", held)
    applied > 0 -> if (applied == 1) nativeString("1 applied") else nativeString("\$applied applied", applied)
    else -> nativeString("\${summary.proposals.size} proposals", summary.proposals.size)
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
    summary.pendingDevices.isNotEmpty() -> nativeString("\${summary.pendingDevices.size} pending", summary.pendingDevices.size)
    summary.hasNodeCapabilityApprovalPending() -> nativeString("Node approval pending")
    summary.nodes.isNotEmpty() -> nativeString("\$online/\${summary.nodes.size} online", online, summary.nodes.size)
    devices > 0 -> nativeString("\$devices paired", devices)
    else -> nativeString("No devices")
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
internal fun channelsSummaryText(summary: GatewayChannelsSummary): String {
  val connected = summary.channels.count { it.connected }
  val issueCount = summary.channels.count { it.error != null }
  return when {
    issueCount == 1 -> nativeString("1 issue")
    issueCount > 1 -> nativeString("\$issueCount issues", issueCount)
    summary.channels.isNotEmpty() -> nativeString("\$connected/\${summary.channels.size} connected", connected, summary.channels.size)
    else -> nativeString("No channels")
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
    !summary.storeHealthy || !summary.phaseSignalHealthy -> nativeString("Needs attention")
    summary.enabled -> nativeString("\${summary.shortTermCount} waiting", summary.shortTermCount)
    else -> nativeString("Off")
  }

/** Maps dreaming store/phase health and enabled state to a settings status dot. */
private fun dreamingStatus(summary: GatewayDreamingSummary): Boolean? =
  when {
    !summary.storeHealthy || !summary.phaseSignalHealthy -> false
    summary.enabled -> true
    else -> null
  }

internal data class SettingsRow(
  val title: NativeText,
  val value: NativeText,
  val icon: ImageVector,
  val status: Boolean? = null,
  val route: SettingsRoute? = null,
)

internal data class SettingsSection(
  val title: NativeText,
  val rows: List<SettingsRow>,
)

internal fun settingsSections(rows: List<SettingsRow>): List<SettingsSection> =
  settingsSectionOrder.mapNotNull { title ->
    val sectionRows = rows.filter { row -> row.route?.let(::settingsSectionTitleForRoute) == title }
    if (sectionRows.isEmpty()) null else SettingsSection(title = title, rows = sectionRows)
  }

private val settingsSectionOrder =
  listOf(
    nativeText("Connection"),
    nativeText("Agents & automation"),
    nativeText("Phone context & privacy"),
    nativeText("Profile & device"),
    nativeText("Diagnostics"),
  )

internal fun settingsSectionTitleForRoute(route: SettingsRoute): NativeText =
  when (route) {
    SettingsRoute.Gateway,
    SettingsRoute.NodesDevices,
    SettingsRoute.Channels,
    -> nativeText("Connection")

    SettingsRoute.Agents,
    SettingsRoute.ProvidersModels,
    SettingsRoute.Approvals,
    SettingsRoute.CronJobs,
    SettingsRoute.Usage,
    SettingsRoute.Skills,
    SettingsRoute.SkillWorkshop,
    SettingsRoute.Dreaming,
    SettingsRoute.Terminal,
    -> nativeText("Agents & automation")

    SettingsRoute.Voice,
    SettingsRoute.Canvas,
    SettingsRoute.Notifications,
    SettingsRoute.PhoneCapabilities,
    -> nativeText("Phone context & privacy")

    SettingsRoute.Profile,
    SettingsRoute.Appearance,
    SettingsRoute.About,
    SettingsRoute.Licenses,
    -> nativeText("Profile & device")

    SettingsRoute.Health -> nativeText("Diagnostics")
    SettingsRoute.Home -> nativeText("Diagnostics")
  }

@Composable
private fun SettingsSectionTitle(title: NativeText) {
  val localizedTitle = title.resolveNativeTextResource()
  Text(
    text = localizedUppercase(localizedTitle, currentAppLanguage().languageTag),
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
            text =
              displayName
                .firstOrNull()
                ?.let { localizedUppercase(it.toString(), currentAppLanguage().languageTag) }
                ?: "O",
            style = ClawTheme.type.title.copy(fontSize = 14.sp, lineHeight = 17.sp),
            color = ClawTheme.colors.text,
            textAlign = TextAlign.Center,
          )
        }
      }
      Column(modifier = Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(2.dp)) {
        Text(text = displayName, style = ClawTheme.type.section, color = ClawTheme.colors.text, maxLines = 1)
        Text(text = nativeString("OpenClaw mobile"), style = ClawTheme.type.caption.copy(fontSize = 12.5.sp, lineHeight = 16.sp), color = ClawTheme.colors.textMuted, maxLines = 1)
      }
      Icon(
        imageVector = Icons.AutoMirrored.Filled.KeyboardArrowRight,
        contentDescription = nativeString("Open profile"),
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
  val localizedTitle = row.title.resolveNativeTextResource()
  val localizedValue = row.value.resolveNativeTextResource()
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
    Text(text = localizedTitle, style = ClawTheme.type.body, color = ClawTheme.colors.text, modifier = Modifier.weight(1f), maxLines = 1)
    Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(5.dp)) {
      if (localizedValue.isNotBlank()) {
        Text(text = localizedValue, style = ClawTheme.type.caption.copy(fontSize = 13.sp, lineHeight = 17.sp), color = ClawTheme.colors.textMuted, maxLines = 1, overflow = TextOverflow.Ellipsis)
      }
      row.status?.let { active ->
        Box(modifier = Modifier.size(4.5.dp).clip(CircleShape).background(if (active) ClawTheme.colors.success else ClawTheme.colors.textSubtle))
      }
      if (showDisclosure) {
        Icon(
          imageVector = Icons.AutoMirrored.Filled.KeyboardArrowRight,
          contentDescription = settingsRowDisclosureDescription(localizedTitle, opensRoute = row.route != null),
          modifier = Modifier.size(17.dp),
          tint = ClawTheme.colors.text,
        )
      }
    }
  }
}

internal fun settingsRowDisclosureDescription(
  localizedTitle: String,
  opensRoute: Boolean,
): String = if (opensRoute) nativeString("Open \${row.title}", localizedTitle) else localizedTitle

private fun overviewRelativeSessionTime(
  updatedAtMs: Long,
  nowMs: Long = System.currentTimeMillis(),
): String {
  val deltaMs = (nowMs - updatedAtMs).coerceAtLeast(0L)
  val minutes = deltaMs / 60_000L
  if (minutes < 1) return nativeString("now")
  if (minutes < 60) return nativeString("\${minutes}m", minutes)
  val hours = minutes / 60
  if (hours < 24) return nativeString("\${hours}h", hours)
  val days = hours / 24
  return nativeString("\${days}d", days)
}

private fun displaySessionTitle(displayName: String?): String = displayName?.takeIf { it.isNotBlank() } ?: nativeString("Main session")

internal fun gatewaySummary(
  statusText: String,
  isConnected: Boolean,
  gatewayConnectionProblem: GatewayConnectionProblem? = null,
): String {
  if (isConnected) return nativeString("Online and ready")
  val status = statusText.trim().lowercase()
  return when {
    status.contains("connecting") || status.contains("reconnecting") -> nativeString("Connecting...")
    status.contains("pairing") -> nativeString("Waiting for pairing")
    status.contains("auth") || status.contains("device identity") -> gatewayAuthRecoveryLabel(gatewayConnectionProblem) ?: nativeString("Authentication needed")
    status.contains("fingerprint verification timed out") -> nativeString("TLS timed out")
    status.contains("no tls endpoint") -> nativeString("No TLS endpoint")
    status.contains("certificate") || status.contains("tls") -> nativeString("Certificate review needed")
    else -> nativeString("Not connected")
  }
}

internal fun gatewaySummary(display: GatewayConnectionDisplay): String = gatewaySummary(display.statusText, display.isConnected, display.problem)
