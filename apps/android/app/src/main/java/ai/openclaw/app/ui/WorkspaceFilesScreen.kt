package ai.openclaw.app.ui

import ai.openclaw.app.GatewayWorkspaceEntry
import ai.openclaw.app.GatewayWorkspaceFile
import ai.openclaw.app.MainViewModel
import ai.openclaw.app.i18n.nativeString
import ai.openclaw.app.ui.chat.ChatCodeBlock
import ai.openclaw.app.ui.chat.rememberBase64ImageState
import ai.openclaw.app.ui.design.ClawEmptyState
import ai.openclaw.app.ui.design.ClawPlainIconButton
import ai.openclaw.app.ui.design.ClawScaffold
import ai.openclaw.app.ui.design.ClawTheme
import android.content.Context
import android.content.Intent
import android.text.format.Formatter
import android.util.Base64
import androidx.activity.compose.BackHandler
import androidx.compose.foundation.Image
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
import androidx.compose.foundation.layout.only
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.safeDrawing
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.selection.SelectionContainer
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.outlined.Description
import androidx.compose.material.icons.outlined.Folder
import androidx.compose.material.icons.outlined.Refresh
import androidx.compose.material.icons.outlined.Share
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.Icon
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.key
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.core.content.FileProvider
import kotlinx.coroutines.launch
import java.io.File
import java.text.DateFormat
import java.util.Date
import java.util.UUID

/**
 * Read-only workspace browser for the active agent, backed by the
 * `agents.workspace.list` / `agents.workspace.get` gateway RPCs.
 */
@Composable
internal fun WorkspaceFilesScreen(
  viewModel: MainViewModel,
  onBack: () -> Unit,
) {
  val mainSessionKey by viewModel.mainSessionKey.collectAsState()
  val gatewayDefaultAgentId by viewModel.gatewayDefaultAgentId.collectAsState()

  // Runtime routing derives the active agent from these two facts. Re-key the
  // local browser with the same facts so paths from one agent never cross over.
  key(mainSessionKey, gatewayDefaultAgentId) {
    var pathStack by rememberSaveable { mutableStateOf(listOf("")) }
    var previewPath by rememberSaveable { mutableStateOf<String?>(null) }

    BackHandler(enabled = previewPath != null || pathStack.size > 1) {
      if (previewPath != null) {
        previewPath = null
      } else {
        pathStack = pathStack.dropLast(1)
      }
    }

    val openPreview = previewPath
    if (openPreview != null) {
      WorkspaceFilePreview(
        viewModel = viewModel,
        path = openPreview,
        onBack = { previewPath = null },
      )
    } else {
      WorkspaceDirectoryScreen(
        viewModel = viewModel,
        path = pathStack.last(),
        onBack = {
          if (pathStack.size > 1) pathStack = pathStack.dropLast(1) else onBack()
        },
        onOpenDirectory = { path -> pathStack = pathStack + path },
        onOpenFile = { path -> previewPath = path },
      )
    }
  }
}

internal fun isWorkspaceDirectoryRequestInFlight(
  loading: Boolean,
  loadingMore: Boolean,
): Boolean = loading || loadingMore

@Composable
private fun WorkspaceDirectoryScreen(
  viewModel: MainViewModel,
  path: String,
  onBack: () -> Unit,
  onOpenDirectory: (String) -> Unit,
  onOpenFile: (String) -> Unit,
) {
  val isConnected by viewModel.isConnected.collectAsState()
  val scope = rememberCoroutineScope()
  var entries by remember(path) { mutableStateOf<List<GatewayWorkspaceEntry>>(emptyList()) }
  var totalEntries by remember(path) { mutableIntStateOf(0) }
  var loading by remember(path) { mutableStateOf(false) }
  var loadingMore by remember(path) { mutableStateOf(false) }
  var errorText by remember(path) { mutableStateOf<String?>(null) }
  var refreshNonce by remember(path) { mutableIntStateOf(0) }
  val requestInFlight = isWorkspaceDirectoryRequestInFlight(loading, loadingMore)

  LaunchedEffect(path, isConnected, refreshNonce) {
    if (!isConnected) {
      errorText = nativeString("Connect the gateway to browse workspace files.")
      return@LaunchedEffect
    }
    loading = true
    errorText = null
    try {
      val listing = viewModel.listWorkspaceFiles(path = path.ifEmpty { null })
      entries = listing.entries
      totalEntries = listing.totalEntries
    } catch (_: Throwable) {
      errorText = nativeString("Could not load this folder.")
    } finally {
      loading = false
    }
  }

  ClawScaffold(
    contentPadding = PaddingValues(start = 16.dp, top = 10.dp, end = 16.dp, bottom = 4.dp),
    contentWindowInsets = WindowInsets.safeDrawing.only(WindowInsetsSides.Top + WindowInsetsSides.Horizontal),
  ) {
    LazyColumn(
      modifier = Modifier.fillMaxSize(),
      verticalArrangement = Arrangement.spacedBy(6.dp),
      contentPadding = PaddingValues(bottom = 8.dp),
    ) {
      item {
        Row(
          modifier = Modifier.fillMaxWidth(),
          verticalAlignment = Alignment.CenterVertically,
          horizontalArrangement = Arrangement.spacedBy(8.dp),
        ) {
          ClawPlainIconButton(icon = Icons.AutoMirrored.Filled.ArrowBack, contentDescription = nativeString("Back"), onClick = onBack)
          Column(modifier = Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(1.dp)) {
            Text(
              text = if (path.isEmpty()) nativeString("Files") else path.substringAfterLast('/'),
              style = ClawTheme.type.display.copy(fontSize = 24.sp, lineHeight = 28.sp),
              color = ClawTheme.colors.text,
            )
            if (path.isNotEmpty()) {
              Text(
                text = path,
                style = ClawTheme.type.caption,
                color = ClawTheme.colors.textMuted,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
              )
            }
          }
          if (requestInFlight) {
            Box(modifier = Modifier.size(ClawTheme.spacing.touchTarget), contentAlignment = Alignment.Center) {
              CircularProgressIndicator(modifier = Modifier.size(18.dp), strokeWidth = 2.dp)
            }
          } else if (isConnected) {
            ClawPlainIconButton(
              icon = Icons.Outlined.Refresh,
              contentDescription = nativeString("Refresh"),
              onClick = {
                if (!isWorkspaceDirectoryRequestInFlight(loading, loadingMore)) {
                  loading = true
                  refreshNonce += 1
                }
              },
            )
          }
        }
      }

      errorText?.let { message ->
        item {
          ClawEmptyState(title = nativeString("Files unavailable"), body = message)
        }
      }

      if (errorText == null && !loading && entries.isEmpty()) {
        item {
          ClawEmptyState(title = nativeString("Empty folder"), body = nativeString("This folder has no files yet."))
        }
      }

      items(entries.size, key = { index -> entries[index].path }) { index ->
        val entry = entries[index]
        WorkspaceEntryRow(
          entry = entry,
          onClick = {
            if (entry.isDirectory) onOpenDirectory(entry.path) else onOpenFile(entry.path)
          },
        )
      }

      if (entries.size < totalEntries) {
        item {
          Row(
            modifier =
              Modifier
                .fillMaxWidth()
                .clip(RoundedCornerShape(ClawTheme.radii.row))
                .clickable(enabled = !requestInFlight) {
                  if (isWorkspaceDirectoryRequestInFlight(loading, loadingMore)) return@clickable
                  loadingMore = true
                  scope.launch {
                    try {
                      val listing = viewModel.listWorkspaceFiles(path = path.ifEmpty { null }, offset = entries.size)
                      val known = entries.map { it.path }.toSet()
                      entries = entries + listing.entries.filter { it.path !in known }
                      totalEntries = listing.totalEntries
                    } catch (_: Throwable) {
                      errorText = nativeString("Could not load this folder.")
                    } finally {
                      loadingMore = false
                    }
                  }
                }.padding(horizontal = 10.dp, vertical = 12.dp),
            horizontalArrangement = Arrangement.SpaceBetween,
            verticalAlignment = Alignment.CenterVertically,
          ) {
            Text(text = nativeString("Load more"), style = ClawTheme.type.body, color = ClawTheme.colors.text)
            Text(
              text = nativeString("\${entries.size} of \$totalEntries", entries.size, totalEntries),
              style = ClawTheme.type.caption,
              color = ClawTheme.colors.textMuted,
            )
          }
        }
      }

      if (loading && entries.isEmpty() && errorText == null) {
        item {
          Row(modifier = Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.Center) {
            CircularProgressIndicator(modifier = Modifier.size(22.dp))
          }
        }
      }
    }
  }
}

@Composable
private fun WorkspaceEntryRow(
  entry: GatewayWorkspaceEntry,
  onClick: () -> Unit,
) {
  val context = LocalContext.current
  Row(
    modifier =
      Modifier
        .fillMaxWidth()
        .clip(RoundedCornerShape(ClawTheme.radii.row))
        .clickable(onClick = onClick)
        .padding(horizontal = 10.dp, vertical = 10.dp),
    verticalAlignment = Alignment.CenterVertically,
    horizontalArrangement = Arrangement.spacedBy(10.dp),
  ) {
    Icon(
      imageVector = if (entry.isDirectory) Icons.Outlined.Folder else Icons.Outlined.Description,
      contentDescription = null,
      tint = if (entry.isDirectory) ClawTheme.colors.primary else ClawTheme.colors.textMuted,
      modifier = Modifier.size(20.dp),
    )
    Column(modifier = Modifier.weight(1f)) {
      Text(text = entry.name, style = ClawTheme.type.body.copy(lineBreak = androidx.compose.ui.text.style.LineBreak.Heading), color = ClawTheme.colors.text)
      workspaceEntryDetail(context, entry)?.let { detail ->
        Text(text = detail, style = ClawTheme.type.caption, color = ClawTheme.colors.textMuted, maxLines = 1)
      }
    }
  }
}

private fun workspaceEntryDetail(
  context: Context,
  entry: GatewayWorkspaceEntry,
): String? {
  val parts = mutableListOf<String>()
  entry.size?.let { parts.add(Formatter.formatShortFileSize(context, it)) }
  entry.updatedAtMs?.let { parts.add(DateFormat.getDateInstance(DateFormat.SHORT).format(Date(it))) }
  return parts.takeIf { it.isNotEmpty() }?.joinToString(" • ")
}

@Composable
private fun WorkspaceFilePreview(
  viewModel: MainViewModel,
  path: String,
  onBack: () -> Unit,
) {
  val context = LocalContext.current
  var file by remember(path) { mutableStateOf<GatewayWorkspaceFile?>(null) }
  var loading by remember(path) { mutableStateOf(false) }
  var errorText by remember(path) { mutableStateOf<String?>(null) }

  LaunchedEffect(path) {
    loading = true
    errorText = null
    try {
      file = viewModel.fetchWorkspaceFile(path)
    } catch (_: Throwable) {
      errorText = nativeString("This file cannot be previewed. It may be binary or too large.")
    } finally {
      loading = false
    }
  }

  ClawScaffold(
    contentPadding = PaddingValues(start = 16.dp, top = 10.dp, end = 16.dp, bottom = 4.dp),
    contentWindowInsets = WindowInsets.safeDrawing.only(WindowInsetsSides.Top + WindowInsetsSides.Horizontal),
  ) {
    Column(modifier = Modifier.fillMaxSize(), verticalArrangement = Arrangement.spacedBy(8.dp)) {
      Row(
        modifier = Modifier.fillMaxWidth(),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(8.dp),
      ) {
        ClawPlainIconButton(icon = Icons.AutoMirrored.Filled.ArrowBack, contentDescription = nativeString("Back"), onClick = onBack)
        Text(
          text = path.substringAfterLast('/'),
          style = ClawTheme.type.display.copy(fontSize = 20.sp, lineHeight = 24.sp, lineBreak = androidx.compose.ui.text.style.LineBreak.Heading),
          color = ClawTheme.colors.text,
          softWrap = true,
          modifier = Modifier.weight(1f),
        )
        file?.let { loaded ->
          ClawPlainIconButton(
            icon = Icons.Outlined.Share,
            contentDescription = nativeString("Share file"),
            onClick = { shareWorkspaceFile(context, loaded) },
          )
        }
      }

      when {
        loading ->
          Row(modifier = Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.Center) {
            CircularProgressIndicator(modifier = Modifier.size(22.dp))
          }
        errorText != null ->
          ClawEmptyState(title = nativeString("No preview"), body = errorText.orEmpty())
        file != null ->
          WorkspaceFileContent(file = file ?: return@Column)
      }
    }
  }
}

@Composable
private fun WorkspaceFileContent(file: GatewayWorkspaceFile) {
  if (file.isBase64 && file.mimeType.startsWith("image/")) {
    val imageState = rememberBase64ImageState(file.content)
    when {
      imageState.image != null ->
        Image(
          bitmap = imageState.image,
          contentDescription = file.name,
          modifier = Modifier.fillMaxWidth().verticalScroll(rememberScrollState()),
        )
      imageState.failed -> ClawEmptyState(title = nativeString("No preview"), body = nativeString("This image could not be decoded."))
      else -> CircularProgressIndicator(modifier = Modifier.size(22.dp))
    }
  } else {
    // Reuse the chat renderer's code block so previews highlight and cap
    // exactly like fenced code in the transcript.
    SelectionContainer {
      Column(
        modifier =
          Modifier
            .fillMaxSize()
            .verticalScroll(rememberScrollState())
            .padding(bottom = 12.dp),
      ) {
        ChatCodeBlock(code = file.content, language = workspaceLanguageHint(file.name))
      }
    }
  }
}

/** File extensions double as fence language hints; unknown ones render plain. */
private fun workspaceLanguageHint(name: String): String? = name.substringAfterLast('.', missingDelimiterValue = "").lowercase().ifEmpty { null }

/** Exports one previewed file through the system share sheet via FileProvider. */
private fun shareWorkspaceFile(
  context: Context,
  file: GatewayWorkspaceFile,
) {
  // A FileProvider grant can outlive the share sheet. Unique directories keep
  // a later same-basename export from replacing bytes behind an older grant.
  val directory = File(context.cacheDir, "workspace-files/${UUID.randomUUID()}").apply { mkdirs() }
  // Server names are plain basenames; keep the guard so a hostile gateway
  // cannot steer the temp write outside the export directory.
  val safeName = file.name.substringAfterLast('/').ifEmpty { "file" }
  val target = File(directory, safeName)
  if (file.isBase64) {
    val bytes = runCatching { Base64.decode(file.content, Base64.DEFAULT) }.getOrNull() ?: return
    target.writeBytes(bytes)
  } else {
    target.writeText(file.content)
  }
  val uri = FileProvider.getUriForFile(context, "${context.packageName}.fileprovider", target)
  val send =
    Intent(Intent.ACTION_SEND).apply {
      type = file.mimeType.ifEmpty { "application/octet-stream" }
      putExtra(Intent.EXTRA_STREAM, uri)
      addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
    }
  context.startActivity(Intent.createChooser(send, file.name))
}
