package ai.openclaw.app.ui

import ai.openclaw.app.GatewayAgentSummary
import ai.openclaw.app.chat.ChatSessionEntry
import ai.openclaw.app.i18n.nativeString
import ai.openclaw.app.ui.design.ClawAgentAvatar
import ai.openclaw.app.ui.design.ClawTheme
import ai.openclaw.app.ui.design.agentAvatarSource
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.RowScope
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.selection.selectable
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Close
import androidx.compose.material.icons.filled.PushPin
import androidx.compose.material.icons.filled.Search
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.NavigationDrawerItem
import androidx.compose.material3.NavigationDrawerItemDefaults
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.OutlinedTextFieldDefaults
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.semantics.stateDescription
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp

@Composable
internal fun sidebarSearchLabel(): String = nativeString("Search sessions")

@Composable
internal fun SidebarSearchField(
  query: String,
  onQueryChange: (String) -> Unit,
  palette: SidebarPalette,
  modifier: Modifier = Modifier,
) {
  OutlinedTextField(
    value = query,
    onValueChange = onQueryChange,
    modifier = modifier.fillMaxWidth().testTag("sidebar-search"),
    singleLine = true,
    label = { Text(sidebarSearchLabel()) },
    leadingIcon = {
      Icon(
        imageVector = Icons.Default.Search,
        contentDescription = null,
      )
    },
    trailingIcon = {
      if (query.isNotEmpty()) {
        IconButton(onClick = { onQueryChange("") }, modifier = Modifier.size(48.dp)) {
          Icon(
            imageVector = Icons.Default.Close,
            contentDescription = nativeString("Clear session search"),
          )
        }
      }
    },
    colors =
      OutlinedTextFieldDefaults.colors(
        focusedTextColor = palette.text,
        unfocusedTextColor = palette.text,
        focusedContainerColor = palette.elevated,
        unfocusedContainerColor = palette.elevated,
        cursorColor = ClawTheme.colors.primary,
        focusedBorderColor = ClawTheme.colors.primary,
        unfocusedBorderColor = palette.hairline,
        focusedLabelColor = ClawTheme.colors.primary,
        unfocusedLabelColor = palette.muted,
        focusedLeadingIconColor = palette.text,
        unfocusedLeadingIconColor = palette.muted,
        focusedTrailingIconColor = palette.text,
        unfocusedTrailingIconColor = palette.muted,
      ),
  )
}

@Composable
internal fun SidebarSectionTitle(
  label: String,
  palette: SidebarPalette,
  modifier: Modifier = Modifier,
) {
  Text(
    text = label,
    style = ClawTheme.type.caption.copy(fontWeight = FontWeight.SemiBold, fontSize = 12.sp),
    color = palette.muted,
    modifier = modifier.semantics { heading() }.padding(horizontal = 12.dp, vertical = 6.dp),
    maxLines = 1,
  )
}

@Composable
internal fun SidebarAgentRow(
  agent: GatewayAgentSummary,
  selected: Boolean,
  palette: SidebarPalette,
  onClick: () -> Unit,
) {
  SidebarRowSurface(
    selected = selected,
    stateDescription = if (selected) nativeString("Selected") else null,
    palette = palette,
    onClick = onClick,
  ) {
    ClawAgentAvatar(source = agentAvatarSource(agent), size = 28.dp) {
      Box(
        modifier = Modifier.size(28.dp).clip(CircleShape).background(palette.elevated),
        contentAlignment = Alignment.Center,
      ) {
        Text(
          text = agent.emoji?.takeIf(String::isNotBlank) ?: sidebarAgentName(agent).take(1).uppercase(),
          style = ClawTheme.type.caption,
          color = palette.text,
        )
      }
    }
    Text(
      text = sidebarAgentName(agent),
      style = ClawTheme.type.body,
      color = palette.text,
      modifier = Modifier.weight(1f),
      maxLines = 1,
      overflow = TextOverflow.Ellipsis,
    )
    if (selected) {
      Text(
        text = nativeString("Selected"),
        style = ClawTheme.type.caption.copy(fontSize = 11.sp),
        color = palette.muted,
      )
    }
  }
}

@Composable
internal fun SidebarActionRow(
  label: String,
  icon: ImageVector,
  palette: SidebarPalette,
  onClick: () -> Unit,
) {
  SidebarRowSurface(selected = null, palette = palette, onClick = onClick) {
    Spacer(modifier = Modifier.size(28.dp))
    Text(
      text = label,
      style = ClawTheme.type.body,
      color = palette.muted,
      modifier = Modifier.weight(1f),
      maxLines = 1,
    )
    Icon(imageVector = icon, contentDescription = null, tint = palette.muted, modifier = Modifier.size(18.dp))
  }
}

@Composable
internal fun SidebarNavigationRow(
  destination: SidebarDestination,
  selected: Boolean,
  palette: SidebarPalette,
  onClick: () -> Unit,
) {
  NavigationDrawerItem(
    label = {
      Text(
        text = destination.localizedLabel(),
        style = ClawTheme.type.body,
        maxLines = 1,
      )
    },
    selected = selected,
    onClick = onClick,
    icon = {
      Icon(
        imageVector = destination.icon,
        contentDescription = null,
        modifier = Modifier.size(20.dp),
      )
    },
    modifier = Modifier.fillMaxWidth().heightIn(min = 48.dp),
    shape = RoundedCornerShape(10.dp),
    colors =
      NavigationDrawerItemDefaults.colors(
        selectedContainerColor = palette.selection,
        unselectedContainerColor = Color.Transparent,
        selectedIconColor = palette.text,
        unselectedIconColor = palette.text,
        selectedTextColor = palette.text,
        unselectedTextColor = palette.text,
      ),
  )
}

@Composable
internal fun SidebarSessionRow(
  session: ChatSessionEntry,
  selected: Boolean,
  palette: SidebarPalette,
  onClick: () -> Unit,
) {
  val sessionStateDescription =
    when {
      session.status == "queued" -> nativeString("Queued")
      session.hasActiveRun == true -> nativeString("Working")
      session.unread == true -> nativeString("Needs attention")
      selected -> nativeString("Selected")
      else -> null
    }
  SidebarRowSurface(
    selected = selected,
    stateDescription = sessionStateDescription,
    palette = palette,
    onClick = onClick,
  ) {
    Box(
      modifier =
        Modifier
          .size(7.dp)
          .clip(CircleShape)
          .background(
            when {
              session.hasActiveRun == true -> ClawTheme.colors.warning
              session.unread == true -> ClawTheme.colors.primary
              else -> palette.muted.copy(alpha = 0.45f)
            },
          ).clearAndSetSemantics {},
    )
    Column(modifier = Modifier.weight(1f)) {
      Text(
        text = sidebarSessionTitle(session),
        style = ClawTheme.type.body.copy(fontSize = 13.sp),
        color = palette.text,
        maxLines = 1,
        overflow = TextOverflow.Ellipsis,
      )
      Text(
        text = sidebarSessionSubtitle(session, sessionStateDescription),
        style = ClawTheme.type.caption.copy(fontSize = 11.sp),
        color = palette.muted,
        maxLines = 1,
        overflow = TextOverflow.Ellipsis,
      )
    }
    if (session.pinned == true) {
      Icon(
        imageVector = Icons.Default.PushPin,
        contentDescription = nativeString("Pinned"),
        modifier = Modifier.size(13.dp),
        tint = palette.muted,
      )
    }
  }
}

@Composable
private fun SidebarRowSurface(
  selected: Boolean?,
  stateDescription: String? = null,
  palette: SidebarPalette,
  onClick: () -> Unit,
  content: @Composable RowScope.() -> Unit,
) {
  Row(
    modifier =
      Modifier
        .fillMaxWidth()
        .heightIn(min = 48.dp)
        .clip(RoundedCornerShape(10.dp))
        .background(if (selected == true) palette.selection else Color.Transparent)
        .then(
          if (selected == null) {
            Modifier.clickable(role = Role.Button, onClick = onClick)
          } else {
            Modifier.selectable(selected = selected, role = Role.Button, onClick = onClick)
          },
        ).then(
          if (stateDescription == null) {
            Modifier
          } else {
            Modifier.semantics { this.stateDescription = stateDescription }
          },
        ).padding(horizontal = 12.dp, vertical = 8.dp),
    verticalAlignment = Alignment.CenterVertically,
    horizontalArrangement = Arrangement.spacedBy(10.dp),
    content = content,
  )
}

internal fun sidebarSessionSubtitle(
  session: ChatSessionEntry,
  activeRunLabel: String?,
  nowMs: Long = System.currentTimeMillis(),
): String =
  sessionListSubtitle(
    session = session,
    fallback =
      if (session.hasActiveRun == true) checkNotNull(activeRunLabel) else sessionSourceLabel(session.key),
    nowMs = nowMs,
  )
