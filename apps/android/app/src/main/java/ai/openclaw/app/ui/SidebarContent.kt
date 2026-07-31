package ai.openclaw.app.ui

import ai.openclaw.app.GatewayAgentSummary
import ai.openclaw.app.GatewayConnectionDisplay
import ai.openclaw.app.chat.ChatSessionEntry
import ai.openclaw.app.i18n.nativeString
import ai.openclaw.app.selectableAgents
import ai.openclaw.app.ui.design.ClawTheme
import ai.openclaw.app.ui.design.OpenClawMascot
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.safeDrawing
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.windowInsetsPadding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Close
import androidx.compose.material.icons.filled.Home
import androidx.compose.material.icons.filled.KeyboardArrowDown
import androidx.compose.material.icons.filled.Settings
import androidx.compose.material.icons.filled.Storage
import androidx.compose.material.icons.outlined.AccessTime
import androidx.compose.material.icons.outlined.ChatBubbleOutline
import androidx.compose.material.icons.outlined.Dashboard
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.luminance
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.semantics.stateDescription
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp

internal enum class SidebarDestination(
  val icon: ImageVector,
) {
  Home(icon = Icons.Outlined.ChatBubbleOutline),
  Overview(icon = Icons.Default.Home),
  Usage(icon = Icons.Default.Storage),
  Automations(icon = Icons.Outlined.AccessTime),
  Sessions(icon = Icons.Outlined.Dashboard),
}

internal fun SidebarDestination.localizedLabel(): String =
  when (this) {
    SidebarDestination.Home -> nativeString("Home")
    SidebarDestination.Overview -> nativeString("Overview")
    SidebarDestination.Usage -> nativeString("Usage")
    SidebarDestination.Automations -> nativeString("Automations")
    SidebarDestination.Sessions -> nativeString("Threads")
  }

internal val SidebarDestination.compactLabelSource: String
  get() =
    when (this) {
      SidebarDestination.Home -> "Chat"
      SidebarDestination.Overview -> "Status"
      SidebarDestination.Usage -> "Usage"
      SidebarDestination.Automations -> "Cron"
      SidebarDestination.Sessions -> "Threads"
    }

internal fun SidebarDestination.compactLocalizedLabel(): String = nativeString(compactLabelSource)

internal data class SidebarAgentRoster(
  val selected: GatewayAgentSummary?,
  val others: List<GatewayAgentSummary>,
)

internal fun sidebarAgentRoster(
  agents: List<GatewayAgentSummary>,
  selectedAgentId: String?,
): SidebarAgentRoster {
  val selectable = agents.selectableAgents().distinctBy(GatewayAgentSummary::id)
  val selected =
    selectable.firstOrNull { it.id == selectedAgentId?.trim() }
      ?: selectable.firstOrNull()
  return SidebarAgentRoster(
    selected = selected,
    others = selectable.filterNot { it.id == selected?.id },
  )
}

internal fun sidebarRecentSessions(
  sessions: List<ChatSessionEntry>,
  query: String,
  limit: Int = 8,
): List<ChatSessionEntry> {
  val normalizedQuery = query.trim().lowercase()
  return sessions
    .asSequence()
    .filter { it.archived != true }
    .filter { session ->
      normalizedQuery.isEmpty() ||
        listOfNotNull(session.displayName, session.label, session.key, session.ownerAgentId)
          .any { it.lowercase().contains(normalizedQuery) }
    }.sortedWith(
      compareByDescending<ChatSessionEntry> { it.pinned == true }
        .thenByDescending { it.lastActivityAt ?: it.updatedAtMs ?: 0L }
        .thenBy { it.key },
    ).take(limit.coerceAtLeast(0))
    .toList()
}

internal fun sidebarSessionTitle(session: ChatSessionEntry): String =
  session.displayName?.trim()?.takeIf(String::isNotEmpty)
    ?: session.label?.trim()?.takeIf(String::isNotEmpty)
    ?: session.key

internal fun sidebarAgentName(agent: GatewayAgentSummary): String = agent.name?.trim()?.takeIf(String::isNotEmpty) ?: agent.id

internal data class SidebarPalette(
  val background: Color,
  val elevated: Color,
  val selection: Color,
  val text: Color,
  val muted: Color,
  val hairline: Color,
)

@Composable
private fun sidebarPalette(): SidebarPalette {
  val dark = ClawTheme.colors.canvas.luminance() < 0.5f
  return if (dark) {
    SidebarPalette(
      background = Color.Black,
      elevated = Color(0xFF1A1A1A),
      selection = Color(0xFF232327),
      text = Color(0xFFEDEDED),
      muted = Color(0xFF8F8F8F),
      hairline = Color.White.copy(alpha = 0.14f),
    )
  } else {
    SidebarPalette(
      background = Color(0xFFFAFAFA),
      elevated = Color(0xFFF2F2F2),
      selection = Color(0xFFEDEDED),
      text = Color(0xFF171717),
      muted = Color(0xFF8F8F8F),
      hairline = Color.Black.copy(alpha = 0.08f),
    )
  }
}

@Composable
internal fun OpenClawSidebar(
  agents: List<GatewayAgentSummary>,
  selectedAgentId: String?,
  sessions: List<ChatSessionEntry>,
  activeSessionKey: String,
  activeDestination: SidebarDestination?,
  connection: GatewayConnectionDisplay,
  showCloseButton: Boolean,
  onClose: () -> Unit,
  onOpenSettings: () -> Unit,
  onSelectAgent: (String) -> Unit,
  onSelectSession: (ChatSessionEntry) -> Unit,
  onSelectDestination: (SidebarDestination) -> Unit,
) {
  val palette = sidebarPalette()
  val roster = sidebarAgentRoster(agents, selectedAgentId)
  var query by rememberSaveable { mutableStateOf("") }
  var agentsExpanded by remember { mutableStateOf(false) }
  val recentSessions = sidebarRecentSessions(sessions, query)
  val connectionLabel = gatewayStatusLabel(connection)

  Column(
    modifier =
      Modifier
        .fillMaxSize()
        .background(palette.background)
        .windowInsetsPadding(WindowInsets.safeDrawing)
        .padding(horizontal = 14.dp, vertical = 10.dp),
  ) {
    Column(
      modifier =
        Modifier
          .weight(1f)
          .fillMaxWidth()
          .verticalScroll(rememberScrollState()),
    ) {
      Row(
        modifier = Modifier.fillMaxWidth().heightIn(min = 48.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(8.dp),
      ) {
        OpenClawMascot(modifier = Modifier.size(28.dp))
        Text(
          text = "OpenClaw",
          style = ClawTheme.type.title.copy(fontSize = 18.sp, lineHeight = 22.sp),
          color = palette.text,
          modifier = Modifier.weight(1f),
          maxLines = 1,
        )
        IconButton(onClick = onOpenSettings, modifier = Modifier.size(48.dp)) {
          Icon(
            imageVector = Icons.Default.Settings,
            contentDescription = nativeString("Open Settings"),
            tint = palette.text,
            modifier = Modifier.size(20.dp),
          )
        }
        if (showCloseButton) {
          IconButton(onClick = onClose, modifier = Modifier.size(48.dp).testTag("sidebar-close")) {
            Icon(
              imageVector = Icons.Default.Close,
              contentDescription = nativeString("Hide Sidebar"),
              tint = palette.text,
              modifier = Modifier.size(20.dp),
            )
          }
        }
      }

      SidebarSearchField(
        query = query,
        onQueryChange = { query = it },
        palette = palette,
        modifier = Modifier.padding(top = 4.dp, bottom = 12.dp),
      )

      SidebarSectionTitle(nativeString("Agents"), palette)
      roster.selected?.let { selected ->
        SidebarAgentRow(
          agent = selected,
          selected = true,
          palette = palette,
          onClick = { onSelectAgent(selected.id) },
        )
      }
      if (roster.others.isNotEmpty()) {
        Box {
          SidebarActionRow(
            label = nativeString("More Agents"),
            icon = Icons.Default.KeyboardArrowDown,
            palette = palette,
            onClick = { agentsExpanded = true },
          )
          DropdownMenu(
            expanded = agentsExpanded,
            onDismissRequest = { agentsExpanded = false },
            containerColor = palette.elevated,
          ) {
            roster.others.forEach { agent ->
              DropdownMenuItem(
                text = {
                  Text(
                    text = sidebarAgentName(agent),
                    color = palette.text,
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                  )
                },
                onClick = {
                  agentsExpanded = false
                  onSelectAgent(agent.id)
                },
              )
            }
          }
        }
      }

      SidebarSectionTitle(nativeString("Pages"), palette, modifier = Modifier.padding(top = 12.dp))
      SidebarDestination.entries.forEach { destination ->
        SidebarNavigationRow(
          destination = destination,
          selected = destination == activeDestination,
          palette = palette,
          onClick = { onSelectDestination(destination) },
        )
      }

      SidebarSectionTitle(nativeString("Recent sessions"), palette, modifier = Modifier.padding(top = 12.dp))
      if (recentSessions.isEmpty()) {
        Text(
          text = nativeString("No recent sessions"),
          style = ClawTheme.type.caption,
          color = palette.muted,
          modifier = Modifier.padding(horizontal = 12.dp, vertical = 12.dp),
        )
      } else {
        Column(verticalArrangement = Arrangement.spacedBy(2.dp)) {
          recentSessions.forEach { session ->
            SidebarSessionRow(
              session = session,
              selected = session.key == activeSessionKey,
              palette = palette,
              onClick = { onSelectSession(session) },
            )
          }
        }
      }
    }

    HorizontalDivider(color = palette.hairline)
    Row(
      modifier =
        Modifier
          .fillMaxWidth()
          .heightIn(min = 48.dp)
          .semantics(mergeDescendants = true) {
            stateDescription = connectionLabel
          }.padding(horizontal = 12.dp),
      verticalAlignment = Alignment.CenterVertically,
      horizontalArrangement = Arrangement.spacedBy(9.dp),
    ) {
      Box(
        modifier =
          Modifier
            .size(8.dp)
            .clip(CircleShape)
            .background(if (connection.isConnected) ClawTheme.colors.success else palette.muted)
            .clearAndSetSemantics {},
      )
      Text(
        text = connectionLabel,
        style = ClawTheme.type.caption,
        color = palette.muted,
        maxLines = 1,
      )
    }
  }
}
