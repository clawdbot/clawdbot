package ai.openclaw.app.ui

import ai.openclaw.app.R
import ai.openclaw.app.chat.ChatSessionEntry
import ai.openclaw.app.i18n.nativeString
import ai.openclaw.app.ui.design.ClawTheme
import ai.openclaw.app.ui.design.sessionColor
import ai.openclaw.app.ui.design.sessionColorStripe
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.gestures.detectDragGesturesAfterLongPress
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
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
import androidx.compose.material.icons.automirrored.filled.KeyboardArrowRight
import androidx.compose.material.icons.filled.Close
import androidx.compose.material.icons.filled.ErrorOutline
import androidx.compose.material.icons.filled.HourglassEmpty
import androidx.compose.material.icons.filled.KeyboardArrowDown
import androidx.compose.material.icons.filled.PushPin
import androidx.compose.material.icons.filled.Search
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.NavigationDrawerItem
import androidx.compose.material3.NavigationDrawerItemDefaults
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.OutlinedTextFieldDefaults
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableFloatStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberUpdatedState
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.graphics.painter.Painter
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.hapticfeedback.HapticFeedbackType
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.platform.LocalHapticFeedback
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.semantics.stateDescription
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.compose.ui.zIndex
import kotlin.math.abs

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
        cursorColor = palette.text,
        focusedBorderColor = ClawTheme.colors.primary,
        unfocusedBorderColor = palette.hairline,
        focusedLabelColor = palette.text,
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
internal fun SidebarCollapsibleHeader(
  label: String,
  expanded: Boolean,
  palette: SidebarPalette,
  onClick: () -> Unit,
  modifier: Modifier = Modifier,
  icon: ImageVector? = null,
  iconPainter: Painter? = null,
  iconContent: (@Composable () -> Unit)? = null,
  iconTint: Color = palette.text,
  trailingContent: (@Composable () -> Unit)? = null,
) {
  Row(
    modifier =
      modifier
        .fillMaxWidth()
        .heightIn(min = 44.dp)
        .clip(RoundedCornerShape(10.dp))
        .clickable(role = Role.Button, onClick = onClick)
        .padding(horizontal = 8.dp),
    verticalAlignment = Alignment.CenterVertically,
    horizontalArrangement = Arrangement.spacedBy(8.dp),
  ) {
    Icon(
      imageVector =
        if (expanded) {
          Icons.Default.KeyboardArrowDown
        } else {
          Icons.AutoMirrored.Filled.KeyboardArrowRight
        },
      contentDescription = null,
      tint = palette.muted,
      modifier = Modifier.size(18.dp),
    )
    iconContent?.invoke()
    icon?.let {
      Icon(
        imageVector = it,
        contentDescription = null,
        tint = palette.text,
        modifier = Modifier.size(18.dp),
      )
    }
    iconPainter?.let {
      Icon(
        painter = it,
        contentDescription = null,
        tint = iconTint,
        modifier = Modifier.size(18.dp),
      )
    }
    Text(
      text = label,
      style = ClawTheme.type.body.copy(fontSize = 13.sp),
      color = palette.text,
      modifier = Modifier.weight(1f),
      maxLines = 1,
      overflow = TextOverflow.Ellipsis,
    )
    trailingContent?.invoke()
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
  pinned: Boolean? = null,
  palette: SidebarPalette,
  onClick: () -> Unit,
  onMove: (Int) -> Unit,
  onDragActiveChange: (Boolean) -> Unit,
) {
  val thresholdPx = with(LocalDensity.current) { 48.dp.toPx() }
  val haptic = LocalHapticFeedback.current
  val currentOnMove by rememberUpdatedState(onMove)
  val currentOnDragActiveChange by rememberUpdatedState(onDragActiveChange)
  val pinStateDescription =
    pinned?.let { nativeString(if (it) "Pinned" else "Not pinned") }
  var dragOffset by remember(destination) { mutableFloatStateOf(0f) }
  var dragging by remember(destination) { mutableStateOf(false) }
  val finishDrag = {
    dragOffset = 0f
    dragging = false
    currentOnDragActiveChange(false)
  }

  Box(
    modifier =
      Modifier
        .fillMaxWidth()
        .zIndex(if (dragging) 1f else 0f)
        .graphicsLayer {
          translationY = dragOffset
          scaleX = if (dragging) 1.015f else 1f
          scaleY = if (dragging) 1.015f else 1f
          shadowElevation = if (dragging) 10.dp.toPx() else 0f
        },
  ) {
    NavigationDrawerItem(
      label = {
        Row(
          modifier = Modifier.fillMaxWidth(),
          verticalAlignment = Alignment.CenterVertically,
        ) {
          Text(
            text = destination.localizedLabel(),
            style = ClawTheme.type.body,
            modifier = Modifier.weight(1f),
            maxLines = 1,
          )
          if (pinned == true) {
            Icon(
              painter = painterResource(R.drawable.ic_web_check),
              contentDescription = nativeString("Pinned"),
              tint = palette.text,
              modifier = Modifier.size(18.dp),
            )
          }
        }
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
      modifier =
        Modifier
          .fillMaxWidth()
          .heightIn(min = 48.dp)
          .semantics {
            if (pinStateDescription != null) stateDescription = pinStateDescription
          }.pointerInput(destination, thresholdPx) {
            detectDragGesturesAfterLongPress(
              onDragStart = {
                dragOffset = 0f
                dragging = true
                haptic.performHapticFeedback(HapticFeedbackType.LongPress)
                currentOnDragActiveChange(true)
              },
              onDragEnd = finishDrag,
              onDragCancel = finishDrag,
            ) { change, dragAmount ->
              change.consume()
              dragOffset += dragAmount.y
              if (abs(dragOffset) >= thresholdPx) {
                val direction = if (dragOffset < 0f) -1 else 1
                currentOnMove(direction)
                dragOffset -= direction * thresholdPx
              }
            }
          },
      shape = RoundedCornerShape(10.dp),
      colors =
        NavigationDrawerItemDefaults.colors(
          selectedContainerColor = palette.selection,
          unselectedContainerColor = if (dragging) palette.elevated else Color.Transparent,
          selectedIconColor = palette.text,
          unselectedIconColor = palette.text,
          selectedTextColor = palette.text,
          unselectedTextColor = palette.text,
        ),
    )
    if (dragging) {
      HorizontalDivider(
        color = ClawTheme.colors.primary,
        thickness = 2.dp,
        modifier = Modifier.align(if (dragOffset < 0f) Alignment.TopCenter else Alignment.BottomCenter),
      )
    }
  }
}

internal enum class SidebarSessionActivity {
  Queued,
  Running,
  Unread,
  Failed,
}

internal fun sidebarSessionActivity(
  status: String?,
  lastRunError: String?,
  hasActiveRun: Boolean,
  unread: Boolean,
): SidebarSessionActivity? {
  val normalizedStatus = status?.trim()?.lowercase()
  return when {
    !lastRunError.isNullOrBlank() ||
      normalizedStatus == "failed" ||
      normalizedStatus == "timeout" ||
      normalizedStatus == "killed" ||
      normalizedStatus == "error" -> SidebarSessionActivity.Failed

    normalizedStatus == "queued" -> SidebarSessionActivity.Queued

    hasActiveRun || normalizedStatus == "active" || normalizedStatus == "running" -> SidebarSessionActivity.Running

    unread -> SidebarSessionActivity.Unread

    else -> null
  }
}

@Composable
internal fun SidebarSessionActivityIndicator(
  activity: SidebarSessionActivity,
  palette: SidebarPalette,
) {
  when (activity) {
    SidebarSessionActivity.Queued -> {
      Icon(
        imageVector = Icons.Default.HourglassEmpty,
        contentDescription = nativeString("Queued"),
        modifier = Modifier.size(15.dp),
        tint = palette.muted,
      )
    }

    SidebarSessionActivity.Running -> {
      CircularProgressIndicator(
        modifier = Modifier.size(15.dp).clearAndSetSemantics { stateDescription = nativeString("Working") },
        color = ClawTheme.colors.primary,
        strokeWidth = 2.dp,
      )
    }

    SidebarSessionActivity.Unread -> {
      Box(
        modifier =
          Modifier
            .size(7.dp)
            .clip(CircleShape)
            .background(ClawTheme.colors.primary)
            .clearAndSetSemantics { stateDescription = nativeString("Needs attention") },
      )
    }

    SidebarSessionActivity.Failed -> {
      Icon(
        imageVector = Icons.Default.ErrorOutline,
        contentDescription = nativeString("Run failed"),
        modifier = Modifier.size(16.dp),
        tint = ClawTheme.colors.danger,
      )
    }
  }
}

@Composable
internal fun SidebarSessionRow(
  session: ChatSessionEntry,
  selected: Boolean,
  palette: SidebarPalette,
  onClick: () -> Unit,
  onDragCommit: ((Int) -> Unit)? = null,
  onDragActiveChange: (Boolean) -> Unit = {},
) {
  val activity =
    sidebarSessionActivity(
      status = session.status,
      lastRunError = session.lastRunError,
      hasActiveRun = session.hasActiveRun == true,
      unread = session.unread == true,
    )
  val sessionStateDescription =
    when (activity) {
      SidebarSessionActivity.Failed -> nativeString("Run failed")
      SidebarSessionActivity.Queued -> nativeString("Queued")
      SidebarSessionActivity.Running -> nativeString("Working")
      SidebarSessionActivity.Unread -> nativeString("Needs attention")
      null -> nativeString("Selected").takeIf { selected }
    }
  SidebarRowSurface(
    selected = selected,
    stateDescription = sessionStateDescription,
    palette = palette,
    stripeColor = ClawTheme.colors.sessionColor(session.color),
    onClick = onClick,
    dragKey = session.key,
    onDragCommit = onDragCommit,
    onDragActiveChange = onDragActiveChange,
  ) {
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
    activity?.let {
      SidebarSessionActivityIndicator(activity = it, palette = palette)
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
internal fun SidebarRowSurface(
  selected: Boolean?,
  stateDescription: String? = null,
  palette: SidebarPalette,
  enabled: Boolean = true,
  stripeColor: Color? = null,
  onClick: () -> Unit,
  dragKey: Any? = null,
  onDragCommit: ((Int) -> Unit)? = null,
  onDragActiveChange: (Boolean) -> Unit = {},
  contentPadding: PaddingValues = PaddingValues(horizontal = 12.dp, vertical = 8.dp),
  content: @Composable RowScope.() -> Unit,
) {
  val dragThresholdPx = with(LocalDensity.current) { 48.dp.toPx() }
  val haptic = LocalHapticFeedback.current
  val currentOnDragCommit by rememberUpdatedState(onDragCommit)
  val currentOnDragActiveChange by rememberUpdatedState(onDragActiveChange)
  var dragOffset by remember(dragKey) { mutableFloatStateOf(0f) }
  var dragging by remember(dragKey) { mutableStateOf(false) }
  val finishDrag = {
    val commit = currentOnDragCommit
    if (commit != null && abs(dragOffset) >= dragThresholdPx) {
      commit(if (dragOffset < 0f) -1 else 1)
    }
    dragOffset = 0f
    dragging = false
    currentOnDragActiveChange(false)
  }
  val dragModifier =
    if (!enabled || onDragCommit == null) {
      Modifier
    } else {
      Modifier.pointerInput(dragKey, dragThresholdPx) {
        detectDragGesturesAfterLongPress(
          onDragStart = {
            dragOffset = 0f
            dragging = true
            haptic.performHapticFeedback(HapticFeedbackType.LongPress)
            currentOnDragActiveChange(true)
          },
          onDragEnd = finishDrag,
          onDragCancel = {
            dragOffset = 0f
            dragging = false
            currentOnDragActiveChange(false)
          },
        ) { change, dragAmount ->
          change.consume()
          dragOffset += dragAmount.y
        }
      }
    }

  Box(
    modifier =
      Modifier
        .fillMaxWidth()
        .zIndex(if (dragging) 1f else 0f)
        .graphicsLayer {
          translationY = dragOffset
          scaleX = if (dragging) 1.015f else 1f
          scaleY = if (dragging) 1.015f else 1f
          shadowElevation = if (dragging) 10.dp.toPx() else 0f
        },
  ) {
    Row(
      modifier =
        Modifier
          .fillMaxWidth()
          .heightIn(min = 48.dp)
          .clip(RoundedCornerShape(10.dp))
          .background(
            if (selected == true) {
              palette.selection
            } else if (dragging) {
              palette.elevated
            } else {
              Color.Transparent
            },
          ).sessionColorStripe(stripeColor)
          .then(
            if (selected == null) {
              Modifier.clickable(enabled = enabled, role = Role.Button, onClick = onClick)
            } else {
              Modifier.selectable(enabled = enabled, selected = selected, role = Role.Button, onClick = onClick)
            },
          ).then(
            if (stateDescription == null) {
              Modifier
            } else {
              Modifier.semantics { this.stateDescription = stateDescription }
            },
          ).then(dragModifier)
          .padding(contentPadding),
      verticalAlignment = Alignment.CenterVertically,
      horizontalArrangement = Arrangement.spacedBy(10.dp),
      content = content,
    )
    if (dragging) {
      HorizontalDivider(
        color = ClawTheme.colors.primary,
        thickness = 2.dp,
        modifier = Modifier.align(if (dragOffset < 0f) Alignment.TopCenter else Alignment.BottomCenter),
      )
    }
  }
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
