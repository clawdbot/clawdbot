package ai.openclaw.app.ui

import ai.openclaw.app.GatewayAgentSummary
import ai.openclaw.app.selectableAgents
import ai.openclaw.app.ui.design.ClawAgentAvatar
import ai.openclaw.app.ui.design.ClawTheme
import ai.openclaw.app.ui.design.agentAvatarSource
import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Check
import androidx.compose.material.icons.filled.KeyboardArrowDown
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.Icon
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp

internal data class AgentPickerState(
  val agents: List<GatewayAgentSummary>,
  val selectedAgentId: String?,
) {
  val selected: GatewayAgentSummary?
    get() = agents.firstOrNull { it.id == selectedAgentId }
}

internal fun agentPickerState(
  agents: List<GatewayAgentSummary>,
  selectedAgentId: String?,
  fallbackToFirst: Boolean = true,
): AgentPickerState {
  val selectable = agents.selectableAgents().distinctBy(GatewayAgentSummary::id)
  val requestedAgentId = selectedAgentId?.trim()?.takeIf(String::isNotEmpty)
  val effectiveAgentId =
    selectable
      .firstOrNull { it.id == requestedAgentId }
      ?.id
      ?: if (fallbackToFirst) selectable.firstOrNull()?.id else requestedAgentId
  return AgentPickerState(
    agents = selectable,
    selectedAgentId = effectiveAgentId,
  )
}

internal fun agentPickerName(agent: GatewayAgentSummary): String = agent.name?.trim()?.takeIf(String::isNotEmpty) ?: agent.id

internal fun agentPickerLabel(state: AgentPickerState): String? = state.selected?.let(::agentPickerName) ?: state.selectedAgentId

@Composable
internal fun AgentPicker(
  state: AgentPickerState,
  onSelectAgent: (String) -> Unit,
  modifier: Modifier = Modifier,
) {
  val selectedAgentId = state.selectedAgentId ?: return
  val label = agentPickerLabel(state) ?: return
  var expanded by remember { mutableStateOf(false) }

  Box(modifier = modifier) {
    Surface(
      onClick = { expanded = true },
      modifier = Modifier.fillMaxWidth().heightIn(min = ClawTheme.spacing.touchTarget),
      shape = RoundedCornerShape(ClawTheme.radii.pill),
      color = ClawTheme.colors.surfaceRaised.copy(alpha = 0.72f),
      contentColor = ClawTheme.colors.text,
      border = BorderStroke(1.dp, ClawTheme.colors.border.copy(alpha = 0.7f)),
    ) {
      Row(
        modifier = Modifier.padding(horizontal = 10.dp, vertical = 7.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(7.dp),
      ) {
        state.selected?.let { selected -> AgentPickerAvatar(agent = selected, size = 24) }
        Text(
          text = label,
          style = ClawTheme.type.caption,
          maxLines = 1,
          modifier = Modifier.weight(1f),
          overflow = TextOverflow.Ellipsis,
        )
        Icon(
          imageVector = Icons.Default.KeyboardArrowDown,
          contentDescription = null,
          modifier = Modifier.size(18.dp),
        )
      }
    }

    DropdownMenu(
      expanded = expanded,
      onDismissRequest = { expanded = false },
      containerColor = ClawTheme.colors.surfaceRaised,
    ) {
      state.agents.forEach { agent ->
        DropdownMenuItem(
          text = {
            Text(
              text = agentPickerName(agent),
              maxLines = 1,
              overflow = TextOverflow.Ellipsis,
            )
          },
          leadingIcon = { AgentPickerAvatar(agent = agent, size = 24) },
          trailingIcon = {
            if (agent.id == selectedAgentId) {
              Icon(imageVector = Icons.Default.Check, contentDescription = null)
            }
          },
          onClick = {
            expanded = false
            onSelectAgent(agent.id)
          },
        )
      }
    }
  }
}

@Composable
private fun AgentPickerAvatar(
  agent: GatewayAgentSummary,
  size: Int,
) {
  val avatarSize = size.dp
  ClawAgentAvatar(source = agentAvatarSource(agent), size = avatarSize) {
    Box(
      modifier = Modifier.size(avatarSize).clip(CircleShape).background(ClawTheme.colors.surfacePressed),
      contentAlignment = Alignment.Center,
    ) {
      Text(
        text = agent.emoji?.trim()?.takeIf(String::isNotEmpty) ?: agentPickerName(agent).take(1).uppercase(),
        style = ClawTheme.type.caption,
      )
    }
  }
}
