package ai.openclaw.app.ui.chat

import ai.openclaw.app.i18n.nativeStringResource
import ai.openclaw.app.ui.design.ClawTheme
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Memory
import androidx.compose.material.icons.filled.Restore
import androidx.compose.material.icons.filled.UnfoldLess
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp

@Composable
internal fun ChatSystemNoticeRow(item: ChatTimelineItem.SystemNotice) {
  ChatSystemRow(
    icon = Icons.Default.Memory,
    label = item.label,
    body = item.body,
  )
}

@Composable
internal fun ChatSystemDividerRow(item: ChatTimelineItem.SystemDivider) {
  ChatSystemRow(
    icon =
      when (item.kind) {
        SystemDividerKind.Compaction -> Icons.Default.UnfoldLess
        SystemDividerKind.Reset -> Icons.Default.Restore
      },
    label = item.label,
    metric = item.metric,
    body = item.secondary,
  )
}

@Composable
private fun ChatSystemRow(
  icon: ImageVector,
  label: String,
  metric: String? = null,
  body: String? = null,
) {
  Column(
    modifier = Modifier.fillMaxWidth().padding(horizontal = 10.dp, vertical = 5.dp),
    horizontalAlignment = Alignment.CenterHorizontally,
    verticalArrangement = Arrangement.spacedBy(4.dp),
  ) {
    Row(
      modifier = Modifier.fillMaxWidth(),
      verticalAlignment = Alignment.CenterVertically,
      horizontalArrangement = Arrangement.spacedBy(7.dp),
    ) {
      HorizontalDivider(
        modifier = Modifier.weight(1f),
        thickness = 0.5.dp,
        color = ClawTheme.colors.border,
      )
      Icon(
        imageVector = icon,
        contentDescription = null,
        tint = ClawTheme.colors.textSubtle,
        modifier = Modifier.size(14.dp),
      )
      Text(
        text = label,
        style =
          ClawTheme.type.caption.copy(
            fontSize = 10.5.sp,
            lineHeight = 13.sp,
            fontWeight = FontWeight.SemiBold,
            letterSpacing = 0.6.sp,
          ),
        color = ClawTheme.colors.textMuted,
      )
      metric?.let {
        Text(text = nativeStringResource("·"), style = ClawTheme.type.caption, color = ClawTheme.colors.textSubtle)
        Text(text = it, style = ClawTheme.type.caption, color = ClawTheme.colors.textMuted)
      }
      HorizontalDivider(
        modifier = Modifier.weight(1f),
        thickness = 0.5.dp,
        color = ClawTheme.colors.border,
      )
    }
    body?.takeIf { it.isNotBlank() }?.let {
      Text(
        text = it,
        modifier = Modifier.fillMaxWidth(),
        style = ClawTheme.type.caption,
        color = ClawTheme.colors.textMuted,
        textAlign = TextAlign.Center,
      )
    }
  }
}
