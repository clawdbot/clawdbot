package ai.openclaw.app.ui

import ai.openclaw.app.AndroidLicenseNotice
import ai.openclaw.app.AppLanguage
import ai.openclaw.app.AppearanceThemeMode
import ai.openclaw.app.BuildConfig
import ai.openclaw.app.CronEditorDraftState
import ai.openclaw.app.GatewayAgentSummary
import ai.openclaw.app.GatewayConnectionDisplay
import ai.openclaw.app.GatewayConnectionProblem
import ai.openclaw.app.GatewayCronActionState
import ai.openclaw.app.GatewayCronJobDetail
import ai.openclaw.app.GatewayCronJobDetailState
import ai.openclaw.app.GatewayCronJobEdit
import ai.openclaw.app.GatewayCronJobSummary
import ai.openclaw.app.GatewayCronRunHistoryState
import ai.openclaw.app.GatewayExecApprovalNotice
import ai.openclaw.app.GatewayExecApprovalSummary
import ai.openclaw.app.GatewayTalkSetupReadiness
import ai.openclaw.app.GatewayTalkSetupState
import ai.openclaw.app.GatewayUsageProviderSummary
import ai.openclaw.app.LocationMode
import ai.openclaw.app.MainViewModel
import ai.openclaw.app.NotificationPackageFilterMode
import ai.openclaw.app.SensitiveFeatureConfig
import ai.openclaw.app.VoiceCaptureMode
import ai.openclaw.app.appLanguageRowSubtitle
import ai.openclaw.app.chat.ChatPendingToolCall
import ai.openclaw.app.currentAppLanguage
import ai.openclaw.app.currentSystemLanguageTag
import ai.openclaw.app.gateway.GatewayEndpoint
import ai.openclaw.app.gateway.GatewayRegistryEntryKind
import ai.openclaw.app.gatewayExecApprovalTextForDisplay
import ai.openclaw.app.gatewayTalkSetupDescription
import ai.openclaw.app.gatewayTalkSetupStatusText
import ai.openclaw.app.hasPhotoReadPermission
import ai.openclaw.app.i18n.nativeString
import ai.openclaw.app.i18n.resolveNativeText
import ai.openclaw.app.i18n.resolveNativeTextResource
import ai.openclaw.app.isReady
import ai.openclaw.app.loadAndroidLicenseNotices
import ai.openclaw.app.locationModeAfterBackgroundSettings
import ai.openclaw.app.node.DeviceNotificationListenerService
import ai.openclaw.app.photoReadPermissionsForRequest
import ai.openclaw.app.reconcileRestoredAction
import ai.openclaw.app.setAppLanguage
import ai.openclaw.app.ui.design.ClawAgentAvatar
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
import ai.openclaw.app.ui.design.agentAvatarSource
import ai.openclaw.app.uppercaseFirstGraphemeOrNull
import ai.openclaw.app.voice.AudioInputDeviceOption
import ai.openclaw.app.voice.VoiceWakePreferences
import ai.openclaw.app.voice.audioInputDeviceOptionFromKey
import android.Manifest
import android.content.ClipData
import android.content.ClipboardManager
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.media.AudioDeviceInfo
import android.media.AudioManager
import android.media.ToneGenerator
import android.net.Uri
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.provider.Settings
import android.widget.Toast
import androidx.activity.compose.BackHandler
import androidx.activity.compose.LocalActivity
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
import androidx.compose.foundation.text.selection.SelectionContainer
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.automirrored.filled.KeyboardArrowRight
import androidx.compose.material.icons.automirrored.filled.OpenInNew
import androidx.compose.material.icons.automirrored.filled.ScreenShare
import androidx.compose.material.icons.automirrored.filled.VolumeUp
import androidx.compose.material.icons.filled.Add
import androidx.compose.material.icons.filled.Bolt
import androidx.compose.material.icons.filled.CameraAlt
import androidx.compose.material.icons.filled.Check
import androidx.compose.material.icons.filled.Close
import androidx.compose.material.icons.filled.Cloud
import androidx.compose.material.icons.filled.ContentCopy
import androidx.compose.material.icons.filled.Delete
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
import androidx.compose.ui.platform.LocalConfiguration
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
  SystemAgent,
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
    SettingsRoute.SystemAgent -> SystemAgentSettingsScreen(viewModel = viewModel, onBack = onBack)
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

  SettingsDetailFrame(title = nativeString("Usage"), subtitle = nativeString("Provider limits and quota health."), icon = Icons.Default.Storage, onBack = onBack) {
    SettingsMetricPanel(
      rows =
        listOf(
          SettingsMetric(nativeString("Providers"), providerCount.toString()),
          SettingsMetric(nativeString("Issues"), issueCount.toString()),
          SettingsMetric(nativeString("Updated"), formatUsageUpdated(usageSummary.updatedAtMs)),
        ),
    )
    Row(modifier = Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
      ClawSecondaryButton(text = if (usageRefreshing) nativeString("Refreshing") else nativeString("Refresh"), onClick = viewModel::refreshUsage, enabled = isConnected && !usageRefreshing, modifier = Modifier.weight(1f))
    }
    usageErrorText?.let { errorText ->
      ClawPanel {
        Text(text = errorText, style = ClawTheme.type.body, color = ClawTheme.colors.warning)
      }
    }
    when {
      !isConnected ->
        ClawPanel {
          Text(text = nativeString("Connect the gateway to load usage."), style = ClawTheme.type.body, color = ClawTheme.colors.textMuted)
        }
      usageSummary.providers.isEmpty() ->
        ClawPanel {
          Column(verticalArrangement = Arrangement.spacedBy(3.dp)) {
            Text(text = nativeString("No usage data yet."), style = ClawTheme.type.section, color = ClawTheme.colors.text)
            Text(text = nativeString("Provider limits will appear here when your gateway reports them."), style = ClawTheme.type.body, color = ClawTheme.colors.textMuted)
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
  var query by rememberSaveable { mutableStateOf("") }
  var filterName by rememberSaveable { mutableStateOf(CronJobsListFilter.All.name) }
  val filter = CronJobsListFilter.valueOf(filterName)
  val visibleJobs = filterCronJobs(cronJobs, query, filter)
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

  SettingsDetailFrame(title = nativeString("Automations"), subtitle = nativeString("Scheduled OpenClaw work from your gateway."), icon = Icons.Default.Bolt, onBack = onBack) {
    SettingsMetricPanel(
      rows =
        listOf(
          SettingsMetric(nativeString("Status"), if (cronStatus.enabled) nativeString("Enabled") else nativeString("Off")),
          SettingsMetric(nativeString("Automations"), cronStatus.jobs.toString()),
          SettingsMetric(nativeString("Next Wake"), formatCronWake(cronStatus.nextWakeAtMs)),
        ),
    )
    ClawSecondaryButton(text = if (cronRefreshing) nativeString("Refreshing") else nativeString("Refresh"), onClick = viewModel::refreshCronJobs, enabled = isConnected && !cronRefreshing, modifier = Modifier.fillMaxWidth())
    ClawTextField(
      value = query,
      onValueChange = { query = it },
      placeholder = nativeString("Search automations"),
      label = nativeString("Search"),
      enabled = isConnected,
    )
    val filterOptions = CronJobsListFilter.entries.map(CronJobsListFilter::label)
    ClawSegmentedControl(
      options = filterOptions,
      selected = filter.label,
      onSelect = { selected ->
        CronJobsListFilter.entries.firstOrNull { it.label == selected }?.let {
          filterName = it.name
        }
      },
      modifier = Modifier.fillMaxWidth(),
      enabledOptions = if (isConnected) filterOptions.toSet() else emptySet(),
    )
    ClawPanel {
      Text(text = nativeString("Open an automation to inspect its configuration and run history. Admin-scoped connections can also run, edit, enable, disable, or delete it."), style = ClawTheme.type.body, color = ClawTheme.colors.textMuted)
    }
    cronErrorText?.let { errorText ->
      ClawPanel {
        Text(text = errorText, style = ClawTheme.type.body, color = ClawTheme.colors.warning)
      }
    }
    when {
      !isConnected ->
        ClawPanel {
          Text(text = nativeString("Connect the gateway to load automations."), style = ClawTheme.type.body, color = ClawTheme.colors.textMuted)
        }
      cronJobs.isEmpty() ->
        ClawPanel {
          Column(verticalArrangement = Arrangement.spacedBy(3.dp)) {
            Text(text = nativeString("No automations yet."), style = ClawTheme.type.section, color = ClawTheme.colors.text)
            Text(text = nativeString("Scheduled work created on the gateway will appear here."), style = ClawTheme.type.body, color = ClawTheme.colors.textMuted)
          }
        }
      visibleJobs.isEmpty() ->
        ClawPanel {
          Text(text = nativeString("No matching automations."), style = ClawTheme.type.body, color = ClawTheme.colors.textMuted)
        }
      else -> CronJobsPanel(jobs = visibleJobs, onJobClick = { selectedJobId = it.id })
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
  fun leaveDetail() {
    viewModel.cronEditorDraftMemory.clear(jobId)
    viewModel.dismissCronActionNotice(jobId)
    onBack()
  }
  BackHandler(onBack = ::leaveDetail)

  val detailState by viewModel.cronJobDetailState.collectAsState()
  val historyState by viewModel.cronRunHistoryState.collectAsState()
  val actionState by viewModel.cronActionState.collectAsState()
  val pendingCronRunJobIds by viewModel.pendingCronRunJobIds.collectAsState()
  val operatorAdminScopeAvailable by viewModel.operatorAdminScopeAvailable.collectAsState()
  val isConnected by viewModel.isConnected.collectAsState()
  val activity = LocalActivity.current

  DisposableEffect(activity, viewModel, jobId) {
    onDispose {
      viewModel.clearCronJobDetail()
      if (cronDetailDisposalClearsTransientState(activity?.isChangingConfigurations == true)) {
        viewModel.cronEditorDraftMemory.clear(jobId)
        viewModel.dismissCronActionNotice(jobId)
      }
    }
  }

  LaunchedEffect(isConnected, jobId) {
    if (isConnected) {
      viewModel.loadCronJobDetail(jobId)
    }
  }

  val current = (detailState as? GatewayCronJobDetailState.Loaded)?.job?.takeIf { it.id == jobId }
  var editorDraft by remember(viewModel, jobId) {
    mutableStateOf(viewModel.cronEditorDraftMemory.get(jobId))
  }
  var restoredDraftNeedsActionCheck by remember(viewModel, jobId) {
    mutableStateOf(editorDraft?.savePending == true)
  }

  fun updateEditorDraft(value: CronEditorDraftState?) {
    editorDraft = value
    viewModel.cronEditorDraftMemory.set(jobId, value)
  }
  LaunchedEffect(isConnected, actionState, restoredDraftNeedsActionCheck) {
    if (restoredDraftNeedsActionCheck) {
      updateEditorDraft(
        editorDraft?.reconcileRestoredAction(
          isConnected = isConnected,
          jobId = jobId,
          actionState = actionState,
        ),
      )
      restoredDraftNeedsActionCheck = false
    }
  }
  LaunchedEffect(isConnected) {
    if (!isConnected) updateEditorDraft(editorDraft?.saveAborted())
  }
  LaunchedEffect(current) {
    current?.let { job ->
      updateEditorDraft(editorDraft?.observeJob(job) ?: CronEditorDraftState.from(job))
    }
  }
  LaunchedEffect(actionState, current) {
    val notice = actionState as? GatewayCronActionState.Notice
    if (notice?.id == jobId) {
      val observed = editorDraft?.observeSaveNotice(notice.kind)
      updateEditorDraft(
        current?.let { job ->
          observed?.observeJob(job) ?: CronEditorDraftState.from(job)
        } ?: observed,
      )
    }
  }
  val loading = (detailState as? GatewayCronJobDetailState.Loading)?.id == jobId
  val errorText = (detailState as? GatewayCronJobDetailState.Error)?.takeIf { it.id == jobId }?.message
  val deleted =
    (actionState as? GatewayCronActionState.Notice)
      ?.takeIf { it.id == jobId }
      ?.deleted == true

  LaunchedEffect(deleted) {
    if (deleted) leaveDetail()
  }
  SettingsDetailFrame(
    title = current?.name ?: jobName ?: nativeString("Automation"),
    subtitle = nativeString("Inspect and manage scheduled gateway work."),
    icon = Icons.Default.Bolt,
    onBack = ::leaveDetail,
  ) {
    ClawSecondaryButton(
      text = if (loading) nativeString("Refreshing") else nativeString("Refresh"),
      onClick = { viewModel.loadCronJobDetail(jobId) },
      enabled =
        cronDetailRefreshEnabled(
          isConnected = isConnected,
          loading = loading,
          hasCurrentJob = current != null,
          draftRequiresResolution = editorDraft?.requiresResolution == true,
          saveSucceeded = editorDraft?.saveSucceeded == true,
        ),
      modifier = Modifier.fillMaxWidth(),
    )

    when {
      !isConnected ->
        ClawPanel {
          Text(text = nativeString("Connect the gateway to inspect automations."), style = ClawTheme.type.body, color = ClawTheme.colors.textMuted)
        }
      errorText != null ->
        ClawPanel {
          Text(text = errorText.resolveNativeTextResource(), style = ClawTheme.type.body, color = ClawTheme.colors.warning)
        }
      current == null ->
        ClawPanel {
          Text(text = if (loading) nativeString("Loading automation…") else nativeString("Automation not loaded."), style = ClawTheme.type.body, color = ClawTheme.colors.textMuted)
        }
      else ->
        CronJobDetailPanel(
          job = current,
          editorDraft = editorDraft ?: CronEditorDraftState.from(current),
          onEditorDraftChange = ::updateEditorDraft,
          historyState = historyState,
          actionState = actionState,
          runPending = jobId in pendingCronRunJobIds,
          operatorAdminScopeAvailable = operatorAdminScopeAvailable,
          onRun = { viewModel.runCronJob(current.id) },
          onToggleEnabled = {
            viewModel.setCronJobEnabled(id = current.id, enabled = !current.enabled)
          },
          onSave = { edit -> viewModel.updateCronJob(original = current, edit = edit) },
          onRefreshHistory = { viewModel.refreshCronRunHistory(current.id) },
          onDelete = { viewModel.deleteCronJob(current.id) },
        )
    }
  }
}

internal fun cronDetailRefreshEnabled(
  isConnected: Boolean,
  loading: Boolean,
  hasCurrentJob: Boolean,
  draftRequiresResolution: Boolean,
  saveSucceeded: Boolean,
): Boolean =
  isConnected &&
    !loading &&
    (!hasCurrentJob || !draftRequiresResolution || saveSucceeded)

internal fun cronDetailDisposalClearsTransientState(isChangingConfigurations: Boolean): Boolean = !isChangingConfigurations

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

  SettingsDetailFrame(title = nativeString("Agents"), subtitle = nativeString("Choose and inspect the assistants available on this gateway."), icon = Icons.Default.Person, onBack = onBack) {
    SettingsMetricPanel(
      rows =
        listOf(
          SettingsMetric(nativeString("Available"), agents.size.toString()),
          SettingsMetric(nativeString("Default"), defaultAgentName(agents, defaultAgentId)),
        ),
    )
    when {
      !isConnected ->
        ClawPanel {
          Text(text = nativeString("Connect the gateway to load agents."), style = ClawTheme.type.body, color = ClawTheme.colors.textMuted)
        }
      agents.isEmpty() ->
        ClawPanel {
          Text(text = nativeString("No agents loaded yet."), style = ClawTheme.type.body, color = ClawTheme.colors.textMuted)
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
  val execApprovalsNotice by viewModel.execApprovalsNotice.collectAsState()
  val pendingToolCalls by viewModel.chatPendingToolCalls.collectAsState()
  val pendingRunCount by viewModel.pendingRunCount.collectAsState()
  val issueCount = execApprovals.count { it.errorText != null } + pendingToolCalls.count { it.isError == true }

  LaunchedEffect(isConnected) {
    if (isConnected) {
      viewModel.refreshExecApprovals()
    }
  }

  SettingsDetailFrame(title = nativeString("Approvals"), subtitle = nativeString("Review actions that need your attention."), icon = Icons.Default.Lock, onBack = onBack) {
    SettingsMetricPanel(
      rows =
        listOf(
          SettingsMetric(nativeString("Gateway Pending"), execApprovals.size.toString()),
          SettingsMetric(nativeString("Thread Activity"), pendingToolCalls.size.toString()),
          SettingsMetric(nativeString("Issues"), issueCount.toString()),
          SettingsMetric(nativeString("Active Runs"), pendingRunCount.toString()),
        ),
    )
    ClawSecondaryButton(
      text = if (execApprovalsRefreshing) nativeString("Refreshing") else nativeString("Refresh"),
      onClick = viewModel::refreshExecApprovals,
      enabled = isConnected && !execApprovalsRefreshing,
      modifier = Modifier.fillMaxWidth(),
    )
    if (execApprovalsErrorText != null) {
      ClawPanel {
        Text(text = gatewayExecApprovalTextForDisplay(execApprovalsErrorText ?: ""), style = ClawTheme.type.body, color = ClawTheme.colors.warning)
      }
    }
    // Terminal outcomes always retire their card first, so the notice renders as a
    // standalone banner above the list; it stays visible until the user dismisses it.
    execApprovalsNotice?.let { notice ->
      ExecApprovalNotice(notice = notice, onDismiss = { viewModel.dismissExecApprovalsNotice(notice) })
    }
    if (!isConnected) {
      ClawPanel {
        Column(verticalArrangement = Arrangement.spacedBy(3.dp)) {
          Text(text = nativeString("Gateway disconnected."), style = ClawTheme.type.section, color = ClawTheme.colors.text)
          Text(text = nativeString("Connect the gateway to load approval requests in the app."), style = ClawTheme.type.body, color = ClawTheme.colors.textMuted)
        }
      }
    } else if (execApprovals.isEmpty()) {
      ClawPanel {
        Column(verticalArrangement = Arrangement.spacedBy(3.dp)) {
          Text(text = nativeString("No gateway approvals."), style = ClawTheme.type.section, color = ClawTheme.colors.text)
          Text(text = nativeString("Exec approval requests will appear here while this phone is connected."), style = ClawTheme.type.body, color = ClawTheme.colors.textMuted)
        }
      }
    } else {
      ExecApprovalsPanel(
        approvals = execApprovals,
        onResolve = viewModel::resolveExecApproval,
      )
    }
    if (pendingToolCalls.isNotEmpty()) {
      Text(text = nativeString("Thread activity"), style = ClawTheme.type.section, color = ClawTheme.colors.text)
      Text(text = nativeString("Chat tool calls waiting in the active thread remain visible here."), style = ClawTheme.type.caption, color = ClawTheme.colors.textMuted)
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

  SettingsDetailFrame(title = nativeString("Profile"), subtitle = nativeString("How this phone appears to OpenClaw."), icon = Icons.Default.Person, onBack = onBack) {
    ClawPanel {
      Column(verticalArrangement = Arrangement.spacedBy(9.dp)) {
        ClawTextField(value = draft, onValueChange = { draft = it }, placeholder = nativeString("Device name"))
        ClawPrimaryButton(text = nativeString("Save Profile"), onClick = { viewModel.setDisplayName(draft) }, enabled = draft.isNotBlank())
      }
    }
  }
}

@Composable
private fun VoiceSettingsScreen(
  viewModel: MainViewModel,
  onBack: () -> Unit,
) {
  val context = LocalContext.current
  val speakerEnabled by viewModel.speakerEnabled.collectAsState()
  val preferredAudioInputDevice by viewModel.preferredAudioInputDevice.collectAsState()
  val voiceCaptureMode by viewModel.voiceCaptureMode.collectAsState()
  val activeAudioInputDevicePreference by viewModel.activeAudioInputDevicePreference.collectAsState()
  val isConnected by viewModel.isConnected.collectAsState()
  val talkSetupReadiness by viewModel.talkSetupReadiness.collectAsState()
  val voiceWakeEnabled by viewModel.voiceWakeEnabled.collectAsState()
  val voiceWakeAvailable by viewModel.voiceWakeAvailable.collectAsState()
  val voiceWakeIsListening by viewModel.voiceWakeIsListening.collectAsState()
  val voiceWakeStatusText by viewModel.voiceWakeStatusText.collectAsState()
  val voiceWakeWords by viewModel.voiceWakeWords.collectAsState()
  val voiceWakeLastCommand by viewModel.voiceWakeLastTriggeredCommand.collectAsState()
  val voiceWakeWordsSaving by viewModel.voiceWakeWordsSaving.collectAsState()
  val voiceWakeWordsNoticeText by viewModel.voiceWakeWordsNoticeText.collectAsState()
  var wakeWordDrafts by remember(voiceWakeWords) {
    mutableStateOf(voiceWakeWords)
  }
  var audioInputDevices by remember { mutableStateOf<List<AudioInputDeviceOption>>(emptyList()) }
  val audioInputDevicePending =
    voiceCaptureMode != VoiceCaptureMode.Off && preferredAudioInputDevice != activeAudioInputDevicePreference

  val microphonePermissionLauncher =
    rememberLauncherForActivityResult(ActivityResultContracts.RequestPermission()) { granted ->
      viewModel.refreshVoiceWakePermission()
      if (granted) viewModel.setVoiceWakeEnabled(true)
    }

  fun setVoiceWake(checked: Boolean) {
    if (!checked) {
      viewModel.setVoiceWakeEnabled(false)
    } else if (hasPermission(context, Manifest.permission.RECORD_AUDIO)) {
      viewModel.refreshVoiceWakePermission()
      viewModel.setVoiceWakeEnabled(true)
    } else {
      microphonePermissionLauncher.launch(Manifest.permission.RECORD_AUDIO)
    }
  }

  LaunchedEffect(isConnected) {
    if (isConnected) viewModel.refreshTalkSetupReadiness()
  }

  DisposableEffect(viewModel) {
    val observer = viewModel.observeAudioInputDevices { devices -> audioInputDevices = devices }
    onDispose { observer.close() }
  }

  SettingsDetailFrame(title = nativeString("Voice"), subtitle = nativeString("Configure wake words, talk, and playback."), icon = Icons.Default.Mic, onBack = onBack) {
    Column(verticalArrangement = Arrangement.spacedBy(10.dp)) {
      Text(text = nativeString("Voice Wake"), style = ClawTheme.type.section, color = ClawTheme.colors.text)
      SettingsTogglePanel(
        rows =
          listOf(
            SettingsToggleRow(
              title = nativeString("Listen for wake words"),
              subtitle =
                if (voiceWakeAvailable) {
                  nativeString("Runs on-device while OpenClaw is visible.")
                } else {
                  nativeString("On-device speech recognition is unavailable.")
                },
              icon = Icons.Default.Mic,
              checked = voiceWakeEnabled,
              onCheckedChange = ::setVoiceWake,
              enabled = voiceWakeAvailable || voiceWakeEnabled,
            ),
          ),
      )
      VoiceSetupActionRow(
        title = nativeString("Wake listener"),
        subtitle =
          voiceWakeLastCommand?.let { command -> nativeString("Last command: \$command", command) }
            ?: nativeString("Pauses during other voice activity."),
        icon = Icons.Default.GraphicEq,
        statusText = voiceWakeStatusText,
        ready = voiceWakeIsListening,
      )
      ClawPanel {
        Column(verticalArrangement = Arrangement.spacedBy(9.dp)) {
          Text(text = nativeString("Wake words"), style = ClawTheme.type.section, color = ClawTheme.colors.text)
          Text(
            text = nativeString("Add one wake word or phrase per field. Then say one before your command."),
            style = ClawTheme.type.body,
            color = ClawTheme.colors.textMuted,
          )
          wakeWordDrafts.forEachIndexed { index, value ->
            Row(
              modifier = Modifier.fillMaxWidth(),
              verticalAlignment = Alignment.CenterVertically,
              horizontalArrangement = Arrangement.spacedBy(4.dp),
            ) {
              ClawTextField(
                value = value,
                onValueChange = { updated ->
                  wakeWordDrafts = wakeWordDrafts.toMutableList().also { it[index] = updated }
                },
                placeholder = nativeString("Wake word or phrase"),
                enabled = voiceWakeAvailable && !voiceWakeWordsSaving,
                modifier = Modifier.weight(1f),
              )
              if (voiceWakeAvailable && !voiceWakeWordsSaving && wakeWordDrafts.size > 1) {
                ClawPlainIconButton(
                  icon = Icons.Default.Delete,
                  contentDescription = nativeString("Remove wake phrase"),
                  onClick = {
                    wakeWordDrafts = wakeWordDrafts.filterIndexed { draftIndex, _ -> draftIndex != index }
                  },
                )
              }
            }
          }
          ClawSecondaryButton(
            text = nativeString("Add wake phrase"),
            onClick = { wakeWordDrafts = wakeWordDrafts + "" },
            enabled = voiceWakeAvailable && !voiceWakeWordsSaving && wakeWordDrafts.size < VoiceWakePreferences.maxWords,
            icon = Icons.Default.Add,
            modifier = Modifier.fillMaxWidth(),
          )
          ClawSecondaryButton(
            text = if (voiceWakeWordsSaving) nativeString("Saving…") else nativeString("Save wake words"),
            onClick = { viewModel.setVoiceWakeWords(wakeWordDrafts) },
            enabled = voiceWakeAvailable && isConnected && !voiceWakeWordsSaving && wakeWordDrafts.any(String::isNotBlank),
            modifier = Modifier.fillMaxWidth(),
          )
          (voiceWakeWordsNoticeText ?: if (!isConnected) nativeString("Connect to a Gateway to save wake words") else null)?.let { notice ->
            Text(text = notice, style = ClawTheme.type.caption, color = ClawTheme.colors.textMuted)
          }
        }
      }
      Text(text = nativeString("Talk Provider Setup"), style = ClawTheme.type.section, color = ClawTheme.colors.text)
      VoiceSetupPanel(talkSetupReadiness)
      Text(text = nativeString("Microphone"), style = ClawTheme.type.section, color = ClawTheme.colors.text)
      AudioInputDevicePanel(
        devices = audioInputDevices,
        preferredDeviceKey = preferredAudioInputDevice,
        preferencePending = audioInputDevicePending,
        onSelect = viewModel::setPreferredAudioInputDevice,
      )
      Text(text = nativeString("Audio Test"), style = ClawTheme.type.section, color = ClawTheme.colors.text)
      Text(text = nativeString("Check that OpenClaw can speak clearly on this phone."), style = ClawTheme.type.body, color = ClawTheme.colors.textMuted)
      SettingsWaveformPanel(active = speakerEnabled, onClick = ::playVoiceSetupTone)
      VoiceSetupActionRow(
        title = if (speakerEnabled) nativeString("Mute speaker") else nativeString("Enable speaker"),
        subtitle = if (speakerEnabled) nativeString("Replies play aloud") else nativeString("Assistant speech muted"),
        icon = Icons.AutoMirrored.Filled.VolumeUp,
        statusText = if (speakerEnabled) nativeString("On") else nativeString("Muted"),
        ready = speakerEnabled,
        onClick = { viewModel.setSpeakerEnabled(!speakerEnabled) },
      )
      ClawPrimaryButton(text = nativeString("Done"), onClick = onBack, modifier = Modifier.fillMaxWidth(), icon = Icons.Default.GraphicEq)
    }
  }
}

@Composable
private fun AudioInputDevicePanel(
  devices: List<AudioInputDeviceOption>,
  preferredDeviceKey: String?,
  preferencePending: Boolean,
  onSelect: (String?) -> Unit,
) {
  val preferredAvailable = devices.any { it.key == preferredDeviceKey }
  val unavailablePreferredDevice =
    preferredDeviceKey?.takeUnless { preferredAvailable }?.let(::audioInputDeviceOptionFromKey)
  ClawPanel {
    Column(verticalArrangement = Arrangement.spacedBy(4.dp)) {
      AudioInputDeviceRow(
        title = nativeString("Automatic"),
        subtitle =
          if (preferredDeviceKey != null && !preferredAvailable) {
            nativeString("Preferred microphone unavailable; using automatic routing.")
          } else {
            nativeString("Prioritizes connected Bluetooth microphones.")
          },
        selected = preferredDeviceKey == null || !preferredAvailable,
        pending = preferencePending && preferredDeviceKey == null,
        onClick = { onSelect(null) },
      )
      unavailablePreferredDevice?.let { device ->
        HorizontalDivider(color = ClawTheme.colors.border)
        AudioInputDeviceRow(
          title = device.productName.ifBlank { nativeString("Preferred microphone") },
          subtitle = nativeString("Unavailable"),
          selected = false,
          pending = preferencePending,
          onClick = null,
        )
      }
      devices.forEach { device ->
        HorizontalDivider(color = ClawTheme.colors.border)
        val typeLabel = audioInputDeviceTypeLabel(device.type)
        AudioInputDeviceRow(
          title = device.productName.ifBlank { typeLabel },
          subtitle = typeLabel,
          selected = device.key == preferredDeviceKey,
          pending = preferencePending && device.key == preferredDeviceKey,
          onClick = { onSelect(device.key) },
        )
      }
    }
  }
}

@Composable
private fun AudioInputDeviceRow(
  title: String,
  subtitle: String,
  selected: Boolean,
  pending: Boolean,
  onClick: (() -> Unit)?,
) {
  ClawListItem(
    title = title,
    subtitle = subtitle,
    metadata = nativeString("Next session").takeIf { pending },
    leading = { ClawIconBadge(Icons.Default.Mic) },
    trailing =
      if (selected) {
        {
          Icon(
            imageVector = Icons.Default.Check,
            contentDescription = nativeString("Selected"),
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

@Composable
private fun audioInputDeviceTypeLabel(type: Int): String =
  when (type) {
    AudioDeviceInfo.TYPE_BUILTIN_MIC -> nativeString("Built-in microphone")
    AudioDeviceInfo.TYPE_BLUETOOTH_SCO -> nativeString("Bluetooth microphone")
    AudioDeviceInfo.TYPE_BLE_HEADSET -> nativeString("Bluetooth LE microphone")
    AudioDeviceInfo.TYPE_WIRED_HEADSET -> nativeString("Wired headset microphone")
    AudioDeviceInfo.TYPE_USB_DEVICE,
    AudioDeviceInfo.TYPE_USB_ACCESSORY,
    AudioDeviceInfo.TYPE_USB_HEADSET,
    -> nativeString("USB microphone")
    else -> nativeString("External microphone")
  }

@Composable
private fun VoiceSetupPanel(
  readiness: GatewayTalkSetupReadiness,
) {
  Column(verticalArrangement = Arrangement.spacedBy(9.dp)) {
    VoiceSetupReadinessRow(title = nativeString("Realtime Talk"), state = readiness.realtimeTalk, icon = Icons.Default.GraphicEq)
    VoiceSetupReadinessRow(title = nativeString("Dictation"), state = readiness.dictation, icon = Icons.Default.Mic)
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
  val lifecycleOwner = LocalLifecycleOwner.current
  val enabled by viewModel.notificationForwardingEnabled.collectAsState()
  val mode by viewModel.notificationForwardingMode.collectAsState()
  val packages by viewModel.notificationForwardingPackages.collectAsState()
  val quietEnabled by viewModel.notificationForwardingQuietHoursEnabled.collectAsState()
  val quietStart by viewModel.notificationForwardingQuietStart.collectAsState()
  val quietEnd by viewModel.notificationForwardingQuietEnd.collectAsState()
  val maxEventsPerMinute by viewModel.notificationForwardingMaxEventsPerMinute.collectAsState()
  val modeLabel = if (mode == NotificationPackageFilterMode.Blocklist) nativeString("Blocklist") else nativeString("Allowlist")
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

  DisposableEffect(lifecycleOwner, context) {
    val observer =
      LifecycleEventObserver { _, event ->
        if (event == Lifecycle.Event.ON_RESUME) {
          listenerEnabled = DeviceNotificationListenerService.isAccessEnabled(context)
        }
      }
    lifecycleOwner.lifecycle.addObserver(observer)
    onDispose { lifecycleOwner.lifecycle.removeObserver(observer) }
  }

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

  SettingsDetailFrame(title = nativeString("Notifications"), subtitle = nativeString("Choose what reaches OpenClaw."), icon = Icons.Default.Notifications, onBack = onBack) {
    SettingsTogglePanel(
      rows =
        listOf(
          SettingsToggleRow(nativeString("Forward Notifications"), if (enabled) nativeString("OpenClaw can receive selected alerts.") else nativeString("Alerts stay on this phone."), Icons.Default.Notifications, enabled, ::setForwarding),
          SettingsToggleRow(
            nativeString("Quiet Hours"),
            nativeString("\$quietStart to \$quietEnd", quietStart, quietEnd),
            Icons.Default.Bolt,
            quietEnabled,
            onCheckedChange = { checked ->
              viewModel.setNotificationForwardingQuietHours(enabled = checked, start = quietStart, end = quietEnd)
            },
          ),
        ),
    )
    SettingsMetricPanel(
      rows =
        listOf(
          SettingsMetric(nativeString("Policy"), modeLabel),
          SettingsMetric(nativeString("Selected Apps"), packages.size.toString()),
          SettingsMetric(nativeString("Rate Limit"), "$maxEventsPerMinute/min"),
          SettingsMetric(nativeString("Access"), if (listenerEnabled) nativeString("Granted") else nativeString("Setup")),
        ),
    )
    Row(modifier = Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
      ClawSecondaryButton(
        text = if (listenerEnabled) nativeString("Check Access") else nativeString("Open System Access"),
        onClick = {
          openNotificationListenerSettings(context)
        },
        modifier = Modifier.weight(1f),
      )
    }
    ClawPanel {
      Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
        Text(text = nativeString("Forwarding Mode"), style = ClawTheme.type.section, color = ClawTheme.colors.text)
        ClawSegmentedControl(
          options = listOf(nativeString("Blocklist"), nativeString("Allowlist")),
          selected = nativeString(modeLabel),
          onSelect = { selected ->
            viewModel.setNotificationForwardingMode(
              if (selected == nativeString("Allowlist")) {
                NotificationPackageFilterMode.Allowlist
              } else {
                NotificationPackageFilterMode.Blocklist
              },
            )
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
      Text(text = nativeString("App Filter"), style = ClawTheme.type.section, color = ClawTheme.colors.text)
      Text(
        text = notificationPackageSelectionSummary(mode = mode, selectedCount = selectedPackages.size),
        style = ClawTheme.type.body,
        color = ClawTheme.colors.textMuted,
      )
      ClawSecondaryButton(
        text = if (expanded) nativeString("Close App Picker") else nativeString("Open App Picker"),
        onClick = { onExpandedChange(!expanded) },
        modifier = Modifier.fillMaxWidth(),
      )
      if (expanded) {
        ClawTextField(value = search, onValueChange = onSearchChange, placeholder = nativeString("Search apps"))
        SettingsToggleListRow(
          SettingsToggleRow(
            title = nativeString("Show System Apps"),
            subtitle = nativeString("Include Android and background packages."),
            icon = Icons.Default.Storage,
            checked = showSystemApps,
            onCheckedChange = onShowSystemAppsChange,
          ),
        )
        if (visibleApps.isEmpty()) {
          Text(text = nativeString("No matching apps."), style = ClawTheme.type.body, color = ClawTheme.colors.textMuted)
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
              text = nativeString("Showing \${visibleApps.size} of \${apps.size}. Refine search for more.", visibleApps.size, apps.size),
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
  var showInstalledAppsDisclosure by rememberSaveable { mutableStateOf(false) }
  var pendingPreciseLocation by rememberSaveable { mutableStateOf(false) }
  val platformBackgroundPermissionLabel =
    remember(context) {
      context.packageManager.backgroundPermissionOptionLabel.toString()
    }
  val backgroundPermissionLabel = resolvedBackgroundPermissionLabel(platformBackgroundPermissionLabel)
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

  fun setInstalledAppsSharing(checked: Boolean) {
    if (checked) {
      showInstalledAppsDisclosure = true
    } else {
      viewModel.revokeInstalledAppsDisclosureConsent()
    }
  }

  SettingsDetailFrame(title = nativeString("Phone Capabilities"), subtitle = nativeString("Choose what this phone can share."), icon = Icons.AutoMirrored.Filled.ScreenShare, onBack = onBack) {
    SettingsTogglePanel(
      rows =
        listOfNotNull(
          SettingsToggleRow(nativeString("Camera"), nativeString("Allow camera tools when requested."), Icons.Default.CameraAlt, cameraEnabled, ::setCameraAccess),
          SettingsToggleRow(nativeString("Precise Location"), nativeString("Share precise location while location is enabled."), Icons.Default.LocationOn, locationPreciseEnabled, ::setPreciseLocation),
          if (photosAvailable) {
            SettingsToggleRow(
              nativeString("Photos"),
              if (photosGranted) nativeString("Selected or full photo access granted.") else nativeString("Allow photo library access."),
              Icons.Default.Image,
              photosGranted,
              ::setPhotoAccess,
            )
          } else {
            null
          },
          SettingsToggleRow(
            nativeString("Installed Apps"),
            if (installedAppsSharingEnabled) nativeString("OpenClaw can list launcher-visible apps.") else nativeString("App list stays on this phone."),
            Icons.Default.Storage,
            installedAppsSharingEnabled,
            ::setInstalledAppsSharing,
          ),
          SettingsToggleRow(nativeString("Keep Awake"), nativeString("Keep the node available during active work."), Icons.Default.Bolt, preventSleep, viewModel::setPreventSleep),
          SettingsToggleRow(nativeString("Canvas Status"), nativeString("Show screen-sharing debug state."), Icons.AutoMirrored.Filled.ScreenShare, canvasDebugStatusEnabled, viewModel::setCanvasDebugStatusEnabled),
        ),
    )
    if (SensitiveFeatureConfig.accessibilityControlEnabled) {
      FlavorPhoneCapabilitiesSettings(viewModel)
    }
    ClawPanel {
      Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
        Text(text = nativeString("Location"), style = ClawTheme.type.section, color = ClawTheme.colors.text)
        ClawSegmentedControl(
          options = locationModeLabels(backgroundLocationAvailable),
          selected = locationMode.displayLabel,
          onSelect = { selected -> setLocationAccess(locationModeForLabel(selected)) },
        )
        if (backgroundLocationAvailable) {
          Text(
            text = nativeString("Always allows requested location checks while OpenClaw is in the background; Android shows this in the persistent node notification."),
            style = ClawTheme.type.caption,
            color = ClawTheme.colors.textMuted,
          )
        }
      }
    }
  }

  if (showInstalledAppsDisclosure) {
    InstalledAppsDisclosureDialog(
      onDismiss = { showInstalledAppsDisclosure = false },
      onAgree = {
        showInstalledAppsDisclosure = false
        viewModel.grantInstalledAppsDisclosureConsent()
      },
    )
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
      title = { Text(nativeString("Allow background location?")) },
      text = {
        Text(
          nativeString(
            "OpenClaw only checks location when your paired Gateway requests it. On the next Android screen, choose \$backgroundPermissionLabel to allow checks while the app is in the background.",
            backgroundPermissionLabel,
          ),
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
          Text(nativeString("Open Settings"))
        }
      },
      dismissButton = {
        TextButton(onClick = ::cancelBackgroundLocationRequest) {
          Text(nativeString("Not Now"))
        }
      },
    )
  }
}

@Composable
private fun InstalledAppsDisclosureDialog(
  onDismiss: () -> Unit,
  onAgree: () -> Unit,
) {
  AlertDialog(
    onDismissRequest = onDismiss,
    title = { Text(nativeString("Share installed app information?")) },
    text = {
      Column(verticalArrangement = Arrangement.spacedBy(10.dp)) {
        Text(
          nativeString("OpenClaw collects and sends the names, package IDs, and status of apps visible on this phone when your paired OpenClaw Gateway asks for them. This lets your assistant answer questions and take actions using installed apps."),
        )
        Text(
          nativeString("Your phone sends this information to your Gateway, not to a server run by OpenClaw. Your Gateway may include it in requests to the AI provider you chose."),
        )
      }
    },
    confirmButton = {
      TextButton(onClick = onAgree) {
        Text(nativeString("Agree and Enable"))
      }
    },
    dismissButton = {
      TextButton(onClick = onDismiss) {
        Text(nativeString("Not Now"))
      }
    },
  )
}

@Composable
private fun GatewaySettingsScreen(
  viewModel: MainViewModel,
  onBack: () -> Unit,
) {
  val context = LocalContext.current
  val isNodeConnected by viewModel.isNodeConnected.collectAsState()
  val operatorAdminScopeAvailable by viewModel.operatorAdminScopeAvailable.collectAsState()
  val gatewayConnectionDisplay by viewModel.gatewayConnectionDisplay.collectAsState()
  val serverName by viewModel.serverName.collectAsState()
  val remoteAddress by viewModel.remoteAddress.collectAsState()
  val manualHost by viewModel.manualHost.collectAsState()
  val manualPort by viewModel.manualPort.collectAsState()
  val manualTls by viewModel.manualTls.collectAsState()
  val pairedGateways by viewModel.pairedGateways.collectAsState()
  val activeGatewayStableId by viewModel.activeGatewayStableId.collectAsState()
  val connectedGatewayStableIds by viewModel.connectedGatewayStableIds.collectAsState()
  val discoveredGateways by viewModel.gateways.collectAsState()
  val gatewayAgents by viewModel.gatewayAgents.collectAsState()
  val gatewayDefaultAgentId by viewModel.gatewayDefaultAgentId.collectAsState()
  val instanceId by viewModel.instanceId.collectAsState()
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
      title = { Text(nativeString("Replace gateway setup?")) },
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
          Text(nativeString("Replace setup"))
        }
      },
      dismissButton = {
        TextButton(onClick = { pendingSetupResetPlan = null }) {
          Text(nativeString("Cancel"))
        }
      },
      containerColor = ClawTheme.colors.surface,
    )
  }

  pendingForgetStableId?.let { stableId ->
    val entry = pairedGateways.firstOrNull { it.stableId == stableId }
    val gatewayName = entry?.name ?: nativeString("this gateway")
    AlertDialog(
      onDismissRequest = { pendingForgetStableId = null },
      title = { Text(nativeString("Forget gateway?")) },
      text = {
        Text(
          nativeString(
            "Remove \$gatewayName and its saved credentials from this phone?",
            gatewayName,
          ),
        )
      },
      confirmButton = {
        TextButton(
          onClick = {
            pendingForgetStableId = null
            viewModel.forgetGateway(stableId)
          },
        ) {
          Text(nativeString("Forget"))
        }
      },
      dismissButton = {
        TextButton(onClick = { pendingForgetStableId = null }) { Text(nativeString("Cancel")) }
      },
      containerColor = ClawTheme.colors.surface,
    )
  }

  // Discovery only runs while a discovery consumer is active; the Add Gateway
  // panel needs live results just like onboarding does.
  LaunchedEffect(Unit) { viewModel.startGatewayDiscovery() }

  fun connectSetupCode() {
    val plan =
      resolveGatewayConnectPlan(
        useSetupCode = true,
        setupCode = setupCode,
        savedManualHost = manualHost,
        savedManualPort = manualPort.toString(),
        savedManualTls = manualTls,
        manualHostInput = hostInput,
        manualPortInput = portInput,
        manualTlsInput = transport.effectiveTls,
        tokenInput = "",
        bootstrapTokenInput = "",
        passwordInput = "",
      )
    if (plan == null) {
      validationText = nativeString("Enter a valid setup code or gateway address.")
      return
    }
    if (plan.savedAuthAction == GatewaySavedAuthAction.REPLACE_SETUP) {
      pendingSetupResetPlan = plan
    } else {
      saveAndConnect(plan)
    }
  }

  SettingsDetailFrame(
    title = nativeString("Gateway"),
    subtitle = nativeString("Connection between this phone and OpenClaw."),
    icon = Icons.Default.Cloud,
    onBack = onBack,
    trailingAction = {
      ClawPlainIconButton(
        icon = Icons.Default.QrCode2,
        contentDescription = nativeString("Scan QR"),
        onClick = viewModel::pairNewGateway,
      )
    },
  ) {
    SettingsMetricPanel(
      rows =
        listOf(
          SettingsMetric(nativeString("Connection"), if (gatewayConnectionDisplay.isConnected) nativeString("Connected") else nativeString("Offline")),
          SettingsMetric(nativeString("Node"), if (isNodeConnected) nativeString("Online") else nativeString("Not paired")),
          SettingsMetric(
            nativeString("Access"),
            gatewayAccessLabel(
              isConnected = gatewayConnectionDisplay.isConnected,
              operatorAdminScopeAvailable = operatorAdminScopeAvailable,
            ),
          ),
          SettingsMetric(nativeString("Gateway"), serverName?.takeIf { it.isNotBlank() } ?: nativeString("Home Gateway")),
          SettingsMetric(nativeString("Address"), remoteAddress?.takeIf { it.isNotBlank() } ?: nativeString("Not available")),
          SettingsMetric(
            nativeString("Status"),
            gatewayStatusLabel(gatewayConnectionDisplay),
          ),
          SettingsMetric(nativeString("Discovered"), discoveredGateways.size.toString()),
          SettingsMetric(nativeString("Default Agent"), defaultAgentName(gatewayAgents, gatewayDefaultAgentId)),
          SettingsMetric(nativeString("Agents"), gatewayAgents.size.toString()),
          SettingsMetric(nativeString("Instance ID"), instanceId, copyable = true),
        ),
    )
    // First-run hero: no paired gateways yet, so pairing is the primary action.
    if (gatewayShowsScanHero(pairedGateways.size)) {
      ClawPrimaryButton(
        text = nativeString("Scan QR to Pair"),
        onClick = viewModel::pairNewGateway,
        modifier = Modifier.fillMaxWidth(),
        icon = Icons.Default.QrCode2,
      )
    }
    if (gatewayConnectionDisplay.isConnected && !operatorAdminScopeAvailable) {
      ClawPanel {
        Column(verticalArrangement = Arrangement.spacedBy(4.dp)) {
          Text(
            text = nativeString("Limited Gateway access"),
            style = ClawTheme.type.section,
            color = ClawTheme.colors.text,
          )
          Text(
            text = gatewayLimitedAccessUpgradeText(),
            style = ClawTheme.type.body,
            color = ClawTheme.colors.textMuted,
          )
        }
      }
    }
    Row(modifier = Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
      ClawPrimaryButton(text = nativeString("Reconnect"), onClick = viewModel::refreshGatewayConnection, modifier = Modifier.weight(1f))
      ClawSecondaryButton(text = nativeString("Disconnect"), onClick = viewModel::disconnect, modifier = Modifier.weight(1f))
    }
    ClawSecondaryButton(
      text = nativeString("Diagnose"),
      onClick = {
        copyGatewayDiagnosticsReport(
          context = context,
          screen = "gateway settings",
          gatewayAddress = gatewayDiagnosticsEndpoint(remoteAddress, manualHost, manualPort, manualTls),
          statusText = gatewayStatusLabel(gatewayConnectionDisplay),
        )
      },
      modifier = Modifier.fillMaxWidth(),
    )
    ClawPanel {
      Column(verticalArrangement = Arrangement.spacedBy(10.dp)) {
        Text(text = nativeString("Add Gateway"), style = ClawTheme.type.section, color = ClawTheme.colors.text)
        Text(
          text = nativeString("Scan or paste a setup code to add another gateway."),
          style = ClawTheme.type.body,
          color = ClawTheme.colors.textMuted,
          maxLines = 2,
          overflow = TextOverflow.Ellipsis,
        )
        ClawSecondaryButton(text = nativeString("Scan QR"), onClick = viewModel::pairNewGateway, modifier = Modifier.fillMaxWidth(), icon = Icons.Default.QrCode2)
        ClawTextField(value = setupCode, onValueChange = { setupCode = it }, placeholder = nativeString("Setup code"))
        ClawSecondaryButton(text = nativeString("Connect"), onClick = ::connectSetupCode, modifier = Modifier.fillMaxWidth(), icon = Icons.Default.Cloud)
        TextButton(onClick = { showSetupCodeHelp = !showSetupCodeHelp }) {
          Text(nativeString("Where do I get a setup code?"))
        }
        if (showSetupCodeHelp) {
          Text(
            text = nativeString("Android can scan or paste an existing setup code, but this gateway does not expose setup-code generation to the app yet. Generate the QR/code on the gateway host with openclaw qr, then scan it here or paste the setup code below."),
            style = ClawTheme.type.caption,
            color = ClawTheme.colors.textMuted,
          )
        }
        if (discoveredGateways.isEmpty()) {
          Text(
            text = nativeString("No gateways found yet. Use manual setup if discovery is blocked."),
            style = ClawTheme.type.caption,
            color = ClawTheme.colors.textMuted,
          )
        } else {
          discoveredGateways.forEachIndexed { index, endpoint ->
            if (index > 0) HorizontalDivider(color = ClawTheme.colors.border)
            ClawListItem(
              title = endpoint.name,
              subtitle = gatewayDiscoveredRowSubtitle(endpoint),
              leading = { ClawIconBadge(Icons.Default.Cloud) },
              trailing = {
                TextButton(onClick = { viewModel.connect(endpoint) }) {
                  Text(nativeString("Connect"))
                }
              },
              onClick = null,
            )
          }
        }
      }
    }
    ClawPanel {
      Column(verticalArrangement = Arrangement.spacedBy(4.dp)) {
        Text(text = nativeString("Gateways"), style = ClawTheme.type.section, color = ClawTheme.colors.text)
        if (pairedGateways.isEmpty()) {
          Text(text = nativeString("No paired gateways."), style = ClawTheme.type.body, color = ClawTheme.colors.textMuted)
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
                Row(verticalAlignment = Alignment.CenterVertically) {
                  Switch(
                    checked = entry.stableId == activeGatewayStableId || entry.stableId in connectedGatewayStableIds,
                    onCheckedChange = { enabled ->
                      viewModel.setGatewayConnectionEnabled(entry.stableId, enabled)
                    },
                    enabled = entry.stableId != activeGatewayStableId,
                  )
                  TextButton(onClick = { pendingForgetStableId = entry.stableId }) {
                    Text(nativeString("Forget"))
                  }
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
      }
    }
    ClawPanel {
      Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
        Text(text = nativeString("Manual Gateway"), style = ClawTheme.type.section, color = ClawTheme.colors.text)
        Row(modifier = Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
          ClawTextField(value = hostInput, onValueChange = { hostInput = it }, placeholder = nativeString("Host"), modifier = Modifier.weight(1f))
          ClawTextField(value = portInput, onValueChange = { portInput = it }, placeholder = nativeString("Port"), modifier = Modifier.weight(0.62f))
        }
        Text(text = nativeString("Connection security"), style = ClawTheme.type.caption, color = ClawTheme.colors.textMuted)
        val securityOptions = listOf(nativeString("Unencrypted"), nativeString("Secure (TLS)"))
        ClawSegmentedControl(
          options = securityOptions,
          selected = if (transport.effectiveTls) nativeString("Secure (TLS)") else nativeString("Unencrypted"),
          onSelect = { selected -> tlsInput = selected == nativeString("Secure (TLS)") },
          enabledOptions =
            if (transport.requiresTls) {
              setOf(nativeString("Secure (TLS)"))
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
          ClawTextField(value = tokenInput, onValueChange = { tokenInput = it }, placeholder = nativeString("Token"), modifier = Modifier.weight(1f))
          ClawTextField(value = bootstrapTokenInput, onValueChange = { bootstrapTokenInput = it }, placeholder = nativeString("Bootstrap"), modifier = Modifier.weight(1.05f))
        }
        ClawTextField(value = passwordInput, onValueChange = { passwordInput = it }, placeholder = nativeString("Password"))
        validationText?.let {
          Text(text = it, style = ClawTheme.type.caption, color = ClawTheme.colors.warning)
        }
        ClawPrimaryButton(
          text = nativeString("Save & Connect"),
          onClick = {
            val plan =
              resolveGatewayConnectPlan(
                useSetupCode = false,
                setupCode = "",
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
              validationText = nativeString("Enter a valid setup code or gateway address.")
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

internal fun gatewayAccessLabel(
  isConnected: Boolean,
  operatorAdminScopeAvailable: Boolean,
): String =
  when {
    !isConnected -> nativeString("Not available")
    operatorAdminScopeAvailable -> nativeString("Full")
    else -> nativeString("Limited")
  }

internal fun gatewayLimitedAccessUpgradeText(): String =
  nativeString(
    "Use a secure wss:// or Tailscale Serve Gateway, generate a full-access setup code in the Control UI or with openclaw qr, then scan or paste it below and reconnect to enable settings and upgrades.",
  )

@Composable
private fun AppearanceSettingsScreen(
  viewModel: MainViewModel,
  onBack: () -> Unit,
) {
  val themeMode by viewModel.appearanceThemeMode.collectAsState()
  val context = LocalContext.current
  var appLanguage by remember { mutableStateOf(currentAppLanguage()) }
  val systemLanguageTag = currentSystemLanguageTag(context)

  SettingsDetailFrame(title = nativeString("Appearance"), subtitle = nativeString("Theme and translated Android text."), icon = Icons.Default.Palette, onBack = onBack) {
    SettingsMetricPanel(
      rows =
        listOf(
          SettingsMetric(nativeString("Theme"), appearanceThemeSummary(themeMode)),
          SettingsMetric(nativeString("Language"), appLanguageTitle(appLanguage)),
          SettingsMetric(nativeString("Contrast"), nativeString("High")),
          SettingsMetric(nativeString("Typography"), nativeString("Readable")),
        ),
    )
    ClawPanel {
      Column(verticalArrangement = Arrangement.spacedBy(10.dp)) {
        Text(text = nativeString("Theme"), style = ClawTheme.type.section, color = ClawTheme.colors.text)
        ClawSegmentedControl(
          options = appearanceThemeOptions(),
          selected = appearanceThemeSummary(themeMode),
          onSelect = { selected -> viewModel.setAppearanceThemeMode(appearanceThemeModeForLabel(selected)) },
        )
      }
    }
    ClawPanel {
      Column(verticalArrangement = Arrangement.spacedBy(4.dp)) {
        Text(text = nativeString("App language"), style = ClawTheme.type.section, color = ClawTheme.colors.text)
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
    title = appLanguageTitle(language),
    subtitle = appLanguageRowSubtitle(language = language, systemLanguageTag = systemLanguageTag),
    leading = { ClawIconBadge(Icons.Default.Language) },
    trailing =
      if (selected) {
        {
          Icon(
            imageVector = Icons.Default.Check,
            contentDescription = nativeString("Selected"),
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

private fun appLanguageTitle(language: AppLanguage): String = if (language == AppLanguage.System) nativeString("System") else language.displayName

internal fun appearanceThemeSummary(mode: AppearanceThemeMode): String = nativeString(mode.displayLabel)

internal fun appearanceThemeOptions(): List<String> = AppearanceThemeMode.entries.map(::appearanceThemeSummary)

internal fun appearanceThemeModeForLabel(label: String): AppearanceThemeMode =
  AppearanceThemeMode.entries.firstOrNull { appearanceThemeSummary(it).equals(label.trim(), ignoreCase = true) }
    ?: AppearanceThemeMode.Dark

internal fun locationModeLabels(backgroundLocationAvailable: Boolean): List<String> =
  if (backgroundLocationAvailable) {
    listOf(nativeString("Off"), nativeString("While Using"), nativeString("Always"))
  } else {
    listOf(nativeString("Off"), nativeString("While Using"))
  }

internal fun locationModeForLabel(label: String): LocationMode =
  when (label) {
    nativeString("While Using") -> LocationMode.WhileUsing
    nativeString("Always") -> LocationMode.Always
    else -> LocationMode.Off
  }

private val LocationMode.displayLabel: String
  get() =
    when (this) {
      LocationMode.Off -> nativeString("Off")
      LocationMode.WhileUsing -> nativeString("While Using")
      LocationMode.Always -> nativeString("Always")
    }

/** Converts raw gateway connection text into stable settings metric labels. */
internal fun gatewayStatusLabel(
  statusText: String,
  isConnected: Boolean,
  gatewayConnectionProblem: GatewayConnectionProblem? = null,
): String {
  if (isConnected) return nativeString("Ready")
  val status = statusText.trim().lowercase()
  return when {
    status.contains("connecting") || status.contains("reconnecting") -> nativeString("Connecting...")
    status.contains("pair") -> nativeString("Pairing needed")
    status.contains("auth") || status.contains("device identity") -> gatewayAuthRecoveryLabel(gatewayConnectionProblem) ?: nativeString("Authentication needed")
    status.contains("fingerprint verification timed out") -> nativeString("TLS timed out")
    status.contains("no tls endpoint") -> nativeString("No TLS endpoint")
    status.contains("certificate") || status.contains("tls") -> nativeString("Certificate review needed")
    status.contains("failed") || status.contains("error") || status.contains("offline") || status.contains("not connected") -> nativeString("Cannot reach gateway")
    status.isBlank() -> nativeString("Not connected")
    else -> nativeString("Not connected")
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
  val appLocale = LocalConfiguration.current.locales[0]

  SettingsDetailFrame(title = nativeString("About"), subtitle = nativeString("OpenClaw for Android."), icon = Icons.Default.Info, onBack = onBack) {
    AboutHeroPanel()
    AboutBuildIdentityPanel(
      versionName = BuildConfig.VERSION_NAME,
      versionCode = BuildConfig.VERSION_CODE,
      gitCommit = BuildConfig.GIT_COMMIT,
      buildTimestamp = BuildConfig.BUILD_TIMESTAMP,
      locale = appLocale,
    )
    SettingsMetricPanel(
      rows =
        listOf(
          SettingsMetric(nativeString("Channel"), androidDistributionChannel()),
          SettingsMetric(nativeString("Gateway"), currentGatewayVersion ?: nativeString("Not connected")),
        ),
    )
    ClawPanel(contentPadding = PaddingValues(horizontal = 0.dp, vertical = 0.dp)) {
      Column {
        AboutStatusRow(title = nativeString("Gateway"), value = serverName?.takeIf { it.isNotBlank() } ?: nativeString("Home Gateway"), healthy = isConnected)
        HorizontalDivider(color = ClawTheme.colors.border, thickness = 1.dp)
        AboutStatusRow(title = nativeString("Runtime"), value = currentGatewayVersion ?: nativeString("Waiting"), healthy = currentGatewayVersion != null)
        HorizontalDivider(color = ClawTheme.colors.border, thickness = 1.dp)
        AboutStatusRow(
          title = nativeString("Update"),
          value = latestVersion?.let { nativeString("v\$it available", it) } ?: nativeString("Up to date"),
          healthy = latestVersion == null,
        )
      }
    }
    ClawPanel {
      Text(text = aboutUpdateText(latestVersion = latestVersion), style = ClawTheme.type.body, color = ClawTheme.colors.textMuted)
    }
    AboutLinksPanel()
    Text(
      text = nativeString("© 2026 OpenClaw Foundation — MIT License."),
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
      OpenClawMascot(contentDescription = nativeString("OpenClaw logo"), modifier = Modifier.size(96.dp))
      Column(horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.spacedBy(2.dp)) {
        Text(text = nativeString("OpenClaw"), style = ClawTheme.type.section, color = ClawTheme.colors.text)
        Text(text = nativeString("Personal AI on your devices"), style = ClawTheme.type.caption, color = ClawTheme.colors.textMuted)
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
      title = aboutLinkTitle(link.title),
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
    title = nativeString("Licenses"),
    subtitle = if (selectedLicense == null) nativeString("OpenClaw appreciates its partners in the open-source community.") else "",
    subtitleTextAlign = TextAlign.Center,
    icon = Icons.Default.Info,
    onBack = backToListOrSettings,
  ) {
    val selected = selectedLicense
    if (selected == null) {
      if (licenses.isEmpty()) {
        ClawPanel {
          Text(text = nativeString("No license notices are packaged in this build."), style = ClawTheme.type.body, color = ClawTheme.colors.textMuted)
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
        contentDescription = nativeString("Open \${license.title}", license.title),
        modifier = Modifier.size(20.dp),
        tint = ClawTheme.colors.text,
      )
    },
  )
}

internal fun androidDistributionChannel(flavor: String = BuildConfig.FLAVOR): String =
  when (flavor.trim()) {
    "play" -> "Play"
    "thirdParty" -> nativeString("Third-party")
    "" -> nativeString("Unknown")
    else -> flavor.trim()
  }

internal fun aboutLinkTitle(title: String): String =
  when (title) {
    "Website" -> nativeString("Website")
    "Docs" -> nativeString("Docs")
    else -> title
  }

internal fun resolvedBackgroundPermissionLabel(platformLabel: String): String = platformLabel.trim().ifEmpty { nativeString("Allow all the time") }

internal fun gatewaySettingsSetupResetConfirmationText(): String =
  nativeString(
    "Replacing the setup code clears this phone's saved setup credentials and device tokens before reconnecting. This phone may need node capability approval again; continue only when you mean to pair with a fresh gateway setup code.",
  )

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
    ClawStatusPill(text = if (healthy) "OK" else nativeString("Check"), status = if (healthy) ClawStatus.Success else ClawStatus.Warning)
  }
}

/** Chooses about-screen copy based on whether the gateway advertises an update. */
private fun aboutUpdateText(latestVersion: String?): String =
  if (latestVersion == null) {
    nativeString("OpenClaw turns this phone into a clean mobile command surface for threads, voice, providers, and Gateway.")
  } else {
    nativeString("A Gateway update is available. Run the update from the Web UI or CLI when you are ready.")
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
  trailingAction: (@Composable () -> Unit)? = null,
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
            contentDescription = nativeString("Back"),
            onClick = onBack,
          )
          Text(text = title, style = ClawTheme.type.title, color = ClawTheme.colors.text, modifier = Modifier.weight(1f), maxLines = 1, overflow = TextOverflow.Ellipsis)
          trailingAction?.invoke()
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
internal data class SettingsToggleRow(
  val title: String,
  val subtitle: String,
  val icon: ImageVector,
  val checked: Boolean,
  val onCheckedChange: (Boolean) -> Unit,
  val enabled: Boolean = true,
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
      ExecApprovalCard(
        approval = approval,
        onResolve = onResolve,
      )
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
          Text(text = nativeString("Command approval"), style = ClawTheme.type.section, color = ClawTheme.colors.text)
          approval.commandPreview?.let { preview ->
            Text(text = preview, style = ClawTheme.type.caption, color = ClawTheme.colors.textMuted, maxLines = 2, overflow = TextOverflow.Ellipsis)
          }
        }
        ClawStatusPill(text = if (resolving) nativeString("Sending") else nativeString("Review"), status = if (resolving) ClawStatus.Warning else ClawStatus.Success)
      }
      ExecApprovalCommandReview(approval.commandText.resolveNativeTextResource())
      approval.warningText?.let { warningText ->
        Text(text = warningText, style = ClawTheme.type.body, color = ClawTheme.colors.warning)
      }
      Text(text = execApprovalMetadata(approval), style = ClawTheme.type.caption, color = ClawTheme.colors.textSubtle, maxLines = 2, overflow = TextOverflow.Ellipsis)
      approval.errorText?.let { errorText ->
        Text(text = gatewayExecApprovalTextForDisplay(errorText), style = ClawTheme.type.caption, color = ClawTheme.colors.warning)
      }
      Column(modifier = Modifier.fillMaxWidth(), verticalArrangement = Arrangement.spacedBy(8.dp)) {
        execApprovalActions(approval.allowedDecisions).forEach { action ->
          if (action.decision == "allow-once") {
            ClawPrimaryButton(
              text = action.label,
              onClick = { onResolve(approval.id, action.decision) },
              enabled = !resolving,
              modifier = Modifier.fillMaxWidth(),
            )
          } else {
            ClawSecondaryButton(
              text = action.label,
              onClick = { onResolve(approval.id, action.decision) },
              enabled = !resolving,
              modifier = Modifier.fillMaxWidth(),
            )
          }
        }
      }
    }
  }
}

@Composable
private fun ExecApprovalCommandReview(commandText: String) {
  Surface(
    modifier = Modifier.fillMaxWidth(),
    shape = RoundedCornerShape(8.dp),
    color = ClawTheme.colors.surfacePressed,
    border = BorderStroke(1.dp, ClawTheme.colors.border),
  ) {
    SelectionContainer {
      Text(
        text = commandText,
        modifier = Modifier.fillMaxWidth().padding(horizontal = 12.dp, vertical = 10.dp),
        style = ClawTheme.type.body.copy(fontFamily = FontFamily.Monospace),
        color = ClawTheme.colors.text,
      )
    }
  }
}

internal data class ExecApprovalAction(
  val decision: String,
  val label: String,
)

internal fun execApprovalActions(allowedDecisions: List<String>): List<ExecApprovalAction> =
  allowedDecisions.mapNotNull { decision ->
    when (decision) {
      "allow-once" -> ExecApprovalAction(decision, nativeString("Allow Once"))
      "allow-always" -> ExecApprovalAction(decision, nativeString("Allow Always"))
      "deny" -> ExecApprovalAction(decision, nativeString("Deny"))
      else -> null
    }
  }

@Composable
private fun ExecApprovalNotice(
  notice: GatewayExecApprovalNotice,
  onDismiss: () -> Unit,
) {
  ClawPanel {
    Row(modifier = Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(9.dp)) {
      Column(modifier = Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(3.dp)) {
        Text(
          text = gatewayExecApprovalTextForDisplay(notice.message),
          style = ClawTheme.type.body,
          color = if (notice.warning) ClawTheme.colors.warning else ClawTheme.colors.success,
        )
        // The retired card is gone by the time this renders; keep the id association
        // so the outcome stays attributable while other approval cards remain visible.
        Text(
          text = nativeString("Approval \${notice.approvalId}", notice.approvalId),
          style = ClawTheme.type.caption,
          color = ClawTheme.colors.textSubtle,
          maxLines = 1,
          overflow = TextOverflow.Ellipsis,
        )
      }
      ClawPlainIconButton(icon = Icons.Default.Close, contentDescription = nativeString("Dismiss approval notice"), onClick = onDismiss)
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
    trailing = { ClawStatusPill(text = if (hasIssue) nativeString("Issue") else nativeString("Review"), status = if (hasIssue) ClawStatus.Warning else ClawStatus.Success) },
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
    leading = { ClawTextBadge(text = provider.displayName.uppercaseFirstGraphemeOrNull() ?: "U") },
    trailing = { ClawStatusPill(text = if (hasIssue) nativeString("Issue") else "OK", status = if (hasIssue) ClawStatus.Warning else ClawStatus.Success) },
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
    modifier = Modifier.clickable(onClickLabel = nativeString("Open automation detail"), onClick = onClick),
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
  editorDraft: CronEditorDraftState,
  onEditorDraftChange: (CronEditorDraftState) -> Unit,
  historyState: GatewayCronRunHistoryState,
  actionState: GatewayCronActionState,
  runPending: Boolean,
  operatorAdminScopeAvailable: Boolean,
  onRun: () -> Unit,
  onToggleEnabled: () -> Unit,
  onSave: (GatewayCronJobEdit) -> Unit,
  onRefreshHistory: () -> Unit,
  onDelete: () -> Unit,
) {
  CronJobManagementPanel(
    job = job,
    editorDraft = editorDraft,
    onEditorDraftChange = onEditorDraftChange,
    historyState = historyState,
    actionState = actionState,
    runPending = runPending,
    operatorAdminScopeAvailable = operatorAdminScopeAvailable,
    onRun = onRun,
    onToggleEnabled = onToggleEnabled,
    onSave = onSave,
    onRefreshHistory = onRefreshHistory,
    onDelete = onDelete,
  )
  SettingsMetricPanel(
    rows =
      listOf(
        SettingsMetric(nativeString("Status"), if (job.enabled) nativeString("Enabled") else nativeString("Off")),
        SettingsMetric(nativeString("Schedule"), job.scheduleLabel.resolveNativeTextResource()),
        SettingsMetric(nativeString("Next Wake"), formatCronWake(job.nextRunAtMs)),
        SettingsMetric(nativeString("Last Run"), formatCronTimestamp(job.lastRunAtMs)),
      ),
  )
  CronJobFieldsPanel(
    rows =
      listOf(
        SettingsMetric("ID", job.id, copyable = true),
        SettingsMetric(nativeString("Description"), job.description.ifBlank { nativeString("None") }),
        SettingsMetric(nativeString("Schedule Detail"), job.scheduleDetail.resolveNativeTextResource()),
        SettingsMetric(nativeString("Session Target"), cronSessionTargetLabel(job.sessionTarget)),
        SettingsMetric(nativeString("Wake Mode"), cronWakeModeLabel(job.wakeMode)),
        SettingsMetric(nativeString("Delete After Run"), if (job.deleteAfterRun) nativeString("Yes") else nativeString("No")),
        SettingsMetric(nativeString("Payload"), job.payloadLabel.resolveNativeTextResource()),
        SettingsMetric(nativeString("Delivery"), job.deliveryLabel.resolveNativeTextResource()),
        SettingsMetric(nativeString("Failure Alert"), job.failureAlertLabel.resolveNativeTextResource()),
        SettingsMetric(nativeString("Created"), formatCronTimestamp(job.createdAtMs)),
        SettingsMetric(nativeString("Updated"), formatCronTimestamp(job.updatedAtMs)),
        SettingsMetric(nativeString("Running Since"), formatCronTimestamp(job.runningAtMs)),
        SettingsMetric(nativeString("Last Status"), cronJobStatusText(job)),
        SettingsMetric(
          nativeString("Last Duration"),
          job.lastDurationMs?.let { durationMs -> nativeString("\${durationMs}ms", durationMs) } ?: nativeString("None"),
        ),
        SettingsMetric(nativeString("Consecutive Errors"), job.consecutiveErrors?.toString() ?: "0"),
        SettingsMetric(nativeString("Consecutive Skips"), job.consecutiveSkipped?.toString() ?: "0"),
        SettingsMetric(nativeString("Delivery Status"), cronJobDeliveryStatusText(job.lastDeliveryStatus)),
      ),
  )
  job.payloadText?.let { text ->
    CronJobTextPanel(title = cronPayloadTextTitle(job), text = text)
  }
  job.lastError?.let { text ->
    CronJobTextPanel(title = nativeString("Last Error"), text = text, warning = true)
  }
  job.lastDeliveryError?.let { text ->
    CronJobTextPanel(title = nativeString("Delivery Error"), text = text, warning = true)
  }
}

internal fun cronJobDeliveryStatusText(status: String?): String = status?.let(::cronDeliveryStatusLabel) ?: nativeString("None")

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
            .clickable(onClickLabel = nativeString("Copy \${row.title}", row.title)) { copyCronDetailValue(context, row.title, row.value) }
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
            Text(text = nativeString("Tap to copy"), style = ClawTheme.type.caption, color = ClawTheme.colors.textMuted)
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
  clipboard.setPrimaryClip(ClipData.newPlainText("OpenClaw automation $title", value))
  Toast.makeText(context, nativeString("\$title copied", title), Toast.LENGTH_SHORT).show()
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
    subtitle = if (isDefault) nativeString("Default assistant") else nativeString("Ready"),
    leading = {
      ClawAgentAvatar(source = agentAvatarSource(agent), size = 30.dp) {
        ClawTextBadge(text = agentBadge(agent))
      }
    },
    trailing = { ClawStatusPill(text = if (isDefault) nativeString("Default") else nativeString("Ready"), status = ClawStatus.Success) },
  )
}

/** First-run pairing state: the hero scan CTA shows until a gateway is paired. */
internal fun gatewayShowsScanHero(pairedGatewayCount: Int): Boolean = pairedGatewayCount == 0

/** Discovered rows show the endpoint target so users can tell twins apart before connecting. */
internal fun gatewayDiscoveredRowSubtitle(endpoint: GatewayEndpoint): String = "${endpoint.host}:${endpoint.port}"

/**
 * Chooses a display name for the configured default agent, falling back to any available agent.
 */
private fun defaultAgentName(
  agents: List<GatewayAgentSummary>,
  defaultAgentId: String?,
): String {
  val defaultId = defaultAgentId?.trim().orEmpty()
  val agent = agents.firstOrNull { it.id == defaultId } ?: agents.firstOrNull()
  return agent?.name?.takeIf { it.isNotBlank() } ?: agent?.id ?: nativeString("None")
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
    .mapNotNull { it.uppercaseFirstGraphemeOrNull() }
    .joinToString("")
    .ifBlank { "A" }
}

/**
 * Normalizes tool-call names into readable approval action labels.
 */
internal fun approvalActionName(name: String): String {
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
    .ifBlank { nativeString("Action Request") }
}

/** Builds approval row age/error copy without exposing raw tool arguments. */
private fun approvalSubtitle(
  toolCall: ChatPendingToolCall,
  hasIssue: Boolean,
): String {
  if (hasIssue) return nativeString("Needs attention")
  val ageMs = (System.currentTimeMillis() - toolCall.startedAtMs).coerceAtLeast(0L)
  val minutes = ageMs / 60_000L
  return if (minutes < 1) nativeString("Waiting for review") else nativeString("Waiting \${minutes}m", minutes)
}

internal fun execApprovalMetadata(
  approval: GatewayExecApprovalSummary,
  nowMs: Long = System.currentTimeMillis(),
): String {
  val target =
    when {
      approval.host == "node" && approval.nodeId != null -> {
        val nodeId = approval.nodeId.take(8)
        nativeString("Node \${nodeId}", nodeId)
      }
      approval.host == "node" -> nativeString("Node")
      approval.host == "gateway" -> nativeString("Gateway")
      approval.host != null -> approval.host
      else -> nativeString("Gateway")
    }
  val agent =
    approval.agentId?.let {
      val agentId = it.take(8)
      nativeString("Agent \${agentId}", agentId)
    }
  val age =
    approval.createdAtMs?.let {
      val duration = formatApprovalDuration(nowMs - it)
      nativeString("Waiting \${duration}", duration)
    }
  val expires =
    approval.expiresAtMs?.let {
      val duration = formatApprovalDuration(it - nowMs)
      nativeString("Expires \${duration}", duration)
    }
  return listOfNotNull(target, agent, age, expires).joinToString(" · ")
}

internal fun formatApprovalDuration(deltaMs: Long): String {
  val safeDelta = deltaMs.coerceAtLeast(0L)
  val minutes = safeDelta / 60_000L
  val hours = minutes / 60L
  return when {
    minutes < 1 -> nativeString("soon")
    hours < 1 -> nativeString("\${minutes}m", minutes)
    else -> nativeString("\${hours}h", hours)
  }
}

internal fun cronSessionTargetLabel(target: String): String =
  when (target) {
    "main" -> nativeString("Main")
    "isolated" -> nativeString("Isolated")
    "current" -> nativeString("Current")
    else -> target
  }

/** Builds the dense cron-job subtitle from schedule, next wake, and prompt preview. */
private fun cronJobSubtitle(job: GatewayCronJobSummary): String =
  nativeString(
    "\${job.scheduleLabel} · \${formatCronWake(job.nextRunAtMs)} · \${job.promptPreview}",
    job.scheduleLabel.resolveNativeText(),
    formatCronWake(job.nextRunAtMs),
    job.promptPreview.resolveNativeText(),
  )

internal enum class CronJobsListFilter {
  All,
  Active,
  Paused,
  ;

  val label: String
    get() =
      when (this) {
        All -> nativeString("All")
        Active -> nativeString("Active")
        Paused -> nativeString("Paused")
      }
}

internal fun filterCronJobs(
  jobs: List<GatewayCronJobSummary>,
  rawQuery: String,
  filter: CronJobsListFilter,
): List<GatewayCronJobSummary> {
  val query = rawQuery.trim()
  return jobs.filter { job ->
    val statusMatches =
      when (filter) {
        CronJobsListFilter.All -> true
        CronJobsListFilter.Active -> job.enabled
        CronJobsListFilter.Paused -> !job.enabled
      }
    statusMatches &&
      (
        query.isEmpty() ||
          listOf(job.name, job.scheduleLabel.resolveNativeText(), job.promptPreview.resolveNativeText())
            .any { it.contains(query, ignoreCase = true) }
      )
  }
}

/** Summarizes a provider plan and most-used quota window for usage rows. */
internal fun usageProviderSubtitle(provider: GatewayUsageProviderSummary): String {
  provider.error?.let { return it }
  val window = provider.windows.maxByOrNull { it.usedPercent }
  val quota =
    window?.let {
      val remaining = (100.0 - it.usedPercent).coerceIn(0.0, 100.0).toInt()
      nativeString("\${remaining}% left \${label}", remaining, it.label)
    }
  return listOfNotNull(provider.plan, quota).joinToString(" · ").ifBlank {
    nativeString("No limits reported")
  }
}

/**
 * Converts usage timestamps into short relative labels for metric panels.
 */
internal fun formatUsageUpdated(
  updatedAtMs: Long?,
  nowMs: Long = System.currentTimeMillis(),
): String {
  val updated = updatedAtMs ?: return nativeString("Never")
  val deltaMs = (nowMs - updated).coerceAtLeast(0L)
  val minutes = deltaMs / 60_000L
  val hours = minutes / 60L
  return when {
    minutes < 1 -> nativeString("Now")
    hours < 1 -> nativeString("\${minutes}m", minutes)
    hours < 24 -> nativeString("\${hours}h", hours)
    else -> {
      val days = hours / 24L
      nativeString("\${days}d", days)
    }
  }
}

/** Converts gateway cron status text into the short row badge label. */
private fun cronJobStatusText(job: GatewayCronJobSummary): String {
  if (!job.enabled) return nativeString("Off")
  return when (job.lastRunStatus?.lowercase()) {
    "error" -> nativeString("Issue")
    "ok" -> "OK"
    "skipped" -> nativeString("Skipped")
    else -> nativeString("Ready")
  }
}

private fun cronJobStatusText(job: GatewayCronJobDetail): String {
  if (!job.enabled) return nativeString("Off")
  return when (job.lastRunStatus?.lowercase()) {
    "error" -> nativeString("Issue")
    "ok" -> "OK"
    "skipped" -> nativeString("Skipped")
    else -> nativeString("Ready")
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
    "systemEvent" -> nativeString("System Event Text")
    "agentTurn" -> nativeString("Agent Prompt")
    "command" -> nativeString("Command")
    "script" -> nativeString("Script")
    else -> nativeString("Payload Text")
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
        nativeString("No apps selected. Nothing forwards until you add apps.")
      } else if (selectedCount == 1) {
        nativeString("\$selectedCount app allowed to forward.", selectedCount)
      } else {
        nativeString("\$selectedCount apps allowed to forward.", selectedCount)
      }
    NotificationPackageFilterMode.Blocklist ->
      if (selectedCount == 0) {
        nativeString("No apps blocked. Apps can forward unless you add blocks.")
      } else if (selectedCount == 1) {
        nativeString("\$selectedCount app blocked from forwarding.", selectedCount)
      } else {
        nativeString("\$selectedCount apps blocked from forwarding.", selectedCount)
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
      .mapNotNull { it.uppercaseFirstGraphemeOrNull() }
      .joinToString("")
  return initials.ifBlank { "A" }
}

/**
 * Converts cron wake times into short relative labels for scheduled-work rows.
 */
internal fun formatCronWake(
  timeMs: Long?,
  nowMs: Long = System.currentTimeMillis(),
): String {
  val target = timeMs ?: return nativeString("None")
  val deltaMs = target - nowMs
  if (deltaMs <= 0) return nativeString("Due")
  val minutes = deltaMs / 60_000L
  val hours = minutes / 60L
  val days = hours / 24L
  return when {
    days > 0 -> nativeString("\${days}d", days)
    hours > 0 -> nativeString("\${hours}h", hours)
    minutes > 0 -> nativeString("\${minutes}m", minutes)
    else -> nativeString("Soon")
  }
}

internal fun formatCronTimestamp(timeMs: Long?): String {
  val value = timeMs ?: return nativeString("None")
  return DateFormat.getDateTimeInstance(DateFormat.SHORT, DateFormat.SHORT).format(Date(value))
}

@Composable
internal fun SettingsTogglePanel(rows: List<SettingsToggleRow>) {
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
        .clickable(enabled = row.enabled) { row.onCheckedChange(!row.checked) }
        .padding(horizontal = 10.dp, vertical = 6.dp),
    verticalAlignment = Alignment.CenterVertically,
    horizontalArrangement = Arrangement.spacedBy(9.dp),
  ) {
    Icon(imageVector = row.icon, contentDescription = null, modifier = Modifier.size(19.dp), tint = ClawTheme.colors.text)
    Column(modifier = Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(1.dp)) {
      Text(text = row.title, style = ClawTheme.type.body, color = ClawTheme.colors.text, maxLines = 1)
      Text(text = row.subtitle, style = ClawTheme.type.caption, color = ClawTheme.colors.textMuted, maxLines = 2, overflow = TextOverflow.Ellipsis)
    }
    Switch(checked = row.checked, onCheckedChange = row.onCheckedChange, enabled = row.enabled)
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
