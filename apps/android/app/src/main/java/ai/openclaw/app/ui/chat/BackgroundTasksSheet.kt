package ai.openclaw.app.ui.chat

import ai.openclaw.app.MainViewModel
import ai.openclaw.app.chat.BackgroundTask
import ai.openclaw.app.chat.BackgroundTaskDisplayStatus
import ai.openclaw.app.i18n.nativeString
import ai.openclaw.app.ui.design.ClawStatus
import ai.openclaw.app.ui.design.ClawStatusPill
import ai.openclaw.app.ui.design.ClawTheme
import ai.openclaw.app.ui.foldAwareSheet
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.selection.SelectionContainer
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.filled.ChevronRight
import androidx.compose.material.icons.filled.Refresh
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.rememberModalBottomSheetState
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Job
import kotlinx.coroutines.launch

private class BackgroundTaskReads {
  var disposed = false
  var listToken: Any? = null
  var detailToken: Any? = null
  var listJob: Job? = null
  var detailJob: Job? = null
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
internal fun BackgroundTasksSheet(
  viewModel: MainViewModel,
  opening: ChatModelPickerSession,
  admit: () -> Boolean,
  onDismiss: () -> Unit,
) {
  var tasks by remember(opening) { mutableStateOf<List<BackgroundTask>>(emptyList()) }
  var selectedTask by remember(opening) { mutableStateOf<BackgroundTask?>(null) }
  var loading by remember(opening) { mutableStateOf(true) }
  var detailLoading by remember(opening) { mutableStateOf(false) }
  var listError by remember(opening) { mutableStateOf<String?>(null) }
  var detailError by remember(opening) { mutableStateOf<String?>(null) }
  val reads = remember(opening) { BackgroundTaskReads() }
  val scope = rememberCoroutineScope()

  // Reads can finish before first placement or after a same-owner disconnect.
  // Only user actions require placed geometry; neither completion gate requires a live socket.
  fun isCurrent() = !reads.disposed && !opening.geometry.revoked && viewModel.isCurrentChatComposerOwner(opening.composerOwner)

  fun loadTasks() {
    if (!isCurrent()) return
    val token = Any()
    reads.listToken = token
    reads.listJob?.cancel()
    loading = true
    listError = null
    reads.listJob =
      scope.launch {
        if (!isCurrent() || reads.listToken !== token) return@launch
        try {
          val result = viewModel.listBackgroundTasks(opening.composerOwner.agentId)
          if (isCurrent() && reads.listToken === token) tasks = result
        } catch (failure: Exception) {
          if (failure is CancellationException) throw failure
          if (isCurrent() && reads.listToken === token) {
            listError = failure.message ?: nativeString("Couldn’t load background tasks")
          }
        } finally {
          if (isCurrent() && reads.listToken === token) loading = false
        }
      }
  }

  fun selectTask(task: BackgroundTask) {
    if (!admit()) return
    val token = Any()
    reads.detailToken = token
    reads.detailJob?.cancel()
    selectedTask = task
    detailLoading = true
    detailError = null
    reads.detailJob =
      scope.launch {
        if (!isCurrent() || reads.detailToken !== token) return@launch
        try {
          val result = viewModel.getBackgroundTask(task.id)
          if (isCurrent() && reads.detailToken === token) selectedTask = result
        } catch (failure: Exception) {
          if (failure is CancellationException) throw failure
          if (isCurrent() && reads.detailToken === token) {
            detailError = failure.message ?: nativeString("Couldn’t load task details")
          }
        } finally {
          if (isCurrent() && reads.detailToken === token) detailLoading = false
        }
      }
  }

  LaunchedEffect(opening) { loadTasks() }
  DisposableEffect(opening) {
    onDispose {
      reads.disposed = true
      reads.listToken = null
      reads.detailToken = null
      reads.listJob?.cancel()
      reads.detailJob?.cancel()
    }
  }

  ModalBottomSheet(
    modifier = Modifier.foldAwareSheet(opening.geometry),
    onDismissRequest = onDismiss,
    sheetState = rememberModalBottomSheetState(skipPartiallyExpanded = true),
    containerColor = ClawTheme.colors.surface,
    contentColor = ClawTheme.colors.text,
  ) {
    if (selectedTask != null) {
      BackgroundTaskDetail(
        task = selectedTask!!,
        loading = detailLoading,
        error = detailError,
        onBack = {
          if (admit()) {
            // Retire the detail result before cancellation or deferred Compose removal.
            reads.detailToken = null
            reads.detailJob?.cancel()
            selectedTask = null
            detailLoading = false
            detailError = null
          }
        },
      )
    } else {
      BackgroundTaskList(
        tasks = tasks,
        loading = loading,
        error = listError,
        onRefresh = { if (admit()) loadTasks() },
        onSelect = ::selectTask,
      )
    }
  }
}

@Composable
private fun BackgroundTaskList(
  tasks: List<BackgroundTask>,
  loading: Boolean,
  error: String?,
  onRefresh: () -> Unit,
  onSelect: (BackgroundTask) -> Unit,
) {
  val running = tasks.filter(BackgroundTask::isActive)
  val finished = tasks.filterNot(BackgroundTask::isActive)
  LazyColumn(
    modifier = Modifier.fillMaxWidth().heightIn(max = 620.dp),
    contentPadding = PaddingValues(bottom = 28.dp),
  ) {
    item {
      Row(
        modifier = Modifier.fillMaxWidth().padding(start = 20.dp, end = 10.dp, bottom = 12.dp),
        verticalAlignment = Alignment.CenterVertically,
      ) {
        Text(
          text = nativeString("Background tasks"),
          style = ClawTheme.type.title,
          modifier = Modifier.weight(1f),
        )
        if (loading) {
          CircularProgressIndicator(modifier = Modifier.padding(12.dp), strokeWidth = 2.dp)
        } else {
          IconButton(onClick = onRefresh) {
            Icon(Icons.Default.Refresh, contentDescription = nativeString("Refresh background tasks"))
          }
        }
      }
    }
    error?.let { message ->
      item {
        Text(
          text = message,
          style = ClawTheme.type.caption,
          color = ClawTheme.colors.danger,
          modifier = Modifier.padding(horizontal = 20.dp, vertical = 8.dp),
        )
      }
    }
    if (backgroundTasksEmptyStateVisible(loading, error, tasks.size)) {
      item {
        Text(
          text = nativeString("No background tasks for this agent."),
          style = ClawTheme.type.body,
          color = ClawTheme.colors.textMuted,
          modifier = Modifier.padding(horizontal = 20.dp, vertical = 24.dp),
        )
      }
    }
    taskSection(nativeString("Running"), running, onSelect)
    taskSection(nativeString("Finished"), finished, onSelect)
  }
}

internal fun backgroundTasksEmptyStateVisible(
  loading: Boolean,
  error: String?,
  taskCount: Int,
): Boolean = !loading && error == null && taskCount == 0

private fun androidx.compose.foundation.lazy.LazyListScope.taskSection(
  title: String,
  tasks: List<BackgroundTask>,
  onSelect: (BackgroundTask) -> Unit,
) {
  if (tasks.isEmpty()) return
  item(key = "section-$title") {
    Text(
      text = title,
      style = ClawTheme.type.caption,
      color = ClawTheme.colors.textMuted,
      modifier = Modifier.padding(start = 20.dp, top = 16.dp, end = 20.dp, bottom = 6.dp),
    )
  }
  items(tasks, key = BackgroundTask::id) { task ->
    val statusLabel = backgroundTaskStatusLabel(task)
    Surface(
      onClick = { onSelect(task) },
      modifier = Modifier.fillMaxWidth(),
      color = Color.Transparent,
      contentColor = ClawTheme.colors.text,
    ) {
      Row(
        modifier = Modifier.fillMaxWidth().padding(horizontal = 20.dp, vertical = 13.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(12.dp),
      ) {
        Column(modifier = Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(6.dp)) {
          Text(
            text = task.displayTitle,
            style = ClawTheme.type.body,
            maxLines = 2,
            overflow = TextOverflow.Ellipsis,
          )
          Row(horizontalArrangement = Arrangement.spacedBy(8.dp), verticalAlignment = Alignment.CenterVertically) {
            ClawStatusPill(
              text = statusLabel,
              status =
                when {
                  task.isActive -> ClawStatus.Warning
                  task.status == "completed" -> ClawStatus.Success
                  else -> ClawStatus.Danger
                },
            )
            Text(task.runtime, style = ClawTheme.type.caption, color = ClawTheme.colors.textMuted)
          }
          task.output?.let { output ->
            Text(
              text = output,
              style = ClawTheme.type.caption,
              color = ClawTheme.colors.textMuted,
              maxLines = 2,
              overflow = TextOverflow.Ellipsis,
            )
          }
        }
        Icon(Icons.Default.ChevronRight, contentDescription = null, tint = ClawTheme.colors.textMuted)
      }
    }
    HorizontalDivider(color = ClawTheme.colors.border, thickness = 1.dp)
  }
}

@Composable
private fun BackgroundTaskDetail(
  task: BackgroundTask,
  loading: Boolean,
  error: String?,
  onBack: () -> Unit,
) {
  val statusLabel = backgroundTaskStatusLabel(task)
  LazyColumn(
    modifier = Modifier.fillMaxWidth().heightIn(max = 620.dp),
    contentPadding = PaddingValues(bottom = 28.dp),
  ) {
    item {
      Row(
        modifier = Modifier.fillMaxWidth().padding(start = 8.dp, end = 20.dp, bottom = 10.dp),
        verticalAlignment = Alignment.CenterVertically,
      ) {
        IconButton(onClick = onBack) {
          Icon(Icons.AutoMirrored.Filled.ArrowBack, contentDescription = nativeString("Back to background tasks"))
        }
        Column(modifier = Modifier.weight(1f)) {
          Text(task.displayTitle, style = ClawTheme.type.title, maxLines = 2, overflow = TextOverflow.Ellipsis)
          Text(
            text =
              nativeString(
                "\${statusLabel} · \${task.runtime}",
                statusLabel,
                task.runtime,
              ),
            style = ClawTheme.type.caption,
            color = ClawTheme.colors.textMuted,
          )
        }
        if (loading) CircularProgressIndicator(strokeWidth = 2.dp)
      }
    }
    error?.let { message ->
      item {
        Text(
          text = message,
          style = ClawTheme.type.caption,
          color = ClawTheme.colors.danger,
          modifier = Modifier.padding(horizontal = 20.dp, vertical = 8.dp),
        )
      }
    }
    item { TaskTextBlock(label = nativeString("Prompt"), text = task.prompt ?: nativeString("Prompt unavailable")) }
    item { TaskTextBlock(label = nativeString("Output"), text = task.output ?: nativeString("No output yet")) }
  }
}

private fun backgroundTaskStatusLabel(task: BackgroundTask): String =
  when (task.displayStatus) {
    BackgroundTaskDisplayStatus.Queued -> nativeString("Queued")
    BackgroundTaskDisplayStatus.Running -> nativeString("Running")
    BackgroundTaskDisplayStatus.Completed -> nativeString("Completed")
    BackgroundTaskDisplayStatus.Failed -> nativeString("Failed")
  }

@Composable
private fun TaskTextBlock(
  label: String,
  text: String,
) {
  Column(
    modifier = Modifier.fillMaxWidth().padding(horizontal = 20.dp, vertical = 10.dp),
    verticalArrangement = Arrangement.spacedBy(7.dp),
  ) {
    Text(label, style = ClawTheme.type.caption, color = ClawTheme.colors.textMuted)
    Surface(
      modifier = Modifier.fillMaxWidth(),
      color = ClawTheme.colors.surfaceRaised,
      contentColor = ClawTheme.colors.text,
      shape = RoundedCornerShape(ClawTheme.radii.panel),
    ) {
      SelectionContainer {
        Text(text, style = ClawTheme.type.mono, modifier = Modifier.padding(12.dp))
      }
    }
  }
}
