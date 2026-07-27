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
import androidx.compose.material3.TextButton
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
  onSkip: (String) -> Unit,
  modifier: Modifier = Modifier,
) {
  var draft by remember(prompt.record.id) { mutableStateOf(ChatQuestionDraft()) }
  var nowMs by remember(prompt.record.id) { mutableLongStateOf(System.currentTimeMillis()) }
  val status = prompt.status(nowMs)
  val pending = status == ChatQuestionStatus.Pending
  if (!pending && status != ChatQuestionStatus.Submitting) {
    ChatQuestionSummary(prompt = prompt, status = status, modifier = modifier)
    return
  }
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
        onSkip = onSkip,
      )
    }
  }
}

@Composable
private fun ChatQuestionSummary(
  prompt: ChatQuestionPrompt,
  status: ChatQuestionStatus,
  modifier: Modifier = Modifier,
) {
  Surface(
    modifier = modifier.fillMaxWidth(),
    shape = RoundedCornerShape(ClawTheme.radii.row),
    color = ClawTheme.colors.surfaceRaised,
    border = BorderStroke(1.dp, ClawTheme.colors.border),
  ) {
    Column(
      modifier = Modifier.padding(horizontal = 12.dp, vertical = 10.dp),
      verticalArrangement = Arrangement.spacedBy(4.dp),
    ) {
      prompt.record.questions.forEach { question ->
        Column {
          Text(
            text = question.header + ':',
            style = ClawTheme.type.caption,
            color = ClawTheme.colors.text,
            fontWeight = FontWeight.SemiBold,
          )
          Text(
            text = terminalQuestionAnswer(prompt, question, status),
            style = ClawTheme.type.caption,
            color = ClawTheme.colors.textMuted,
          )
        }
      }
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
      val selected = option.label in draft.selectedOptions[question.questionId].orEmpty()
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
        value = draft.otherText[question.questionId].orEmpty(),
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
  onSkip: (String) -> Unit,
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
      TextButton(
        onClick = { onSkip(prompt.record.id) },
        enabled = status == ChatQuestionStatus.Pending,
      ) {
        Text(nativeString("Skip"))
      }
      Button(
        onClick = { answers?.let { onSubmit(prompt.record.id, it) } },
        enabled = answers != null && status == ChatQuestionStatus.Pending,
      ) {
        Text(
          if (status == ChatQuestionStatus.Submitting && !prompt.skipping) {
            nativeString("Submitting…")
          } else {
            nativeString("Submit")
          },
        )
      }
    }
    prompt.errorText?.let { error ->
      Text(text = error, style = ClawTheme.type.caption, color = ClawTheme.colors.danger)
    }
  }
}

internal fun terminalQuestionAnswer(
  prompt: ChatQuestionPrompt,
  question: Question,
  status: ChatQuestionStatus,
): String {
  if (status == ChatQuestionStatus.Cancelled) return nativeString("Skipped")
  if (status == ChatQuestionStatus.Expired) return nativeString("Expired")
  if (status == ChatQuestionStatus.Unavailable) return nativeString("Unavailable")
  prompt.record.answers?.answers?.get(question.questionId)?.takeIf { it.isNotEmpty() }?.let {
    return it.joinToString(", ")
  }
  return if (status == ChatQuestionStatus.AnsweredElsewhere) nativeString("Answered elsewhere") else nativeString("Answered")
}

// nativeString is the non-composable resource accessor (nativeStringResource
// is the @Composable variant), so this helper is safe outside composition.
internal fun questionCountdown(
  expiresAtMs: Long,
  nowMs: Long,
): String {
  val seconds = ((expiresAtMs - nowMs).coerceAtLeast(0) + 999) / 1000
  return (seconds / 60).toString() + ':' + (seconds % 60).toString().padStart(2, '0')
}
