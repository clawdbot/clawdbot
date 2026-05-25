package ai.openclaw.app.ui

import ai.openclaw.app.BuildConfig
import ai.openclaw.app.GatewayAgentSummary
import ai.openclaw.app.GatewayCronJobSummary
import ai.openclaw.app.GatewayUsageProviderSummary
import ai.openclaw.app.LocationMode
import ai.openclaw.app.MainViewModel
import ai.openclaw.app.NotificationPackageFilterMode
import ai.openclaw.app.chat.ChatPendingToolCall
import ai.openclaw.app.gateway.GatewayEndpoint
import ai.openclaw.app.node.DeviceNotificationListenerService
import ai.openclaw.app.ui.design.ClawDetailRow
import ai.openclaw.app.ui.design.ClawIconBadge
import ai.openclaw.app.ui.design.ClawListPanel
import ai.openclaw.app.ui.design.ClawPanel
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
import android.Manifest
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.media.AudioManager
import android.media.ToneGenerator
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.provider.Settings
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
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.automirrored.filled.KeyboardArrowRight
import androidx.compose.material.icons.automirrored.filled.ScreenShare
import androidx.compose.material.icons.automirrored.filled.VolumeUp
import androidx.compose.material.icons.filled.Bolt
import androidx.compose.material.icons.filled.CameraAlt
import androidx.compose.material.icons.filled.Cloud
import androidx.compose.material.icons.filled.GraphicEq
import androidx.compose.material.icons.filled.Info
import androidx.compose.material.icons.filled.LocationOn
import androidx.compose.material.icons.filled.Lock
import androidx.compose.material.icons.filled.Mic
import androidx.compose.material.icons.filled.Notifications
import androidx.compose.material.icons.filled.Palette
import androidx.compose.material.icons.filled.Person
import androidx.compose.material.icons.filled.PlayArrow
import androidx.compose.material.icons.filled.QrCode2
import androidx.compose.material.icons.filled.Storage
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.Surface
import androidx.compose.material3.Switch
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.core.content.ContextCompat

internal enum class SettingsRoute {
  Home,
  Profile,
  Voice,
  Agents,
  Approvals,
  CronJobs,
  Usage,
  Skills,
  NodesDevices,
  Channels,
  Dreaming,
  Canvas,
  Notifications,
  PhoneCapabilities,
  Gateway,
  Appearance,
  Health,
  About,
}

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
    SettingsRoute.Approvals -> ApprovalsSettingsScreen(viewModel = viewModel, onBack = onBack)
    SettingsRoute.CronJobs -> CronJobsSettingsScreen(viewModel = viewModel, onBack = onBack)
    SettingsRoute.Usage -> UsageSettingsScreen(viewModel = viewModel, onBack = onBack)
    SettingsRoute.Skills -> SkillsSettingsScreen(viewModel = viewModel, onBack = onBack)
    SettingsRoute.NodesDevices -> NodesDevicesSettingsScreen(viewModel = viewModel, onBack = onBack)
    SettingsRoute.Channels -> ChannelsSettingsScreen(viewModel = viewModel, onBack = onBack)
    SettingsRoute.Dreaming -> DreamingSettingsScreen(viewModel = viewModel, onBack = onBack)
    SettingsRoute.Canvas -> CanvasSettingsScreen(viewModel = viewModel, onBack = onBack)
    SettingsRoute.Notifications -> NotificationSettingsScreen(viewModel = viewModel, onBack = onBack)
    SettingsRoute.PhoneCapabilities -> PhoneCapabilitiesScreen(viewModel = viewModel, onBack = onBack)
    SettingsRoute.Gateway -> GatewaySettingsScreen(viewModel = viewModel, onBack = onBack)
    SettingsRoute.Appearance -> AppearanceSettingsScreen(onBack = onBack)
    SettingsRoute.Health -> HealthLogsSettingsScreen(viewModel = viewModel, onBack = onBack)
    SettingsRoute.About -> AboutSettingsScreen(viewModel = viewModel, onBack = onBack)
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
      else -> CronJobsPanel(jobs = cronJobs)
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
  val pendingToolCalls by viewModel.chatPendingToolCalls.collectAsState()
  val pendingRunCount by viewModel.pendingRunCount.collectAsState()
  val waitingCount = pendingToolCalls.count { it.isError != true }
  val issueCount = pendingToolCalls.count { it.isError == true }

  SettingsDetailFrame(title = "Approvals", subtitle = "Review actions that need your attention.", icon = Icons.Default.Lock, onBack = onBack) {
    SettingsMetricPanel(
      rows =
        listOf(
          SettingsMetric("Pending", waitingCount.toString()),
          SettingsMetric("Issues", issueCount.toString()),
          SettingsMetric("Active Runs", pendingRunCount.toString()),
        ),
    )
    if (pendingToolCalls.isEmpty()) {
      ClawPanel {
        Column(verticalArrangement = Arrangement.spacedBy(3.dp)) {
          Text(text = "Nothing needs approval.", style = ClawTheme.type.section, color = ClawTheme.colors.text)
          Text(text = "OpenClaw will show action requests here when a session pauses for review.", style = ClawTheme.type.body, color = ClawTheme.colors.textMuted)
        }
      }
    } else {
      ApprovalsPanel(toolCalls = pendingToolCalls)
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
  val micEnabled by viewModel.micEnabled.collectAsState()
  val talkModeEnabled by viewModel.talkModeEnabled.collectAsState()

  SettingsDetailFrame(title = "Talk Provider Setup", subtitle = "Configure voice, transport, and playback.", icon = Icons.Default.Mic, onBack = onBack) {
    Column(verticalArrangement = Arrangement.spacedBy(10.dp)) {
      VoiceSetupPanel(
        voiceActive = micEnabled || talkModeEnabled,
      )
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
  voiceActive: Boolean,
) {
  Column(verticalArrangement = Arrangement.spacedBy(9.dp)) {
    VoiceSetupActionRow(
      title = "Realtime Provider",
      subtitle = "Gateway voice relay",
      icon = Icons.Default.GraphicEq,
      statusText = if (voiceActive) "Live" else "Ready",
      ready = true,
    )
    VoiceSetupActionRow(
      title = "Voice",
      subtitle = "Voice input",
      icon = Icons.Default.Mic,
      statusText = "Configured",
      ready = true,
    )
    VoiceSetupActionRow(
      title = "Transport",
      subtitle = "Socket relay",
      icon = Icons.Default.Bolt,
      statusText = "Configured",
      ready = true,
    )
  }
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
      Row(modifier = Modifier.weight(1f), horizontalArrangement = Arrangement.SpaceEvenly, verticalAlignment = Alignment.CenterVertically) {
        listOf(6, 12, 18, 11, 28, 34, 18, 10, 8, 24, 38, 31, 12, 8, 18, 30, 40, 22, 12, 8, 20, 29, 16, 8).forEachIndexed { index, height ->
          Box(
            modifier =
              Modifier
                .size(width = 2.dp, height = (if (active) height else 7 + index % 4 * 4).dp)
                .background(if (active) ClawTheme.colors.text else ClawTheme.colors.textSubtle, RoundedCornerShape(999.dp)),
          )
        }
      }
    }
  }
}

private fun playVoiceSetupTone() {
  val tone = ToneGenerator(AudioManager.STREAM_MUSIC, 80)
  tone.startTone(ToneGenerator.TONE_PROP_BEEP, 250)
  Handler(Looper.getMainLooper()).postDelayed({ tone.release() }, 300L)
}

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
  }
}

@Composable
private fun PhoneCapabilitiesScreen(
  viewModel: MainViewModel,
  onBack: () -> Unit,
) {
  val context = LocalContext.current
  val cameraEnabled by viewModel.cameraEnabled.collectAsState()
  val locationMode by viewModel.locationMode.collectAsState()
  val locationPreciseEnabled by viewModel.locationPreciseEnabled.collectAsState()
  val preventSleep by viewModel.preventSleep.collectAsState()
  val canvasDebugStatusEnabled by viewModel.canvasDebugStatusEnabled.collectAsState()
  val cameraPermissionLauncher =
    rememberLauncherForActivityResult(ActivityResultContracts.RequestPermission()) { granted ->
      viewModel.setCameraEnabled(granted)
    }
  val locationPermissionLauncher =
    rememberLauncherForActivityResult(ActivityResultContracts.RequestMultiplePermissions()) { grants ->
      val granted = grants[Manifest.permission.ACCESS_FINE_LOCATION] == true || grants[Manifest.permission.ACCESS_COARSE_LOCATION] == true
      viewModel.setLocationMode(if (granted) LocationMode.WhileUsing else LocationMode.Off)
      viewModel.setLocationPreciseEnabled(grants[Manifest.permission.ACCESS_FINE_LOCATION] == true)
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
    if (mode == LocationMode.Off) {
      viewModel.setLocationMode(LocationMode.Off)
      return
    }
    if (hasLocationPermission(context)) {
      viewModel.setLocationMode(LocationMode.WhileUsing)
    } else {
      locationPermissionLauncher.launch(arrayOf(Manifest.permission.ACCESS_FINE_LOCATION, Manifest.permission.ACCESS_COARSE_LOCATION))
    }
  }

  fun setPreciseLocation(checked: Boolean) {
    if (!checked) {
      viewModel.setLocationPreciseEnabled(false)
      return
    }
    if (hasPermission(context, Manifest.permission.ACCESS_FINE_LOCATION)) {
      viewModel.setLocationPreciseEnabled(true)
      viewModel.setLocationMode(LocationMode.WhileUsing)
    } else {
      locationPermissionLauncher.launch(arrayOf(Manifest.permission.ACCESS_FINE_LOCATION, Manifest.permission.ACCESS_COARSE_LOCATION))
    }
  }

  SettingsDetailFrame(title = "Phone Capabilities", subtitle = "Choose what this phone can share.", icon = Icons.AutoMirrored.Filled.ScreenShare, onBack = onBack) {
    SettingsTogglePanel(
      rows =
        listOf(
          SettingsToggleRow("Camera", "Allow camera tools when requested.", Icons.Default.CameraAlt, cameraEnabled, ::setCameraAccess),
          SettingsToggleRow("Precise Location", "Share precise location while location is enabled.", Icons.Default.LocationOn, locationPreciseEnabled, ::setPreciseLocation),
          SettingsToggleRow("Keep Awake", "Keep the node available during active work.", Icons.Default.Bolt, preventSleep, viewModel::setPreventSleep),
          SettingsToggleRow("Canvas Status", "Show screen-sharing debug state.", Icons.AutoMirrored.Filled.ScreenShare, canvasDebugStatusEnabled, viewModel::setCanvasDebugStatusEnabled),
        ),
    )
    ClawPanel {
      Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
        Text(text = "Location", style = ClawTheme.type.section, color = ClawTheme.colors.text)
        ClawSegmentedControl(
          options = listOf("Off", "While Using"),
          selected = if (locationMode == LocationMode.WhileUsing) "While Using" else "Off",
          onSelect = { selected -> setLocationAccess(if (selected == "While Using") LocationMode.WhileUsing else LocationMode.Off) },
        )
      }
    }
  }
}

@Composable
private fun GatewaySettingsScreen(
  viewModel: MainViewModel,
  onBack: () -> Unit,
) {
  val isConnected by viewModel.isConnected.collectAsState()
  val isNodeConnected by viewModel.isNodeConnected.collectAsState()
  val statusText by viewModel.statusText.collectAsState()
  val serverName by viewModel.serverName.collectAsState()
  val remoteAddress by viewModel.remoteAddress.collectAsState()
  val manualHost by viewModel.manualHost.collectAsState()
  val manualPort by viewModel.manualPort.collectAsState()
  val manualTls by viewModel.manualTls.collectAsState()
  val savedBootstrapToken by viewModel.gatewayBootstrapToken.collectAsState()
  val savedGatewayToken by viewModel.gatewayToken.collectAsState()
  var setupCode by remember { mutableStateOf("") }
  var hostInput by remember(manualHost) { mutableStateOf(manualHost.ifBlank { "127.0.0.1" }) }
  var portInput by remember(manualPort) { mutableStateOf(manualPort.toString()) }
  var tlsInput by remember(manualTls) { mutableStateOf(manualTls) }
  var tokenInput by remember { mutableStateOf("") }
  var bootstrapTokenInput by remember { mutableStateOf("") }
  var passwordInput by remember { mutableStateOf("") }
  var validationText by remember { mutableStateOf<String?>(null) }

  SettingsDetailFrame(title = "Gateway", subtitle = "Connection between this phone and OpenClaw.", icon = Icons.Default.Cloud, onBack = onBack) {
    SettingsMetricPanel(
      rows =
        listOf(
          SettingsMetric("Connection", if (isConnected) "Connected" else "Offline"),
          SettingsMetric("Node", if (isNodeConnected) "Online" else "Not paired"),
          SettingsMetric("Gateway", serverName?.takeIf { it.isNotBlank() } ?: "Home Gateway"),
          SettingsMetric("Address", remoteAddress?.takeIf { it.isNotBlank() } ?: "Not available"),
          SettingsMetric("Status", gatewayStatusLabel(statusText = statusText, isConnected = isConnected)),
        ),
    )
    Row(modifier = Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
      ClawPrimaryButton(text = "Reconnect", onClick = viewModel::refreshGatewayConnection, modifier = Modifier.weight(1f))
      ClawSecondaryButton(text = "Disconnect", onClick = viewModel::disconnect, modifier = Modifier.weight(1f))
    }
    ClawPanel {
      Column(verticalArrangement = Arrangement.spacedBy(10.dp)) {
        Text(text = "Pair New Gateway", style = ClawTheme.type.section, color = ClawTheme.colors.text)
        Text(text = "Clear this phone's saved gateway access and scan a fresh setup code.", style = ClawTheme.type.body, color = ClawTheme.colors.textMuted)
        ClawSecondaryButton(text = "Pair New Gateway", onClick = viewModel::pairNewGateway, modifier = Modifier.fillMaxWidth(), icon = Icons.Default.QrCode2)
      }
    }
    ClawPanel {
      Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
        Text(text = "Connection Setup", style = ClawTheme.type.section, color = ClawTheme.colors.text)
        ClawTextField(value = setupCode, onValueChange = { setupCode = it }, placeholder = "Setup code")
        Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
          ClawTextField(value = hostInput, onValueChange = { hostInput = it }, placeholder = "Host", modifier = Modifier.weight(1f))
          ClawTextField(value = portInput, onValueChange = { portInput = it }, placeholder = "Port", modifier = Modifier.weight(0.55f))
        }
        ClawSegmentedControl(
          options = listOf("Local", "TLS"),
          selected = if (tlsInput) "TLS" else "Local",
          onSelect = { selected -> tlsInput = selected == "TLS" },
        )
        Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
          ClawTextField(value = tokenInput, onValueChange = { tokenInput = it }, placeholder = "Token", modifier = Modifier.weight(1f))
          ClawTextField(value = bootstrapTokenInput, onValueChange = { bootstrapTokenInput = it }, placeholder = "Bootstrap", modifier = Modifier.weight(1f))
        }
        ClawTextField(value = passwordInput, onValueChange = { passwordInput = it }, placeholder = "Password")
        validationText?.let {
          Text(text = it, style = ClawTheme.type.caption, color = ClawTheme.colors.warning)
        }
        ClawPrimaryButton(
          text = "Save & Connect",
          onClick = {
            val setup = setupCode.trim().takeIf { it.isNotEmpty() }?.let(::decodeGatewaySetupCode)
            val endpointConfig =
              if (setup != null) {
                parseGatewayEndpointResult(setup.url).config
              } else {
                composeGatewayManualUrl(hostInput, portInput, tlsInput)?.let { parseGatewayEndpointResult(it).config }
              }
            if (endpointConfig == null) {
              validationText = "Enter a valid setup code or gateway address."
              return@ClawPrimaryButton
            }
            val bootstrapToken =
              setup
                ?.bootstrapToken
                ?.trim()
                .orEmpty()
                .ifEmpty { bootstrapTokenInput.trim().ifEmpty { savedBootstrapToken } }
            val token =
              setup
                ?.token
                ?.trim()
                .orEmpty()
                .ifEmpty { tokenInput.trim().ifEmpty { if (bootstrapToken.isBlank()) savedGatewayToken else "" } }
            val password =
              setup
                ?.password
                ?.trim()
                .orEmpty()
                .ifEmpty { passwordInput.trim() }
            validationText = null
            viewModel.setManualEnabled(true)
            viewModel.setManualHost(endpointConfig.host)
            viewModel.setManualPort(endpointConfig.port)
            viewModel.setManualTls(endpointConfig.tls)
            viewModel.setGatewayBootstrapToken(bootstrapToken)
            viewModel.setGatewayToken(token)
            viewModel.setGatewayPassword(password)
            viewModel.connect(
              GatewayEndpoint.manual(host = endpointConfig.host, port = endpointConfig.port),
              token = token.ifEmpty { null },
              bootstrapToken = bootstrapToken.ifEmpty { null },
              password = password.ifEmpty { null },
            )
          },
          modifier = Modifier.fillMaxWidth(),
        )
      }
    }
  }
}

@Composable
private fun AppearanceSettingsScreen(onBack: () -> Unit) {
  SettingsDetailFrame(title = "Appearance", subtitle = "A calm, high-contrast OpenClaw interface.", icon = Icons.Default.Palette, onBack = onBack) {
    SettingsMetricPanel(
      rows =
        listOf(
          SettingsMetric("Theme", "Dark"),
          SettingsMetric("Contrast", "High"),
          SettingsMetric("Typography", "Readable"),
        ),
    )
    ClawPanel {
      Text(text = "OpenClaw uses a fixed premium dark theme so it stays consistent across devices.", style = ClawTheme.type.body, color = ClawTheme.colors.textMuted)
    }
  }
}

private fun gatewayStatusLabel(
  statusText: String,
  isConnected: Boolean,
): String {
  if (isConnected) return "Ready"
  val status = statusText.trim().lowercase()
  return when {
    status.contains("connecting") || status.contains("reconnecting") -> "Connecting..."
    status.contains("pair") -> "Pairing needed"
    status.contains("auth") -> "Authentication needed"
    status.contains("certificate") || status.contains("tls") -> "Certificate review needed"
    status.contains("failed") || status.contains("error") || status.contains("offline") || status.contains("not connected") -> "Cannot reach gateway"
    status.isBlank() -> "Not connected"
    else -> "Not connected"
  }
}

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
    SettingsMetricPanel(
      rows =
        listOf(
          SettingsMetric("Android App", BuildConfig.VERSION_NAME),
          SettingsMetric("Build", BuildConfig.VERSION_CODE.toString()),
          SettingsMetric("Channel", "Play"),
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
  }
}

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

private fun aboutUpdateText(latestVersion: String?): String =
  if (latestVersion == null) {
    "OpenClaw turns this phone into a clean mobile command surface for sessions, voice, providers, and Gateway."
  } else {
    "A Gateway update is available. Run the update from the Web UI or CLI when you are ready."
  }

@Composable
internal fun SettingsDetailFrame(
  title: String,
  subtitle: String,
  icon: ImageVector,
  onBack: () -> Unit,
  content: @Composable () -> Unit,
) {
  ClawScaffold(contentPadding = PaddingValues(start = ClawTheme.spacing.lg, top = 14.dp, end = ClawTheme.spacing.lg, bottom = 20.dp)) {
    LazyColumn(verticalArrangement = Arrangement.spacedBy(10.dp)) {
      item {
        Row(modifier = Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(9.dp)) {
          SettingsBackButton(onClick = onBack)
          Text(text = title, style = ClawTheme.type.title, color = ClawTheme.colors.text, modifier = Modifier.weight(1f), maxLines = 1, overflow = TextOverflow.Ellipsis)
          SettingsIconMark(icon = icon)
        }
      }
      item {
        Text(text = subtitle, style = ClawTheme.type.body, color = ClawTheme.colors.textMuted)
      }
      item {
        Column(verticalArrangement = Arrangement.spacedBy(12.dp)) {
          content()
        }
      }
      item {
        Spacer(modifier = Modifier.height(12.dp))
      }
    }
  }
}

private data class SettingsToggleRow(
  val title: String,
  val subtitle: String,
  val icon: ImageVector,
  val checked: Boolean,
  val onCheckedChange: (Boolean) -> Unit,
)

internal data class SettingsMetric(
  val title: String,
  val value: String,
)

@Composable
private fun ApprovalsPanel(toolCalls: List<ChatPendingToolCall>) {
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
private fun CronJobsPanel(jobs: List<GatewayCronJobSummary>) {
  ClawListPanel(items = jobs) { job ->
    CronJobListRow(job = job)
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
private fun CronJobListRow(job: GatewayCronJobSummary) {
  ClawDetailRow(
    title = job.name,
    subtitle = cronJobSubtitle(job),
    leading = { ClawIconBadge(icon = Icons.Default.Bolt) },
    trailing = { ClawStatusPill(text = cronJobStatusText(job), status = cronJobStatus(job)) },
  )
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

private fun defaultAgentName(
  agents: List<GatewayAgentSummary>,
  defaultAgentId: String?,
): String {
  val defaultId = defaultAgentId?.trim().orEmpty()
  val agent = agents.firstOrNull { it.id == defaultId } ?: agents.firstOrNull()
  return agent?.name?.takeIf { it.isNotBlank() } ?: agent?.id ?: "None"
}

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

private fun approvalSubtitle(
  toolCall: ChatPendingToolCall,
  hasIssue: Boolean,
): String {
  if (hasIssue) return "Needs attention"
  val ageMs = (System.currentTimeMillis() - toolCall.startedAtMs).coerceAtLeast(0L)
  val minutes = ageMs / 60_000L
  return if (minutes < 1) "Waiting for review" else "Waiting ${minutes}m"
}

private fun cronJobSubtitle(job: GatewayCronJobSummary): String = "${job.scheduleLabel} · ${formatCronWake(job.nextRunAtMs)} · ${job.promptPreview}"

private fun usageProviderSubtitle(provider: GatewayUsageProviderSummary): String {
  provider.error?.let { return it }
  val window = provider.windows.maxByOrNull { it.usedPercent }
  val quota = window?.let { "${(100.0 - it.usedPercent).coerceIn(0.0, 100.0).toInt()}% left ${it.label}" }
  return listOfNotNull(provider.plan, quota).joinToString(" · ").ifBlank { "No limits reported" }
}

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

private fun cronJobStatusText(job: GatewayCronJobSummary): String {
  if (!job.enabled) return "Off"
  return when (job.lastRunStatus?.lowercase()) {
    "error" -> "Issue"
    "ok" -> "OK"
    "skipped" -> "Skipped"
    else -> "Ready"
  }
}

private fun cronJobStatus(job: GatewayCronJobSummary): ClawStatus {
  if (!job.enabled) return ClawStatus.Neutral
  return when (job.lastRunStatus?.lowercase()) {
    "error" -> ClawStatus.Danger
    "skipped" -> ClawStatus.Warning
    else -> ClawStatus.Success
  }
}

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

@Composable
internal fun SettingsMetricPanel(rows: List<SettingsMetric>) {
  ClawPanel(contentPadding = PaddingValues(horizontal = 14.dp, vertical = 4.dp)) {
    ClawSeparatedColumn(items = rows) { row ->
      Row(modifier = Modifier.fillMaxWidth().heightIn(min = 50.dp).padding(horizontal = 0.dp, vertical = 7.dp), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
        Text(text = row.title, style = ClawTheme.type.body, color = ClawTheme.colors.text, modifier = Modifier.weight(1f), maxLines = 1)
        Text(text = row.value, style = ClawTheme.type.caption.copy(fontSize = 13.sp, lineHeight = 17.sp), color = ClawTheme.colors.textMuted, maxLines = 1, overflow = TextOverflow.Ellipsis)
      }
    }
  }
}

@Composable
private fun SettingsBackButton(onClick: () -> Unit) {
  Surface(onClick = onClick, modifier = Modifier.size(ClawTheme.spacing.touchTarget), shape = CircleShape, color = Color.Transparent, contentColor = ClawTheme.colors.text) {
    Box(contentAlignment = Alignment.Center) {
      Icon(imageVector = Icons.AutoMirrored.Filled.ArrowBack, contentDescription = "Back", modifier = Modifier.size(18.dp))
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

private fun hasPermission(
  context: Context,
  permission: String,
): Boolean = ContextCompat.checkSelfPermission(context, permission) == PackageManager.PERMISSION_GRANTED

private fun hasLocationPermission(context: Context): Boolean =
  hasPermission(context, Manifest.permission.ACCESS_FINE_LOCATION) ||
    hasPermission(context, Manifest.permission.ACCESS_COARSE_LOCATION)

private fun openNotificationListenerSettings(context: Context) {
  val intent = Intent(Settings.ACTION_NOTIFICATION_LISTENER_SETTINGS).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
  context.startActivity(intent)
}
