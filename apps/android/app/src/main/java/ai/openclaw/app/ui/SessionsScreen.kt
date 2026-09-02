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
import ai.openclaw.app.ui.design.sessionColor
import ai.openclaw.app.ui.design.sessionColorNames
import ai.openclaw.app.ui.design.sessionColorStripe
import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.background
import androidx.compose.foundation.combinedClickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.safeDrawing
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.KeyboardArrowRight
import androidx.compose.material.icons.filled.Check
import androidx.compose.material.icons.filled.Close
import androidx.compose.material.icons.filled.ErrorOutline
import androidx.compose.material.icons.filled.KeyboardArrowDown
import androidx.compose.material.icons.filled.KeyboardArrowUp
import androidx.compose.material.icons.filled.Menu
import androidx.compose.material.icons.filled.PlayArrow
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
import androidx.compose.runtime.saveable.Saver
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
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch

/** Session browser for active, current, and archived chat sessions. */
@Composable
internal fun SessionsScreen(
  viewModel: MainViewModel,
  showSidebarButton: Boolean,
  onOpenSidebar: () -> Unit,
  onOpenChat: () -> Unit,
) {
  val sessions by viewModel.chatSessions.collectAsState()
  val chatSessionKey by viewModel.chatSessionKey.collectAsState()
  val activeGatewayStableId by viewModel.activeGatewayStableId.collectAsState()
  val isConnected by viewModel.isConnected.collectAsState()
  val coroutineScope = rememberCoroutineScope()
  val searchFocusRequester = remember { FocusRequester() }
  val keyboardController = LocalSoftwareKeyboardController.current
  var filter by rememberSaveable { mutableStateOf(SessionFilter.Recent) }
  var compactLayout by rememberSaveable { mutableStateOf(false) }
  var recentFirst by rememberSaveable { mutableStateOf(true) }
  var sessionStatusNowMs by remember { mutableStateOf(System.currentTimeMillis()) }
  var collapsedSessionKeys by
    rememberSaveable(activeGatewayStableId, stateSaver = CollapsedSessionKeysSaver) {
      mutableStateOf<Set<String>>(emptySet())
    }
  var sortMenuExpanded by remember { mutableStateOf(false) }
  var renameSessionTarget by
    rememberSaveable(stateSaver = SessionActionTargetSaver) { mutableStateOf<SessionActionTarget?>(null) }
  var groupSessionTarget by
    rememberSaveable(stateSaver = SessionActionTargetSaver) { mutableStateOf<SessionActionTarget?>(null) }
  var deleteSessionTarget by
    rememberSaveable(stateSaver = SessionActionTargetSaver) { mutableStateOf<SessionActionTarget?>(null) }
  var searchText by rememberSaveable { mutableStateOf("") }
  var renameGroupName by rememberSaveable { mutableStateOf<String?>(null) }
  var deleteGroupName by rememberSaveable { mutableStateOf<String?>(null) }
  var newGroupDialogVisible by rememberSaveable { mutableStateOf(false) }
  val searchState =
    rememberSessionBrowserSearchState(
      viewModel = viewModel,
      sessions = sessions,
      query = searchText,
      archived = filter == SessionFilter.Archived,
    )
  val visibleSessions =
    resolveSessionBrowserEntries(
      entries = searchState.entries,
      currentSessionKey = chatSessionKey,
      filter = filter,
      recentFirst = recentFirst,
    )
  val nextAttentionExpiry = nextSessionStatusExpiry(visibleSessions, sessionStatusNowMs)
  val storedGroups by viewModel.sessionCustomGroups.collectAsState()
  val sections =
    buildSessionTreeSections(
      entries = visibleSessions,
      knownGroups = storedGroups,
      collapsedSessionKeys = collapsedSessionKeys,
      currentSessionKey = chatSessionKey,
      nowMs = sessionStatusNowMs,
    )
  // Stored group names stay offered as move targets even while they have no members.
  val categories =
    (sessions.mapNotNull { it.category?.trim()?.takeIf(String::isNotEmpty) } + storedGroups)
      .distinctBy { it.lowercase() }
      .sortedWith(String.CASE_INSENSITIVE_ORDER)

  LaunchedEffect(activeGatewayStableId) {
    renameSessionTarget = renameSessionTarget?.takeIf { it.matchesGateway(activeGatewayStableId) }
    groupSessionTarget = groupSessionTarget?.takeIf { it.matchesGateway(activeGatewayStableId) }
    deleteSessionTarget = deleteSessionTarget?.takeIf { it.matchesGateway(activeGatewayStableId) }
  }

  LaunchedEffect(isConnected, filter) {
    if (isConnected) {
      viewModel.refreshChatSessions(limit = 200, archived = filter == SessionFilter.Archived)
    }
  }

  LaunchedEffect(nextAttentionExpiry) {
    nextAttentionExpiry?.let { expiry ->
      sessionStatusNowMs = awaitSessionStatusExpiry(expiry)
    }
  }

  ClawScaffold(
    contentPadding = PaddingValues(start = 16.dp, top = 10.dp, end = 16.dp, bottom = 4.dp),
    contentWindowInsets = WindowInsets.safeDrawing,
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
          if (showSidebarButton) {
            ClawPlainIconButton(
              icon = Icons.Default.Menu,
              contentDescription = nativeString("Show Sidebar"),
              onClick = onOpenSidebar,
              modifier = Modifier.testTag("sidebar-open-sessions"),
            )
          }
          Text(text = nativeString("Threads"), style = ClawTheme.type.display.copy(fontSize = 24.sp, lineHeight = 28.sp), color = ClawTheme.colors.text, modifier = Modifier.weight(1f))
          ClawPlainIconButton(
            icon = Icons.Default.Search,
            contentDescription = nativeString("Focus thread search"),
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
          placeholder = { Text(text = nativeString("Search threads"), style = ClawTheme.type.body, color = ClawTheme.colors.textMuted) },
          singleLine = true,
          trailingIcon = {
            if (searchText.isNotEmpty()) {
              IconButton(onClick = { searchText = "" }) {
                Icon(imageVector = Icons.Default.Close, contentDescription = nativeString("Clear thread search"))
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
          SessionOutlineIconButton(icon = Icons.Default.Storage, contentDescription = nativeString("Toggle thread layout"), onClick = { compactLayout = !compactLayout })
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
            when (sessionEmptyMode(searchState.query, searchState.loading)) {
              SessionEmptyMode.SearchLoading -> {
                ClawLoadingState(title = nativeString("Searching threads"))
              }

              SessionEmptyMode.SearchNoMatches -> {
                ClawEmptyState(
                  title = nativeString("No matching threads"),
                  body = nativeString("Try a different search or clear the current query."),
                  action = { ClawPrimaryButton(text = nativeString("Clear Search"), onClick = { searchText = "" }) },
                )
              }

              SessionEmptyMode.Filter -> {
                ClawEmptyState(
                  title = emptySessionTitle(filter),
                  body = emptySessionBody(filter),
                  action = { ClawPrimaryButton(text = nativeString("Start Chat"), onClick = onOpenChat) },
                )
              }
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
          items(section.entries, key = { it.session.key }) { treeEntry ->
            val session = treeEntry.session
            val active = session.key == chatSessionKey
            val descendantsCollapsed =
              session.key in collapsedSessionKeys && (treeEntry.hasChildren || treeEntry.descendantState.hasActionableState)
            val collapsedDescendantLabel =
              treeEntry.descendantState.presentationLabel().takeIf { descendantsCollapsed }
            SessionRow(
              session = session,
              title = sessionPresentationTitle(session) { nativeString("Main thread") },
              subtitle =
                collapsedDescendantLabel
                  ?: sessionListSubtitle(
                    session,
                    fallback = if (active) nativeString("Current thread") else nativeString("OpenClaw thread"),
                    nowMs = sessionStatusNowMs,
                  ),
              metadata = (session.lastActivityAt ?: session.updatedAtMs)?.let(::relativeSessionTime) ?: nativeString("now"),
              active = active,
              compact = compactLayout,
              archived = session.archived == true,
              categories = categories,
              depth = treeEntry.depth,
              hasChildren = treeEntry.hasChildren,
              expanded = session.key !in collapsedSessionKeys,
              collapsedDescendantState = treeEntry.descendantState.takeIf { descendantsCollapsed },
              onToggleExpanded = {
                collapsedSessionKeys =
                  if (session.key in collapsedSessionKeys) {
                    collapsedSessionKeys - session.key
                  } else {
                    collapsedSessionKeys + session.key
                  }
              },
              onClick = {
                viewModel.switchChatSession(session.key, session.ownerAgentId)
                onOpenChat()
              },
              onSetPinned = { pinned ->
                coroutineScope.launch {
                  viewModel.patchChatSession(key = session.key, ownerAgentId = session.ownerAgentId, pinned = pinned)
                }
              },
              onSetUnread = { unread ->
                coroutineScope.launch {
                  viewModel.patchChatSession(key = session.key, ownerAgentId = session.ownerAgentId, unread = unread)
                }
              },
              onRename = { renameSessionTarget = session.toActionTarget(activeGatewayStableId) },
              onSetColor = { color ->
                coroutineScope.launch {
                  viewModel.patchChatSession(
                    key = session.key,
                    ownerAgentId = session.ownerAgentId,
                    color = color,
                    clearColor = color == null,
                  )
                }
              },
              onFork = {
                coroutineScope.launch {
                  val newKey =
                    viewModel.forkChatSession(
                      session.key,
                      session.ownerAgentId,
                      fromLastCompleted = session.hasActiveRun == true,
                    )
                  if (newKey != null) {
                    viewModel.switchChatSession(newKey, session.ownerAgentId)
                    onOpenChat()
                  }
                }
              },
              onMoveToGroup = { category ->
                coroutineScope.launch {
                  viewModel.patchChatSession(key = session.key, ownerAgentId = session.ownerAgentId, category = category)
                }
              },
              onNewGroup = { groupSessionTarget = session.toActionTarget(activeGatewayStableId) },
              onRemoveFromGroup = {
                coroutineScope.launch {
                  viewModel.patchChatSession(key = session.key, ownerAgentId = session.ownerAgentId, clearCategory = true)
                }
              },
              onSetArchived = { archived ->
                coroutineScope.launch {
                  viewModel.patchChatSession(
                    key = session.key,
                    ownerAgentId = session.ownerAgentId,
                    expectedSessionId = session.sessionId,
                    archived = archived,
                  )
                }
              },
              onDelete = { deleteSessionTarget = session.toActionTarget(activeGatewayStableId) },
            )
          }
        }
      }
    }
  }

  renameSessionTarget?.let { session ->
    SessionTextDialog(
      title = nativeString("Rename thread"),
      stateKey = session.stateKey,
      initialValue = session.label ?: session.displayName.orEmpty(),
      confirmLabel = nativeString("Rename"),
      allowEmpty = true,
      onDismiss = { renameSessionTarget = null },
      onConfirm = { value ->
        renameSessionTarget = null
        if (!session.matchesGateway(activeGatewayStableId)) return@SessionTextDialog
        val label = value.trim()
        coroutineScope.launch {
          viewModel.patchChatSession(
            key = session.key,
            ownerAgentId = session.ownerAgentId,
            label = label.takeIf(String::isNotEmpty),
            clearLabel = label.isEmpty(),
          )
        }
      },
    )
  }

  groupSessionTarget?.let { session ->
    SessionTextDialog(
      title = nativeString("New group"),
      stateKey = session.stateKey,
      initialValue = "",
      confirmLabel = nativeString("Create"),
      allowEmpty = false,
      onDismiss = { groupSessionTarget = null },
      onConfirm = { value ->
        groupSessionTarget = null
        if (!session.matchesGateway(activeGatewayStableId)) return@SessionTextDialog
        // Remember the name so the group survives locally even if the patch later empties it.
        viewModel.addChatSessionGroup(value)
        coroutineScope.launch {
          viewModel.patchChatSession(key = session.key, ownerAgentId = session.ownerAgentId, category = value.trim())
        }
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
      text = { Text(nativeString("Threads in \"\$group\" are kept and move back to Ungrouped.", group), style = ClawTheme.type.body, color = ClawTheme.colors.textMuted) },
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

  deleteSessionTarget?.let { session ->
    AlertDialog(
      onDismissRequest = { deleteSessionTarget = null },
      containerColor = ClawTheme.colors.surfaceRaised,
      title = { Text(nativeString("Delete thread?"), style = ClawTheme.type.section, color = ClawTheme.colors.text) },
      text = { Text(nativeString("This permanently deletes the thread and its transcript."), style = ClawTheme.type.body, color = ClawTheme.colors.textMuted) },
      confirmButton = {
        TextButton(
          onClick = {
            deleteSessionTarget = null
            if (!session.matchesGateway(activeGatewayStableId)) return@TextButton
            coroutineScope.launch { viewModel.deleteChatSession(session.key, session.ownerAgentId) }
          },
        ) {
          Text(nativeString("Delete"), color = ClawTheme.colors.danger)
        }
      },
      dismissButton = {
        TextButton(onClick = { deleteSessionTarget = null }) {
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
  depth: Int,
  hasChildren: Boolean,
  expanded: Boolean,
  collapsedDescendantState: SessionDescendantState?,
  onToggleExpanded: () -> Unit,
  onClick: () -> Unit,
  onSetPinned: (Boolean) -> Unit,
  onSetUnread: (Boolean) -> Unit,
  onRename: () -> Unit,
  onSetColor: (String?) -> Unit,
  onFork: () -> Unit,
  onMoveToGroup: (String) -> Unit,
  onNewGroup: () -> Unit,
  onRemoveFromGroup: () -> Unit,
  onSetArchived: (Boolean) -> Unit,
  onDelete: () -> Unit,
) {
  var menuExpanded by remember { mutableStateOf(false) }
  var submenu by remember { mutableStateOf<SessionRowSubmenu?>(null) }
  val selectedColor = session.color.takeIf { it in sessionColorNames }
  val canChangeArchived = !session.sessionId.isNullOrBlank()

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
                  submenu = null
                  menuExpanded = true
                },
              ).heightIn(min = 58.dp)
              .padding(start = (depth.coerceAtMost(3) * 18).dp)
              .sessionColorStripe(ClawTheme.colors.sessionColor(session.color))
              .padding(vertical = 5.dp),
          verticalAlignment = Alignment.CenterVertically,
          horizontalArrangement = Arrangement.spacedBy(7.dp),
        ) {
          Box(modifier = Modifier.size(ClawTheme.spacing.touchTarget), contentAlignment = Alignment.Center) {
            if (hasChildren) {
              IconButton(onClick = onToggleExpanded) {
                Icon(
                  imageVector =
                    if (expanded) {
                      Icons.Default.KeyboardArrowDown
                    } else {
                      Icons.AutoMirrored.Filled.KeyboardArrowRight
                    },
                  contentDescription =
                    if (expanded) {
                      nativeString("Collapse child sessions")
                    } else {
                      nativeString("Expand child sessions")
                    },
                  modifier = Modifier.size(18.dp),
                  tint = ClawTheme.colors.textMuted,
                )
              }
            }
          }

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
              SessionDescendantSignals(collapsedDescendantState, visible = compact)
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
          submenu = null
        },
      ) {
        if (submenu == null) {
          SessionMenuItem(nativeString("Color")) { submenu = SessionRowSubmenu.Color }
        }
        if (submenu == SessionRowSubmenu.Color) {
          SessionMenuItem(nativeString("← Back")) { submenu = null }
          (listOf(null) + sessionColorNames).forEach { name ->
            DropdownMenuItem(
              text = { Text(sessionColorLabel(name), style = ClawTheme.type.body) },
              leadingIcon = {
                ClawTheme.colors.sessionColor(name)?.let { color ->
                  Box(modifier = Modifier.size(16.dp).background(color, CircleShape))
                }
              },
              trailingIcon = {
                if (selectedColor == name) Icon(Icons.Default.Check, contentDescription = nativeString("Selected"))
              },
              onClick = {
                menuExpanded = false
                submenu = null
                onSetColor(name)
              },
            )
          }
        } else if (archived) {
          if (canChangeArchived) {
            SessionMenuItem(nativeString("Unarchive")) {
              menuExpanded = false
              onSetArchived(false)
            }
          }
          SessionMenuItem(nativeString("Delete…")) {
            menuExpanded = false
            onDelete()
          }
        } else if (submenu == SessionRowSubmenu.Group) {
          SessionMenuItem(nativeString("← Back")) { submenu = null }
          categories.forEach { category ->
            SessionMenuItem(category) {
              menuExpanded = false
              submenu = null
              onMoveToGroup(category)
            }
          }
          SessionMenuItem(nativeString("New group…")) {
            menuExpanded = false
            submenu = null
            onNewGroup()
          }
          if (!session.category.isNullOrBlank()) {
            SessionMenuItem(nativeString("Remove from group")) {
              menuExpanded = false
              submenu = null
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
          SessionMenuItem(
            nativeString(
              if (session.hasActiveRun == true) "Fork from last completed message" else "Fork",
            ),
          ) {
            menuExpanded = false
            onFork()
          }
          SessionMenuItem(nativeString("Move to group")) { submenu = SessionRowSubmenu.Group }
          if (canChangeArchived) {
            SessionMenuItem(nativeString("Archive")) {
              menuExpanded = false
              onSetArchived(true)
            }
          }
          // Delete is archive-gated: the bounded operator session lacks
          // operator.admin, and the gateway only grants write-scope deletes
          // for archived sessions. Archived rows keep the Delete item.
        }
      }
    }
  }
}

private enum class SessionRowSubmenu { Color, Group }

private fun sessionColorLabel(name: String?): String =
  when (name) {
    "red" -> nativeString("Red")
    "blue" -> nativeString("Blue")
    "green" -> nativeString("Green")
    "yellow" -> nativeString("Yellow")
    "purple" -> nativeString("Purple")
    "orange" -> nativeString("Orange")
    "pink" -> nativeString("Pink")
    "cyan" -> nativeString("Cyan")
    else -> nativeString("Default")
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

internal enum class SessionFilter {
  Recent,
  Current,
  Archived,
}

internal data class SessionBrowserSearchState(
  val query: String,
  val entries: List<ChatSessionEntry>,
  val loading: Boolean,
)

/** Canonical debounced, gateway-backed search state shared by session browser surfaces. */
@Composable
internal fun rememberSessionBrowserSearchState(
  viewModel: MainViewModel,
  sessions: List<ChatSessionEntry>,
  query: String,
  archived: Boolean,
): SessionBrowserSearchState {
  val normalizedQuery = query.trim()
  var searchResults by remember { mutableStateOf<List<ChatSessionEntry>>(emptyList()) }
  var searchLoading by remember { mutableStateOf(false) }

  // Keyed on the live list too: row mutations refresh sessions and re-run an active search.
  LaunchedEffect(normalizedQuery, archived, sessions) {
    if (normalizedQuery.isEmpty()) {
      searchResults = emptyList()
      searchLoading = false
      return@LaunchedEffect
    }
    searchResults = emptyList()
    searchLoading = true
    try {
      // Key changes cancel superseded debounce/fetch work. The controller owns
      // gateway search plus the offline local-filter fallback.
      delay(250)
      searchResults =
        viewModel.fetchChatSessionList(
          search = normalizedQuery,
          archived = archived,
        )
    } finally {
      searchLoading = false
    }
  }

  return SessionBrowserSearchState(
    query = normalizedQuery,
    entries = if (normalizedQuery.isEmpty()) sessions else searchResults,
    loading = searchLoading,
  )
}

/** Applies the canonical active/current/archived filter and chronological ordering. */
internal fun resolveSessionBrowserEntries(
  entries: List<ChatSessionEntry>,
  currentSessionKey: String,
  filter: SessionFilter,
  recentFirst: Boolean,
): List<ChatSessionEntry> {
  val filtered =
    when (filter) {
      SessionFilter.Recent -> entries.filter { it.archived != true }

      SessionFilter.Current -> entries.filter { it.key == currentSessionKey && it.archived != true }

      // Gate on the entry's own archived flag so a pre-toggle active list can
      // never render with archived-only actions while a refetch is in flight.
      SessionFilter.Archived -> entries.filter { it.archived == true }
    }
  return if (recentFirst) {
    filtered.sortedByDescending { it.lastActivityAt ?: it.updatedAtMs ?: 0L }
  } else {
    filtered.sortedBy { it.lastActivityAt ?: it.updatedAtMs ?: 0L }
  }
}

internal fun sessionListSubtitle(
  session: ChatSessionEntry,
  fallback: String,
  nowMs: Long = System.currentTimeMillis(),
): String {
  val agentStatus =
    session.agentStatus?.takeIf { status ->
      status.expiresAt > nowMs && status.note.isNotBlank()
    }
  val declaredAttention = agentStatus?.takeIf { it.attention != null }?.note
  val runStatus = session.status?.trim()?.lowercase()
  val failureAt = session.endedAt ?: session.updatedAtMs ?: 0L
  val failedAttention =
    session.lastRunError
      ?.trim()
      ?.takeIf { it.isNotEmpty() && (runStatus == "failed" || runStatus == "timeout") && (session.lastReadAt ?: 0L) < failureAt }
  val digest = session.observerDigest
  val running = session.hasActiveRun == true || runStatus == "running"
  val digestMatchesActiveRun =
    digest
      ?.runId
      ?.trim()
      ?.takeIf(String::isNotEmpty)
      ?.let { runId -> session.activeRunIds.orEmpty().any { it.trim() == runId } } == true
  val finalDigestUnread =
    digest != null &&
      (digest.health == "done" || digest.health == "failed") &&
      (session.lastReadAt ?: 0L) < digest.updatedAt
  val observer = digest?.headline?.takeIf { (running && digestMatchesActiveRun) || (!running && finalDigestUnread) }
  val queued = nativeString("Waiting for a concurrency slot").takeIf { runStatus == "queued" }
  return declaredAttention ?: failedAttention ?: agentStatus?.note ?: queued ?: observer ?: fallback
}

internal data class SessionSection(
  val title: String?,
  val entries: List<ChatSessionEntry>,
  // Only custom category sections expose group actions; "Pinned"/"Ungrouped" are structural.
  val isCategory: Boolean = false,
)

internal data class SessionTreeEntry(
  val session: ChatSessionEntry,
  val depth: Int,
  val hasChildren: Boolean,
  val descendantState: SessionDescendantState = SessionDescendantState(),
)

internal data class SessionDescendantState(
  val containsCurrent: Boolean = false,
  val hasRunning: Boolean = false,
  val hasUnread: Boolean = false,
  val hasFailure: Boolean = false,
  val hasAttention: Boolean = false,
) {
  val hasActionableState: Boolean
    get() = containsCurrent || hasRunning || hasUnread || hasFailure || hasAttention

  fun merge(other: SessionDescendantState): SessionDescendantState =
    SessionDescendantState(
      containsCurrent = containsCurrent || other.containsCurrent,
      hasRunning = hasRunning || other.hasRunning,
      hasUnread = hasUnread || other.hasUnread,
      hasFailure = hasFailure || other.hasFailure,
      hasAttention = hasAttention || other.hasAttention,
    )

  fun presentationLabel(): String? = presentationLabels().takeIf { it.isNotEmpty() }?.joinToString(" · ")

  @Composable
  fun presentationSignals(): List<SessionDescendantSignal> =
    buildList {
      if (hasAttention) {
        add(SessionDescendantSignal(nativeString("Needs attention"), Icons.Default.ErrorOutline, ClawTheme.colors.warning))
      }
      if (hasFailure) add(SessionDescendantSignal(nativeString("Thread failed"), Icons.Default.Close, ClawTheme.colors.danger))
      if (containsCurrent) {
        add(SessionDescendantSignal(nativeString("Current thread"), Icons.Default.StarBorder, ClawTheme.colors.success))
      }
      if (hasRunning) add(SessionDescendantSignal(nativeString("Running"), Icons.Default.PlayArrow, ClawTheme.colors.success))
      if (hasUnread) {
        add(SessionDescendantSignal(nativeString("Unread"), Icons.Outlined.ChatBubbleOutline, ClawTheme.colors.primary))
      }
    }

  private fun presentationLabels(): List<String> =
    buildList {
      if (hasAttention) add(nativeString("Needs attention"))
      if (hasFailure) add(nativeString("Thread failed"))
      if (containsCurrent) add(nativeString("Current thread"))
      if (hasRunning) add(nativeString("Running"))
      if (hasUnread) add(nativeString("Unread"))
    }
}

internal data class SessionDescendantSignal(
  val label: String,
  val icon: ImageVector,
  val color: Color,
)

internal fun nextSessionStatusExpiry(
  entries: List<ChatSessionEntry>,
  nowMs: Long,
): Long? = entries.mapNotNull { it.agentStatus?.expiresAt }.filter { it > nowMs }.minOrNull()

internal suspend fun awaitSessionStatusExpiry(
  expiry: Long,
  nowMs: () -> Long = System::currentTimeMillis,
  wait: suspend (Long) -> Unit = { delay(it) },
): Long {
  while (true) {
    val currentTimeMs = nowMs()
    val remainingMs = expiry - currentTimeMs
    if (remainingMs <= 0L) return currentTimeMs
    wait(remainingMs)
  }
}

@Composable
internal fun SessionDescendantSignals(
  state: SessionDescendantState?,
  visible: Boolean,
) {
  if (!visible) return
  state?.presentationSignals()?.let { signals ->
    Row(horizontalArrangement = Arrangement.spacedBy(3.dp)) {
      signals.forEach { signal ->
        Icon(
          imageVector = signal.icon,
          contentDescription = signal.label,
          modifier = Modifier.size(13.dp),
          tint = signal.color,
        )
      }
    }
  }
}

internal data class SessionTreeSection(
  val title: String?,
  val entries: List<SessionTreeEntry>,
  val isCategory: Boolean = false,
)

private val CollapsedSessionKeysSaver =
  Saver<Set<String>, ArrayList<String>>(
    save = { keys -> ArrayList(keys.sorted()) },
    restore = { keys -> keys.toSet() },
  )

/** Projects a flat visible snapshot into section roots and expandable descendants. */
internal fun buildSessionTreeSections(
  entries: List<ChatSessionEntry>,
  knownGroups: List<String> = emptyList(),
  collapsedSessionKeys: Set<String> = emptySet(),
  currentSessionKey: String = "",
  nowMs: Long = System.currentTimeMillis(),
): List<SessionTreeSection> {
  if (entries.isEmpty()) return emptyList()
  val entriesByKey = entries.associateBy { it.key }
  val candidateParents =
    buildMap {
      entries.forEach { entry ->
        if (entry.pinned == true || !entry.category.isNullOrBlank()) return@forEach
        val parentKey =
          entry.parentSessionKey?.trim()?.takeIf(String::isNotEmpty)
            ?: entry.spawnedBy?.trim()?.takeIf(String::isNotEmpty)
        if (parentKey != null && parentKey != entry.key && parentKey in entriesByKey) {
          put(entry.key, parentKey)
        }
      }
    }

  fun hasParentCycle(startKey: String): Boolean {
    val seen = mutableSetOf<String>()
    var key: String? = startKey
    while (key != null) {
      if (!seen.add(key)) return true
      key = candidateParents[key]
    }
    return false
  }

  val parentByKey = candidateParents.filterKeys { key -> !hasParentCycle(key) }
  val childrenByParent = mutableMapOf<String, MutableList<ChatSessionEntry>>()
  entries.forEach { entry ->
    parentByKey[entry.key]?.let { parentKey ->
      childrenByParent.getOrPut(parentKey) { mutableListOf() }.add(entry)
    }
  }
  val roots = entries.filter { it.key !in parentByKey }
  val visited = mutableSetOf<String>()
  val descendantStateByKey = mutableMapOf<String, SessionDescendantState>()

  fun ownState(session: ChatSessionEntry): SessionDescendantState {
    val status = session.status?.trim()?.lowercase()
    val attention = session.agentStatus?.let { it.expiresAt > nowMs && it.attention != null } == true
    return SessionDescendantState(
      containsCurrent = session.key == currentSessionKey,
      hasRunning = session.hasActiveRun == true || status == "running",
      hasUnread = session.unread == true,
      hasFailure = status == "failed" || status == "timeout" || status == "timed_out",
      hasAttention = attention,
    )
  }

  fun descendantState(session: ChatSessionEntry): SessionDescendantState =
    descendantStateByKey.getOrPut(session.key) {
      childrenByParent[session.key]
        .orEmpty()
        .fold(
          SessionDescendantState(hasRunning = session.hasActiveSubagentRun == true),
        ) { state, child -> state.merge(ownState(child)).merge(descendantState(child)) }
    }

  fun flatten(
    session: ChatSessionEntry,
    depth: Int,
  ): List<SessionTreeEntry> {
    if (!visited.add(session.key)) return emptyList()
    val children = childrenByParent[session.key].orEmpty()
    return buildList {
      add(
        SessionTreeEntry(
          session = session,
          depth = depth,
          hasChildren = children.isNotEmpty(),
          descendantState = descendantState(session),
        ),
      )
      if (session.key !in collapsedSessionKeys) {
        children.forEach { child -> addAll(flatten(child, depth + 1)) }
      }
    }
  }

  return groupSessionEntries(roots, knownGroups = knownGroups).map { section ->
    SessionTreeSection(
      title = section.title,
      entries = section.entries.flatMap { root -> flatten(root, depth = 0) },
      isCategory = section.isCategory,
    )
  }
}

/** Immutable row identity retained while a destructive or mutating dialog is open. */
internal data class SessionActionTarget(
  val gatewayStableId: String?,
  val key: String,
  val ownerAgentId: String?,
  val label: String?,
  val displayName: String?,
) {
  val stateKey: String = "${gatewayStableId.orEmpty()}:${ownerAgentId.orEmpty()}:$key"

  fun matchesGateway(activeGatewayStableId: String?): Boolean = gatewayStableId == activeGatewayStableId
}

private const val SESSION_ACTION_TARGET_STATE_FIELDS = 9

private val SessionActionTargetSaver =
  Saver<SessionActionTarget?, ArrayList<String>>(
    save = { target -> target?.toSavedState() ?: arrayListOf() },
    restore = ::sessionActionTargetFromSavedState,
  )

internal fun SessionActionTarget.toSavedState(): ArrayList<String> =
  arrayListOf(
    if (gatewayStableId == null) "0" else "1",
    gatewayStableId.orEmpty(),
    key,
    if (ownerAgentId == null) "0" else "1",
    ownerAgentId.orEmpty(),
    if (label == null) "0" else "1",
    label.orEmpty(),
    if (displayName == null) "0" else "1",
    displayName.orEmpty(),
  )

internal fun sessionActionTargetFromSavedState(values: List<String>): SessionActionTarget? {
  if (values.size != SESSION_ACTION_TARGET_STATE_FIELDS || values[2].isEmpty()) return null
  return SessionActionTarget(
    gatewayStableId = values[1].takeIf { values[0] == "1" },
    key = values[2],
    ownerAgentId = values[4].takeIf { values[3] == "1" },
    label = values[6].takeIf { values[5] == "1" },
    displayName = values[8].takeIf { values[7] == "1" },
  )
}

internal fun ChatSessionEntry.toActionTarget(gatewayStableId: String?): SessionActionTarget =
  SessionActionTarget(
    gatewayStableId = gatewayStableId,
    key = key,
    ownerAgentId = ownerAgentId,
    label = label,
    displayName = displayName,
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
    SessionFilter.Recent -> nativeString("No threads yet")
    SessionFilter.Current -> nativeString("No current thread")
    SessionFilter.Archived -> nativeString("No archived threads")
  }

/** Empty-state body selected by the active session browser filter. */
private fun emptySessionBody(filter: SessionFilter): String =
  when (filter) {
    SessionFilter.Recent -> nativeString("Start a new conversation and it will show up here.")
    SessionFilter.Current -> nativeString("Open Chat to start or resume the current thread.")
    SessionFilter.Archived -> nativeString("Archived threads will show up here.")
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
