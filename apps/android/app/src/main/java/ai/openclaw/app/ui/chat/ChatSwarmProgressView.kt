package ai.openclaw.app.ui.chat

import ai.openclaw.app.chat.ChatSwarmDot
import ai.openclaw.app.chat.ChatSwarmDotStatus
import ai.openclaw.app.chat.ChatSwarmGroup
import ai.openclaw.app.i18n.nativeString
import ai.openclaw.app.i18n.resolveNativeTextResource
import ai.openclaw.app.i18n.verbatimText
import ai.openclaw.app.ui.design.ClawTheme
import androidx.compose.foundation.Canvas
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.rotate
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp

@OptIn(ExperimentalLayoutApi::class)
@Composable
internal fun ChatSwarmProgress(
  groups: List<ChatSwarmGroup>,
  modifier: Modifier = Modifier,
) {
  if (groups.isEmpty()) return
  Column(
    modifier =
      modifier
        .fillMaxWidth()
        .heightIn(max = 260.dp)
        .verticalScroll(rememberScrollState())
        .semantics { contentDescription = nativeString("Swarm") },
    verticalArrangement = Arrangement.spacedBy(6.dp),
  ) {
    groups.forEach { group -> ChatSwarmGroupCard(group) }
  }
}

@OptIn(ExperimentalLayoutApi::class)
@Composable
private fun ChatSwarmGroupCard(group: ChatSwarmGroup) {
  Surface(
    modifier = Modifier.fillMaxWidth(),
    shape = RoundedCornerShape(10.dp),
    color = ClawTheme.colors.surfaceRaised,
    border = androidx.compose.foundation.BorderStroke(1.dp, ClawTheme.colors.primary.copy(alpha = 0.2f)),
  ) {
    Column(
      modifier = Modifier.padding(horizontal = 10.dp, vertical = 8.dp),
      verticalArrangement = Arrangement.spacedBy(6.dp),
    ) {
      Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
        Text(
          text = group.label,
          style = ClawTheme.type.caption.copy(fontWeight = FontWeight.SemiBold),
          maxLines = 1,
          overflow = TextOverflow.Ellipsis,
        )
        Text(
          text =
            nativeString(
              "\$running Running · \$done Done · \$failed Failed",
              group.running,
              group.done,
              group.failed,
            ),
          color = ClawTheme.colors.textMuted,
          style = ClawTheme.type.caption,
          maxLines = 1,
        )
        Spacer(Modifier.weight(1f))
      }
      group.narrator?.let { narrator ->
        Text(
          text = narrator,
          color = ClawTheme.colors.textMuted,
          style = ClawTheme.type.caption,
          maxLines = 2,
          overflow = TextOverflow.Ellipsis,
        )
      }
      group.phases.forEach { phase ->
        Row(verticalAlignment = Alignment.Top, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
          Text(
            text = phase.title ?: nativeString("Unphased"),
            modifier = Modifier.width(64.dp),
            color = ClawTheme.colors.textMuted,
            style = ClawTheme.type.caption,
            maxLines = 1,
            overflow = TextOverflow.Ellipsis,
          )
          FlowRow(
            modifier = Modifier.weight(1f),
            horizontalArrangement = Arrangement.spacedBy(6.dp),
            verticalArrangement = Arrangement.spacedBy(6.dp),
          ) {
            phase.dots.forEach { dot -> ChatSwarmDotView(dot) }
            if (phase.hidden > 0) {
              val moreDescription =
                if (phase.hidden == 1) {
                  nativeString("1 more worker")
                } else {
                  nativeString("\$count more workers", phase.hidden)
                }
              Text(
                text = verbatimText("+${phase.hidden}").resolveNativeTextResource(),
                modifier = Modifier.semantics { contentDescription = moreDescription },
                color = ClawTheme.colors.textMuted,
                style = ClawTheme.type.caption,
              )
            }
          }
        }
      }
    }
  }
}

@Composable
private fun ChatSwarmDotView(dot: ChatSwarmDot) {
  val description = verbatimText("${dot.label}: ${nativeString(dot.status.label)}").resolveNativeTextResource()
  when (dot.status) {
    ChatSwarmDotStatus.Queued -> {
      val color = ClawTheme.colors.textMuted
      Canvas(modifier = Modifier.size(9.dp).semantics { contentDescription = description }) {
        drawCircle(color = color, style = Stroke(width = 1.dp.toPx()))
      }
    }
    ChatSwarmDotStatus.Running -> StatusDot(ClawTheme.colors.primary, description)
    ChatSwarmDotStatus.Done -> StatusDot(ClawTheme.colors.success, description)
    ChatSwarmDotStatus.Failed ->
      Box(
        modifier =
          Modifier
            .size(8.dp)
            .rotate(45f)
            .border(4.dp, ClawTheme.colors.danger, RoundedCornerShape(2.dp))
            .semantics { contentDescription = description },
      )
  }
}

@Composable
private fun StatusDot(
  color: Color,
  description: String,
) {
  Surface(
    modifier = Modifier.size(9.dp).semantics { contentDescription = description },
    shape = CircleShape,
    color = color,
  ) {}
}
