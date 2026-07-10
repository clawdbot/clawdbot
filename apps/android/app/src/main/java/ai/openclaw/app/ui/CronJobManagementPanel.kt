package ai.openclaw.app.ui

import ai.openclaw.app.CronEditorDraftState
import ai.openclaw.app.GatewayCronActionState
import ai.openclaw.app.GatewayCronJobDetail
import ai.openclaw.app.GatewayCronJobEdit
import ai.openclaw.app.GatewayCronNoticeKind
import ai.openclaw.app.GatewayCronPayloadEdit
import ai.openclaw.app.GatewayCronRunHistoryState
import ai.openclaw.app.GatewayCronRunSummary
import ai.openclaw.app.GatewayCronScheduleEdit
import ai.openclaw.app.ui.design.ClawDetailRow
import ai.openclaw.app.ui.design.ClawIconBadge
import ai.openclaw.app.ui.design.ClawListPanel
import ai.openclaw.app.ui.design.ClawPanel
import ai.openclaw.app.ui.design.ClawPrimaryButton
import ai.openclaw.app.ui.design.ClawSecondaryButton
import ai.openclaw.app.ui.design.ClawSegmentedControl
import ai.openclaw.app.ui.design.ClawStatus
import ai.openclaw.app.ui.design.ClawStatusPill
import ai.openclaw.app.ui.design.ClawTextField
import ai.openclaw.app.ui.design.ClawTheme
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.size
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Delete
import androidx.compose.material.icons.filled.Edit
import androidx.compose.material.icons.filled.History
import androidx.compose.material.icons.filled.Lock
import androidx.compose.material.icons.filled.Pause
import androidx.compose.material.icons.filled.PlayArrow
import androidx.compose.material.icons.filled.Refresh
import androidx.compose.material.icons.filled.Save
import androidx.compose.material.icons.filled.Schedule
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Icon
import androidx.compose.material3.Switch
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import java.text.DateFormat
import java.util.Date

@Composable
internal fun CronJobManagementPanel(
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
  val busy = actionState is GatewayCronActionState.Running
  val notice = (actionState as? GatewayCronActionState.Notice)?.takeIf { it.id == job.id }
  var showDeleteConfirmation by remember(job.id) { mutableStateOf(false) }

  if (showDeleteConfirmation) {
    AlertDialog(
      onDismissRequest = { showDeleteConfirmation = false },
      confirmButton = {
        TextButton(
          onClick = {
            showDeleteConfirmation = false
            onDelete()
          },
        ) {
          Text("Delete")
        }
      },
      dismissButton = {
        TextButton(onClick = { showDeleteConfirmation = false }) {
          Text("Cancel")
        }
      },
      title = { Text("Delete cron job?") },
      text = { Text("This permanently removes the scheduled job from the gateway.") },
    )
  }

  notice?.let { value ->
    ClawPanel {
      Text(
        text = value.message,
        style = ClawTheme.type.body,
        color =
          when (value.kind) {
            GatewayCronNoticeKind.Success -> ClawTheme.colors.success
            GatewayCronNoticeKind.Warning -> ClawTheme.colors.warning
            GatewayCronNoticeKind.Error -> ClawTheme.colors.danger
          },
      )
    }
  }

  if (!operatorAdminScopeAvailable) CronAdminAccessPanel()
  if (editorDraft.requiresResolution) {
    ClawPanel {
      Text(
        text =
          if (editorDraft.hasIncomingConflict) {
            "This job changed while you were editing. Revert to the latest gateway version before saving."
          } else {
            "Save or revert your edits before running, enabling, disabling, deleting, or refreshing this job."
          },
        style = ClawTheme.type.body,
        color = ClawTheme.colors.warning,
      )
    }
  }

  CronActionPanel(
    job = job,
    enabled = operatorAdminScopeAvailable && !busy && !editorDraft.requiresResolution,
    busy = busy,
    runPending = runPending,
    onRun = onRun,
    onToggleEnabled = onToggleEnabled,
    onDelete = { showDeleteConfirmation = true },
  )
  CronEditorPanel(
    job = job,
    draft = editorDraft,
    onDraftChange = onEditorDraftChange,
    enabled =
      operatorAdminScopeAvailable &&
        !busy &&
        !editorDraft.savePending &&
        !editorDraft.saveSucceeded,
    canRevert = !busy && !editorDraft.savePending && !editorDraft.saveSucceeded,
    busy = busy,
    onSave = onSave,
  )
  CronRunHistoryPanel(
    jobId = job.id,
    state = historyState,
    onRefresh = onRefreshHistory,
  )
}

@Composable
private fun CronAdminAccessPanel() {
  ClawPanel {
    Column(verticalArrangement = Arrangement.spacedBy(7.dp)) {
      Row(
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(8.dp),
      ) {
        Icon(
          imageVector = Icons.Default.Lock,
          contentDescription = null,
          modifier = Modifier.size(17.dp),
          tint = ClawTheme.colors.text,
        )
        Text(text = "Admin access required", style = ClawTheme.type.section, color = ClawTheme.colors.text)
      }
      Text(
        text =
          "Cron changes require operator.admin. Setup codes intentionally do not grant it. " +
            "Reconnect with the gateway's shared token or password to request admin access. " +
            "If this device still lacks it, approve the pending scope upgrade from an existing admin client.",
        style = ClawTheme.type.body,
        color = ClawTheme.colors.textMuted,
      )
    }
  }
}

@Composable
private fun CronActionPanel(
  job: GatewayCronJobDetail,
  enabled: Boolean,
  busy: Boolean,
  runPending: Boolean,
  onRun: () -> Unit,
  onToggleEnabled: () -> Unit,
  onDelete: () -> Unit,
) {
  ClawPanel {
    Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
      Row(
        modifier = Modifier.fillMaxWidth(),
        horizontalArrangement = Arrangement.spacedBy(8.dp),
      ) {
        ClawPrimaryButton(
          text =
            when {
              busy -> "Working"
              runPending -> "Run Pending"
              else -> "Run Now"
            },
          onClick = onRun,
          modifier = Modifier.weight(1f),
          enabled = enabled && !runPending,
          icon = Icons.Default.PlayArrow,
        )
        ClawSecondaryButton(
          text = if (job.enabled) "Disable" else "Enable",
          onClick = onToggleEnabled,
          modifier = Modifier.weight(1f),
          enabled = enabled,
          icon = if (job.enabled) Icons.Default.Pause else Icons.Default.PlayArrow,
        )
      }
      ClawSecondaryButton(
        text = "Delete Job",
        onClick = onDelete,
        modifier = Modifier.fillMaxWidth(),
        enabled = enabled,
        icon = Icons.Default.Delete,
      )
    }
  }
}

@Composable
private fun CronEditorPanel(
  job: GatewayCronJobDetail,
  draft: CronEditorDraftState,
  onDraftChange: (CronEditorDraftState) -> Unit,
  enabled: Boolean,
  canRevert: Boolean,
  busy: Boolean,
  onSave: (GatewayCronJobEdit) -> Unit,
) {
  val edit = draft.edit
  ClawPanel {
    Column(verticalArrangement = Arrangement.spacedBy(9.dp)) {
      Row(
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(8.dp),
      ) {
        Icon(
          imageVector = Icons.Default.Edit,
          contentDescription = null,
          modifier = Modifier.size(17.dp),
          tint = ClawTheme.colors.text,
        )
        Text(text = "Edit Job", style = ClawTheme.type.section, color = ClawTheme.colors.text)
      }
      CronSwitchRow(
        title = "Enabled",
        subtitle = "Allow the scheduler to run this job.",
        checked = edit.enabled,
        onCheckedChange = { onDraftChange(draft.withEdit(edit.copy(enabled = it))) },
        enabled = enabled,
      )
      if (edit.schedule is GatewayCronScheduleEdit.At) {
        CronSwitchRow(
          title = "Delete after run",
          subtitle = "Remove this job after a successful one-shot run.",
          checked = edit.deleteAfterRun,
          onCheckedChange = { onDraftChange(draft.withEdit(edit.copy(deleteAfterRun = it))) },
          enabled = enabled,
        )
      }
      ClawTextField(
        value = edit.name,
        onValueChange = { onDraftChange(draft.withEdit(edit.copy(name = it))) },
        placeholder = "Job name",
        label = "Name",
        enabled = enabled,
      )
      ClawTextField(
        value = edit.description,
        onValueChange = { onDraftChange(draft.withEdit(edit.copy(description = it))) },
        placeholder = "Optional description",
        label = "Description",
        enabled = enabled,
        minLines = 2,
      )
      CronScheduleEditor(
        schedule = edit.schedule,
        enabled = enabled,
        onChange = { onDraftChange(draft.withEdit(edit.withSchedule(it))) },
      )
      ClawTextField(
        value = edit.sessionTarget,
        onValueChange = { onDraftChange(draft.withEdit(edit.copy(sessionTarget = it))) },
        placeholder = "main, isolated, current, or session:<id>",
        label = "Session target",
        enabled = enabled,
      )
      ClawSegmentedControl(
        options = listOf("next-heartbeat", "now"),
        selected = edit.wakeMode,
        onSelect = { onDraftChange(draft.withEdit(edit.copy(wakeMode = it))) },
        modifier = Modifier.fillMaxWidth(),
        enabledOptions = if (enabled) setOf("next-heartbeat", "now") else emptySet(),
      )
      CronPayloadEditor(
        payload = edit.payload,
        originalCommandCwd = job.payloadCommandCwd,
        enabled = enabled,
        onChange = { onDraftChange(draft.withEdit(edit.copy(payload = it))) },
      )
      ClawPrimaryButton(
        text = if (busy) "Working" else "Save Changes",
        onClick = {
          onDraftChange(draft.saveStarted())
          onSave(edit)
        },
        modifier = Modifier.fillMaxWidth(),
        enabled =
          enabled &&
            draft.isDirty &&
            !draft.hasIncomingConflict &&
            !draft.savePending &&
            !draft.saveSucceeded,
        icon = Icons.Default.Save,
      )
      if (draft.requiresResolution) {
        ClawSecondaryButton(
          text = "Revert Changes",
          onClick = { onDraftChange(CronEditorDraftState.from(job)) },
          modifier = Modifier.fillMaxWidth(),
          enabled = canRevert,
        )
      }
    }
  }
}

@Composable
private fun CronSwitchRow(
  title: String,
  subtitle: String,
  checked: Boolean,
  onCheckedChange: (Boolean) -> Unit,
  enabled: Boolean,
) {
  Row(
    modifier = Modifier.fillMaxWidth().heightIn(min = 50.dp),
    verticalAlignment = Alignment.CenterVertically,
    horizontalArrangement = Arrangement.spacedBy(9.dp),
  ) {
    Column(modifier = Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(1.dp)) {
      Text(text = title, style = ClawTheme.type.body, color = ClawTheme.colors.text)
      Text(
        text = subtitle,
        style = ClawTheme.type.caption,
        color = ClawTheme.colors.textMuted,
        maxLines = 2,
        overflow = TextOverflow.Ellipsis,
      )
    }
    Switch(
      checked = checked,
      onCheckedChange = onCheckedChange,
      enabled = enabled,
      modifier = Modifier.semantics { contentDescription = title },
    )
  }
}

@Composable
private fun CronScheduleEditor(
  schedule: GatewayCronScheduleEdit,
  enabled: Boolean,
  onChange: (GatewayCronScheduleEdit) -> Unit,
) {
  Text(
    text = "Schedule · ${cronScheduleKindLabel(schedule)}",
    style = ClawTheme.type.caption,
    color = ClawTheme.colors.textMuted,
  )
  when (schedule) {
    is GatewayCronScheduleEdit.At ->
      ClawTextField(
        value = schedule.at,
        onValueChange = { onChange(schedule.copy(at = it)) },
        placeholder = "ISO time, e.g. 2026-07-09T09:30:00Z",
        label = "Run at",
        enabled = enabled,
      )
    is GatewayCronScheduleEdit.Every -> {
      ClawTextField(
        value = schedule.everyMs,
        onValueChange = { onChange(schedule.copy(everyMs = it.filter(Char::isDigit))) },
        placeholder = "Milliseconds",
        label = "Interval",
        enabled = enabled,
      )
      ClawTextField(
        value = schedule.anchorMs,
        onValueChange = { onChange(schedule.copy(anchorMs = it.filter(Char::isDigit))) },
        placeholder = "Epoch milliseconds (optional)",
        label = "Anchor",
        enabled = enabled,
      )
    }
    is GatewayCronScheduleEdit.Cron -> {
      ClawTextField(
        value = schedule.expression,
        onValueChange = { onChange(schedule.copy(expression = it)) },
        placeholder = "Cron expression, e.g. 0 9 * * *",
        label = "Expression",
        enabled = enabled,
      )
      Row(modifier = Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
        ClawTextField(
          value = schedule.timezone,
          onValueChange = { onChange(schedule.copy(timezone = it)) },
          placeholder = "e.g. America/New_York",
          label = "Timezone",
          enabled = enabled,
          modifier = Modifier.weight(1f),
        )
        ClawTextField(
          value = schedule.staggerMs,
          onValueChange = { onChange(schedule.copy(staggerMs = it.filter(Char::isDigit))) },
          placeholder = "0 = exact",
          label = "Stagger ms",
          enabled = enabled,
          modifier = Modifier.weight(1f),
        )
      }
    }
    is GatewayCronScheduleEdit.OnExit -> {
      ClawTextField(
        value = schedule.command,
        onValueChange = { onChange(schedule.copy(command = it)) },
        placeholder = "Command to watch",
        label = "Command",
        enabled = enabled,
      )
      ClawTextField(
        value = schedule.cwd,
        onValueChange = { onChange(schedule.copy(cwd = it)) },
        placeholder = "Optional path",
        label = "Working directory",
        enabled = enabled,
      )
    }
  }
}

@Composable
private fun CronPayloadEditor(
  payload: GatewayCronPayloadEdit,
  originalCommandCwd: String?,
  enabled: Boolean,
  onChange: (GatewayCronPayloadEdit) -> Unit,
) {
  Text(
    text = "Payload · ${cronPayloadKindLabel(payload)}",
    style = ClawTheme.type.caption,
    color = ClawTheme.colors.textMuted,
  )
  when (payload) {
    is GatewayCronPayloadEdit.SystemEvent ->
      ClawTextField(
        value = payload.text,
        onValueChange = { onChange(payload.copy(text = it)) },
        placeholder = "System event text",
        label = "Event text",
        enabled = enabled,
        minLines = 3,
      )
    is GatewayCronPayloadEdit.AgentTurn -> {
      ClawTextField(
        value = payload.message,
        onValueChange = { onChange(payload.copy(message = it)) },
        placeholder = "Agent message",
        label = "Message",
        enabled = enabled,
        minLines = 3,
      )
      Row(modifier = Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
        ClawTextField(
          value = payload.model,
          onValueChange = { onChange(payload.copy(model = it)) },
          placeholder = "Optional override",
          label = "Model",
          enabled = enabled,
          modifier = Modifier.weight(1f),
        )
        ClawTextField(
          value = payload.thinking,
          onValueChange = { onChange(payload.copy(thinking = it)) },
          placeholder = "Optional override",
          label = "Thinking",
          enabled = enabled,
          modifier = Modifier.weight(1f),
        )
      }
    }
    is GatewayCronPayloadEdit.Command -> {
      val commandCwdCanBeCleared = originalCommandCwd == null
      ClawTextField(
        value = payload.argvJson,
        onValueChange = { onChange(payload.copy(argvJson = it)) },
        placeholder = "Command argv JSON array",
        label = "Arguments",
        enabled = enabled,
        minLines = 2,
      )
      ClawTextField(
        value = payload.cwd,
        onValueChange = { value ->
          if (commandCwdCanBeCleared || value.isNotBlank()) {
            onChange(payload.copy(cwd = value))
          }
        },
        placeholder = "Optional path",
        label =
          if (commandCwdCanBeCleared) {
            "Command working directory"
          } else {
            "Command working directory · cannot clear"
          },
        enabled = enabled,
      )
      if (!commandCwdCanBeCleared) {
        Text(
          text = "The gateway can change this path but cannot clear an existing path.",
          style = ClawTheme.type.caption,
          color = ClawTheme.colors.textMuted,
        )
      }
    }
  }
}

@Composable
private fun CronRunHistoryPanel(
  jobId: String,
  state: GatewayCronRunHistoryState,
  onRefresh: () -> Unit,
) {
  val loading = (state as? GatewayCronRunHistoryState.Loading)?.id == jobId
  val runs = (state as? GatewayCronRunHistoryState.Loaded)?.takeIf { it.id == jobId }?.runs.orEmpty()
  val error = (state as? GatewayCronRunHistoryState.Error)?.takeIf { it.id == jobId }?.message
  Row(
    modifier = Modifier.fillMaxWidth(),
    verticalAlignment = Alignment.CenterVertically,
    horizontalArrangement = Arrangement.spacedBy(8.dp),
  ) {
    Icon(
      imageVector = Icons.Default.History,
      contentDescription = null,
      modifier = Modifier.size(17.dp),
      tint = ClawTheme.colors.text,
    )
    Text(
      text = "Recent Runs",
      style = ClawTheme.type.section,
      color = ClawTheme.colors.text,
      modifier = Modifier.weight(1f),
    )
    ClawSecondaryButton(
      text = if (loading) "Loading" else "Reload",
      onClick = onRefresh,
      enabled = !loading,
      icon = Icons.Default.Refresh,
    )
  }
  when {
    error != null ->
      ClawPanel {
        Text(text = error, style = ClawTheme.type.body, color = ClawTheme.colors.warning)
      }
    runs.isEmpty() ->
      ClawPanel {
        Text(
          text = if (loading) "Loading recent runs…" else "No recent runs yet.",
          style = ClawTheme.type.body,
          color = ClawTheme.colors.textMuted,
        )
      }
    else -> ClawListPanel(items = runs) { run -> CronRunHistoryRow(run) }
  }
}

@Composable
private fun CronRunHistoryRow(run: GatewayCronRunSummary) {
  val status = cronRunStatus(run.status)
  ClawDetailRow(
    title = DateFormat.getDateTimeInstance(DateFormat.SHORT, DateFormat.SHORT).format(Date(run.ts)),
    subtitle = cronRunSubtitle(run),
    leading = { ClawIconBadge(icon = Icons.Default.Schedule) },
    trailing = { ClawStatusPill(text = cronRunStatusText(run.status), status = status) },
  )
}

private fun cronScheduleKindLabel(schedule: GatewayCronScheduleEdit): String =
  when (schedule) {
    is GatewayCronScheduleEdit.At -> "One time"
    is GatewayCronScheduleEdit.Every -> "Interval"
    is GatewayCronScheduleEdit.Cron -> "Cron"
    is GatewayCronScheduleEdit.OnExit -> "On command exit"
  }

private fun cronPayloadKindLabel(payload: GatewayCronPayloadEdit): String =
  when (payload) {
    is GatewayCronPayloadEdit.SystemEvent -> "System event"
    is GatewayCronPayloadEdit.AgentTurn -> "Agent turn"
    is GatewayCronPayloadEdit.Command -> "Command"
  }

private fun cronRunSubtitle(run: GatewayCronRunSummary): String =
  listOfNotNull(
    run.durationMs?.let { "${it}ms" },
    run.deliveryStatus,
    run.model,
    run.error ?: run.summary,
  ).joinToString(" · ").ifBlank { "No details" }

private fun cronRunStatusText(status: String?): String =
  when (status?.lowercase()) {
    "ok" -> "OK"
    "error" -> "Issue"
    "skipped" -> "Skipped"
    else -> "Unknown"
  }

private fun cronRunStatus(status: String?): ClawStatus =
  when (status?.lowercase()) {
    "ok" -> ClawStatus.Success
    "error" -> ClawStatus.Danger
    "skipped" -> ClawStatus.Warning
    else -> ClawStatus.Neutral
  }
