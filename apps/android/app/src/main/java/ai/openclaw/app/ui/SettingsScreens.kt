package ai.openclaw.app.ui

import ai.openclaw.app.AndroidLicenseNotice
import ai.openclaw.app.AppLanguage
import ai.openclaw.app.AppearanceThemeMode
import ai.openclaw.app.BuildConfig
import ai.openclaw.app.GatewayAgentSummary
import ai.openclaw.app.GatewayConnectionDisplay
import ai.openclaw.app.GatewayConnectionProblem
import ai.openclaw.app.GatewayCronJobDetail
import ai.openclaw.app.GatewayCronJobDetailState
import ai.openclaw.app.GatewayCronJobSummary
import ai.openclaw.app.GatewayExecApprovalSummary
import ai.openclaw.app.GatewayTalkSetupReadiness
import ai.openclaw.app.GatewayTalkSetupState
import ai.openclaw.app.GatewayUsageProviderSummary
import ai.openclaw.app.LocationMode
import ai.openclaw.app.MainViewModel
import ai.openclaw.app.NotificationPackageFilterMode
import ai.openclaw.app.SensitiveFeatureConfig
import ai.openclaw.app.appLanguageRowSubtitle
import ai.openclaw.app.chat.ChatPendingToolCall
import ai.openclaw.app.currentAppLanguage
import ai.openclaw.app.currentSystemLanguageTag
import ai.openclaw.app.gateway.GatewayRegistryEntryKind
import ai.openclaw.app.gatewayTalkSetupDescription
import ai.openclaw.app.gatewayTalkSetupStatusText
import ai.openclaw.app.hasPhotoReadPermission
import ai.openclaw.app.isReady
import ai.openclaw.app.loadAndroidLicenseNotices
import ai.openclaw.app.locationModeAfterBackgroundSettings
import ai.openclaw.app.node.DeviceNotificationListenerService
import ai.openclaw.app.photoReadPermissionsForRequest
import ai.openclaw.app.setAppLanguage
import ai.openclaw.app.ui.design.ClawDetailRow
import ai.openclaw.app.ui.design.ClawIconBadge
import ai.openclaw.app.ui.design.ClawListItem
import ai.openclaw.app.ui.design.ClawListPanel
import ai.openclaw.app.ui.design.ClawPanel
import ai.openclaw.app.ui.design.ClawPlainIconButton
import ai.openclaw.app.ui.design.ClawPrimaryButton
import ai.openclaw.app.ui.design.ClawScaffold
import ai.openclaw.app.ui.design.ClawSecondaryButton
import ai.openclaw.app.ui.design.ClawSegmentedControl
import ai.openclaw.app.ui.design.ClawSeparatedColumn
import ai.openclaw.app.ui.design.ClawStatus
import ai.openclaw.app.ui.design.ClawStatusPill
import ai.openclaw.app.ui.design.ClawTextBadge
import ai.openclaw.app.ui.design.ClawTextField
import ai.openclaw.app.ui.design.ClawTheme
import ai.openclaw.app.ui.design.OpenClawMascot
import ai.openclaw.app.ui.design.TalkWaveform
import ai.openclaw.app.ui.design.TalkWaveformPhase
import android.Manifest
import android.content.ClipData
import android.content.ClipboardManager
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.media.AudioManager
import android.media.ToneGenerator
import android.net.Uri
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.provider.Settings
import android.widget.Toast
import androidx.activity.compose.BackHandler
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.WindowInsetsSides
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.only
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.safeDrawing
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.automirrored.filled.KeyboardArrowRight
import androidx.compose.material.icons.automirrored.filled.OpenInNew
import androidx.compose.material.icons.automirrored.filled.ScreenShare
import androidx.compose.material.icons.automirrored.filled.VolumeUp
import androidx.compose.material.icons.filled.Bolt
import androidx.compose.material.icons.filled.CameraAlt
import androidx.compose.material.icons.filled.Check
import androidx.compose.material.icons.filled.Cloud
import androidx.compose.material.icons.filled.ContentCopy
import androidx.compose.material.icons.filled.GraphicEq
import androidx.compose.material.icons.filled.Image
import androidx.compose.material.icons.filled.Info
import androidx.compose.material.icons.filled.Language
import androidx.compose.material.icons.filled.LocationOn
import androidx.compose.material.icons.filled.Lock
import androidx.compose.material.icons.filled.Mic
import androidx.compose.material.icons.filled.Notifications
import androidx.compose.material.icons.filled.Palette
import androidx.compose.material.icons.filled.Person
import androidx.compose.material.icons.filled.PlayArrow
import androidx.compose.material.icons.filled.QrCode2
import androidx.compose.material.icons.filled.Storage
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.Surface
import androidx.compose.material3.Switch
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalUriHandler
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.core.content.ContextCompat
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.LifecycleEventObserver
import androidx.lifecycle.compose.LocalLifecycleOwner
import java.text.DateFormat
import java.util.Date

/**
 * Detail routes reachable from the Android settings home surface.
 */
internal enum class SettingsRoute {
  Home,
  Profile,
  Voice,
  Agents,
  ProvidersModels,
  Approvals,
  CronJobs,
  Usage,
  Skills,
  SkillWorkshop,
  NodesDevices,
  Channels,
  Dreaming,
  Canvas,
  Terminal,
  Notifications,
  PhoneCapabilities,
  Gateway,
  Appearance,
  Health,
  About,
  Licenses,
}

/**
 * Dispatches a selected settings route to its detail screen without changing navigation ownership.
 */
@Composable
internal fun SettingsDetailScreen(
  viewModel: MainViewModel,
  route: SettingsRoute,
  onBack: () -> Unit,
) {
  when (route) {
    SettingsRoute.Home -> Unit
    SettingsRoute.Profile -> ProfileSettingsScreen(viewModel = viewModel, onBack = onBack)
    SettingsRoute.Voice -> VoiceSettingsScreen(viewModel = viewModel, onBack = onBack)
    SettingsRoute.Agents -> AgentsSettingsScreen(viewModel = viewModel, onBack = onBack)
    SettingsRoute.ProvidersModels -> ProvidersModelsScreen(viewModel = viewModel, onBack = onBack)
    SettingsRoute.Approvals -> ApprovalsSettingsScreen(viewModel = viewModel, onBack = onBack)
    SettingsRoute.CronJobs -> CronJobsSettingsScreen(viewModel = viewModel, onBack = onBack)
    SettingsRoute.Usage -> UsageSettingsScreen(viewModel = viewModel, onBack = onBack)
    SettingsRoute.Skills -> SkillsSettingsScreen(viewModel = viewModel, onBack = onBack)
    SettingsRoute.SkillWorkshop -> SkillWorkshopSettingsScreen(viewModel = viewModel, onBack = onBack)
    SettingsRoute.NodesDevices -> NodesDevicesSettingsScreen(viewModel = viewModel, onBack = onBack)
    SettingsRoute.Channels -> ChannelsSettingsScreen(viewModel = viewModel, onBack = onBack)
    SettingsRoute.Dreaming -> DreamingSettingsScreen(viewModel = viewModel, onBack = onBack)
    SettingsRoute.Canvas -> CanvasSettingsScreen(viewModel = viewModel, onBack = onBack)
    SettingsRoute.Terminal -> TerminalSettingsScreen(viewModel = viewModel, onBack = onBack)
    SettingsRoute.Notifications -> NotificationSettingsScreen(viewModel = viewModel, onBack = onBack)
    SettingsRoute.PhoneCapabilities -> PhoneCapabilitiesScreen(viewModel = viewModel, onBack = onBack)
    SettingsRoute.Gateway -> GatewaySettingsScreen(viewModel = viewModel, onBack = onBack)
    SettingsRoute.Appearance -> AppearanceSettingsScreen(viewModel = viewModel, onBack = onBack)
    SettingsRoute.Health -> HealthLogsSettingsScreen(viewModel = viewModel, onBack = onBack)
    SettingsRoute.About -> AboutSettingsScreen(viewModel = viewModel, onBack = onBack)
    SettingsRoute.Licenses -> LicensesSettingsScreen(onBack = onBack)
  }
}

@Composable
private fun UsageSettingsScreen(
  viewModel: MainViewModel,
  onBack: () -> Unit,
) {
  val usageSummary by viewModel.usageSummary.collectAsState()
  val usageRefreshing by viewModel.usageRefreshing.collectAsState()
  val usageErrorText by viewModel.usageErrorText.collectAsState()
  val isConnected by viewModel.isConnected.collectAsState()
  val providerCount = usageSummary.providers.size
  val issueCount = usageSummary.providers.count { it.error != null }

  LaunchedEffect(isConnected) {
    if (isConnected) {
      viewModel.refreshUsage()
    }
  }

  SettingsDetailFrame(title = "Usage", subtitle = "Provider limits and quota health.", icon = Icons.Default.Storage, onBack = onBack) {
    SettingsMetricPanel(
      rows =
        listOf(
          SettingsMetric("Providers", providerCount.toString()),
          SettingsMetric("Issues", issueCount.toString()),
          SettingsMetric("Updated", formatUsageUpdated(usageSummary.updatedAtMs)),
        ),
    )
    Row(modifier = Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
      ClawSecondaryButton(text = if (usageRefreshing) "Refreshing" else "Refresh", onClick = viewModel::refreshUsage, enabled = isConnected && !usageRefreshing, modifier = Modifier.weight(1f))
    }
    usageErrorText?.let { errorText ->
      ClawPanel {
        Text(text = errorText, style = ClawTheme.type.body, color = ClawTheme.colors.warning)
      }
    }
    when {
      !isConnected ->
        ClawPanel {
          Text(text = "Connect the gateway to load usage.", style = ClawTheme.type.body, color = ClawTheme.colors.textMuted)
        }
      usageSummary.providers.isEmpty() ->
        ClawPanel {
          Column(verticalArrangement = Arrangement.spacedBy(3.dp)) {
            Text(text = "No usage data yet.", style = ClawTheme.type.section, color = ClawTheme.colors.text)
            Text(text = "Provider limits will appear here when your gateway reports them.", style = ClawTheme.type.body, color = ClawTheme.colors.textMuted)
          }
        }
      else -> UsageProvidersPanel(providers = usageSummary.providers)
    }
  }
}

@Composable
private fun CronJobsSettingsScreen(
  viewModel: MainViewModel,
  onBack: () -> Unit,
) {
  val cronStatus by viewModel.cronStatus.collectAsState()
  val cronJobs by viewModel.cronJobs.collectAsState()
  val cronRefreshing by viewModel.cronRefreshing.collectAsState()
  val cronErrorText by viewModel.cronErrorText.collectAsState()
  val isConnected by viewModel.isConnected.collectAsState()
  var selectedJobId by rememberSaveable { mutableStateOf<String?>(null) }
  selectedJobId?.let { jobId ->
    CronJobDetailSettingsScreen(
      viewModel = viewModel,
      jobId = jobId,
      jobName = cronJobs.firstOrNull { it.id == jobId }?.name,
      onBack = { selectedJobId = null },
    )
    return
  }

  LaunchedEffect(isConnected) {
    if (isConnected) {
      viewModel.refreshCronJobs()
    }
  }

  SettingsDetailFrame(title = "Cron Jobs", subtitle = "Scheduled OpenClaw work from your gateway.", icon = Icons.Default.Bolt, onBack = onBack) {
    SettingsMetricPanel(
      rows =
        listOf(
          SettingsMetric("Status", if (cronStatus.enabled) "Enabled" else "Off"),
          SettingsMetric("Jobs", cronStatus.jobs.toString()),
          SettingsMetric("Next Wake", formatCronWake(cronStatus.nextWakeAtMs)),
        ),
    )
    ClawSecondaryButton(text = if (cronRefreshing) "Refreshing" else "Refresh", onClick = viewModel::refreshCronJobs, enabled = isConnected && !cronRefreshing, modifier = Modifier.fillMaxWidth())
    ClawPanel {
      Text(text = "Android shows scheduled work status. Create and edit schedules from the desktop app.", style = ClawTheme.type.body, color = ClawTheme.colors.textMuted)
    }
    cronErrorText?.let { errorText ->
      ClawPanel {
        Text(text = errorText, style = ClawTheme.type.body, color = ClawTheme.colors.warning)
      }
    }
    when {
      !isConnected ->
        ClawPanel {
          Text(text = "Connect the gateway to load cron jobs.", style = ClawTheme.type.body, color = ClawTheme.colors.textMuted)
        }
      cronJobs.isEmpty() ->
        ClawPanel {
          Column(verticalArrangement = Arrangement.spacedBy(3.dp)) {
            Text(text = "No scheduled jobs.", style = ClawTheme.type.section, color = ClawTheme.colors.text)
            Text(text = "Create recurring OpenClaw work from the desktop app.", style = ClawTheme.type.body, color = ClawTheme.colors.textMuted)
          }
        }
      else -> CronJobsPanel(jobs = cronJobs, onJobClick = { selectedJobId = it.id })
    }
  }
}

@Composable
private fun CronJobDetailSettingsScreen(
  viewModel: MainViewModel,
  jobId: String,
  jobName: String?,
  onBack: () -> Unit,
) {
  BackHandler(onBack = onBack)

  val detailState by viewModel.cronJobDetailState.collectAsState()
  val isConnected by viewModel.isConnected.collectAsState()

  DisposableEffect(viewModel, jobId) {
    onDispose { viewModel.clearCronJobDetail() }
  }

  LaunchedEffect(isConnected, jobId) {
    if (isConnected) {
      viewModel.loadCronJobDetail(jobId)
    }
  }

  val current = (detailState as? GatewayCronJobDetailState.Loaded)?.job?.takeIf { it.id == jobId }
  val loading = (detailState as? GatewayCronJobDetailState.Loading)?.id == jobId
  val errorText = (detailState as? GatewayCronJobDetailState.Error)?.takeIf { it.id == jobId }?.message
  SettingsDetailFrame(
    title = current?.name ?: jobName ?: "Cron Job",
    subtitle = "Inspect scheduled gateway work.",
    icon = Icons.Default.Bolt,
    onBack = onBack,
  ) {
    ClawSecondaryButton(
      text = if (loading) "Refreshing" else "Refresh",
      onClick = { viewModel.loadCronJobDetail(jobId) },
      enabled = isConnected && !loading,
      modifier = Modifier.fillMaxWidth(),
    )

    when {
      !isConnected ->
        ClawPanel {
          Text(text = "Connect the gateway to inspect cron jobs.", style = ClawTheme.type.body, color = ClawTheme.colors.textMuted)
        }
      errorText != null ->
        ClawPanel {
          Text(text = errorText, style = ClawTheme.type.body, color = ClawTheme.colors.warning)
        }
      current == null ->
        ClawPanel {
          Text(text = if (loading) "Loading cron job…" else "Cron job not loaded.", style = ClawTheme.type.body, color = ClawTheme.colors.textMuted)
        }
      else -> CronJobDetailPanel(current)
    }
  }
}

@Composable
private fun AgentsSettingsScreen(
  viewModel: MainViewModel,
  onBack: () -> Unit,
) {
  val agents by viewModel.gatewayAgents.collectAsState()
  val defaultAgentId by viewModel.gatewayDefaultAgentId.collectAsState()
  val isConnected by viewModel.isConnected.collectAsState()

  LaunchedEffect(isConnected) {
    if (isConnected) {
      viewModel.refreshAgents()
    }
  }

  SettingsDetailFrame(title = "Agents", subtitle = "Choose and inspect the assistants available on this gateway.", icon = Icons.Default.Person, onBack = onBack) {
    SettingsMetricPanel(
      rows =
        listOf(
          SettingsMetric("Available", agents.size.toString()),
          SettingsMetric("Default", defaultAgentName(agents, defaultAgentId)),
        ),
    )
    when {
      !isConnected ->
        ClawPanel {
          Text(text = "Connect the gateway to load agents.", style = ClawTheme.type.body, color = ClawTheme.colors.textMuted)
        }
      agents.isEmpty() ->
        ClawPanel {
          Text(text = "No agents loaded yet.", style = ClawTheme.type.body, color = ClawTheme.colors.textMuted)
        }
      else -> AgentsPanel(agents = agents, defaultAgentId = defaultAgentId)
    }
  }
}

@Composable
private fun ApprovalsSettingsScreen(
  viewModel: MainViewModel,
  onBack: () -> Unit,
) {
  val isConnected by viewModel.isConnected.collectAsState()
  val execApprovals by viewModel.execApprovals.collectAsState()
  val execApprovalsRefreshing by viewModel.execApprovalsRefreshing.collectAsState()
  val execApprovalsErrorText by viewModel.execApprovalsErrorText.collectAsState()
  val pendingToolCalls by viewModel.chatPendingToolCalls.collectAsState()
  val pendingRunCount by viewModel.pendingRunCount.collectAsState()
  val issueCount = execApprovals.count { it.errorText != null } + pendingToolCalls.count { it.isError == true }

  LaunchedEffect(isConnected) {
    if (isConnected) {
      viewModel.refreshExecApprovals()
    }
  }

  SettingsDetailFrame(title = "Approvals", subtitle = "Review actions that need your attention.", icon = Icons.Default.Lock, onBack = onBack) {
    SettingsMetricPanel(
      rows =
        listOf(
          SettingsMetric("Gateway Pending", execApprovals.size.toString()),
          SettingsMetric("Session Activity", pendingToolCalls.size.toString()),
          SettingsMetric("Issues", issueCount.toString()),
          SettingsMetric("Active Runs", pendingRunCount.toString()),
        ),
    )
    ClawSecondaryButton(
      text = if (execApprovalsRefreshing) "Refreshing" else "Refresh",
      onClick = viewModel::refreshExecApprovals,
      enabled = isConnected && !execApprovalsRefreshing,
      modifier = Modifier.fillMaxWidth(),
    )
    if (execApprovalsErrorText != null) {
      ClawPanel {
        Text(text = execApprovalsErrorText ?: "", style = ClawTheme.type.body, color = ClawTheme.colors.warning)
      }
    }
    if (!isConnected) {
      ClawPanel {
        Column(verticalArrangement = Arrangement.spacedBy(3.dp)) {
          Text(text = "Gateway disconnected.", style = ClawTheme.type.section, color = ClawTheme.colors.text)
          Text(text = "Connect the gateway to load approval requests in the app.", style = ClawTheme.type.body, color = ClawTheme.colors.textMuted)
        }
      }
    } else if (execApprovals.isEmpty()) {
      ClawPanel {
        Column(verticalArrangement = Arrangement.spacedBy(3.dp)) {
          Text(text = "No gateway approvals.", style = ClawTheme.type.section, color = ClawTheme.colors.text)
          Text(text = "Exec approval requests will appear here while this phone is connected.", style = ClawTheme.type.body, color = ClawTheme.colors.textMuted)
        }
      }
    } else {
      ExecApprovalsPanel(approvals = execApprovals, onResolve = viewModel::resolveExecApproval)
    }
    if (pendingToolCalls.isNotEmpty()) {
      Text(text = "Session activity", style = ClawTheme.type.section, color = ClawTheme.colors.text)
      Text(text = "Chat tool calls waiting in the active session remain visible here.", style = ClawTheme.type.caption, color = ClawTheme.colors.textMuted)
      SessionToolCallsPanel(toolCalls = pendingToolCalls)
    }
  }
}

@Composable
private fun ProfileSettingsScreen(
  viewModel: MainViewModel,
  onBack: () -> Unit,
) {
  val displayName by viewModel.displayName.collectAsState()
  var draft by remember(displayName) { mutableStateOf(displayName.ifBlank { "OpenClaw" }) }

  SettingsDetailFrame(title = "Profile", subtitle = "How this phone appears to OpenClaw.", icon = Icons.Default.Person, onBack = onBack) {
    ClawPanel {
      Column(verticalArrangement = Arrangement.spacedBy(9.dp)) {
        ClawTextField(value = draft, onValueChange = { draft = it }, placeholder = "Device name")
        ClawPrimaryButton(text = "Save Profile", onClick = { viewModel.setDisplayName(draft) }, enabled = draft.isNotBlank())
      }
    }
  }
}

@Composable
private fun VoiceSettingsScreen(
  viewModel: MainViewModel,
  onBack: () -> Unit,
) {
  val speakerEnabled by viewModel.speakerEnabled.collectAsState()
  val isConnected by viewModel.isConnected.collectAsState()
  val talkSetupReadiness by viewModel.talkSetupReadiness.collectAsState()

  LaunchedEffect(isConnected) {
    if (isConnected) viewModel.refreshTalkSetupReadiness()
  }

  SettingsDetailFrame(title = "Talk Provider Setup", subtitle = "Configure voice, transport, and playback.", icon = Icons.Default.Mic, onBack = onBack) {
    Column(verticalArrangement = Arrangement.spacedBy(10.dp)) {
      VoiceSetupPanel(talkSetupReadiness)
      Text(text = "Audio Test", style = ClawTheme.type.section, color = ClawTheme.colors.text)
      Text(text = "Check that OpenClaw can speak clearly on this phone.", style = ClawTheme.type.body, color = ClawTheme.colors.textMuted)
      SettingsWaveformPanel(active = speakerEnabled, onClick = ::playVoiceSetupTone)
      VoiceSetupActionRow(
        title = if (speakerEnabled) "Mute speaker" else "Enable speaker",
        subtitle = if (speakerEnabled) "Replies play aloud" else "Assistant speech muted",
        icon = Icons.AutoMirrored.Filled.VolumeUp,
        statusText = if (speakerEnabled) "On" else "Muted",
        ready = speakerEnabled,
        onClick = { viewModel.setSpeakerEnabled(!speakerEnabled) },
      )
      ClawPrimaryButton(text = "Done", onClick = onBack, modifier = Modifier.fillMaxWidth(), icon = Icons.Default.GraphicEq)
    }
  }
}

@Composable
private fun VoiceSetupPanel(
  readiness: GatewayTalkSetupReadiness,
) {
  Column(verticalArrangement = Arrangement.spacedBy(9.dp)) {
    VoiceSetupReadinessRow(title = "Realtime Talk", state = readiness.realtimeTalk, icon = Icons.Default.GraphicEq)
    VoiceSetupReadinessRow(title = "Dictation", state = readiness.dictation, icon = Icons.Default.Mic)
  }
}

@Composable
private fun VoiceSetupReadinessRow(
  title: String,
  state: GatewayTalkSetupState,
  icon: ImageVector,
) {
  VoiceSetupActionRow(
    title = title,
    subtitle = gatewayTalkSetupDescription(state),
    icon = icon,
    statusText = gatewayTalkSetupStatusText(state),
    ready = state.isReady,
  )
}

@Composable
private fun VoiceSetupActionRow(
  title: String,
  subtitle: String,
  icon: ImageVector,
  statusText: String,
  ready: Boolean,
  onClick: (() -> Unit)? = null,
) {
  val rowModifier = Modifier.fillMaxWidth().heightIn(min = 68.dp)
  Surface(
    onClick = onClick ?: {},
    enabled = onClick != null,
    modifier = rowModifier,
    shape = RoundedCornerShape(ClawTheme.radii.panel),
    color = ClawTheme.colors.surface,
    contentColor = ClawTheme.colors.text,
    border = BorderStroke(1.dp, ClawTheme.colors.border),
  ) {
    Row(
      modifier = Modifier.fillMaxWidth().padding(horizontal = 12.dp, vertical = 10.dp),
      verticalAlignment = Alignment.CenterVertically,
      horizontalArrangement = Arrangement.spacedBy(11.dp),
    ) {
      Surface(
        modifier = Modifier.size(38.dp),
        shape = CircleShape,
        color = ClawTheme.colors.canvas,
        contentColor = ClawTheme.colors.text,
        border = BorderStroke(1.dp, ClawTheme.colors.borderStrong),
      ) {
        Box(contentAlignment = Alignment.Center) {
          Icon(imageVector = icon, contentDescription = null, modifier = Modifier.size(19.dp))
        }
      }
      Column(modifier = Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(2.dp)) {
        Text(text = title, style = ClawTheme.type.section, color = ClawTheme.colors.text, maxLines = 1, overflow = TextOverflow.Ellipsis)
        Text(text = subtitle, style = ClawTheme.type.body, color = ClawTheme.colors.textMuted, maxLines = 1, overflow = TextOverflow.Ellipsis)
      }
      Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(7.dp)) {
        Box(
          modifier =
            Modifier
              .size(7.dp)
              .background(if (ready) ClawTheme.colors.success else ClawTheme.colors.textSubtle, CircleShape),
        )
        Text(text = statusText, style = ClawTheme.type.body, color = ClawTheme.colors.textMuted, maxLines = 1)
        if (onClick != null) {
          Icon(imageVector = Icons.AutoMirrored.Filled.KeyboardArrowRight, contentDescription = null, modifier = Modifier.size(20.dp), tint = ClawTheme.colors.textMuted)
        }
      }
    }
  }
}

@Composable
private fun SettingsWaveformPanel(
  active: Boolean,
  onClick: () -> Unit,
) {
  Surface(
    onClick = onClick,
    modifier = Modifier.fillMaxWidth().height(76.dp),
    shape = RoundedCornerShape(ClawTheme.radii.panel),
    color = ClawTheme.colors.surface,
    contentColor = ClawTheme.colors.text,
    border = BorderStroke(1.dp, ClawTheme.colors.border),
  ) {
    Row(
      modifier = Modifier.fillMaxWidth().padding(horizontal = 18.dp),
      verticalAlignment = Alignment.CenterVertically,
      horizontalArrangement = Arrangement.spacedBy(5.dp),
    ) {
      Icon(imageVector = Icons.Default.PlayArrow, contentDescription = null, modifier = Modifier.size(24.dp), tint = ClawTheme.colors.text)
      // Thinking is the preview phase: no capture runs on this screen, so the
      // synthetic swell demonstrates the animation without touching the mic.
      TalkWaveform(
        phase = if (active) TalkWaveformPhase.Thinking else TalkWaveformPhase.Idle,
        modifier = Modifier.weight(1f).height(48.dp),
      )
    }
  }
}

private fun playVoiceSetupTone() {
  val tone = ToneGenerator(AudioManager.STREAM_MUSIC, 80)
  tone.startTone(ToneGenerator.TONE_PROP_BEEP, 250)
  Handler(Looper.getMainLooper()).postDelayed({ tone.release() }, 300L)
}

private const val NOTIFICATION_PICKER_RESULT_LIMIT = 40

@Composable
private fun NotificationSettingsScreen(
  viewModel: MainViewModel,
  onBack: () -> Unit,
) {
  val context = LocalContext.current
  val enabled by viewModel.notificationForwardingEnabled.collectAsState()
  val mode by viewModel.notificationForwardingMode.collectAsState()
  val packages by viewModel.notificationForwardingPackages.collectAsState()
  val quietEnabled by viewModel.notificationForwardingQuietHoursEnabled.collectAsState()
  val quietStart by viewModel.notificationForwardingQuietStart.collectAsState()
  val quietEnd by viewModel.notificationForwardingQuietEnd.collectAsState()
  val maxEventsPerMinute by viewModel.notificationForwardingMaxEventsPerMinute.collectAsState()
  val modeLabel = if (mode == NotificationPackageFilterMode.Blocklist) "Blocklist" else "Allowlist"
  val installedApps = remember(context, packages) { queryInstalledApps(context, packages) }
  var notificationPickerExpanded by remember { mutableStateOf(false) }
  var notificationAppSearch by remember { mutableStateOf("") }
  var notificationShowSystemApps by remember { mutableStateOf(false) }
  val filteredApps =
    remember(installedApps, packages, notificationAppSearch, notificationShowSystemApps) {
      filterNotificationAppsForPicker(
        apps = installedApps,
        selectedPackages = packages,
        query = notificationAppSearch,
        showSystemApps = notificationShowSystemApps,
      )
    }
  var listenerEnabled by remember { mutableStateOf(DeviceNotificationListenerService.isAccessEnabled(context)) }
  val notificationPermissionLauncher =
    rememberLauncherForActivityResult(ActivityResultContracts.RequestPermission()) { granted ->
      viewModel.setNotificationForwardingEnabled(granted)
    }

  fun setForwarding(checked: Boolean) {
    if (!checked) {
      viewModel.setNotificationForwardingEnabled(false)
      return
    }
    if (Build.VERSION.SDK_INT >= 33 && !hasPermission(context, Manifest.permission.POST_NOTIFICATIONS)) {
      notificationPermissionLauncher.launch(Manifest.permission.POST_NOTIFICATIONS)
    } else {
      viewModel.setNotificationForwardingEnabled(true)
    }
    listenerEnabled = DeviceNotificationListenerService.isAccessEnabled(context)
  }

  SettingsDetailFrame(title = "Notifications", subtitle = "Choose what reaches OpenClaw.", icon = Icons.Default.Notifications, onBack = onBack) {
    SettingsTogglePanel(
      rows =
        listOf(
          SettingsToggleRow("Forward Notifications", if (enabled) "OpenClaw can receive selected alerts." else "Alerts stay on this phone.", Icons.Default.Notifications, enabled, ::setForwarding),
          SettingsToggleRow("Quiet Hours", "$quietStart to $quietEnd", Icons.Default.Bolt, quietEnabled) { checked ->
            viewModel.setNotificationForwardingQuietHours(enabled = checked, start = quietStart, end = quietEnd)
          },
        ),
    )
    SettingsMetricPanel(
      rows =
        listOf(
          SettingsMetric("Policy", modeLabel),
          SettingsMetric("Selected Apps", packages.size.toString()),
          SettingsMetric("Rate Limit", "$maxEventsPerMinute/min"),
          SettingsMetric("Access", if (listenerEnabled) "Granted" else "Setup"),
        ),
    )
    Row(modifier = Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
      ClawSecondaryButton(
        text = if (listenerEnabled) "Check Access" else "Open System Access",
        onClick = {
          openNotificationListenerSettings(context)
          listenerEnabled = DeviceNotificationListenerService.isAccessEnabled(context)
        },
        modifier = Modifier.weight(1f),
      )
    }
    ClawPanel {
      Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
        Text(text = "Forwarding Mode", style = ClawTheme.type.section, color = ClawTheme.colors.text)
        ClawSegmentedControl(
          options = listOf("Blocklist", "Allowlist"),
          selected = modeLabel,
          onSelect = { selected ->
            viewModel.setNotificationForwardingMode(if (selected == "Allowlist") NotificationPackageFilterMode.Allowlist else NotificationPackageFilterMode.Blocklist)
          },
        )
      }
    }
    NotificationPackagePickerPanel(
      mode = mode,
      selectedPackages = packages,
      apps = filteredApps,
      search = notificationAppSearch,
      showSystemApps = notificationShowSystemApps,
      expanded = notificationPickerExpanded,
      onSearchChange = { notificationAppSearch = it },
      onShowSystemAppsChange = { notificationShowSystemApps = it },
      onExpandedChange = { notificationPickerExpanded = it },
      onPackageSelectionChange = { packageName, selected ->
        val next = packages.toMutableSet()
        if (selected) {
          next.add(packageName)
        } else {
          next.remove(packageName)
        }
        viewModel.setNotificationForwardingPackagesCsv(next.sorted().joinToString(","))
      },
    )
  }
}

@Composable
private fun NotificationPackagePickerPanel(
  mode: NotificationPackageFilterMode,
  selectedPackages: Set<String>,
  apps: List<InstalledApp>,
  search: String,
  showSystemApps: Boolean,
  expanded: Boolean,
  onSearchChange: (String) -> Unit,
  onShowSystemAppsChange: (Boolean) -> Unit,
  onExpandedChange: (Boolean) -> Unit,
  onPackageSelectionChange: (String, Boolean) -> Unit,
) {
  val visibleApps = apps.take(NOTIFICATION_PICKER_RESULT_LIMIT)
  ClawPanel {
    Column(verticalArrangement = Arrangement.spacedBy(10.dp)) {
      Text(text = "App Filter", style = ClawTheme.type.section, color = ClawTheme.colors.text)
      Text(
        text = notificationPackageSelectionSummary(mode = mode, selectedCount = selectedPackages.size),
        style = ClawTheme.type.body,
        color = ClawTheme.colors.textMuted,
      )
      ClawSecondaryButton(
        text = if (expanded) "Close App Picker" else "Open App Picker",
        onClick = { onExpandedChange(!expanded) },
        modifier = Modifier.fillMaxWidth(),
      )
      if (expanded) {
        ClawTextField(value = search, onValueChange = onSearchChange, placeholder = "Search apps")
        SettingsToggleListRow(
          SettingsToggleRow(
            title = "Show System Apps",
            subtitle = "Include Android and background packages.",
            icon = Icons.Default.Storage,
            checked = showSystemApps,
            onCheckedChange = onShowSystemAppsChange,
          ),
        )
        if (visibleApps.isEmpty()) {
          Text(text = "No matching apps.", style = ClawTheme.type.body, color = ClawTheme.colors.textMuted)
        } else {
          ClawSeparatedColumn(items = visibleApps) { app ->
            NotificationPackageAppRow(
              app = app,
              selected = selectedPackages.contains(app.packageName),
              onSelectedChange = { selected -> onPackageSelectionChange(app.packageName, selected) },
            )
          }
          if (apps.size > visibleApps.size) {
            Text(
              text = "Showing ${visibleApps.size} of ${apps.size}. Refine search for more.",
              style = ClawTheme.type.caption,
              color = ClawTheme.colors.textMuted,
            )
          }
        }
      }
    }
  }
}

@Composable
private fun NotificationPackageAppRow(
  app: InstalledApp,
  selected: Boolean,
  onSelectedChange: (Boolean) -> Unit,
) {
  Row(
    modifier =
      Modifier
        .fillMaxWidth()
        .heightIn(min = 58.dp)
        .clickable { onSelectedChange(!selected) }
        .padding(vertical = 7.dp),
    verticalAlignment = Alignment.CenterVertically,
    horizontalArrangement = Arrangement.spacedBy(9.dp),
  ) {
    ClawTextBadge(text = notificationAppBadge(app.label))
    Column(modifier = Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(1.dp)) {
      Text(
        text = app.label,
        style = ClawTheme.type.body,
        color = ClawTheme.colors.text,
        maxLines = 1,
        overflow = TextOverflow.Ellipsis,
      )
      Text(
        text = app.packageName,
        style = ClawTheme.type.caption,
        color = ClawTheme.colors.textMuted,
        maxLines = 1,
        overflow = TextOverflow.Ellipsis,
      )
    }
    Switch(checked = selected, onCheckedChange = onSelectedChange)
  }
}

@Composable
private fun PhoneCapabilitiesScreen(
  viewModel: MainViewModel,
  onBack: () -> Unit,
) {
  val context = LocalContext.current
  val lifecycleOwner = LocalLifecycleOwner.current
  val cameraEnabled by viewModel.cameraEnabled.collectAsState()
  val locationMode by viewModel.locationMode.collectAsState()
  val locationPreciseEnabled by viewModel.locationPreciseEnabled.collectAsState()
  val preventSleep by viewModel.preventSleep.collectAsState()
  val canvasDebugStatusEnabled by viewModel.canvasDebugStatusEnabled.collectAsState()
  val installedAppsSharingEnabled by viewModel.installedAppsSharingEnabled.collectAsState()
  val photosAvailable = remember { SensitiveFeatureConfig.photosEnabled }
  val backgroundLocationAvailable = remember { SensitiveFeatureConfig.backgroundLocationEnabled }
  val photoPermissions = remember { photoReadPermissionsForRequest() }
  var photosGranted by remember { mutableStateOf(photosAvailable && hasPhotoReadPermission(context)) }
  var pendingLocationModeRaw by rememberSaveable { mutableStateOf<String?>(null) }
  var pendingAlwaysPreviousModeRaw by rememberSaveable { mutableStateOf<String?>(null) }
  var awaitingBackgroundSettings by rememberSaveable { mutableStateOf(false) }
  var showBackgroundLocationExplanation by rememberSaveable { mutableStateOf(false) }
  var pendingPreciseLocation by rememberSaveable { mutableStateOf(false) }
  val backgroundPermissionLabel =
    remember(context) {
      context.packageManager.backgroundPermissionOptionLabel.toString().trim().ifEmpty {
        "Allow all the time"
      }
    }
  val cameraPermissionLauncher =
    rememberLauncherForActivityResult(ActivityResultContracts.RequestPermission()) { granted ->
      viewModel.setCameraEnabled(granted)
    }
  val locationPermissionLauncher =
    rememberLauncherForActivityResult(ActivityResultContracts.RequestMultiplePermissions()) { _ ->
      val foregroundGranted = hasLocationPermission(context)
      val fineGranted = hasPermission(context, Manifest.permission.ACCESS_FINE_LOCATION)
      if (pendingPreciseLocation) {
        pendingPreciseLocation = false
        viewModel.setLocationPreciseEnabled(fineGranted)
        if (foregroundGranted && locationMode == LocationMode.Off) {
          viewModel.setLocationMode(LocationMode.WhileUsing)
        }
        return@rememberLauncherForActivityResult
      }

      val requestedMode = LocationMode.fromRawValue(pendingLocationModeRaw)
      pendingLocationModeRaw = null
      when (requestedMode) {
        LocationMode.WhileUsing ->
          viewModel.setLocationMode(
            if (foregroundGranted) LocationMode.WhileUsing else LocationMode.Off,
          )
        LocationMode.Always -> {
          if (foregroundGranted) {
            viewModel.setLocationMode(LocationMode.WhileUsing)
            showBackgroundLocationExplanation = true
          } else {
            viewModel.setLocationMode(LocationMode.Off)
            pendingAlwaysPreviousModeRaw = null
          }
        }
        LocationMode.Off -> Unit
      }
      viewModel.setLocationPreciseEnabled(fineGranted)
    }
  val photoPermissionLauncher =
    rememberLauncherForActivityResult(ActivityResultContracts.RequestMultiplePermissions()) {
      photosGranted = photosAvailable && hasPhotoReadPermission(context)
    }

  DisposableEffect(
    lifecycleOwner,
    context,
    photosAvailable,
    backgroundLocationAvailable,
    locationMode,
    awaitingBackgroundSettings,
    pendingAlwaysPreviousModeRaw,
  ) {
    val observer =
      LifecycleEventObserver { _, event ->
        if (event == Lifecycle.Event.ON_RESUME) {
          photosGranted = photosAvailable && hasPhotoReadPermission(context)
          val foregroundGranted = hasLocationPermission(context)
          val backgroundGranted = hasBackgroundLocationPermission(context)
          if (awaitingBackgroundSettings && pendingAlwaysPreviousModeRaw != null) {
            val previousMode = LocationMode.fromRawValue(pendingAlwaysPreviousModeRaw)
            viewModel.setLocationMode(
              locationModeAfterBackgroundSettings(
                previousMode = previousMode,
                foregroundGranted = foregroundGranted,
                backgroundGranted = backgroundGranted,
              ),
            )
            awaitingBackgroundSettings = false
            pendingAlwaysPreviousModeRaw = null
          } else if (
            locationMode == LocationMode.Always &&
            (!backgroundLocationAvailable || !foregroundGranted || !backgroundGranted)
          ) {
            viewModel.setLocationMode(
              if (foregroundGranted) LocationMode.WhileUsing else LocationMode.Off,
            )
          } else if (locationMode == LocationMode.WhileUsing && !foregroundGranted) {
            viewModel.setLocationMode(LocationMode.Off)
          }
        }
      }
    lifecycleOwner.lifecycle.addObserver(observer)
    onDispose { lifecycleOwner.lifecycle.removeObserver(observer) }
  }

  fun setCameraAccess(checked: Boolean) {
    if (!checked) {
      viewModel.setCameraEnabled(false)
      return
    }
    if (hasPermission(context, Manifest.permission.CAMERA)) {
      viewModel.setCameraEnabled(true)
    } else {
      cameraPermissionLauncher.launch(Manifest.permission.CAMERA)
    }
  }

  fun setLocationAccess(mode: LocationMode) {
    when (mode) {
      LocationMode.Off -> viewModel.setLocationMode(LocationMode.Off)
      LocationMode.WhileUsing -> {
        if (hasLocationPermission(context)) {
          viewModel.setLocationMode(LocationMode.WhileUsing)
        } else {
          pendingLocationModeRaw = mode.rawValue
          locationPermissionLauncher.launch(
            arrayOf(
              Manifest.permission.ACCESS_FINE_LOCATION,
              Manifest.permission.ACCESS_COARSE_LOCATION,
            ),
          )
        }
      }
      LocationMode.Always -> {
        if (!backgroundLocationAvailable) return
        if (hasLocationPermission(context) && hasBackgroundLocationPermission(context)) {
          viewModel.setLocationMode(LocationMode.Always)
          return
        }
        pendingAlwaysPreviousModeRaw = locationMode.rawValue
        if (hasLocationPermission(context)) {
          showBackgroundLocationExplanation = true
        } else {
          pendingLocationModeRaw = mode.rawValue
          locationPermissionLauncher.launch(
            arrayOf(
              Manifest.permission.ACCESS_FINE_LOCATION,
              Manifest.permission.ACCESS_COARSE_LOCATION,
            ),
          )
        }
      }
    }
  }

  fun setPreciseLocation(checked: Boolean) {
    if (!checked) {
      viewModel.setLocationPreciseEnabled(false)
      return
    }
    if (hasPermission(context, Manifest.permission.ACCESS_FINE_LOCATION)) {
      viewModel.setLocationPreciseEnabled(true)
      if (locationMode == LocationMode.Off) {
        viewModel.setLocationMode(LocationMode.WhileUsing)
      }
    } else {
      pendingPreciseLocation = true
      locationPermissionLauncher.launch(
        arrayOf(
          Manifest.permission.ACCESS_FINE_LOCATION,
          Manifest.permission.ACCESS_COARSE_LOCATION,
        ),
      )
    }
  }

  fun setPhotoAccess(checked: Boolean) {
    if (checked && !hasPhotoReadPermission(context)) {
      photoPermissionLauncher.launch(photoPermissions.toTypedArray())
    } else {
      openAppPermissionSettings(context)
    }
  }

  SettingsDetailFrame(title = "Phone Capabilities", subtitle = "Choose what this phone can share.", icon = Icons.AutoMirrored.Filled.ScreenShare, onBack = onBack) {
    SettingsTogglePanel(
      rows =
        listOfNotNull(
          SettingsToggleRow("Camera", "Allow camera tools when requested.", Icons.Default.CameraAlt, cameraEnabled, ::setCameraAccess),
          SettingsToggleRow("Precise Location", "Share precise location while location is enabled.", Icons.Default.LocationOn, locationPreciseEnabled, ::setPreciseLocation),
          if (photosAvailable) {
            SettingsToggleRow(
              "Photos",
              if (photosGranted) "Selected or full photo access granted." else "Allow photo library access.",
              Icons.Default.Image,
              photosGranted,
              ::setPhotoAccess,
            )
          } else {
            null
          },
          SettingsToggleRow(
            "Installed Apps",
            if (installedAppsSharingEnabled) "OpenClaw can list launcher-visible apps." else "App list stays on this phone.",
            Icons.Default.Storage,
            installedAppsSharingEnabled,
            viewModel::setInstalledAppsSharingEnabled,
          ),
          SettingsToggleRow("Keep Awake", "Keep the node available during active work.", Icons.Default.Bolt, preventSleep, viewModel::setPreventSleep),
          SettingsToggleRow("Canvas Status", "Show screen-sharing debug state.", Icons.AutoMirrored.Filled.ScreenShare, canvasDebugStatusEnabled, viewModel::setCanvasDebugStatusEnabled),
        ),
    )
    ClawPanel {
      Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
        Text(text = "Location", style = ClawTheme.type.section, color = ClawTheme.colors.text)
        ClawSegmentedControl(
          options = locationModeLabels(backgroundLocationAvailable),
          selected = locationMode.displayLabel,
          onSelect = { selected -> setLocationAccess(locationModeForLabel(selected)) },
        )
        if (backgroundLocationAvailable) {
          Text(
            text = "Always allows requested location checks while OpenClaw is in the background; Android shows this in the persistent node notification.",
            style = ClawTheme.type.caption,
            color = ClawTheme.colors.textMuted,
          )
        }
      }
    }
  }

  if (showBackgroundLocationExplanation) {
    fun cancelBackgroundLocationRequest() {
      val previousMode = LocationMode.fromRawValue(pendingAlwaysPreviousModeRaw)
      viewModel.setLocationMode(
        locationModeAfterBackgroundSettings(
          previousMode = previousMode,
          foregroundGranted = hasLocationPermission(context),
          backgroundGranted = hasBackgroundLocationPermission(context),
        ),
      )
      pendingAlwaysPreviousModeRaw = null
      showBackgroundLocationExplanation = false
    }

    AlertDialog(
      onDismissRequest = ::cancelBackgroundLocationRequest,
      title = { Text("Allow background location?") },
      text = {
        Text(
          "OpenClaw only checks location when your paired Gateway requests it. " +
            "On the next Android screen, choose $backgroundPermissionLabel to allow checks while the app is in the background.",
        )
      },
      confirmButton = {
        TextButton(
          onClick = {
            showBackgroundLocationExplanation = false
            awaitingBackgroundSettings = true
            openAppPermissionSettings(context)
          },
        ) {
          Text("Open Settings")
        }
      },
      dismissButton = {
        TextButton(onClick = ::cancelBackgroundLocationRequest) {
          Text("Not Now")
        }
      },
    )
  }
}

@Composable
private fun GatewaySettingsScreen(
  viewModel: MainViewModel,
  onBack: () -> Unit,
) {
  val isNodeConnected by viewModel.isNodeConnected.collectAsState()
  val gatewayConnectionDisplay by viewModel.gatewayConnectionDisplay.collectAsState()
  val serverName by viewModel.serverName.collectAsState()
  val remoteAddress by viewModel.remoteAddress.collectAsState()
  val manualHost by viewModel.manualHost.collectAsState()
  val manualPort by viewModel.manualPort.collectAsState()
  val manualTls by viewModel.manualTls.collectAsState()
  val pairedGateways by viewModel.pairedGateways.collectAsState()
  val activeGatewayStableId by viewModel.activeGatewayStableId.collectAsState()
  var setupCode by remember { mutableStateOf("") }
  var hostInput by remember(manualHost) { mutableStateOf(manualHost.ifBlank { "127.0.0.1" }) }
  var portInput by remember(manualPort) { mutableStateOf(manualPort.toString()) }
  var tlsInput by remember(manualTls) { mutableStateOf(manualTls) }
  var tokenInput by remember { mutableStateOf("") }
  var bootstrapTokenInput by remember { mutableStateOf("") }
  var passwordInput by remember { mutableStateOf("") }
  var validationText by remember { mutableStateOf<String?>(null) }
  var showSetupCodeHelp by remember { mutableStateOf(false) }
  var pendingSetupResetPlan by remember { mutableStateOf<GatewayConnectPlan?>(null) }
  var pendingForgetStableId by remember { mutableStateOf<String?>(null) }
  val transport =
    remember(hostInput, tlsInput) {
      gatewayManualTransportPresentation(
        hostInput = hostInput,
        requestedTls = tlsInput,
      )
    }

  fun saveAndConnect(plan: GatewayConnectPlan) {
    validationText = null
    viewModel.saveGatewayConfigAndConnect(plan)
  }

  pendingSetupResetPlan?.let { plan ->
    AlertDialog(
      onDismissRequest = { pendingSetupResetPlan = null },
      title = { Text("Replace gateway setup?") },
      text = {
        Text(
          gatewaySettingsSetupResetConfirmationText(),
          style = ClawTheme.type.body,
          color = ClawTheme.colors.text,
        )
      },
      confirmButton = {
        TextButton(
          onClick = {
            pendingSetupResetPlan = null
            saveAndConnect(plan)
          },
        ) {
          Text("Replace setup")
        }
      },
      dismissButton = {
        TextButton(onClick = { pendingSetupResetPlan = null }) {
          Text("Cancel")
        }
      },
      containerColor = ClawTheme.colors.surface,
    )
  }

  pendingForgetStableId?.let { stableId ->
    val entry = pairedGateways.firstOrNull { it.stableId == stableId }
    AlertDialog(
      onDismissRequest = { pendingForgetStableId = null },
      title = { Text("Forget gateway?") },
      text = { Text("Remove ${entry?.name ?: "this gateway"} and its saved credentials from this phone?") },
      confirmButton = {
        TextButton(
          onClick = {
            pendingForgetStableId = null
            viewModel.forgetGateway(stableId)
          },
        ) {
          Text("Forget")
        }
      },
      dismissButton = {
        TextButton(onClick = { pendingForgetStableId = null }) { Text("Cancel") }
      },
      containerColor = ClawTheme.colors.surface,
    )
  }

  SettingsDetailFrame(title = "Gateway", subtitle = "Connection between this phone and OpenClaw.", icon = Icons.Default.Cloud, onBack = onBack) {
    SettingsMetricPanel(
      rows =
        listOf(
          SettingsMetric("Connection", if (gatewayConnectionDisplay.isConnected) "Connected" else "Offline"),
          SettingsMetric("Node", if (isNodeConnected) "Online" else "Not paired"),
          SettingsMetric("Gateway", serverName?.takeIf { it.isNotBlank() } ?: "Home Gateway"),
          SettingsMetric("Address", remoteAddress?.takeIf { it.isNotBlank() } ?: "Not available"),
          SettingsMetric(
            "Status",
            gatewayStatusLabel(gatewayConnectionDisplay),
          ),
        ),
    )
    Row(modifier = Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
      ClawPrimaryButton(text = "Reconnect", onClick = viewModel::refreshGatewayConnection, modifier = Modifier.weight(1f))
      ClawSecondaryButton(text = "Disconnect", onClick = viewModel::disconnect, modifier = Modifier.weight(1f))
    }
    ClawPanel {
      Column(verticalArrangement = Arrangement.spacedBy(4.dp)) {
        Text(text = "Gateways", style = ClawTheme.type.section, color = ClawTheme.colors.text)
        if (pairedGateways.isEmpty()) {
          Text(text = "No paired gateways.", style = ClawTheme.type.body, color = ClawTheme.colors.textMuted)
        } else {
          pairedGateways.forEachIndexed { index, entry ->
            if (index > 0) HorizontalDivider(color = ClawTheme.colors.border)
            ClawListItem(
              title = entry.name,
              subtitle =
                when (entry.kind) {
                  GatewayRegistryEntryKind.MANUAL -> "${entry.host}:${entry.port}"
                  GatewayRegistryEntryKind.DISCOVERED -> entry.stableId
                },
              leading = {
                if (entry.stableId == activeGatewayStableId) {
                  ClawIconBadge(Icons.Default.Check)
                } else {
                  ClawIconBadge(Icons.Default.Cloud)
                }
              },
              trailing = {
                TextButton(onClick = { pendingForgetStableId = entry.stableId }) {
                  Text("Forget")
                }
              },
              onClick =
                if (entry.stableId == activeGatewayStableId) {
                  null
                } else {
                  { viewModel.switchToGateway(entry.stableId) }
                },
            )
          }
        }
        ClawSecondaryButton(
          text = "Add gateway",
          onClick = viewModel::pairNewGateway,
          modifier = Modifier.fillMaxWidth(),
          icon = Icons.Default.QrCode2,
        )
      }
    }
    ClawPanel {
      Column(verticalArrangement = Arrangement.spacedBy(10.dp)) {
        Text(text = "Gateway setup", style = ClawTheme.type.section, color = ClawTheme.colors.text)
        Text(
          text = "Scan or paste a setup code to add another gateway.",
          style = ClawTheme.type.body,
          color = ClawTheme.colors.textMuted,
          maxLines = 2,
          overflow = TextOverflow.Ellipsis,
        )
        Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
          ClawSecondaryButton(text = "Add gateway", onClick = viewModel::pairNewGateway, modifier = Modifier.fillMaxWidth(), icon = Icons.Default.QrCode2)
          ClawSecondaryButton(text = "Setup Code", onClick = { showSetupCodeHelp = !showSetupCodeHelp }, modifier = Modifier.fillMaxWidth(), icon = Icons.Default.Info)
        }
        if (showSetupCodeHelp) {
          Text(
            text = "Android can scan or paste an existing setup code, but this gateway does not expose setup-code generation to the app yet. Generate the QR/code on the gateway host with openclaw qr, then scan it here or paste the setup code below.",
            style = ClawTheme.type.caption,
            color = ClawTheme.colors.textMuted,
          )
        }
      }
    }
    ClawPanel {
      Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
        Text(text = "Connection Setup", style = ClawTheme.type.section, color = ClawTheme.colors.text)
        ClawTextField(value = setupCode, onValueChange = { setupCode = it }, placeholder = "Setup code")
        Row(modifier = Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
          ClawTextField(value = hostInput, onValueChange = { hostInput = it }, placeholder = "Host", modifier = Modifier.weight(1f))
          ClawTextField(value = portInput, onValueChange = { portInput = it }, placeholder = "Port", modifier = Modifier.weight(0.62f))
        }
        Text(text = "Connection security", style = ClawTheme.type.caption, color = ClawTheme.colors.textMuted)
        val securityOptions = listOf("Unencrypted", "Secure (TLS)")
        ClawSegmentedControl(
          options = securityOptions,
          selected = if (transport.effectiveTls) "Secure (TLS)" else "Unencrypted",
          onSelect = { selected -> tlsInput = selected == "Secure (TLS)" },
          enabledOptions =
            if (transport.requiresTls) {
              setOf("Secure (TLS)")
            } else {
              securityOptions.toSet()
            },
        )
        transport.helperText?.let { helperText ->
          Text(
            text = helperText,
            style = ClawTheme.type.caption,
            color = ClawTheme.colors.textMuted,
          )
        }
        Row(modifier = Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
          ClawTextField(value = tokenInput, onValueChange = { tokenInput = it }, placeholder = "Token", modifier = Modifier.weight(1f))
          ClawTextField(value = bootstrapTokenInput, onValueChange = { bootstrapTokenInput = it }, placeholder = "Bootstrap", modifier = Modifier.weight(1.05f))
        }
        ClawTextField(value = passwordInput, onValueChange = { passwordInput = it }, placeholder = "Password")
        validationText?.let {
          Text(text = it, style = ClawTheme.type.caption, color = ClawTheme.colors.warning)
        }
        ClawPrimaryButton(
          text = "Save & Connect",
          onClick = {
            val plan =
              resolveGatewayConnectPlan(
                useSetupCode = setupCode.isNotBlank(),
                setupCode = setupCode,
                savedManualHost = manualHost,
                savedManualPort = manualPort.toString(),
                savedManualTls = manualTls,
                manualHostInput = hostInput,
                manualPortInput = portInput,
                manualTlsInput = transport.effectiveTls,
                tokenInput = tokenInput,
                bootstrapTokenInput = bootstrapTokenInput,
                passwordInput = passwordInput,
              )
            if (plan == null) {
              validationText = "Enter a valid setup code or gateway address."
              return@ClawPrimaryButton
            }
            if (plan.savedAuthAction == GatewaySavedAuthAction.REPLACE_SETUP) {
              pendingSetupResetPlan = plan
            } else {
              saveAndConnect(plan)
            }
          },
          modifier = Modifier.fillMaxWidth(),
        )
      }
    }
  }
}

@Composable
private fun AppearanceSettingsScreen(
  viewModel: MainViewModel,
  onBack: () -> Unit,
) {
  val themeMode by viewModel.appearanceThemeMode.collectAsState()
  val context = LocalContext.current
  var appLanguage by remember { mutableStateOf(currentAppLanguage()) }
  val systemLanguageTag = currentSystemLanguageTag(context)

  SettingsDetailFrame(title = "Appearance", subtitle = "Theme and translated Android text.", icon = Icons.Default.Palette, onBack = onBack) {
    SettingsMetricPanel(
      rows =
        listOf(
          SettingsMetric("Theme", appearanceThemeSummary(themeMode)),
          SettingsMetric("Language", appLanguage.displayName),
          SettingsMetric("Contrast", "High"),
          SettingsMetric("Typography", "Readable"),
        ),
    )
    ClawPanel {
      Column(verticalArrangement = Arrangement.spacedBy(10.dp)) {
        Text(text = "Theme", style = ClawTheme.type.section, color = ClawTheme.colors.text)
        ClawSegmentedControl(
          options = appearanceThemeOptions(),
          selected = appearanceThemeSummary(themeMode),
          onSelect = { selected -> viewModel.setAppearanceThemeMode(appearanceThemeModeForLabel(selected)) },
        )
      }
    }
    ClawPanel {
      Column(verticalArrangement = Arrangement.spacedBy(4.dp)) {
        Text(text = "App language", style = ClawTheme.type.section, color = ClawTheme.colors.text)
        Text(
          text = "Changes Android text that OpenClaw has translated. Screens with English-only copy stay unchanged.",
          style = ClawTheme.type.caption,
          color = ClawTheme.colors.textMuted,
        )
        AppLanguage.entries.forEachIndexed { index, language ->
          if (index > 0) HorizontalDivider(color = ClawTheme.colors.border)
          AppLanguageRow(
            language = language,
            selected = language == appLanguage,
            systemLanguageTag = systemLanguageTag,
            onClick = {
              appLanguage = language
              setAppLanguage(language)
            },
          )
        }
      }
    }
  }
}

@Composable
private fun AppLanguageRow(
  language: AppLanguage,
  selected: Boolean,
  systemLanguageTag: String,
  onClick: () -> Unit,
) {
  ClawListItem(
    title = language.displayName,
    subtitle = appLanguageRowSubtitle(language = language, systemLanguageTag = systemLanguageTag),
    leading = { ClawIconBadge(Icons.Default.Language) },
    trailing =
      if (selected) {
        {
          Icon(
            imageVector = Icons.Default.Check,
            contentDescription = "Selected",
            modifier = Modifier.size(18.dp),
            tint = ClawTheme.colors.primary,
          )
        }
      } else {
        null
      },
    onClick = onClick,
  )
}

internal fun appearanceThemeSummary(mode: AppearanceThemeMode): String = mode.displayLabel

internal fun appearanceThemeOptions(): List<String> = AppearanceThemeMode.entries.map { it.displayLabel }

internal fun appearanceThemeModeForLabel(label: String): AppearanceThemeMode = AppearanceThemeMode.fromDisplayLabel(label)

internal fun locationModeLabels(backgroundLocationAvailable: Boolean): List<String> =
  if (backgroundLocationAvailable) {
    listOf("Off", "While Using", "Always")
  } else {
    listOf("Off", "While Using")
  }

internal fun locationModeForLabel(label: String): LocationMode =
  when (label) {
    "While Using" -> LocationMode.WhileUsing
    "Always" -> LocationMode.Always
    else -> LocationMode.Off
  }

private val LocationMode.displayLabel: String
  get() =
    when (this) {
      LocationMode.Off -> "Off"
      LocationMode.WhileUsing -> "While Using"
      LocationMode.Always -> "Always"
    }

/** Converts raw gateway connection text into stable settings metric labels. */
internal fun gatewayStatusLabel(
  statusText: String,
  isConnected: Boolean,
  gatewayConnectionProblem: GatewayConnectionProblem? = null,
): String {
  if (isConnected) return "Ready"
  val status = statusText.trim().lowercase()
  return when {
    status.contains("connecting") || status.contains("reconnecting") -> "Connecting..."
    status.contains("pair") -> "Pairing needed"
    status.contains("auth") || status.contains("device identity") -> gatewayAuthRecoveryLabel(gatewayConnectionProblem) ?: "Authentication needed"
    status.contains("fingerprint verification timed out") -> "TLS timed out"
    status.contains("no tls endpoint") -> "No TLS endpoint"
    status.contains("certificate") || status.contains("tls") -> "Certificate review needed"
    status.contains("failed") || status.contains("error") || status.contains("offline") || status.contains("not connected") -> "Cannot reach gateway"
    status.isBlank() -> "Not connected"
    else -> "Not connected"
  }
}

internal fun gatewayStatusLabel(display: GatewayConnectionDisplay): String = gatewayStatusLabel(display.statusText, display.isConnected, display.problem)

@Composable
private fun AboutSettingsScreen(
  viewModel: MainViewModel,
  onBack: () -> Unit,
) {
  val isConnected by viewModel.isConnected.collectAsState()
  val serverName by viewModel.serverName.collectAsState()
  val gatewayVersion by viewModel.gatewayVersion.collectAsState()
  val updateAvailable by viewModel.gatewayUpdateAvailable.collectAsState()
  val latestVersion = updateAvailable?.latestVersion?.takeIf { it.isNotBlank() }
  val currentGatewayVersion = updateAvailable?.currentVersion?.takeIf { it.isNotBlank() } ?: gatewayVersion

  SettingsDetailFrame(title = "About", subtitle = "OpenClaw for Android.", icon = Icons.Default.Info, onBack = onBack) {
    AboutHeroPanel()
    SettingsMetricPanel(
      rows =
        listOf(
          SettingsMetric("Android App", BuildConfig.VERSION_NAME),
          SettingsMetric("Build", BuildConfig.VERSION_CODE.toString()),
          SettingsMetric("Channel", androidDistributionChannel()),
          SettingsMetric("Gateway", currentGatewayVersion ?: "Not connected"),
        ),
    )
    ClawPanel(contentPadding = PaddingValues(horizontal = 0.dp, vertical = 0.dp)) {
      Column {
        AboutStatusRow(title = "Gateway", value = serverName?.takeIf { it.isNotBlank() } ?: "Home Gateway", healthy = isConnected)
        HorizontalDivider(color = ClawTheme.colors.border, thickness = 1.dp)
        AboutStatusRow(title = "Runtime", value = currentGatewayVersion ?: "Waiting", healthy = currentGatewayVersion != null)
        HorizontalDivider(color = ClawTheme.colors.border, thickness = 1.dp)
        AboutStatusRow(
          title = "Update",
          value = latestVersion?.let { "v$it available" } ?: "Up to date",
          healthy = latestVersion == null,
        )
      }
    }
    ClawPanel {
      Text(text = aboutUpdateText(latestVersion = latestVersion), style = ClawTheme.type.body, color = ClawTheme.colors.textMuted)
    }
    AboutLinksPanel()
    Text(
      text = "© 2026 OpenClaw Foundation — MIT License.",
      style = ClawTheme.type.caption,
      color = ClawTheme.colors.textSubtle,
      modifier = Modifier.fillMaxWidth(),
      textAlign = TextAlign.Center,
    )
  }
}

@Composable
private fun AboutHeroPanel() {
  ClawPanel {
    Column(
      modifier = Modifier.fillMaxWidth(),
      horizontalAlignment = Alignment.CenterHorizontally,
      verticalArrangement = Arrangement.spacedBy(10.dp),
    ) {
      OpenClawMascot(contentDescription = "OpenClaw logo", modifier = Modifier.size(96.dp))
      Column(horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.spacedBy(2.dp)) {
        Text(text = "OpenClaw", style = ClawTheme.type.section, color = ClawTheme.colors.text)
        Text(text = "Personal AI on your devices", style = ClawTheme.type.caption, color = ClawTheme.colors.textMuted)
      }
    }
  }
}

/** External project links; static first-party URLs matching the iOS and macOS About screens. */
private data class AboutLink(
  val title: String,
  val subtitle: String,
  val url: String,
)

private val aboutLinks =
  listOf(
    AboutLink("Website", "openclaw.ai", "https://openclaw.ai"),
    AboutLink("Docs", "docs.openclaw.ai", "https://docs.openclaw.ai"),
    AboutLink("GitHub", "github.com/openclaw/openclaw", "https://github.com/openclaw/openclaw"),
    AboutLink("Discord", "discord.gg/clawd", "https://discord.gg/clawd"),
  )

@Composable
private fun AboutLinksPanel() {
  val uriHandler = LocalUriHandler.current
  ClawListPanel(items = aboutLinks) { link ->
    ClawListItem(
      title = link.title,
      subtitle = link.subtitle,
      onClick = { uriHandler.openUri(link.url) },
      trailing = {
        Icon(
          imageVector = Icons.AutoMirrored.Filled.OpenInNew,
          contentDescription = null,
          tint = ClawTheme.colors.textSubtle,
          modifier = Modifier.size(16.dp),
        )
      },
    )
  }
}

@Composable
private fun LicensesSettingsScreen(onBack: () -> Unit) {
  val context = LocalContext.current
  val licenses = remember(context) { loadAndroidLicenseNotices(context.assets) }
  var selectedLicense by remember { mutableStateOf<AndroidLicenseNotice?>(null) }
  val backToListOrSettings = {
    if (selectedLicense == null) {
      onBack()
    } else {
      selectedLicense = null
    }
  }

  BackHandler(enabled = selectedLicense != null) {
    selectedLicense = null
  }

  SettingsDetailFrame(
    title = "Licenses",
    subtitle = if (selectedLicense == null) "OpenClaw appreciates its partners in the open-source community." else "",
    subtitleTextAlign = TextAlign.Center,
    icon = Icons.Default.Info,
    onBack = backToListOrSettings,
  ) {
    val selected = selectedLicense
    if (selected == null) {
      if (licenses.isEmpty()) {
        ClawPanel {
          Text(text = "No license notices are packaged in this build.", style = ClawTheme.type.body, color = ClawTheme.colors.textMuted)
        }
      } else {
        ClawListPanel(items = licenses) { license ->
          LicenseListRow(license = license, onClick = { selectedLicense = license })
        }
      }
    } else {
      ClawPanel {
        Text(text = selected.text, style = ClawTheme.type.caption.copy(fontFamily = FontFamily.Monospace), color = ClawTheme.colors.textMuted)
      }
    }
  }
}

@Composable
private fun LicenseListRow(
  license: AndroidLicenseNotice,
  onClick: () -> Unit,
) {
  ClawListItem(
    title = license.title,
    onClick = onClick,
    trailing = {
      Icon(
        imageVector = Icons.AutoMirrored.Filled.KeyboardArrowRight,
        contentDescription = "Open ${license.title}",
        modifier = Modifier.size(20.dp),
        tint = ClawTheme.colors.text,
      )
    },
  )
}

internal fun androidDistributionChannel(flavor: String = BuildConfig.FLAVOR): String =
  when (flavor.trim()) {
    "play" -> "Play"
    "thirdParty" -> "Third-party"
    "" -> "Unknown"
    else -> flavor.trim()
  }

internal fun gatewaySettingsSetupResetConfirmationText(): String =
  "Replacing the setup code clears this phone's saved setup credentials and device tokens before reconnecting. " +
    "This phone may need node capability approval again; continue only when you mean to pair with a fresh gateway setup code."

@Composable
private fun AboutStatusRow(
  title: String,
  value: String,
  healthy: Boolean,
) {
  Row(
    modifier = Modifier.fillMaxWidth().padding(horizontal = 10.dp, vertical = 7.dp),
    verticalAlignment = Alignment.CenterVertically,
    horizontalArrangement = Arrangement.spacedBy(9.dp),
  ) {
    Column(modifier = Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(1.dp)) {
      Text(text = title, style = ClawTheme.type.body, color = ClawTheme.colors.text, maxLines = 1)
      Text(text = value, style = ClawTheme.type.caption, color = ClawTheme.colors.textMuted, maxLines = 1, overflow = TextOverflow.Ellipsis)
    }
    ClawStatusPill(text = if (healthy) "OK" else "Check", status = if (healthy) ClawStatus.Success else ClawStatus.Warning)
  }
}

/** Chooses about-screen copy based on whether the gateway advertises an update. */
private fun aboutUpdateText(latestVersion: String?): String =
  if (latestVersion == null) {
    "OpenClaw turns this phone into a clean mobile command surface for sessions, voice, providers, and Gateway."
  } else {
    "A Gateway update is available. Run the update from the Web UI or CLI when you are ready."
  }

/**
 * Shared settings detail shell with back navigation, title, subtitle, and section content.
 */
@Composable
internal fun SettingsDetailFrame(
  title: String,
  subtitle: String,
  icon: ImageVector,
  onBack: () -> Unit,
  subtitleTextAlign: TextAlign = TextAlign.Start,
  content: @Composable () -> Unit,
) {
  ClawScaffold(
    contentPadding = PaddingValues(start = ClawTheme.spacing.lg, top = 14.dp, end = ClawTheme.spacing.lg, bottom = 6.dp),
    contentWindowInsets = WindowInsets.safeDrawing.only(WindowInsetsSides.Top + WindowInsetsSides.Horizontal),
  ) {
    LazyColumn(modifier = Modifier.fillMaxSize(), verticalArrangement = Arrangement.spacedBy(10.dp), contentPadding = PaddingValues(bottom = 4.dp)) {
      item {
        Row(modifier = Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(9.dp)) {
          ClawPlainIconButton(
            icon = Icons.AutoMirrored.Filled.ArrowBack,
            contentDescription = "Back",
            onClick = onBack,
          )
          Text(text = title, style = ClawTheme.type.title, color = ClawTheme.colors.text, modifier = Modifier.weight(1f), maxLines = 1, overflow = TextOverflow.Ellipsis)
          SettingsIconMark(icon = icon)
        }
      }
      if (subtitle.isNotBlank()) {
        item {
          Text(
            text = subtitle,
            style = ClawTheme.type.body,
            color = ClawTheme.colors.textMuted,
            modifier = Modifier.fillMaxWidth(),
            textAlign = subtitleTextAlign,
          )
        }
      }
      item {
        Column(verticalArrangement = Arrangement.spacedBy(12.dp)) {
          content()
        }
      }
    }
  }
}

/**
 * Toggle row model reused by settings sections that render simple on/off controls.
 */
private data class SettingsToggleRow(
  val title: String,
  val subtitle: String,
  val icon: ImageVector,
  val checked: Boolean,
  val onCheckedChange: (Boolean) -> Unit,
)

/**
 * Compact metric row model for connected gateway summaries.
 */
internal data class SettingsMetric(
  val title: String,
  val value: String,
  val copyable: Boolean = false,
)

@Composable
private fun ExecApprovalsPanel(
  approvals: List<GatewayExecApprovalSummary>,
  onResolve: (String, String) -> Unit,
) {
  Column(verticalArrangement = Arrangement.spacedBy(10.dp)) {
    approvals.forEach { approval ->
      ExecApprovalCard(approval = approval, onResolve = onResolve)
    }
  }
}

@Composable
private fun ExecApprovalCard(
  approval: GatewayExecApprovalSummary,
  onResolve: (String, String) -> Unit,
) {
  val resolving = approval.resolvingDecision != null
  ClawPanel {
    Column(verticalArrangement = Arrangement.spacedBy(9.dp)) {
      Row(modifier = Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(9.dp)) {
        Column(modifier = Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(3.dp)) {
          Text(text = approval.commandText, style = ClawTheme.type.body, color = ClawTheme.colors.text, maxLines = 2, overflow = TextOverflow.Ellipsis)
          approval.commandPreview?.let { preview ->
            Text(text = preview, style = ClawTheme.type.caption, color = ClawTheme.colors.textMuted, maxLines = 2, overflow = TextOverflow.Ellipsis)
          }
        }
        ClawStatusPill(text = if (resolving) "Sending" else "Review", status = if (resolving) ClawStatus.Warning else ClawStatus.Success)
      }
      Text(text = execApprovalMetadata(approval), style = ClawTheme.type.caption, color = ClawTheme.colors.textSubtle, maxLines = 2, overflow = TextOverflow.Ellipsis)
      approval.errorText?.let { errorText ->
        Text(text = errorText, style = ClawTheme.type.caption, color = ClawTheme.colors.warning)
      }
      Row(modifier = Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
        if ("allow-once" in approval.allowedDecisions) {
          ClawPrimaryButton(
            text = if (approval.resolvingDecision == "allow-once") "Allowing" else "Allow Once",
            onClick = { onResolve(approval.id, "allow-once") },
            enabled = !resolving,
            modifier = Modifier.weight(1f),
          )
        }
        if ("allow-always" in approval.allowedDecisions) {
          ClawSecondaryButton(
            text = if (approval.resolvingDecision == "allow-always") "Saving" else "Always",
            onClick = { onResolve(approval.id, "allow-always") },
            enabled = !resolving,
            modifier = Modifier.weight(1f),
          )
        }
        if ("deny" in approval.allowedDecisions) {
          ClawSecondaryButton(
            text = if (approval.resolvingDecision == "deny") "Denying" else "Deny",
            onClick = { onResolve(approval.id, "deny") },
            enabled = !resolving,
            modifier = Modifier.weight(1f),
          )
        }
      }
    }
  }
}

@Composable
private fun SessionToolCallsPanel(toolCalls: List<ChatPendingToolCall>) {
  ClawListPanel(items = toolCalls) { toolCall ->
    ApprovalListRow(toolCall = toolCall)
  }
}

@Composable
private fun ApprovalListRow(toolCall: ChatPendingToolCall) {
  val hasIssue = toolCall.isError == true
  ClawDetailRow(
    title = approvalActionName(toolCall.name),
    subtitle = approvalSubtitle(toolCall, hasIssue),
    leading = { ClawIconBadge(icon = Icons.Default.Lock) },
    trailing = { ClawStatusPill(text = if (hasIssue) "Issue" else "Review", status = if (hasIssue) ClawStatus.Warning else ClawStatus.Success) },
  )
}

@Composable
private fun CronJobsPanel(
  jobs: List<GatewayCronJobSummary>,
  onJobClick: (GatewayCronJobSummary) -> Unit,
) {
  ClawListPanel(items = jobs) { job ->
    CronJobListRow(job = job, onClick = { onJobClick(job) })
  }
}

@Composable
private fun UsageProvidersPanel(providers: List<GatewayUsageProviderSummary>) {
  ClawListPanel(items = providers) { provider ->
    UsageProviderListRow(provider = provider)
  }
}

@Composable
private fun UsageProviderListRow(provider: GatewayUsageProviderSummary) {
  val hasIssue = provider.error != null
  ClawDetailRow(
    title = provider.displayName,
    subtitle = usageProviderSubtitle(provider),
    leading = { ClawTextBadge(text = provider.displayName.firstOrNull()?.uppercase() ?: "U") },
    trailing = { ClawStatusPill(text = if (hasIssue) "Issue" else "OK", status = if (hasIssue) ClawStatus.Warning else ClawStatus.Success) },
  )
}

@Composable
private fun CronJobListRow(
  job: GatewayCronJobSummary,
  onClick: () -> Unit,
) {
  ClawDetailRow(
    title = job.name,
    subtitle = cronJobSubtitle(job),
    modifier = Modifier.clickable(onClick = onClick),
    leading = { ClawIconBadge(icon = Icons.Default.Bolt) },
    trailing = {
      Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(6.dp)) {
        ClawStatusPill(text = cronJobStatusText(job), status = cronJobStatus(job))
        Icon(imageVector = Icons.AutoMirrored.Filled.KeyboardArrowRight, contentDescription = null, modifier = Modifier.size(17.dp), tint = ClawTheme.colors.textSubtle)
      }
    },
  )
}

@Composable
private fun CronJobDetailPanel(
  job: GatewayCronJobDetail,
) {
  SettingsMetricPanel(
    rows =
      listOf(
        SettingsMetric("Status", if (job.enabled) "Enabled" else "Off"),
        SettingsMetric("Schedule", job.scheduleLabel),
        SettingsMetric("Next Wake", formatCronWake(job.nextRunAtMs)),
        SettingsMetric("Last Run", formatCronTimestamp(job.lastRunAtMs)),
      ),
  )
  CronJobFieldsPanel(
    rows =
      listOf(
        SettingsMetric("ID", job.id, copyable = true),
        SettingsMetric("Description", job.description.ifBlank { "None" }),
        SettingsMetric("Schedule Detail", job.scheduleDetail),
        SettingsMetric("Session Target", job.sessionTarget),
        SettingsMetric("Wake Mode", job.wakeMode),
        SettingsMetric("Delete After Run", if (job.deleteAfterRun) "Yes" else "No"),
        SettingsMetric("Payload", job.payloadLabel),
        SettingsMetric("Delivery", job.deliveryLabel),
        SettingsMetric("Failure Alert", job.failureAlertLabel),
        SettingsMetric("Created", formatCronTimestamp(job.createdAtMs)),
        SettingsMetric("Updated", formatCronTimestamp(job.updatedAtMs)),
        SettingsMetric("Running Since", formatCronTimestamp(job.runningAtMs)),
        SettingsMetric("Last Status", cronJobStatusText(job)),
        SettingsMetric("Last Duration", job.lastDurationMs?.let { "${it}ms" } ?: "None"),
        SettingsMetric("Consecutive Errors", job.consecutiveErrors?.toString() ?: "0"),
        SettingsMetric("Consecutive Skips", job.consecutiveSkipped?.toString() ?: "0"),
        SettingsMetric("Delivery Status", job.lastDeliveryStatus ?: "None"),
      ),
  )
  job.payloadText?.let { text ->
    CronJobTextPanel(title = cronPayloadTextTitle(job), text = text)
  }
  job.lastError?.let { text ->
    CronJobTextPanel(title = "Last Error", text = text, warning = true)
  }
  job.lastDeliveryError?.let { text ->
    CronJobTextPanel(title = "Delivery Error", text = text, warning = true)
  }
}

@Composable
private fun CronJobFieldsPanel(rows: List<SettingsMetric>) {
  val context = LocalContext.current
  ClawPanel(contentPadding = PaddingValues(horizontal = 14.dp, vertical = 4.dp)) {
    ClawSeparatedColumn(items = rows) { row ->
      val rowModifier =
        if (row.copyable) {
          Modifier
            .fillMaxWidth()
            .heightIn(min = 46.dp)
            .clickable(onClickLabel = "Copy ${row.title}") { copyCronDetailValue(context, row.title, row.value) }
            .padding(vertical = 6.dp)
        } else {
          Modifier
            .fillMaxWidth()
            .heightIn(min = 46.dp)
            .padding(vertical = 6.dp)
        }
      Row(modifier = rowModifier, horizontalArrangement = Arrangement.spacedBy(10.dp), verticalAlignment = Alignment.Top) {
        Text(text = row.title, style = ClawTheme.type.caption, color = ClawTheme.colors.textMuted, modifier = Modifier.weight(0.42f), maxLines = 2, overflow = TextOverflow.Ellipsis)
        Column(modifier = Modifier.weight(0.58f), verticalArrangement = Arrangement.spacedBy(2.dp)) {
          Row(horizontalArrangement = Arrangement.spacedBy(6.dp), verticalAlignment = Alignment.CenterVertically) {
            Text(
              text = row.value,
              style = ClawTheme.type.caption,
              color = if (row.copyable) ClawTheme.colors.primary else ClawTheme.colors.text,
              modifier = Modifier.weight(1f),
              maxLines = 3,
              overflow = TextOverflow.Ellipsis,
            )
            if (row.copyable) {
              Icon(imageVector = Icons.Default.ContentCopy, contentDescription = null, modifier = Modifier.size(14.dp), tint = ClawTheme.colors.primary)
            }
          }
          if (row.copyable) {
            Text(text = "Tap to copy", style = ClawTheme.type.caption, color = ClawTheme.colors.textMuted)
          }
        }
      }
    }
  }
}

private fun copyCronDetailValue(
  context: Context,
  title: String,
  value: String,
) {
  val clipboard = context.getSystemService(ClipboardManager::class.java) ?: return
  clipboard.setPrimaryClip(ClipData.newPlainText("OpenClaw cron job $title", value))
  Toast.makeText(context, "$title copied", Toast.LENGTH_SHORT).show()
}

@Composable
private fun CronJobTextPanel(
  title: String,
  text: String,
  warning: Boolean = false,
) {
  ClawPanel {
    Column(verticalArrangement = Arrangement.spacedBy(5.dp)) {
      Text(text = title, style = ClawTheme.type.caption, color = ClawTheme.colors.textMuted)
      Text(
        text = text,
        style = ClawTheme.type.body,
        color = if (warning) ClawTheme.colors.warning else ClawTheme.colors.text,
      )
    }
  }
}

@Composable
private fun AgentsPanel(
  agents: List<GatewayAgentSummary>,
  defaultAgentId: String?,
) {
  ClawListPanel(items = agents) { agent ->
    AgentListRow(agent = agent, isDefault = agent.id == defaultAgentId)
  }
}

@Composable
private fun AgentListRow(
  agent: GatewayAgentSummary,
  isDefault: Boolean,
) {
  ClawDetailRow(
    title = agent.name?.takeIf { it.isNotBlank() } ?: agent.id,
    subtitle = if (isDefault) "Default assistant" else "Ready",
    leading = { ClawTextBadge(text = agentBadge(agent)) },
    trailing = { ClawStatusPill(text = if (isDefault) "Default" else "Ready", status = ClawStatus.Success) },
  )
}

/**
 * Chooses a display name for the configured default agent, falling back to any available agent.
 */
private fun defaultAgentName(
  agents: List<GatewayAgentSummary>,
  defaultAgentId: String?,
): String {
  val defaultId = defaultAgentId?.trim().orEmpty()
  val agent = agents.firstOrNull { it.id == defaultId } ?: agents.firstOrNull()
  return agent?.name?.takeIf { it.isNotBlank() } ?: agent?.id ?: "None"
}

/**
 * Builds a short stable badge from agent emoji/name/id for dense lists.
 */
private fun agentBadge(agent: GatewayAgentSummary): String {
  agent.emoji
    ?.trim()
    ?.takeIf { it.isNotEmpty() }
    ?.let { return it }
  val source = agent.name?.takeIf { it.isNotBlank() } ?: agent.id
  return source
    .split(' ', '-', '_')
    .filter { it.isNotBlank() }
    .take(2)
    .mapNotNull { it.firstOrNull()?.uppercaseChar()?.toString() }
    .joinToString("")
    .ifBlank { "A" }
}

/**
 * Normalizes tool-call names into readable approval action labels.
 */
private fun approvalActionName(name: String): String {
  val cleaned =
    name
      .replace('.', ' ')
      .replace('_', ' ')
      .replace('-', ' ')
      .trim()
  return cleaned
    .split(' ')
    .filter { it.isNotBlank() }
    .joinToString(" ") { word -> word.replaceFirstChar { it.uppercaseChar() } }
    .ifBlank { "Action Request" }
}

/** Builds approval row age/error copy without exposing raw tool arguments. */
private fun approvalSubtitle(
  toolCall: ChatPendingToolCall,
  hasIssue: Boolean,
): String {
  if (hasIssue) return "Needs attention"
  val ageMs = (System.currentTimeMillis() - toolCall.startedAtMs).coerceAtLeast(0L)
  val minutes = ageMs / 60_000L
  return if (minutes < 1) "Waiting for review" else "Waiting ${minutes}m"
}

private fun execApprovalMetadata(approval: GatewayExecApprovalSummary): String {
  val target =
    when {
      approval.host == "node" && approval.nodeId != null -> "Node ${approval.nodeId.take(8)}"
      approval.host != null -> approval.host.replaceFirstChar { it.uppercaseChar() }
      else -> "Gateway"
    }
  val agent = approval.agentId?.let { "Agent ${it.take(8)}" }
  val age = approval.createdAtMs?.let { "Waiting ${formatApprovalDuration(System.currentTimeMillis() - it)}" }
  val expires = approval.expiresAtMs?.let { "Expires ${formatApprovalDuration(it - System.currentTimeMillis())}" }
  return listOfNotNull(target, agent, age, expires).joinToString(" · ")
}

private fun formatApprovalDuration(deltaMs: Long): String {
  val safeDelta = deltaMs.coerceAtLeast(0L)
  val minutes = safeDelta / 60_000L
  val hours = minutes / 60L
  return when {
    minutes < 1 -> "soon"
    hours < 1 -> "${minutes}m"
    else -> "${hours}h"
  }
}

/** Builds the dense cron-job subtitle from schedule, next wake, and prompt preview. */
private fun cronJobSubtitle(job: GatewayCronJobSummary): String = "${job.scheduleLabel} · ${formatCronWake(job.nextRunAtMs)} · ${job.promptPreview}"

/** Summarizes a provider plan and most-used quota window for usage rows. */
private fun usageProviderSubtitle(provider: GatewayUsageProviderSummary): String {
  provider.error?.let { return it }
  val window = provider.windows.maxByOrNull { it.usedPercent }
  val quota = window?.let { "${(100.0 - it.usedPercent).coerceIn(0.0, 100.0).toInt()}% left ${it.label}" }
  return listOfNotNull(provider.plan, quota).joinToString(" · ").ifBlank { "No limits reported" }
}

/**
 * Converts usage timestamps into short relative labels for metric panels.
 */
private fun formatUsageUpdated(updatedAtMs: Long?): String {
  val updated = updatedAtMs ?: return "Never"
  val deltaMs = (System.currentTimeMillis() - updated).coerceAtLeast(0L)
  val minutes = deltaMs / 60_000L
  val hours = minutes / 60L
  return when {
    minutes < 1 -> "Now"
    hours < 1 -> "${minutes}m"
    hours < 24 -> "${hours}h"
    else -> "${hours / 24L}d"
  }
}

/** Converts gateway cron status text into the short row badge label. */
private fun cronJobStatusText(job: GatewayCronJobSummary): String {
  if (!job.enabled) return "Off"
  return when (job.lastRunStatus?.lowercase()) {
    "error" -> "Issue"
    "ok" -> "OK"
    "skipped" -> "Skipped"
    else -> "Ready"
  }
}

private fun cronJobStatusText(job: GatewayCronJobDetail): String {
  if (!job.enabled) return "Off"
  return when (job.lastRunStatus?.lowercase()) {
    "error" -> "Issue"
    "ok" -> "OK"
    "skipped" -> "Skipped"
    else -> "Ready"
  }
}

/** Maps gateway cron status text to app status colors. */
private fun cronJobStatus(job: GatewayCronJobSummary): ClawStatus {
  if (!job.enabled) return ClawStatus.Neutral
  return when (job.lastRunStatus?.lowercase()) {
    "error" -> ClawStatus.Danger
    "skipped" -> ClawStatus.Warning
    else -> ClawStatus.Success
  }
}

private fun cronPayloadTextTitle(job: GatewayCronJobDetail): String =
  when (job.payloadKind) {
    "systemEvent" -> "System Event Text"
    "agentTurn" -> "Agent Prompt"
    "command" -> "Command"
    else -> "Payload Text"
  }

/** Applies query/system visibility rules while always preserving selected packages. */
internal fun filterNotificationAppsForPicker(
  apps: List<InstalledApp>,
  selectedPackages: Set<String>,
  query: String,
  showSystemApps: Boolean,
): List<InstalledApp> {
  val normalizedQuery = query.trim().lowercase()
  return apps.filter { app ->
    val selected = app.packageName in selectedPackages
    val visibleByType = showSystemApps || !app.isSystemApp || selected
    val visibleBySearch =
      normalizedQuery.isEmpty() ||
        app.label.lowercase().contains(normalizedQuery) ||
        app.packageName.lowercase().contains(normalizedQuery)
    visibleByType && visibleBySearch
  }
}

/** Summarizes allowlist/blocklist mode with an empty-state warning when needed. */
private fun notificationPackageSelectionSummary(
  mode: NotificationPackageFilterMode,
  selectedCount: Int,
): String =
  when (mode) {
    NotificationPackageFilterMode.Allowlist ->
      if (selectedCount == 0) {
        "No apps selected. Nothing forwards until you add apps."
      } else {
        "$selectedCount ${if (selectedCount == 1) "app" else "apps"} allowed to forward."
      }
    NotificationPackageFilterMode.Blocklist ->
      if (selectedCount == 0) {
        "No apps blocked. Apps can forward unless you add blocks."
      } else {
        "$selectedCount ${if (selectedCount == 1) "app" else "apps"} blocked from forwarding."
      }
  }

/** Builds compact two-letter app badges from package-picker labels. */
private fun notificationAppBadge(label: String): String {
  val initials =
    label
      .split(' ', '-', '_', '.')
      .asSequence()
      .filter { it.isNotBlank() }
      .take(2)
      .mapNotNull { it.firstOrNull()?.uppercaseChar()?.toString() }
      .joinToString("")
  return initials.ifBlank { "A" }
}

/**
 * Converts cron wake times into short relative labels for scheduled-work rows.
 */
private fun formatCronWake(timeMs: Long?): String {
  val target = timeMs ?: return "None"
  val deltaMs = target - System.currentTimeMillis()
  if (deltaMs <= 0) return "Due"
  val minutes = deltaMs / 60_000L
  val hours = minutes / 60L
  val days = hours / 24L
  return when {
    days > 0 -> "${days}d"
    hours > 0 -> "${hours}h"
    minutes > 0 -> "${minutes}m"
    else -> "Soon"
  }
}

private fun formatCronTimestamp(timeMs: Long?): String {
  val value = timeMs ?: return "None"
  return DateFormat.getDateTimeInstance(DateFormat.SHORT, DateFormat.SHORT).format(Date(value))
}

@Composable
private fun SettingsTogglePanel(rows: List<SettingsToggleRow>) {
  ClawPanel(contentPadding = PaddingValues(horizontal = 0.dp, vertical = 0.dp)) {
    ClawSeparatedColumn(items = rows) { row ->
      SettingsToggleListRow(row)
    }
  }
}

@Composable
private fun SettingsToggleListRow(row: SettingsToggleRow) {
  Row(
    modifier =
      Modifier
        .fillMaxWidth()
        .heightIn(min = 56.dp)
        .clickable { row.onCheckedChange(!row.checked) }
        .padding(horizontal = 10.dp, vertical = 6.dp),
    verticalAlignment = Alignment.CenterVertically,
    horizontalArrangement = Arrangement.spacedBy(9.dp),
  ) {
    Icon(imageVector = row.icon, contentDescription = null, modifier = Modifier.size(19.dp), tint = ClawTheme.colors.text)
    Column(modifier = Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(1.dp)) {
      Text(text = row.title, style = ClawTheme.type.body, color = ClawTheme.colors.text, maxLines = 1)
      Text(text = row.subtitle, style = ClawTheme.type.caption, color = ClawTheme.colors.textMuted, maxLines = 2, overflow = TextOverflow.Ellipsis)
    }
    Switch(checked = row.checked, onCheckedChange = row.onCheckedChange)
  }
}

/**
 * Reusable metric panel for settings screens with compact title/value rows.
 */
@Composable
internal fun SettingsMetricPanel(rows: List<SettingsMetric>) {
  ClawPanel(contentPadding = PaddingValues(horizontal = 14.dp, vertical = 4.dp)) {
    ClawSeparatedColumn(items = rows) { row ->
      Row(modifier = Modifier.fillMaxWidth().heightIn(min = 50.dp).padding(horizontal = 0.dp, vertical = 7.dp), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
        Text(
          text = row.title,
          style = ClawTheme.type.body,
          color = ClawTheme.colors.text,
          modifier = Modifier.weight(0.9f),
          maxLines = 1,
          overflow = TextOverflow.Ellipsis,
        )
        Text(
          text = row.value,
          style = ClawTheme.type.caption.copy(fontSize = 13.sp, lineHeight = 17.sp),
          color = ClawTheme.colors.textMuted,
          modifier = Modifier.weight(1.1f),
          maxLines = 1,
          overflow = TextOverflow.Ellipsis,
          textAlign = TextAlign.End,
        )
      }
    }
  }
}

@Composable
private fun SettingsIconMark(icon: ImageVector) {
  Surface(
    modifier = Modifier.size(30.dp),
    shape = CircleShape,
    color = ClawTheme.colors.surfaceRaised,
    border = BorderStroke(1.dp, ClawTheme.colors.border),
    contentColor = ClawTheme.colors.text,
  ) {
    Box(contentAlignment = Alignment.Center) {
      Icon(imageVector = icon, contentDescription = null, modifier = Modifier.size(15.dp))
    }
  }
}

/**
 * Checks an exact Android runtime permission for settings enablement.
 */
private fun hasPermission(
  context: Context,
  permission: String,
): Boolean = ContextCompat.checkSelfPermission(context, permission) == PackageManager.PERMISSION_GRANTED

/** Returns true when either fine or coarse location is available to settings callers. */
private fun hasLocationPermission(context: Context): Boolean =
  hasPermission(context, Manifest.permission.ACCESS_FINE_LOCATION) ||
    hasPermission(context, Manifest.permission.ACCESS_COARSE_LOCATION)

private fun hasBackgroundLocationPermission(context: Context): Boolean = hasPermission(context, Manifest.permission.ACCESS_BACKGROUND_LOCATION)

private fun openNotificationListenerSettings(context: Context) {
  val intent = Intent(Settings.ACTION_NOTIFICATION_LISTENER_SETTINGS).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
  context.startActivity(intent)
}

private fun openAppPermissionSettings(context: Context) {
  val intent =
    Intent(
      Settings.ACTION_APPLICATION_DETAILS_SETTINGS,
      Uri.fromParts("package", context.packageName, null),
    ).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
  context.startActivity(intent)
}
