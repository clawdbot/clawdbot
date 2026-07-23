package ai.openclaw.app.ui

import ai.openclaw.app.MainViewModel
import ai.openclaw.app.i18n.nativeString
import ai.openclaw.app.systemagent.SystemAgentChatAccess
import ai.openclaw.app.systemagent.SystemAgentChatMessage
import ai.openclaw.app.systemagent.SystemAgentChatQuestionOption
import ai.openclaw.app.systemagent.SystemAgentChatState
import ai.openclaw.app.ui.design.ClawPanel
import ai.openclaw.app.ui.design.ClawPlainIconButton
import ai.openclaw.app.ui.design.ClawPrimaryButton
import ai.openclaw.app.ui.design.ClawScaffold
import ai.openclaw.app.ui.design.ClawSecondaryButton
import ai.openclaw.app.ui.design.ClawTheme
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.filled.Bolt
import androidx.compose.material.icons.filled.Lock
import androidx.compose.material.icons.filled.Refresh
import androidx.compose.material3.Icon
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.text.input.VisualTransformation
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.LifecycleEventObserver
import androidx.lifecycle.compose.LocalLifecycleOwner

@Composable
internal fun SystemAgentSettingsScreen(
  viewModel: MainViewModel,
  onBack: () -> Unit,
) {
  val state by viewModel.systemAgentChatState.collectAsState()
  val lifecycleOwner = LocalLifecycleOwner.current
  LaunchedEffect(state.access, state.sessionId) { viewModel.refreshSystemAgentChat() }
  DisposableEffect(lifecycleOwner) {
    val observer =
      LifecycleEventObserver { _, event ->
        if (event == Lifecycle.Event.ON_STOP) viewModel.clearSystemAgentChatInput()
      }
    lifecycleOwner.lifecycle.addObserver(observer)
    onDispose {
      lifecycleOwner.lifecycle.removeObserver(observer)
      viewModel.clearSystemAgentChatInput()
    }
  }

  ClawScaffold {
    Column(modifier = Modifier.fillMaxSize(), verticalArrangement = Arrangement.spacedBy(12.dp)) {
      Row(
        modifier = Modifier.fillMaxWidth(),
        verticalAlignment = Alignment.CenterVertically,
      ) {
        ClawPlainIconButton(
          icon = Icons.AutoMirrored.Filled.ArrowBack,
          contentDescription = nativeString("Back"),
          onClick = onBack,
        )
        Text(
          text = nativeString("OpenClaw"),
          style = ClawTheme.type.display,
          color = ClawTheme.colors.text,
          modifier = Modifier.weight(1f),
        )
        Icon(
          imageVector = Icons.Default.Bolt,
          contentDescription = null,
          tint = ClawTheme.colors.primary,
          modifier = Modifier.size(24.dp),
        )
      }

      when (state.access) {
        SystemAgentChatAccess.Ready ->
          SystemAgentConversation(
            state = state,
            onInputChange = viewModel::setSystemAgentChatInput,
            onSend = viewModel::sendSystemAgentChatInput,
            onAnswer = viewModel::answerSystemAgentQuestion,
            onSkip = viewModel::skipSystemAgentQuestion,
            onRestart = viewModel::restartSystemAgentChat,
            onOpenChat = viewModel::openSystemAgentChatHandoff,
          )
        else -> SystemAgentAccessGate(state = state)
      }
    }
  }
}

@Composable
private fun SystemAgentAccessGate(state: SystemAgentChatState) {
  val title =
    when (state.access) {
      SystemAgentChatAccess.Disconnected -> nativeString("Gateway Required")
      SystemAgentChatAccess.MissingAdminScope -> nativeString("Full Access Required")
      SystemAgentChatAccess.CheckingGateway -> nativeString("Checking Gateway")
      SystemAgentChatAccess.GatewayUpdateRequired -> nativeString("Gateway Update Required")
      SystemAgentChatAccess.Ready -> ""
    }
  val detail =
    when (state.access) {
      SystemAgentChatAccess.Disconnected -> nativeString("Connect this phone to a Gateway before opening OpenClaw.")
      SystemAgentChatAccess.MissingAdminScope -> nativeString("Reconnect with operator.admin access to review and change Gateway settings.")
      SystemAgentChatAccess.CheckingGateway -> nativeString("Checking whether this Gateway supports the OpenClaw settings assistant.")
      SystemAgentChatAccess.GatewayUpdateRequired -> nativeString("Update this Gateway to use the OpenClaw settings assistant.")
      SystemAgentChatAccess.Ready -> ""
    }
  ClawPanel(modifier = Modifier.fillMaxWidth()) {
    Column(
      modifier = Modifier.fillMaxWidth().padding(24.dp),
      horizontalAlignment = Alignment.CenterHorizontally,
      verticalArrangement = Arrangement.spacedBy(12.dp),
    ) {
      Icon(
        imageVector = if (state.access == SystemAgentChatAccess.Disconnected) Icons.Default.Lock else Icons.Default.Bolt,
        contentDescription = null,
        tint = ClawTheme.colors.warning,
        modifier = Modifier.size(42.dp),
      )
      Text(text = title, style = ClawTheme.type.title, color = ClawTheme.colors.text)
      Text(
        text = detail,
        style = ClawTheme.type.body,
        color = ClawTheme.colors.textMuted,
        textAlign = TextAlign.Center,
      )
    }
  }
}

@Composable
private fun SystemAgentConversation(
  state: SystemAgentChatState,
  onInputChange: (String) -> Unit,
  onSend: () -> Unit,
  onAnswer: (String, String) -> Unit,
  onSkip: (String) -> Unit,
  onRestart: () -> Unit,
  onOpenChat: () -> Unit,
) {
  Column(modifier = Modifier.fillMaxSize(), verticalArrangement = Arrangement.spacedBy(10.dp)) {
    LazyColumn(
      modifier = Modifier.weight(1f),
      verticalArrangement = Arrangement.spacedBy(10.dp),
    ) {
      items(state.messages, key = { it.id }) { message ->
        SystemAgentMessage(message = message)
        message.question?.takeIf { message.id !in state.dismissedQuestionIds && message.id !in state.retiredQuestionIds }?.let { question ->
          SystemAgentQuestionCard(
            question = question,
            enabled = !state.sending && state.errorText == null,
            onAnswer = { option -> onAnswer(message.id, option.label) },
            onSkip = { onSkip(message.id) },
          )
        }
      }
      if (state.sending) {
        item { Text(nativeString("OpenClaw is working…"), style = ClawTheme.type.caption, color = ClawTheme.colors.textMuted) }
      }
    }

    state.errorText?.let { error ->
      ClawPanel(modifier = Modifier.fillMaxWidth()) {
        Row(
          modifier = Modifier.fillMaxWidth().padding(12.dp),
          verticalAlignment = Alignment.CenterVertically,
          horizontalArrangement = Arrangement.spacedBy(10.dp),
        ) {
          Text(error, style = ClawTheme.type.caption, color = ClawTheme.colors.warning, modifier = Modifier.weight(1f))
          ClawSecondaryButton(text = nativeString("Restart"), onClick = onRestart, icon = Icons.Default.Refresh)
        }
      }
    }

    state.handoff?.let {
      ClawPanel(modifier = Modifier.fillMaxWidth()) {
        Column(modifier = Modifier.fillMaxWidth().padding(12.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
          Text(nativeString("OpenClaw is ready to continue in your ordinary chat."), style = ClawTheme.type.body, color = ClawTheme.colors.textMuted)
          ClawPrimaryButton(text = nativeString("Open Chat"), onClick = onOpenChat)
        }
      }
    }

    if (state.handoff == null) {
      SystemAgentComposer(
        state = state,
        onInputChange = onInputChange,
        onSend = onSend,
      )
    }
  }
}

@Composable
private fun SystemAgentMessage(message: SystemAgentChatMessage) {
  val user = message.role == SystemAgentChatMessage.Role.User
  Row(modifier = Modifier.fillMaxWidth()) {
    if (user) Spacer(modifier = Modifier.weight(1f))
    Text(
      text = message.text,
      style = ClawTheme.type.body,
      color = ClawTheme.colors.text,
      modifier =
        Modifier
          .weight(if (user) 0.8f else 0.9f, fill = false)
          .background(if (user) ClawTheme.colors.primary.copy(alpha = 0.14f) else ClawTheme.colors.surfaceRaised, RoundedCornerShape(14.dp))
          .padding(horizontal = 12.dp, vertical = 9.dp),
    )
    if (!user) Spacer(modifier = Modifier.weight(1f))
  }
}

@Composable
private fun SystemAgentQuestionCard(
  question: ai.openclaw.app.systemagent.SystemAgentChatQuestion,
  enabled: Boolean,
  onAnswer: (SystemAgentChatQuestionOption) -> Unit,
  onSkip: () -> Unit,
) {
  ClawPanel(modifier = Modifier.fillMaxWidth()) {
    Column(modifier = Modifier.fillMaxWidth().padding(12.dp), verticalArrangement = Arrangement.spacedBy(9.dp)) {
      Text(question.header.uppercase(), style = ClawTheme.type.caption, color = ClawTheme.colors.primary)
      Text(question.question, style = ClawTheme.type.body, color = ClawTheme.colors.text)
      question.options.forEach { option ->
        ClawSecondaryButton(
          text = if (option.recommended) "${option.label} · ${nativeString("Recommended")}" else option.label,
          onClick = { onAnswer(option) },
          enabled = enabled,
        )
        option.description?.let { Text(it, style = ClawTheme.type.caption, color = ClawTheme.colors.textMuted) }
      }
      ClawSecondaryButton(text = nativeString("Skip for now"), onClick = onSkip, enabled = enabled)
    }
  }
}

@Composable
private fun SystemAgentComposer(
  state: SystemAgentChatState,
  onInputChange: (String) -> Unit,
  onSend: () -> Unit,
) {
  Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
    BasicTextField(
      value = state.input,
      onValueChange = onInputChange,
      modifier =
        Modifier
          .fillMaxWidth()
          .border(1.dp, ClawTheme.colors.border, RoundedCornerShape(ClawTheme.radii.control))
          .background(ClawTheme.colors.surfaceRaised, RoundedCornerShape(ClawTheme.radii.control))
          .padding(12.dp),
      textStyle = ClawTheme.type.body.copy(color = ClawTheme.colors.text),
      keyboardOptions = KeyboardOptions(keyboardType = if (state.expectsSensitiveReply) KeyboardType.Password else KeyboardType.Text),
      visualTransformation = if (state.expectsSensitiveReply) PasswordVisualTransformation() else VisualTransformation.None,
      minLines = 1,
      maxLines = 5,
      enabled = !state.sending && state.errorText == null,
      decorationBox = { inner ->
        Box {
          if (state.input.isEmpty()) {
            val placeholder =
              if (state.expectsSensitiveReply) {
                nativeString("Enter secret…")
              } else {
                nativeString("Reply to OpenClaw…")
              }
            Text(
              placeholder,
              style = ClawTheme.type.body,
              color = ClawTheme.colors.textSubtle,
            )
          }
          inner()
        }
      },
    )
    ClawPrimaryButton(
      text = nativeString("Send"),
      onClick = onSend,
      enabled = state.input.isNotBlank() && !state.sending && state.errorText == null,
    )
  }
}
