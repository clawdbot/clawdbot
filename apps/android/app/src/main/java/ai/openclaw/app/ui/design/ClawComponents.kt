package ai.openclaw.app.ui.design

import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.safeDrawing
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.windowInsetsPadding
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.ChatBubble
import androidx.compose.material.icons.filled.Home
import androidx.compose.material.icons.filled.Mic
import androidx.compose.material.icons.filled.Search
import androidx.compose.material.icons.filled.Settings
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp

internal enum class ClawStatus {
  Neutral,
  Success,
  Warning,
  Danger,
}

/** Full-screen mobile scaffold that applies OpenClaw safe-area and canvas tokens. */
@Composable
internal fun ClawScaffold(
  modifier: Modifier = Modifier,
  contentPadding: PaddingValues = PaddingValues(horizontal = ClawTheme.spacing.lg, vertical = ClawTheme.spacing.lg),
  content: @Composable () -> Unit,
) {
  Box(
    modifier =
      modifier
        .fillMaxSize()
        .background(ClawTheme.colors.canvas)
        .windowInsetsPadding(WindowInsets.safeDrawing)
        .padding(contentPadding),
  ) {
    content()
  }
}

/** Section title row with an optional trailing action slot. */
@Composable
internal fun ClawSectionHeader(
  title: String,
  modifier: Modifier = Modifier,
  action: (@Composable () -> Unit)? = null,
) {
  Row(
    modifier = modifier.fillMaxWidth(),
    verticalAlignment = Alignment.CenterVertically,
    horizontalArrangement = Arrangement.SpaceBetween,
  ) {
    Text(
      text = title,
      style = ClawTheme.type.section,
      color = ClawTheme.colors.text,
    )
    action?.invoke()
  }
}

/** Primary call-to-action button using the mobile design token set. */
@Composable
internal fun ClawPrimaryButton(
  text: String,
  onClick: () -> Unit,
  modifier: Modifier = Modifier,
  enabled: Boolean = true,
  icon: ImageVector? = null,
) {
  Button(
    onClick = onClick,
    enabled = enabled,
    modifier = modifier.heightIn(min = ClawTheme.spacing.touchTarget),
    shape = RoundedCornerShape(ClawTheme.radii.button),
    colors =
      ButtonDefaults.buttonColors(
        containerColor = ClawTheme.colors.primary,
        contentColor = ClawTheme.colors.primaryText,
        disabledContainerColor = ClawTheme.colors.surfacePressed,
        disabledContentColor = ClawTheme.colors.textSubtle,
      ),
    contentPadding = PaddingValues(horizontal = 16.dp, vertical = 8.dp),
    elevation = ButtonDefaults.buttonElevation(defaultElevation = 0.dp, pressedElevation = 0.dp),
  ) {
    if (icon != null) {
      Icon(imageVector = icon, contentDescription = null, modifier = Modifier.size(16.dp))
      Spacer(modifier = Modifier.width(8.dp))
    }
    Text(text = text, style = ClawTheme.type.label, maxLines = 1, overflow = TextOverflow.Ellipsis)
  }
}

/** Secondary action button for non-default commands. */
@Composable
internal fun ClawSecondaryButton(
  text: String,
  onClick: () -> Unit,
  modifier: Modifier = Modifier,
  enabled: Boolean = true,
  icon: ImageVector? = null,
) {
  Surface(
    onClick = onClick,
    enabled = enabled,
    modifier = modifier.heightIn(min = ClawTheme.spacing.touchTarget),
    shape = RoundedCornerShape(ClawTheme.radii.button),
    color = if (enabled) ClawTheme.colors.surfaceRaised else ClawTheme.colors.surface,
    contentColor = if (enabled) ClawTheme.colors.text else ClawTheme.colors.textSubtle,
    border = BorderStroke(1.dp, if (enabled) ClawTheme.colors.borderStrong else ClawTheme.colors.border),
  ) {
    Row(
      modifier = Modifier.padding(horizontal = 14.dp, vertical = 8.dp),
      verticalAlignment = Alignment.CenterVertically,
      horizontalArrangement = Arrangement.Center,
    ) {
      if (icon != null) {
        Icon(imageVector = icon, contentDescription = null, modifier = Modifier.size(16.dp))
        Spacer(modifier = Modifier.width(7.dp))
      }
      Text(text = text, style = ClawTheme.type.label, maxLines = 1, overflow = TextOverflow.Ellipsis)
    }
  }
}

/** Fixed-size circular icon button for toolbar actions. */
@Composable
internal fun ClawIconButton(
  icon: ImageVector,
  contentDescription: String,
  onClick: () -> Unit,
  modifier: Modifier = Modifier,
  enabled: Boolean = true,
) {
  Surface(
    onClick = onClick,
    enabled = enabled,
    modifier = modifier.size(ClawTheme.spacing.touchTarget),
    shape = CircleShape,
    color = if (enabled) ClawTheme.colors.surfaceRaised else ClawTheme.colors.surface,
    contentColor = if (enabled) ClawTheme.colors.text else ClawTheme.colors.textSubtle,
    border = BorderStroke(1.dp, ClawTheme.colors.border),
  ) {
    Box(contentAlignment = Alignment.Center) {
      Icon(imageVector = icon, contentDescription = contentDescription, modifier = Modifier.size(18.dp))
    }
  }
}

/** Compact status chip with a semantic color dot. */
@Composable
internal fun ClawStatusPill(
  text: String,
  status: ClawStatus,
  modifier: Modifier = Modifier,
) {
  val colors = ClawTheme.colors
  val (dotColor, backgroundColor) =
    when (status) {
      ClawStatus.Neutral -> colors.textSubtle to colors.surfaceRaised
      ClawStatus.Success -> colors.success to colors.successSoft
      ClawStatus.Warning -> colors.warning to colors.warningSoft
      ClawStatus.Danger -> colors.danger to colors.dangerSoft
    }

  Surface(
    modifier = modifier,
    shape = RoundedCornerShape(ClawTheme.radii.control),
    color = backgroundColor,
    border = BorderStroke(1.dp, ClawTheme.colors.border),
  ) {
    Row(
      modifier = Modifier.padding(horizontal = 8.dp, vertical = 4.dp),
      verticalAlignment = Alignment.CenterVertically,
      horizontalArrangement = Arrangement.spacedBy(7.dp),
    ) {
      Box(
        modifier =
          Modifier
            .size(5.dp)
            .clip(CircleShape)
            .background(dotColor),
      )
      Text(text = text, style = ClawTheme.type.caption.copy(fontSize = 13.sp, lineHeight = 17.sp), color = ClawTheme.colors.textMuted, maxLines = 1)
    }
  }
}

/** Small optional-selectable pill used for filters and metadata chips. */
@Composable
internal fun ClawPill(
  text: String,
  modifier: Modifier = Modifier,
  selected: Boolean = false,
  onClick: (() -> Unit)? = null,
) {
  val surfaceModifier =
    if (onClick == null) {
      modifier
    } else {
      modifier.clickable(onClick = onClick)
    }

  Surface(
    modifier = surfaceModifier,
    shape = RoundedCornerShape(ClawTheme.radii.pill),
    color = if (selected) ClawTheme.colors.primary else ClawTheme.colors.surfaceRaised,
    contentColor = if (selected) ClawTheme.colors.primaryText else ClawTheme.colors.textMuted,
    border = BorderStroke(1.dp, if (selected) ClawTheme.colors.primary else ClawTheme.colors.border),
  ) {
    Text(
      text = text,
      modifier = Modifier.padding(horizontal = 10.dp, vertical = 6.dp),
      style = ClawTheme.type.caption,
      maxLines = 1,
      overflow = TextOverflow.Ellipsis,
    )
  }
}

/** Panel wrapper for homogeneous lists with standard row separators. */
@Composable
internal fun <T> ClawListPanel(
  items: List<T>,
  modifier: Modifier = Modifier,
  row: @Composable (T) -> Unit,
) {
  ClawPanel(modifier = modifier, contentPadding = PaddingValues(horizontal = 14.dp, vertical = 4.dp)) {
    ClawSeparatedColumn(items = items, row = row)
  }
}

/** Column helper that inserts standard dividers between rendered rows. */
@Composable
internal fun <T> ClawSeparatedColumn(
  items: List<T>,
  modifier: Modifier = Modifier,
  row: @Composable (T) -> Unit,
) {
  Column(modifier = modifier) {
    items.forEachIndexed { index, item ->
      row(item)
      if (index != items.lastIndex) {
        HorizontalDivider(color = ClawTheme.colors.border.copy(alpha = 0.82f), thickness = 1.dp)
      }
    }
  }
}

/** Two-line settings/detail row with caller-provided leading and trailing slots. */
@Composable
internal fun ClawDetailRow(
  title: String,
  subtitle: String,
  modifier: Modifier = Modifier,
  leading: @Composable () -> Unit,
  trailing: @Composable () -> Unit,
) {
  Row(
    modifier =
      modifier
        .fillMaxWidth()
        .heightIn(min = 54.dp)
        .padding(horizontal = 0.dp, vertical = 7.dp),
    verticalAlignment = Alignment.CenterVertically,
    horizontalArrangement = Arrangement.spacedBy(9.dp),
  ) {
    leading()
    Column(modifier = Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(1.dp)) {
      Text(text = title, style = ClawTheme.type.body, color = ClawTheme.colors.text, maxLines = 1, overflow = TextOverflow.Ellipsis)
      Text(text = subtitle, style = ClawTheme.type.caption, color = ClawTheme.colors.textMuted, maxLines = 1, overflow = TextOverflow.Ellipsis)
    }
    trailing()
  }
}

/** Circular text badge used for compact numeric or initials-style row marks. */
@Composable
internal fun ClawTextBadge(
  text: String,
  modifier: Modifier = Modifier,
) {
  Surface(
    modifier = modifier.size(30.dp),
    shape = CircleShape,
    color = ClawTheme.colors.surfacePressed,
    border = BorderStroke(1.dp, ClawTheme.colors.border),
    contentColor = ClawTheme.colors.text,
  ) {
    Box(contentAlignment = Alignment.Center) {
      Text(text = text, style = ClawTheme.type.label, color = ClawTheme.colors.text, maxLines = 1)
    }
  }
}

/** Circular icon badge used as a neutral leading marker in list rows. */
@Composable
internal fun ClawIconBadge(
  icon: ImageVector,
  modifier: Modifier = Modifier,
) {
  Surface(
    modifier = modifier.size(30.dp),
    shape = CircleShape,
    color = ClawTheme.colors.surfacePressed,
    border = BorderStroke(1.dp, ClawTheme.colors.border),
    contentColor = ClawTheme.colors.text,
  ) {
    Box(contentAlignment = Alignment.Center) {
      Icon(imageVector = icon, contentDescription = null, modifier = Modifier.size(14.dp), tint = ClawTheme.colors.text)
    }
  }
}

/** Reusable one-line list row with optional subtitle, metadata, slots, and click handling. */
@Composable
internal fun ClawListItem(
  title: String,
  modifier: Modifier = Modifier,
  subtitle: String? = null,
  metadata: String? = null,
  leading: (@Composable () -> Unit)? = null,
  trailing: (@Composable () -> Unit)? = null,
  onClick: (() -> Unit)? = null,
) {
  val rowModifier =
    if (onClick == null) {
      modifier
    } else {
      modifier.clickable(onClick = onClick)
    }

  Row(
    modifier =
      rowModifier
        .fillMaxWidth()
        .heightIn(min = ClawTheme.spacing.touchTarget)
        .clip(RoundedCornerShape(ClawTheme.radii.row))
        .padding(horizontal = 2.dp, vertical = 5.dp),
    verticalAlignment = Alignment.CenterVertically,
    horizontalArrangement = Arrangement.spacedBy(9.dp),
  ) {
    leading?.invoke()
    Column(modifier = Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(2.dp)) {
      Text(
        text = title,
        style = ClawTheme.type.body,
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
    if (metadata != null) {
      Text(text = metadata, style = ClawTheme.type.caption, color = ClawTheme.colors.textSubtle, maxLines = 1)
    }
    trailing?.invoke()
  }
}

/** Equal-width segmented control for small mode/filter sets. */
@Composable
internal fun ClawSegmentedControl(
  options: List<String>,
  selected: String,
  onSelect: (String) -> Unit,
  modifier: Modifier = Modifier,
) {
  Row(
    modifier =
      modifier
        .clip(RoundedCornerShape(ClawTheme.radii.control))
        .border(1.dp, ClawTheme.colors.border, RoundedCornerShape(ClawTheme.radii.control))
        .padding(2.dp),
    horizontalArrangement = Arrangement.spacedBy(2.dp),
  ) {
    options.forEach { option ->
      val active = option == selected
      Box(
        modifier =
          Modifier
            .weight(1f)
            .clip(RoundedCornerShape(ClawTheme.radii.control))
            .background(if (active) ClawTheme.colors.primary else Color.Transparent)
            .clickable { onSelect(option) }
            .padding(horizontal = 9.dp, vertical = 7.dp),
        contentAlignment = Alignment.Center,
      ) {
        Text(
          text = option,
          style = ClawTheme.type.caption,
          color = if (active) ClawTheme.colors.primaryText else ClawTheme.colors.textMuted,
          maxLines = 1,
          overflow = TextOverflow.Ellipsis,
        )
      }
    }
  }
}

/** Token-styled text field used by settings and prototype screens. */
@Composable
internal fun ClawTextField(
  value: String,
  onValueChange: (String) -> Unit,
  placeholder: String,
  modifier: Modifier = Modifier,
  minLines: Int = 1,
) {
  BasicTextField(
    value = value,
    onValueChange = onValueChange,
    modifier =
      modifier
        .fillMaxWidth()
        .clip(RoundedCornerShape(ClawTheme.radii.control))
        .background(ClawTheme.colors.surfaceRaised)
        .border(1.dp, ClawTheme.colors.border, RoundedCornerShape(ClawTheme.radii.control))
        .padding(horizontal = 11.dp, vertical = 8.dp),
    textStyle = ClawTheme.type.body.copy(color = ClawTheme.colors.text),
    cursorBrush = SolidColor(ClawTheme.colors.primary),
    minLines = minLines,
    decorationBox = { innerTextField ->
      Box(modifier = Modifier.fillMaxWidth()) {
        if (value.isEmpty()) {
          Text(text = placeholder, style = ClawTheme.type.body, color = ClawTheme.colors.textSubtle)
        }
        innerTextField()
      }
    },
  )
}

/** Local design-system preview surface for visual smoke checks. */
@Composable
internal fun ClawComponentShowcase(modifier: Modifier = Modifier) {
  var selected by rememberSaveable { mutableStateOf("Chat") }
  var prompt by rememberSaveable { mutableStateOf("") }

  ClawScaffold(modifier = modifier) {
    Column(verticalArrangement = Arrangement.spacedBy(18.dp)) {
      ClawTopBar(
        title = "OpenClaw",
        subtitle = "Local command center",
        navigation = { ClawAvatarMark(text = "OC") },
        actions = {
          ClawIconButton(icon = Icons.Default.Search, contentDescription = "Search", onClick = {})
        },
      )

      Row(
        modifier = Modifier.fillMaxWidth(),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.SpaceBetween,
      ) {
        Column(verticalArrangement = Arrangement.spacedBy(4.dp)) {
          Text(text = "OpenClaw", style = ClawTheme.type.display, color = ClawTheme.colors.text)
          Text(text = "Design system prototype", style = ClawTheme.type.body, color = ClawTheme.colors.textMuted)
        }
        ClawStatusPill(text = "Connected", status = ClawStatus.Success)
      }

      ClawSegmentedControl(
        options = listOf("Chat", "Voice", "Sessions"),
        selected = selected,
        onSelect = { selected = it },
        modifier = Modifier.fillMaxWidth(),
      )

      Column(verticalArrangement = Arrangement.spacedBy(4.dp)) {
        ClawSectionHeader(title = "Sessions")
        ClawListItem(
          title = "Testing testing 1 2 3",
          subtitle = "14 messages · Android",
          metadata = "now",
        )
        ClawListItem(
          title = "Provider setup",
          subtitle = "OpenClaw gateway",
          metadata = "8m",
        )
      }

      ClawTextField(value = prompt, onValueChange = { prompt = it }, placeholder = "Ask OpenClaw anything", minLines = 3)

      Row(horizontalArrangement = Arrangement.spacedBy(10.dp)) {
        ClawPrimaryButton(text = "Start Chat", onClick = {}, modifier = Modifier.weight(1f))
        ClawSecondaryButton(text = "Voice", onClick = {}, modifier = Modifier.weight(1f))
      }

      Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
        ClawPill(text = "Realtime", selected = true)
        ClawPill(text = "Dictation")
        ClawPill(text = "Screen")
      }

      ClawEmptyState(
        title = "Nothing needs your attention",
        body = "OpenClaw will surface approvals, failed jobs, and channel issues here.",
      )

      ClawBottomNav(
        items =
          listOf(
            ClawNavItem(key = "overview", label = "Home", icon = Icons.Default.Home),
            ClawNavItem(key = "chat", label = "Chat", icon = Icons.Default.ChatBubble),
            ClawNavItem(key = "voice", label = "Voice", icon = Icons.Default.Mic),
            ClawNavItem(key = "settings", label = "Settings", icon = Icons.Default.Settings),
          ),
        selectedKey = "chat",
        onSelect = {},
      )
    }
  }
}
