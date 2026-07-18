package ai.openclaw.app.ui.chat

import ai.openclaw.app.chat.ChatQuestionDraft
import ai.openclaw.app.chat.ChatQuestionPrompt
import ai.openclaw.app.chat.ChatQuestionStatus
import ai.openclaw.app.gateway.Question
import ai.openclaw.app.i18n.nativeString
import ai.openclaw.app.ui.design.ClawTheme
import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Button
import androidx.compose.material3.Checkbox
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.RadioButton
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableLongStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import kotlinx.coroutines.delay

@Composable
internal fun ChatQuestionCard(
  prompt: ChatQuestionPrompt,
  onSubmit: (String, Map<String, List<String>>) -> Unit,
  modifier: Modifier = Modifier,
) {
  var draft by remember(prompt.record.id) { mutableStateOf(ChatQuestionDraft()) }
  var nowMs by remember(prompt.record.id) { mutableLongStateOf(System.currentTimeMillis()) }
  val status = prompt.status(nowMs)
  val pending = status == ChatQuestionStatus.Pending
  LaunchedEffect(prompt.record.id, prompt.record.expiresAtMs, status) {
    while (status == ChatQuestionStatus.Pending || status == ChatQuestionStatus.Submitting) {
      delay(1000)
      nowMs = System.currentTimeMillis()
    }
  }

  Surface(
    modifier = modifier.fillMaxWidth(),
    shape = RoundedCornerShape(ClawTheme.radii.sheet),
    color = ClawTheme.colors.surfaceRaised,
    border = BorderStroke(1.dp, ClawTheme.colors.border),
  ) {
    Column(
      modifier = Modifier.padding(16.dp),
      verticalArrangement = Arrangement.spacedBy(14.dp),
    ) {
      prompt.record.questions.forEach { question ->
        QuestionSection(
          question = question,
          draft = draft,
          enabled = pending,
          onDraftChanged = { draft = it },
        )
      }
      QuestionFooter(
        prompt = prompt,
        draft = draft,
        status = status,
        nowMs = nowMs,
        onSubmit = onSubmit,
      )
    }
  }
}

@Composable
private fun QuestionSection(
  question: Question,
  draft: ChatQuestionDraft,
  enabled: Boolean,
  onDraftChanged: (ChatQuestionDraft) -> Unit,
) {
  Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
    Text(
      text = question.header.uppercase(),
      style = ClawTheme.type.caption,
      color = ClawTheme.colors.primary,
      fontWeight = FontWeight.SemiBold,
    )
    Text(text = question.question, style = ClawTheme.type.body, color = ClawTheme.colors.text)
    question.options.forEach { option ->
      val selected = option.label in draft.selectedOptions[question.id].orEmpty()
      Surface(
        onClick = { onDraftChanged(draft.toggle(question, option.label)) },
        enabled = enabled,
        shape = RoundedCornerShape(ClawTheme.radii.row),
        color = if (selected) ClawTheme.colors.surfacePressed else ClawTheme.colors.surface,
      ) {
        Row(
          modifier = Modifier.fillMaxWidth().padding(horizontal = 8.dp, vertical = 6.dp),
          verticalAlignment = Alignment.Top,
        ) {
          if (question.multiSelect == true) {
            Checkbox(checked = selected, onCheckedChange = null, enabled = enabled)
          } else {
            RadioButton(selected = selected, onClick = null, enabled = enabled)
          }
          Spacer(Modifier.width(6.dp))
          Column(modifier = Modifier.weight(1f)) {
            Text(text = option.label, style = ClawTheme.type.body, color = ClawTheme.colors.text)
            option.description?.takeIf { it.isNotBlank() }?.let { description ->
              Text(text = description, style = ClawTheme.type.caption, color = ClawTheme.colors.textMuted)
            }
          }
        }
      }
    }
    if (question.options.isEmpty() || question.isOther == true) {
      OutlinedTextField(
        value = draft.otherText[question.id].orEmpty(),
        onValueChange = { onDraftChanged(draft.setOther(question, it)) },
        modifier = Modifier.fillMaxWidth(),
        enabled = enabled,
        label = { Text(nativeString("Other answer")) },
        minLines = 1,
        maxLines = 4,
      )
    }
  }
}

@Composable
private fun QuestionFooter(
  prompt: ChatQuestionPrompt,
  draft: ChatQuestionDraft,
  status: ChatQuestionStatus,
  nowMs: Long,
  onSubmit: (String, Map<String, List<String>>) -> Unit,
) {
  val answers = draft.answers(prompt.record.questions)
  if (status == ChatQuestionStatus.Pending || status == ChatQuestionStatus.Submitting) {
    Row(verticalAlignment = Alignment.CenterVertically) {
      Text(
        text = questionCountdown(prompt.record.expiresAtMs, nowMs),
        style = ClawTheme.type.caption,
        color = ClawTheme.colors.textMuted,
      )
      Spacer(Modifier.weight(1f))
      Button(
        onClick = { answers?.let { onSubmit(prompt.record.id, it) } },
        enabled = answers != null && status == ChatQuestionStatus.Pending,
      ) {
        Text(if (status == ChatQuestionStatus.Submitting) nativeString("Submitting…") else nativeString("Submit"))
      }
    }
    prompt.errorText?.let { error ->
      Text(text = error, style = ClawTheme.type.caption, color = ClawTheme.colors.danger)
    }
  } else {
    Text(
      text =
        when (status) {
          ChatQuestionStatus.Answered -> nativeString("Answered")
          ChatQuestionStatus.AnsweredElsewhere -> nativeString("Answered elsewhere")
          ChatQuestionStatus.Expired -> nativeString("Expired")
          ChatQuestionStatus.Cancelled -> nativeString("Cancelled")
          ChatQuestionStatus.Pending -> nativeString("Pending")
          ChatQuestionStatus.Submitting -> nativeString("Submitting…")
        },
      style = ClawTheme.type.caption,
      color = ClawTheme.colors.textMuted,
      fontWeight = FontWeight.SemiBold,
    )
  }
}

// nativeString is the non-composable resource accessor (nativeStringResource
// is the @Composable variant), so this helper is safe outside composition.
private fun questionCountdown(
  expiresAtMs: Long,
  nowMs: Long,
): String {
  val seconds = ((expiresAtMs - nowMs).coerceAtLeast(0) + 999) / 1000
  return if (seconds >= 60) {
    nativeString("Expires in \${seconds / 60}m \${seconds % 60}s", seconds / 60, seconds % 60)
  } else {
    nativeString("Expires in \${seconds}s", seconds)
  }
}
