package ai.openclaw.app.ui

import ai.openclaw.app.GatewayModelProviderSummary
import ai.openclaw.app.GatewayModelSummary
import ai.openclaw.app.MainViewModel
import ai.openclaw.app.currentAppLanguage
import ai.openclaw.app.i18n.NativeText
import ai.openclaw.app.i18n.nativeString
import ai.openclaw.app.i18n.nativeText
import ai.openclaw.app.i18n.resolveNativeText
import ai.openclaw.app.i18n.resolveNativeTextResource
import ai.openclaw.app.i18n.verbatimText
import ai.openclaw.app.ui.design.ClawEmptyState
import ai.openclaw.app.ui.design.ClawPanel
import ai.openclaw.app.ui.design.ClawPlainIconButton
import ai.openclaw.app.ui.design.ClawScaffold
import ai.openclaw.app.ui.design.ClawSeparatedColumn
import ai.openclaw.app.ui.design.ClawTextField
import ai.openclaw.app.ui.design.ClawTheme
import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.automirrored.filled.KeyboardArrowRight
import androidx.compose.material.icons.outlined.AccessTime
import androidx.compose.material.icons.outlined.ChatBubbleOutline
import androidx.compose.material.icons.outlined.Inventory2
import androidx.compose.material.icons.outlined.MicNone
import androidx.compose.material.icons.outlined.Settings
import androidx.compose.material3.Icon
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
import androidx.compose.ui.draw.clip
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.platform.LocalSoftwareKeyboardController
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp

/** Full-screen command palette for navigation and recent-session search. */
@Composable
internal fun CommandPalette(
  viewModel: MainViewModel,
  onDismiss: () -> Unit,
  onOpenChat: () -> Unit,
  onOpenVoice: () -> Unit,
  onOpenSessions: () -> Unit,
  onOpenProviders: () -> Unit,
  onOpenSettings: () -> Unit,
  onOpenSession: (String, String?) -> Unit,
) {
  val isConnected by viewModel.isConnected.collectAsState()
  val sessions by viewModel.chatSessions.collectAsState()
  val models by viewModel.providerModelCatalog.collectAsState()
  val providers by viewModel.modelAuthProviders.collectAsState()
  val pendingRunCount by viewModel.pendingRunCount.collectAsState()
  var query by rememberSaveable { mutableStateOf("") }
  val searchFocusRequester = remember { FocusRequester() }
  val keyboardController = LocalSoftwareKeyboardController.current
  LaunchedEffect(searchFocusRequester) {
    searchFocusRequester.requestFocus()
    keyboardController?.show()
  }
  val normalizedQuery = query.trim()
  val quickActions =
    listOf(
      CommandItem(CommandAction.Chat, nativeText("Open Chat"), nativeText("Start or continue a conversation"), Icons.Outlined.ChatBubbleOutline, onOpenChat),
      CommandItem(CommandAction.Voice, nativeText("Start Voice"), nativeText("Talk or dictate with OpenClaw"), Icons.Outlined.MicNone, onOpenVoice),
      CommandItem(CommandAction.Sessions, nativeText("Browse Sessions"), nativeText("Find previous conversations"), Icons.Outlined.AccessTime, onOpenSessions),
      CommandItem(CommandAction.Providers, nativeText("Providers & Models"), verbatimText(providerCommandSubtitle(isConnected, providers, models)), Icons.Outlined.Inventory2, onOpenProviders),
      CommandItem(CommandAction.Settings, nativeText("Settings"), nativeText("Gateway, voice, notifications, privacy"), Icons.Outlined.Settings, onOpenSettings),
    )
  val actionRows = quickActions.filter { it.matches(normalizedQuery) }
  val sessionRows =
    sessions
      .filter { session ->
        val title = commandSessionTitle(session.displayName)
        commandSessionMatches(title = title, query = normalizedQuery)
      }.take(5)

  Surface(modifier = Modifier.fillMaxSize(), color = ClawTheme.colors.canvas, contentColor = ClawTheme.colors.text) {
    ClawScaffold(contentPadding = PaddingValues(start = 20.dp, top = 14.dp, end = 20.dp, bottom = 20.dp)) {
      LazyColumn(verticalArrangement = Arrangement.spacedBy(10.dp)) {
        item {
          Row(
            modifier = Modifier.fillMaxWidth(),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(9.dp),
          ) {
            ClawPlainIconButton(
              icon = Icons.AutoMirrored.Filled.ArrowBack,
              contentDescription = nativeString("Close search"),
              onClick = onDismiss,
            )
            Text(text = nativeString("Search"), style = ClawTheme.type.title, color = ClawTheme.colors.text, modifier = Modifier.weight(1f), textAlign = TextAlign.Center)
            Box(
              modifier = Modifier.size(ClawTheme.spacing.touchTarget),
              contentAlignment = Alignment.Center,
            ) {
              CommandAvatar(text = "OC")
            }
          }
        }

        item {
          ClawTextField(
            value = query,
            onValueChange = { query = it },
            placeholder = nativeString("Search OpenClaw"),
            modifier = Modifier.focusRequester(searchFocusRequester),
          )
        }

        item {
          CommandSectionLabel(title = nativeString("Quick actions"))
        }

        if (actionRows.isEmpty()) {
          item {
            ClawEmptyState(title = nativeString("No actions found"), body = nativeString("Try Chat, Voice, Sessions, Providers, or Settings."))
          }
        } else {
          item {
            CommandActionList(rows = actionRows)
          }
        }

        item {
          CommandSectionLabel(title = nativeString("Sessions"))
        }

        if (sessionRows.isEmpty()) {
          item {
            ClawPanel {
              Text(
                text = if (isConnected) nativeString("No matching sessions yet.") else nativeString("Connect the Gateway to search sessions."),
                style = ClawTheme.type.body,
                color = ClawTheme.colors.textMuted,
              )
            }
          }
        } else {
          item {
            CommandSessionList(
              rows =
                sessionRows.map { session ->
                  CommandSessionRow(
                    key = session.key,
                    ownerAgentId = session.ownerAgentId,
                    title = commandSessionTitle(session.displayName),
                    subtitle = if (pendingRunCount > 0) nativeString("Assistant working") else nativeString("OpenClaw session"),
                    metadata = session.updatedAtMs?.let(::commandRelativeTime) ?: nativeString("now"),
                  )
                },
              onOpen = onOpenSession,
            )
          }
        }
      }
    }
  }
}

internal enum class CommandAction {
  Chat,
  Voice,
  Sessions,
  Providers,
  Settings,
}

internal data class CommandItem(
  val action: CommandAction,
  val title: NativeText,
  val subtitle: NativeText,
  val icon: ImageVector,
  val onClick: () -> Unit,
) {
  /** Matches palette queries against both action title and explanatory subtitle. */
  fun matches(query: String): Boolean =
    query.isEmpty() ||
      title.resolveNativeText().contains(query, ignoreCase = true) ||
      subtitle.resolveNativeText().contains(query, ignoreCase = true)
}

internal fun commandSessionMatches(
  title: String,
  query: String,
): Boolean = query.isEmpty() || title.contains(query, ignoreCase = true)

internal fun commandActionAccessibilityDescription(
  action: CommandAction,
  title: String,
  resolve: (String, String) -> String = { source, argument -> nativeString(source, argument) },
): String =
  when (action) {
    CommandAction.Chat,
    CommandAction.Voice,
    CommandAction.Sessions,
    -> title
    CommandAction.Providers,
    CommandAction.Settings,
    -> resolve("Open \${row.title}", title)
  }

private data class CommandSessionRow(
  val key: String,
  val ownerAgentId: String?,
  val title: String,
  val subtitle: String,
  val metadata: String,
)

@Composable
private fun CommandActionList(rows: List<CommandItem>) {
  ClawPanel(contentPadding = PaddingValues(horizontal = 8.dp, vertical = 0.dp)) {
    ClawSeparatedColumn(items = rows) { row ->
      CommandActionRow(row = row)
    }
  }
}

@Composable
private fun CommandActionRow(row: CommandItem) {
  val title = row.title.resolveNativeTextResource()
  val subtitle = row.subtitle.resolveNativeTextResource()
  Surface(color = Color.Transparent, contentColor = ClawTheme.colors.text) {
    Row(
      modifier =
        Modifier
          .fillMaxWidth()
          .heightIn(min = 52.dp)
          .clip(RoundedCornerShape(ClawTheme.radii.row))
          .clickable(onClickLabel = commandActionAccessibilityDescription(row.action, title), onClick = row.onClick)
          .padding(horizontal = 2.dp, vertical = 6.dp),
      verticalAlignment = Alignment.CenterVertically,
      horizontalArrangement = Arrangement.spacedBy(9.dp),
    ) {
      CommandRowIcon(icon = row.icon)
      Column(modifier = Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(1.dp)) {
        Text(text = title, style = ClawTheme.type.body, color = ClawTheme.colors.text, maxLines = 1, overflow = TextOverflow.Ellipsis)
        Text(text = subtitle, style = ClawTheme.type.caption, color = ClawTheme.colors.textMuted, maxLines = 1, overflow = TextOverflow.Ellipsis)
      }
      CommandRowChevron(contentDescription = null)
    }
  }
}

@Composable
private fun CommandSessionList(
  rows: List<CommandSessionRow>,
  onOpen: (String, String?) -> Unit,
) {
  ClawPanel(contentPadding = PaddingValues(horizontal = 8.dp, vertical = 0.dp)) {
    ClawSeparatedColumn(items = rows) { row ->
      CommandSessionListRow(row = row, onClick = { onOpen(row.key, row.ownerAgentId) })
    }
  }
}

@Composable
private fun CommandSessionListRow(
  row: CommandSessionRow,
  onClick: () -> Unit,
) {
  Surface(color = ClawTheme.colors.canvas, contentColor = ClawTheme.colors.text) {
    Row(
      modifier =
        Modifier
          .fillMaxWidth()
          .heightIn(min = 58.dp)
          .clip(RoundedCornerShape(ClawTheme.radii.row))
          .clickable(onClick = onClick)
          .padding(horizontal = 2.dp, vertical = 6.dp),
      verticalAlignment = Alignment.CenterVertically,
      horizontalArrangement = Arrangement.spacedBy(8.dp),
    ) {
      CommandRowIcon(icon = Icons.Outlined.ChatBubbleOutline)
      Column(modifier = Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(1.dp)) {
        Text(text = row.title, style = ClawTheme.type.body, color = ClawTheme.colors.text, maxLines = 1, overflow = TextOverflow.Ellipsis)
        Text(text = row.subtitle, style = ClawTheme.type.caption, color = ClawTheme.colors.textSubtle, maxLines = 1, overflow = TextOverflow.Ellipsis)
      }
      Text(text = row.metadata, style = ClawTheme.type.caption, color = ClawTheme.colors.textMuted, maxLines = 1, overflow = TextOverflow.Ellipsis)
      CommandRowChevron(contentDescription = nativeString("Open session"))
    }
  }
}

@Composable
private fun CommandRowIcon(icon: ImageVector) {
  Surface(
    modifier = Modifier.size(30.dp),
    shape = CircleShape,
    color = ClawTheme.colors.canvas,
    border = BorderStroke(1.dp, ClawTheme.colors.borderStrong),
  ) {
    Box(contentAlignment = Alignment.Center) {
      Icon(imageVector = icon, contentDescription = null, modifier = Modifier.size(15.dp), tint = ClawTheme.colors.text)
    }
  }
}

@Composable
private fun CommandRowChevron(contentDescription: String?) {
  Box(modifier = Modifier.size(24.dp), contentAlignment = Alignment.Center) {
    Icon(
      imageVector = Icons.AutoMirrored.Filled.KeyboardArrowRight,
      contentDescription = contentDescription,
      modifier = Modifier.size(17.dp),
      tint = ClawTheme.colors.textMuted,
    )
  }
}

@Composable
private fun CommandAvatar(text: String) {
  Surface(
    modifier = Modifier.size(34.dp),
    shape = CircleShape,
    color = ClawTheme.colors.surfaceRaised,
    contentColor = ClawTheme.colors.text,
    border = BorderStroke(1.dp, ClawTheme.colors.border),
  ) {
    Box(contentAlignment = Alignment.Center) {
      Text(text = localizedUppercase(text.take(2), currentAppLanguage().languageTag), style = ClawTheme.type.label)
    }
  }
}

@Composable
private fun CommandSectionLabel(title: String) {
  Row(modifier = Modifier.fillMaxWidth()) {
    Text(text = localizedUppercase(title, currentAppLanguage().languageTag), style = ClawTheme.type.caption, color = ClawTheme.colors.textMuted)
  }
}

internal fun providerCommandSubtitle(
  isConnected: Boolean,
  providers: List<GatewayModelProviderSummary>,
  models: List<GatewayModelSummary>,
): String {
  if (!isConnected) return nativeString("Connect Gateway to view providers")
  val rows = providerRows(providers = providers, models = models)
  val readyProviderCount = rows.count { it.ready }
  if (readyProviderCount > 0) return nativeString("\$readyProviderCount providers ready", readyProviderCount)
  if (rows.any { it.availability == ProviderAvailability.Unknown }) return nativeString("Provider availability unknown")
  return nativeString("No ready providers")
}

/** Falls back to the canonical main-session label when gateway display names are blank. */
private fun commandSessionTitle(displayName: String?): String = displayName?.takeIf { it.isNotBlank() } ?: nativeString("Main session")

/** Formats command-palette session timestamps for compact rows. */
internal fun commandRelativeTime(
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
