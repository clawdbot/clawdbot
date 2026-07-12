package ai.openclaw.app.ui

import ai.openclaw.app.MainViewModel
import ai.openclaw.app.chat.ChatSessionEntry
import ai.openclaw.app.i18n.nativeString
import ai.openclaw.app.ui.design.ClawEmptyState
import ai.openclaw.app.ui.design.ClawLoadingState
import ai.openclaw.app.ui.design.ClawPlainIconButton
import ai.openclaw.app.ui.design.ClawPrimaryButton
import ai.openclaw.app.ui.design.ClawScaffold
import ai.openclaw.app.ui.design.ClawTheme
import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.background
import androidx.compose.foundation.combinedClickable
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
import androidx.compose.foundation.layout.only
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.safeDrawing
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Close
import androidx.compose.material.icons.filled.KeyboardArrowDown
import androidx.compose.material.icons.filled.KeyboardArrowUp
import androidx.compose.material.icons.filled.PushPin
import androidx.compose.material.icons.filled.Search
import androidx.compose.material.icons.filled.StarBorder
import androidx.compose.material.icons.filled.Storage
import androidx.compose.material.icons.outlined.AccessTime
import androidx.compose.material.icons.outlined.Archive
import androidx.compose.material.icons.outlined.ChatBubbleOutline
import androidx.compose.material.icons.outlined.MicNone
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
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
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch

/** Session browser for active, current, and archived chat sessions. */
@Composable
internal fun SessionsScreen(
  viewModel: MainViewModel,
  onOpenChat: () -> Unit,
) {
  val sessions by viewModel.chatSessions.collectAsState()
  val chatSessionKey by viewModel.chatSessionKey.collectAsState()
  val isConnected by viewModel.isConnected.collectAsState()
  val coroutineScope = rememberCoroutineScope()
  val searchFocusRequester = remember { FocusRequester() }
  val keyboardController = LocalSoftwareKeyboardController.current
  var filter by rememberSaveable { mutableStateOf(SessionFilter.Recent) }
  var compactLayout by rememberSaveable { mutableStateOf(false) }
  var recentFirst by rememberSaveable { mutableStateOf(true) }
  var sortMenuExpanded by remember { mutableStateOf(false) }
  var renameSessionKey by rememberSaveable { mutableStateOf<String?>(null) }
  var groupSessionKey by rememberSaveable { mutableStateOf<String?>(null) }
  var deleteSessionKey by rememberSaveable { mutableStateOf<String?>(null) }
  var searchText by rememberSaveable { mutableStateOf("") }
  var searchResults by remember { mutableStateOf<List<ChatSessionEntry>>(emptyList()) }
  var searchLoading by remember { mutableStateOf(false) }
  val searchQuery = searchText.trim()
  var renameGroupName by rememberSaveable { mutableStateOf<String?>(null) }
  var deleteGroupName by rememberSaveable { mutableStateOf<String?>(null) }
  var newGroupDialogVisible by rememberSaveable { mutableStateOf(false) }
  val visibleSessions =
    (if (searchQuery.isEmpty()) sessions else searchResults)
      .let { rows ->
        when (filter) {
          SessionFilter.Recent -> rows.filter { it.archived != true }
          SessionFilter.Current -> rows.filter { it.key == chatSessionKey && it.archived != true }
          // Gate on the entry's own archived flag so the pre-toggle active list can
          // never render with archived-only actions while the refetch is in flight.
          SessionFilter.Archived -> rows.filter { it.archived == true }
        }
      }.let { rows ->
        if (recentFirst) {
          rows.sortedByDescending { it.lastActivityAt ?: it.updatedAtMs ?: 0L }
        } else {
          rows.sortedBy { it.lastActivityAt ?: it.updatedAtMs ?: 0L }
        }
      }
  val storedGroups by viewModel.sessionCustomGroups.collectAsState()
  val sections = groupSessionEntries(visibleSessions, knownGroups = storedGroups)
  // Stored group names stay offered as move targets even while they have no members.
  val categories =
    (sessions.mapNotNull { it.category?.trim()?.takeIf(String::isNotEmpty) } + storedGroups)
      .distinctBy { it.lowercase() }
      .sortedWith(String.CASE_INSENSITIVE_ORDER)

  LaunchedEffect(isConnected, filter) {
    if (isConnected) {
      viewModel.refreshChatSessions(limit = 200, archived = filter == SessionFilter.Archived)
    }
  }

  // Keyed on the live session list too: row actions (pin/rename/archive/delete)
  // refresh live state, which re-runs the search so results never go stale.
  LaunchedEffect(searchQuery, filter, sessions) {
    if (searchQuery.isEmpty()) {
      searchResults = emptyList()
      searchLoading = false
      return@LaunchedEffect
    }
    searchResults = emptyList()
    searchLoading = true
    try {
      // Debounce keystrokes; the key change cancels superseded fetches, and the
      // controller falls back to local filtering when the gateway is unreachable.
      delay(250)
      searchResults =
        viewModel.fetchChatSessionList(
          search = searchQuery,
          archived = filter == SessionFilter.Archived,
        )
    } finally {
      searchLoading = false
    }
  }

  ClawScaffold(
    contentPadding = PaddingValues(start = 16.dp, top = 10.dp, end = 16.dp, bottom = 4.dp),
    contentWindowInsets = WindowInsets.safeDrawing.only(WindowInsetsSides.Top + WindowInsetsSides.Horizontal),
  ) {
    LazyColumn(
      modifier = Modifier.fillMaxSize(),
      verticalArrangement = Arrangement.spacedBy(9.dp),
      contentPadding = PaddingValues(bottom = 4.dp),
    ) {
      item {
        Row(
          modifier = Modifier.fillMaxWidth(),
          verticalAlignment = Alignment.CenterVertically,
          horizontalArrangement = Arrangement.spacedBy(8.dp),
        ) {
          Text(text = nativeString("Sessions"), style = ClawTheme.type.display.copy(fontSize = 24.sp, lineHeight = 28.sp), color = ClawTheme.colors.text, modifier = Modifier.weight(1f))
          ClawPlainIconButton(
            icon = Icons.Default.Search,
            contentDescription = nativeString("Focus session search"),
            onClick = {
              searchFocusRequester.requestFocus()
              keyboardController?.show()
            },
          )
        }
      }

      item {
        Row(horizontalArrangement = Arrangement.spacedBy(5.dp)) {
          FilterPill(text = nativeString("Recent"), icon = Icons.Outlined.AccessTime, active = filter == SessionFilter.Recent, onClick = { filter = SessionFilter.Recent })
          FilterPill(text = nativeString("Current"), icon = Icons.Outlined.MicNone, active = filter == SessionFilter.Current, showDot = sessions.any { it.key == chatSessionKey }, onClick = { filter = SessionFilter.Current })
          FilterPill(text = nativeString("Archived"), icon = Icons.Outlined.Archive, active = filter == SessionFilter.Archived, onClick = { filter = SessionFilter.Archived })
        }
      }

      item {
        OutlinedTextField(
          value = searchText,
          onValueChange = { searchText = it },
          modifier = Modifier.fillMaxWidth().focusRequester(searchFocusRequester),
          placeholder = { Text(text = nativeString("Search sessions"), style = ClawTheme.type.body, color = ClawTheme.colors.textMuted) },
          singleLine = true,
          trailingIcon = {
            if (searchText.isNotEmpty()) {
              IconButton(onClick = { searchText = "" }) {
                Icon(imageVector = Icons.Default.Close, contentDescription = nativeString("Clear session search"))
              }
            }
          },
        )
      }

      item {
        Row(modifier = Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween, verticalAlignment = Alignment.Top) {
          Surface(
            modifier = Modifier.widthIn(min = 140.dp, max = 180.dp).heightIn(min = 36.dp),
            shape = RoundedCornerShape(ClawTheme.radii.row),
            color = Color.Transparent,
            contentColor = ClawTheme.colors.textMuted,
            border = BorderStroke(1.dp, ClawTheme.colors.border),
          ) {
            Column {
              Surface(
                onClick = { sortMenuExpanded = !sortMenuExpanded },
                color = Color.Transparent,
                contentColor = ClawTheme.colors.textMuted,
              ) {
                Row(
                  modifier = Modifier.padding(horizontal = 9.dp, vertical = 6.dp),
                  verticalAlignment = Alignment.CenterVertically,
                  horizontalArrangement = Arrangement.spacedBy(5.dp),
                ) {
                  val sortOrder =
                    if (recentFirst) {
                      nativeString("Newest first")
                    } else {
                      nativeString("Oldest first")
                    }
                  Text(
                    text = nativeString("Sort: \$sortOrder", sortOrder),
                    style = ClawTheme.type.body,
                    color = ClawTheme.colors.textMuted,
                  )
                  Icon(
                    imageVector = if (sortMenuExpanded) Icons.Default.KeyboardArrowUp else Icons.Default.KeyboardArrowDown,
                    contentDescription = null,
                    modifier = Modifier.size(13.dp),
                    tint = ClawTheme.colors.textMuted,
                  )
                }
              }
              if (sortMenuExpanded) {
                HorizontalDivider(color = ClawTheme.colors.border, thickness = 1.dp)
                listOf(true to nativeString("Newest first"), false to nativeString("Oldest first")).forEach { (value, label) ->
                  Surface(
                    onClick = {
                      recentFirst = value
                      sortMenuExpanded = false
                    },
                    modifier = Modifier.fillMaxWidth(),
                    color = Color.Transparent,
                    contentColor = if (recentFirst == value) ClawTheme.colors.text else ClawTheme.colors.textMuted,
                  ) {
                    Text(
                      text = label,
                      modifier = Modifier.padding(horizontal = 9.dp, vertical = 8.dp),
                      style = ClawTheme.type.body,
                      color = if (recentFirst == value) ClawTheme.colors.text else ClawTheme.colors.textMuted,
                    )
                  }
                }
              }
            }
          }
          SessionOutlineIconButton(icon = Icons.Default.Storage, contentDescription = nativeString("Toggle session layout"), onClick = { compactLayout = !compactLayout })
        }
      }

      item {
        Text(text = if (compactLayout) nativeString("Layout: Compact") else nativeString("Layout: Detailed"), style = ClawTheme.type.caption, color = ClawTheme.colors.textSubtle)
      }

      if (visibleSessions.isEmpty()) {
        item {
          Box(
            modifier = Modifier.fillParentMaxHeight(0.56f).fillMaxWidth(),
            contentAlignment = Alignment.Center,
          ) {
            when (sessionEmptyMode(searchQuery, searchLoading)) {
              SessionEmptyMode.SearchLoading -> ClawLoadingState(title = nativeString("Searching sessions"))
              SessionEmptyMode.SearchNoMatches ->
                ClawEmptyState(
                  title = nativeString("No matching sessions"),
                  body = nativeString("Try a different search or clear the current query."),
                  action = { ClawPrimaryButton(text = nativeString("Clear Search"), onClick = { searchText = "" }) },
                )
              SessionEmptyMode.Filter ->
                ClawEmptyState(
                  title = emptySessionTitle(filter),
                  body = emptySessionBody(filter),
                  action = { ClawPrimaryButton(text = nativeString("Start Chat"), onClick = onOpenChat) },
                )
            }
          }
        }
      } else {
        sections.forEachIndexed { index, section ->
          section.title?.let { title ->
            item(key = "section:$index:$title") {
              if (section.isCategory) {
                SessionGroupHeader(
                  title = title,
                  onRename = { renameGroupName = title },
                  onNewGroup = { newGroupDialogVisible = true },
                  onDelete = { deleteGroupName = title },
                )
              } else {
                Text(
                  text = title,
                  style = ClawTheme.type.label,
                  color = ClawTheme.colors.textMuted,
                  modifier = Modifier.padding(top = 6.dp),
                )
              }
            }
          }
          items(section.entries, key = { it.key }) { session ->
            val active = session.key == chatSessionKey
            SessionRow(
              session = session,
              title = displaySessionTitle(session),
              subtitle = if (active) nativeString("Current session") else nativeString("OpenClaw session"),
              metadata = (session.lastActivityAt ?: session.updatedAtMs)?.let(::relativeSessionTime) ?: nativeString("now"),
              active = active,
              compact = compactLayout,
              archived = session.archived == true,
              categories = categories,
              onClick = {
                viewModel.switchChatSession(session.key)
                onOpenChat()
              },
              onSetPinned = { pinned ->
                coroutineScope.launch { viewModel.patchChatSession(key = session.key, pinned = pinned) }
              },
              onSetUnread = { unread ->
                coroutineScope.launch { viewModel.patchChatSession(key = session.key, unread = unread) }
              },
              onRename = { renameSessionKey = session.key },
              onFork = {
                coroutineScope.launch {
                  viewModel.forkChatSession(session.key)?.let { newKey ->
                    viewModel.switchChatSession(newKey)
                    onOpenChat()
                  }
                }
              },
              onMoveToGroup = { category ->
                coroutineScope.launch { viewModel.patchChatSession(key = session.key, category = category) }
              },
              onNewGroup = { groupSessionKey = session.key },
              onRemoveFromGroup = {
                coroutineScope.launch { viewModel.patchChatSession(key = session.key, clearCategory = true) }
              },
              onSetArchived = { archived ->
                coroutineScope.launch { viewModel.patchChatSession(key = session.key, archived = archived) }
              },
              onDelete = { deleteSessionKey = session.key },
            )
          }
        }
      }
    }
  }

  sessions.firstOrNull { it.key == renameSessionKey }?.let { session ->
    SessionTextDialog(
      title = nativeString("Rename session"),
      stateKey = session.key,
      initialValue = session.label ?: session.displayName.orEmpty(),
      confirmLabel = nativeString("Rename"),
      allowEmpty = true,
      onDismiss = { renameSessionKey = null },
      onConfirm = { value ->
        renameSessionKey = null
        val label = value.trim()
        coroutineScope.launch {
          viewModel.patchChatSession(
            key = session.key,
            label = label.takeIf(String::isNotEmpty),
            clearLabel = label.isEmpty(),
          )
        }
      },
    )
  }

  sessions.firstOrNull { it.key == groupSessionKey }?.let { session ->
    SessionTextDialog(
      title = nativeString("New group"),
      stateKey = session.key,
      initialValue = "",
      confirmLabel = nativeString("Create"),
      allowEmpty = false,
      onDismiss = { groupSessionKey = null },
      onConfirm = { value ->
        groupSessionKey = null
        // Remember the name so the group survives locally even if the patch later empties it.
        viewModel.addChatSessionGroup(value)
        coroutineScope.launch { viewModel.patchChatSession(key = session.key, category = value.trim()) }
      },
    )
  }

  renameGroupName?.let { group ->
    SessionTextDialog(
      title = nativeString("Rename group"),
      stateKey = "group-rename:$group",
      initialValue = group,
      confirmLabel = nativeString("Rename"),
      allowEmpty = false,
      onDismiss = { renameGroupName = null },
      onConfirm = { value ->
        renameGroupName = null
        val next = value.trim()
        if (next.isNotEmpty() && next != group) {
          coroutineScope.launch { viewModel.renameChatSessionGroup(from = group, to = next) }
        }
      },
    )
  }

  if (newGroupDialogVisible) {
    SessionTextDialog(
      title = nativeString("New group"),
      stateKey = "group-new",
      initialValue = "",
      confirmLabel = nativeString("Create"),
      allowEmpty = false,
      onDismiss = { newGroupDialogVisible = false },
      onConfirm = { value ->
        newGroupDialogVisible = false
        viewModel.addChatSessionGroup(value)
      },
    )
  }

  deleteGroupName?.let { group ->
    AlertDialog(
      onDismissRequest = { deleteGroupName = null },
      containerColor = ClawTheme.colors.surfaceRaised,
      title = { Text(nativeString("Delete group?"), style = ClawTheme.type.section, color = ClawTheme.colors.text) },
      text = { Text(nativeString("Sessions in \"\$group\" are kept and move back to Ungrouped.", group), style = ClawTheme.type.body, color = ClawTheme.colors.textMuted) },
      confirmButton = {
        TextButton(
          onClick = {
            deleteGroupName = null
            coroutineScope.launch { viewModel.deleteChatSessionGroup(group) }
          },
        ) {
          Text(nativeString("Delete"), color = ClawTheme.colors.danger)
        }
      },
      dismissButton = {
        TextButton(onClick = { deleteGroupName = null }) {
          Text(nativeString("Cancel"))
        }
      },
    )
  }

  sessions.firstOrNull { it.key == deleteSessionKey }?.let { session ->
    AlertDialog(
      onDismissRequest = { deleteSessionKey = null },
      containerColor = ClawTheme.colors.surfaceRaised,
      title = { Text(nativeString("Delete session?"), style = ClawTheme.type.section, color = ClawTheme.colors.text) },
      text = { Text(nativeString("This permanently deletes the session and its transcript."), style = ClawTheme.type.body, color = ClawTheme.colors.textMuted) },
      confirmButton = {
        TextButton(
          onClick = {
            deleteSessionKey = null
            coroutineScope.launch { viewModel.deleteChatSession(session.key) }
          },
        ) {
          Text(nativeString("Delete"), color = ClawTheme.colors.danger)
        }
      },
      dismissButton = {
        TextButton(onClick = { deleteSessionKey = null }) {
          Text(nativeString("Cancel"))
        }
      },
    )
  }
}

@Composable
private fun FilterPill(
  text: String,
  icon: ImageVector? = null,
  active: Boolean = false,
  showDot: Boolean = false,
  dropdown: Boolean = false,
  onClick: (() -> Unit)? = null,
) {
  Surface(
    onClick = onClick ?: {},
    enabled = onClick != null,
    shape = RoundedCornerShape(7.dp),
    color = if (active) ClawTheme.colors.surfaceRaised else Color.Transparent,
    contentColor = ClawTheme.colors.text,
    border = BorderStroke(1.dp, if (active) ClawTheme.colors.borderStrong else ClawTheme.colors.border),
  ) {
    Row(
      modifier = Modifier.padding(horizontal = 6.dp, vertical = 3.dp),
      verticalAlignment = Alignment.CenterVertically,
      horizontalArrangement = Arrangement.spacedBy(4.dp),
    ) {
      icon?.let { Icon(imageVector = it, contentDescription = null, modifier = Modifier.size(12.dp), tint = ClawTheme.colors.text) }
      Text(text = text, style = ClawTheme.type.label, color = ClawTheme.colors.text, maxLines = 1)
      if (showDot) {
        Box(modifier = Modifier.size(4.dp).clip(CircleShape).background(ClawTheme.colors.success))
      }
      if (dropdown) {
        Icon(imageVector = Icons.Default.KeyboardArrowDown, contentDescription = null, modifier = Modifier.size(11.dp), tint = ClawTheme.colors.textMuted)
      }
    }
  }
}

@Composable
private fun SessionRow(
  session: ChatSessionEntry,
  title: String,
  subtitle: String,
  metadata: String,
  active: Boolean,
  compact: Boolean,
  archived: Boolean,
  categories: List<String>,
  onClick: () -> Unit,
  onSetPinned: (Boolean) -> Unit,
  onSetUnread: (Boolean) -> Unit,
  onRename: () -> Unit,
  onFork: () -> Unit,
  onMoveToGroup: (String) -> Unit,
  onNewGroup: () -> Unit,
  onRemoveFromGroup: () -> Unit,
  onSetArchived: (Boolean) -> Unit,
  onDelete: () -> Unit,
) {
  var menuExpanded by remember { mutableStateOf(false) }
  var groupMenuVisible by remember { mutableStateOf(false) }

  Surface(color = Color.Transparent, contentColor = ClawTheme.colors.text) {
    Box {
      Column {
        Row(
          modifier =
            Modifier
              .fillMaxWidth()
              .combinedClickable(
                onClick = onClick,
                onLongClick = {
                  groupMenuVisible = false
                  menuExpanded = true
                },
              ).heightIn(min = 58.dp)
              .padding(vertical = 5.dp),
          verticalAlignment = Alignment.CenterVertically,
          horizontalArrangement = Arrangement.spacedBy(7.dp),
        ) {
          Surface(
            modifier = Modifier.size(32.dp),
            shape = RoundedCornerShape(ClawTheme.radii.control),
            color = Color.Transparent,
            border = BorderStroke(1.dp, ClawTheme.colors.borderStrong),
          ) {
            Box(contentAlignment = Alignment.Center) {
              Icon(
                imageVector = if (active) Icons.Default.StarBorder else Icons.Outlined.ChatBubbleOutline,
                contentDescription = null,
                modifier = Modifier.size(16.dp),
                tint = ClawTheme.colors.text,
              )
            }
          }

          Column(modifier = Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(1.5.dp)) {
            Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(4.dp)) {
              Text(
                text = title,
                style = ClawTheme.type.body,
                color = ClawTheme.colors.text,
                modifier = Modifier.weight(1f),
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
              )
              if (active || session.unread == true || session.pinned == true) {
                Row(
                  modifier = Modifier.size(width = 40.dp, height = 16.dp),
                  verticalAlignment = Alignment.CenterVertically,
                  horizontalArrangement = Arrangement.spacedBy(4.dp, Alignment.End),
                ) {
                  if (active) {
                    Box(modifier = Modifier.size(4.dp).clip(CircleShape).background(ClawTheme.colors.success))
                  }
                  if (session.unread == true) {
                    Box(modifier = Modifier.size(6.dp).clip(CircleShape).background(ClawTheme.colors.primary))
                  }
                  if (session.pinned == true) {
                    Icon(imageVector = Icons.Default.PushPin, contentDescription = nativeString("Pinned"), modifier = Modifier.size(13.dp), tint = ClawTheme.colors.textMuted)
                  }
                }
              }
            }
            if (!compact) {
              Text(text = subtitle, style = ClawTheme.type.caption.copy(fontSize = 12.5.sp, lineHeight = 16.sp), color = ClawTheme.colors.textMuted, maxLines = 1)
              Row(horizontalArrangement = Arrangement.spacedBy(4.dp)) {
                SessionMiniTag(text = nativeString("Workspace"))
                SessionMiniTag(text = if (active) nativeString("Current") else nativeString("OpenClaw"))
              }
            }
          }

          Column(horizontalAlignment = Alignment.End, verticalArrangement = Arrangement.spacedBy(5.dp)) {
            Icon(imageVector = Icons.Outlined.ChatBubbleOutline, contentDescription = null, modifier = Modifier.size(13.dp), tint = ClawTheme.colors.textMuted)
            Text(text = metadata, style = ClawTheme.type.caption.copy(fontSize = 12.5.sp, lineHeight = 16.sp), color = ClawTheme.colors.textMuted, maxLines = 1)
          }
        }
        HorizontalDivider(color = ClawTheme.colors.border, thickness = 1.dp)
      }
      DropdownMenu(
        expanded = menuExpanded,
        onDismissRequest = {
          menuExpanded = false
          groupMenuVisible = false
        },
      ) {
        if (archived) {
          SessionMenuItem(nativeString("Unarchive")) {
            menuExpanded = false
            onSetArchived(false)
          }
          SessionMenuItem(nativeString("Delete…")) {
            menuExpanded = false
            onDelete()
          }
        } else if (groupMenuVisible) {
          SessionMenuItem(nativeString("← Back")) { groupMenuVisible = false }
          categories.forEach { category ->
            SessionMenuItem(category) {
              menuExpanded = false
              groupMenuVisible = false
              onMoveToGroup(category)
            }
          }
          SessionMenuItem(nativeString("New group…")) {
            menuExpanded = false
            groupMenuVisible = false
            onNewGroup()
          }
          if (!session.category.isNullOrBlank()) {
            SessionMenuItem(nativeString("Remove from group")) {
              menuExpanded = false
              groupMenuVisible = false
              onRemoveFromGroup()
            }
          }
        } else {
          SessionMenuItem(if (session.pinned == true) nativeString("Unpin") else nativeString("Pin")) {
            menuExpanded = false
            onSetPinned(session.pinned != true)
          }
          SessionMenuItem(if (session.unread == true) nativeString("Mark as read") else nativeString("Mark as unread")) {
            menuExpanded = false
            onSetUnread(session.unread != true)
          }
          SessionMenuItem(nativeString("Rename…")) {
            menuExpanded = false
            onRename()
          }
          SessionMenuItem(nativeString("Fork")) {
            menuExpanded = false
            onFork()
          }
          SessionMenuItem(nativeString("Move to group")) { groupMenuVisible = true }
          SessionMenuItem(nativeString("Archive")) {
            menuExpanded = false
            onSetArchived(true)
          }
          // Delete is archive-gated: the bounded operator session lacks
          // operator.admin, and the gateway only grants write-scope deletes
          // for archived sessions. Archived rows keep the Delete item.
        }
      }
    }
  }
}

/** Category section header; long-press opens the group management menu. */
@Composable
private fun SessionGroupHeader(
  title: String,
  onRename: () -> Unit,
  onNewGroup: () -> Unit,
  onDelete: () -> Unit,
) {
  var menuExpanded by remember { mutableStateOf(false) }
  Box(modifier = Modifier.padding(top = 6.dp)) {
    Text(
      text = title,
      style = ClawTheme.type.label,
      color = ClawTheme.colors.textMuted,
      modifier =
        Modifier.combinedClickable(
          onClick = {},
          onLongClick = { menuExpanded = true },
        ),
    )
    DropdownMenu(expanded = menuExpanded, onDismissRequest = { menuExpanded = false }) {
      SessionMenuItem(nativeString("Rename group…")) {
        menuExpanded = false
        onRename()
      }
      SessionMenuItem(nativeString("New group…")) {
        menuExpanded = false
        onNewGroup()
      }
      SessionMenuItem(nativeString("Delete group…")) {
        menuExpanded = false
        onDelete()
      }
    }
  }
}

@Composable
private fun SessionMenuItem(
  text: String,
  onClick: () -> Unit,
) {
  DropdownMenuItem(
    text = { Text(text, style = ClawTheme.type.body) },
    onClick = onClick,
  )
}

@Composable
private fun SessionTextDialog(
  title: String,
  stateKey: String,
  initialValue: String,
  confirmLabel: String,
  allowEmpty: Boolean,
  onDismiss: () -> Unit,
  onConfirm: (String) -> Unit,
) {
  var value by rememberSaveable(stateKey) { mutableStateOf(initialValue) }
  val canConfirm = allowEmpty || value.isNotBlank()
  AlertDialog(
    onDismissRequest = onDismiss,
    containerColor = ClawTheme.colors.surfaceRaised,
    title = { Text(title, style = ClawTheme.type.section, color = ClawTheme.colors.text) },
    text = {
      OutlinedTextField(
        value = value,
        onValueChange = { value = it },
        singleLine = true,
        label = { Text(if (allowEmpty) nativeString("Name") else nativeString("Group name")) },
      )
    },
    confirmButton = {
      TextButton(onClick = { onConfirm(value) }, enabled = canConfirm) {
        Text(confirmLabel)
      }
    },
    dismissButton = {
      TextButton(onClick = onDismiss) {
        Text(nativeString("Cancel"))
      }
    },
  )
}

@Composable
private fun SessionOutlineIconButton(
  icon: ImageVector,
  contentDescription: String,
  onClick: () -> Unit,
) {
  Surface(
    onClick = onClick,
    modifier = Modifier.size(ClawTheme.spacing.touchTarget),
    shape = RoundedCornerShape(7.dp),
    color = Color.Transparent,
    contentColor = ClawTheme.colors.text,
    border = BorderStroke(1.dp, ClawTheme.colors.borderStrong),
  ) {
    Box(contentAlignment = Alignment.Center) {
      Icon(imageVector = icon, contentDescription = contentDescription, modifier = Modifier.size(14.dp))
    }
  }
}

@Composable
private fun SessionMiniTag(text: String) {
  Surface(
    shape = RoundedCornerShape(5.dp),
    color = Color.Transparent,
    border = BorderStroke(1.dp, ClawTheme.colors.border),
    contentColor = ClawTheme.colors.textMuted,
  ) {
    Text(text = text, modifier = Modifier.padding(horizontal = 4.dp, vertical = 0.5.dp), style = ClawTheme.type.caption.copy(fontSize = 12.5.sp, lineHeight = 16.sp), maxLines = 1)
  }
}

private enum class SessionFilter {
  Recent,
  Current,
  Archived,
}

internal data class SessionSection(
  val title: String?,
  val entries: List<ChatSessionEntry>,
  // Only custom category sections expose group actions; "Pinned"/"Ungrouped" are structural.
  val isCategory: Boolean = false,
)

/** Groups pinned sessions once, followed by alphabetical categories and remaining sessions. */
internal fun groupSessionEntries(
  entries: List<ChatSessionEntry>,
  knownGroups: List<String> = emptyList(),
): List<SessionSection> {
  if (entries.isEmpty()) return emptyList()
  val pinned = entries.filter { it.pinned == true }
  val remaining = entries.filterNot { it.pinned == true }
  val populated = remaining.filter { !it.category.isNullOrBlank() }.groupBy { it.category.orEmpty().trim() }
  // Stored-but-empty groups still render so they stay visible as move targets.
  val emptyKnown =
    knownGroups
      .mapNotNull { it.trim().takeIf(String::isNotEmpty) }
      .distinctBy { it.lowercase() }
      .filterNot { name -> populated.keys.any { it.equals(name, ignoreCase = true) } }
  val categories =
    (populated.toList() + emptyKnown.map { it to emptyList<ChatSessionEntry>() })
      .sortedBy { it.first.lowercase() }
  val ungrouped = remaining.filter { it.category.isNullOrBlank() }
  return buildList {
    if (pinned.isNotEmpty()) add(SessionSection(title = nativeString("Pinned"), entries = pinned))
    categories.forEach { (category, sessions) -> add(SessionSection(title = category, entries = sessions, isCategory = true)) }
    if (ungrouped.isNotEmpty()) {
      add(SessionSection(title = nativeString("Ungrouped").takeIf { categories.isNotEmpty() }, entries = ungrouped))
    }
  }
}

internal enum class SessionEmptyMode {
  Filter,
  SearchLoading,
  SearchNoMatches,
}

/** Keeps transient search loading distinct from both filter-empty and settled no-match states. */
internal fun sessionEmptyMode(
  query: String,
  loading: Boolean,
): SessionEmptyMode =
  when {
    query.isBlank() -> SessionEmptyMode.Filter
    loading -> SessionEmptyMode.SearchLoading
    else -> SessionEmptyMode.SearchNoMatches
  }

/** Empty-state title selected by the active session browser filter. */
private fun emptySessionTitle(filter: SessionFilter): String =
  when (filter) {
    SessionFilter.Recent -> nativeString("No sessions yet")
    SessionFilter.Current -> nativeString("No current session")
    SessionFilter.Archived -> nativeString("No archived sessions")
  }

/** Empty-state body selected by the active session browser filter. */
private fun emptySessionBody(filter: SessionFilter): String =
  when (filter) {
    SessionFilter.Recent -> nativeString("Start a new conversation and it will show up here.")
    SessionFilter.Current -> nativeString("Open Chat to start or resume the current session.")
    SessionFilter.Archived -> nativeString("Archived sessions will show up here.")
  }

/** Formats session timestamps for compact mobile metadata. */
internal fun relativeSessionTime(
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

/** Prefers the editable label, then falls back to the gateway display name. */
private fun displaySessionTitle(session: ChatSessionEntry): String =
  session.label?.takeIf { it.isNotBlank() }
    ?: session.displayName?.takeIf { it.isNotBlank() }
    ?: nativeString("Main session")
