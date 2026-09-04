package ai.openclaw.app.ui.design

import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.navigationBars
import androidx.compose.foundation.layout.only
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.windowInsetsPadding
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Icon
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.Immutable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp

/**
 * Stable bottom-navigation destination descriptor.
 */
@Immutable
internal data class ClawNavItem(
  val key: String,
  val label: String,
  val icon: ImageVector,
)

/**
 * Compact app bar that keeps title, optional subtitle, navigation, and actions aligned.
 */
@Composable
internal fun ClawTopBar(
  title: String,
  modifier: Modifier = Modifier,
  subtitle: String? = null,
  navigation: (@Composable () -> Unit)? = null,
  actions: (@Composable () -> Unit)? = null,
) {
  Row(
    modifier =
      modifier
        .fillMaxWidth()
        .padding(horizontal = ClawTheme.spacing.sm, vertical = ClawTheme.spacing.xs),
    verticalAlignment = Alignment.CenterVertically,
    horizontalArrangement = Arrangement.spacedBy(12.dp),
  ) {
    navigation?.invoke()
    Column(modifier = Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(2.dp)) {
      Text(
        text = title,
        style = ClawTheme.type.section,
        color = ClawTheme.colors.text,
        maxLines = 1,
        overflow = TextOverflow.Ellipsis,
      )
      if (subtitle != null) {
        Text(
          text = subtitle,
          style = ClawTheme.type.caption,
          color = ClawTheme.colors.textSubtle,
          maxLines = 1,
          overflow = TextOverflow.Ellipsis,
        )
      }
    }
    actions?.invoke()
  }
}

/**
 * Bottom navigation shell that applies navigation-bar insets before laying out destinations.
 */
@Composable
internal fun ClawBottomNav(
  items: List<ClawNavItem>,
  selectedKey: String,
  onSelect: (String) -> Unit,
  modifier: Modifier = Modifier,
) {
  val safeInsets = WindowInsets.navigationBars.only(androidx.compose.foundation.layout.WindowInsetsSides.Bottom)

  Box(modifier = modifier.fillMaxWidth().background(ClawTheme.colors.canvas)) {
    Surface(
      modifier = Modifier.fillMaxWidth(),
      color = ClawTheme.colors.surface,
      border = BorderStroke(1.dp, ClawTheme.colors.border),
      shape = RoundedCornerShape(topStart = ClawTheme.radii.panel, topEnd = ClawTheme.radii.panel),
    ) {
      Row(
        modifier =
          Modifier
            .fillMaxWidth()
            .windowInsetsPadding(safeInsets)
            .padding(horizontal = 8.dp, vertical = 6.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(4.dp),
      ) {
        items.forEach { item ->
          ClawBottomNavItem(
            item = item,
            selected = item.key == selectedKey,
            onClick = { onSelect(item.key) },
            modifier = Modifier.weight(1f),
          )
        }
      }
    }
  }
}

@Composable
private fun ClawBottomNavItem(
  item: ClawNavItem,
  selected: Boolean,
  onClick: () -> Unit,
  modifier: Modifier = Modifier,
) {
  Surface(
    onClick = onClick,
    modifier = modifier.heightIn(min = ClawTheme.spacing.row),
    shape = RoundedCornerShape(ClawTheme.radii.control),
    color = if (selected) ClawTheme.colors.accentSoft else Color.Transparent,
    contentColor = if (selected) ClawTheme.colors.text else ClawTheme.colors.textMuted,
  ) {
    Column(
      modifier = Modifier.fillMaxWidth().padding(horizontal = 4.dp, vertical = 6.dp),
      horizontalAlignment = Alignment.CenterHorizontally,
      verticalArrangement = Arrangement.spacedBy(2.dp),
    ) {
      Icon(imageVector = item.icon, contentDescription = item.label, modifier = Modifier.size(ClawTheme.spacing.icon))
      Text(
        modifier = Modifier.fillMaxWidth(),
        text = item.label,
        style = ClawTheme.type.caption,
        maxLines = 1,
        overflow = TextOverflow.Ellipsis,
        textAlign = TextAlign.Center,
      )
    }
  }
}

/**
 * Two-character identity mark for users, agents, or nodes in compact UI rows.
 */
@Composable
internal fun ClawAvatarMark(
  text: String,
  modifier: Modifier = Modifier,
) {
  Surface(
    modifier = modifier.size(34.dp),
    shape = CircleShape,
    color = ClawTheme.colors.surfaceRaised,
    contentColor = ClawTheme.colors.text,
    border = BorderStroke(1.dp, ClawTheme.colors.border),
  ) {
    Box(contentAlignment = Alignment.Center) {
      Text(text = text.take(2).uppercase(), style = ClawTheme.type.label)
    }
  }
}
