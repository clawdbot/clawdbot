package ai.openclaw.app.ui.chat

import ai.openclaw.app.GatewayAgentSummary
import ai.openclaw.app.GatewayModelSummary
import ai.openclaw.app.MainViewModel
import ai.openclaw.app.PendingAssistantAutoSend
import ai.openclaw.app.R
import ai.openclaw.app.chat.ChatCommandEntry
import ai.openclaw.app.chat.ChatComposerOwner
import ai.openclaw.app.chat.ChatMessage
import ai.openclaw.app.chat.ChatMessageContent
import ai.openclaw.app.chat.ChatOutboxItem
import ai.openclaw.app.chat.ChatPendingToolCall
import ai.openclaw.app.chat.ChatPlanStep
import ai.openclaw.app.chat.ChatPlanStepStatus
import ai.openclaw.app.chat.ChatQuestionPrompt
import ai.openclaw.app.chat.ChatSessionEntry
import ai.openclaw.app.chat.ChatThinkingLevelOption
import ai.openclaw.app.chat.ChatThinkingLevelSelection
import ai.openclaw.app.chat.ChatWidgetResource
import ai.openclaw.app.chat.MessageSpeechPhase
import ai.openclaw.app.chat.MessageSpeechState
import ai.openclaw.app.chat.VoiceNoteRecorderState
import ai.openclaw.app.chat.chatOutboxQueueFailureText
import ai.openclaw.app.chat.questionsForSession
import ai.openclaw.app.chat.resolveChatComposerOwner
import ai.openclaw.app.chat.resolveGatewayDefaultAgentId
import ai.openclaw.app.currentAppLanguage
import ai.openclaw.app.i18n.NativeText
import ai.openclaw.app.i18n.joinedNativeText
import ai.openclaw.app.i18n.nativeString
import ai.openclaw.app.i18n.nativeText
import ai.openclaw.app.i18n.resolveNativeTextResource
import ai.openclaw.app.i18n.verbatimText
import ai.openclaw.app.resolveAgentIdFromMainSessionKey
import ai.openclaw.app.ui.copyGatewayDiagnosticsReport
import ai.openclaw.app.ui.design.AgentAvatarSource
import ai.openclaw.app.ui.design.ClawAgentAvatar
import ai.openclaw.app.ui.design.ClawListItem
import ai.openclaw.app.ui.design.ClawLoadingState
import ai.openclaw.app.ui.design.ClawPanel
import ai.openclaw.app.ui.design.ClawPrimaryButton
import ai.openclaw.app.ui.design.ClawSecondaryButton
import ai.openclaw.app.ui.design.ClawSegmentedControl
import ai.openclaw.app.ui.design.ClawStatus
import ai.openclaw.app.ui.design.ClawStatusPill
import ai.openclaw.app.ui.design.ClawTheme
import ai.openclaw.app.ui.design.OpenClawMascot
import ai.openclaw.app.ui.design.agentAvatarSource
import ai.openclaw.app.ui.gatewayDiagnosticsEndpoint
import ai.openclaw.app.ui.gatewayStatusForDisplay
import ai.openclaw.app.ui.localizedUppercase
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.background
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.itemsIndexed
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.Send
import androidx.compose.material.icons.automirrored.filled.VolumeUp
import androidx.compose.material.icons.filled.Add
import androidx.compose.material.icons.filled.ArrowDropDown
import androidx.compose.material.icons.filled.AttachFile
import androidx.compose.material.icons.filled.Close
import androidx.compose.material.icons.filled.Cloud
import androidx.compose.material.icons.filled.ContentCopy
import androidx.compose.material.icons.filled.GraphicEq
import androidx.compose.material.icons.filled.HourglassEmpty
import androidx.compose.material.icons.filled.KeyboardArrowDown
import androidx.compose.material.icons.filled.KeyboardArrowUp
import androidx.compose.material.icons.filled.Mic
import androidx.compose.material.icons.filled.MoreHoriz
import androidx.compose.material.icons.filled.MoreVert
import androidx.compose.material.icons.filled.Refresh
import androidx.compose.material.icons.filled.Star
import androidx.compose.material.icons.filled.StarBorder
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.rememberUpdatedState
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.input.key.onPreInterceptKeyBeforeSoftKeyboard
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextDecoration
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.compose.LocalLifecycleOwner
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import java.text.DateFormat
import java.util.Date
import java.util.Locale
import java.util.UUID
import kotlin.math.roundToInt

/** Returns a pending assistant prompt only when chat can accept it immediately. */
internal fun resolvePendingAssistantAutoSend(
  pending: PendingAssistantAutoSend?,
  currentOwner: ChatComposerOwner,
  healthOk: Boolean,
  pendingRunCount: Int,
): PendingAssistantAutoSend? {
  val queued = pending ?: return null
  if (queued.prompt.isBlank() || queued.owner != currentOwner) return null
  if (!healthOk || pendingRunCount > 0) return null
  return queued
}

/** Chooses the session key to load for initial chat hydration, if any. */
internal fun resolveInitialChatLoadSessionKey(
  sessionKey: String,
  mainSessionKey: String,
): String? {
  val current = sessionKey.trim()
  val main = mainSessionKey.trim().ifEmpty { "main" }
  if (current.isNotEmpty() && current != "main" && current != main) return null
  return main
}

/** Full chat surface that wires MainViewModel state to messages, attachments, voice, and composer actions. */
@Composable
fun ChatScreen(
  viewModel: MainViewModel,
  onVoice: () -> Unit,
  onOpenSessions: () -> Unit,
  onOpenGatewaySettings: () -> Unit,
) {
  val messages by viewModel.chatMessages.collectAsState()
  val historyLoading by viewModel.chatHistoryLoading.collectAsState()
  val errorText by viewModel.chatError.collectAsState()
  val pendingRunCount by viewModel.pendingRunCount.collectAsState()
  val healthOk by viewModel.chatHealthOk.collectAsState()
  val gatewayConnectionDisplay by viewModel.gatewayConnectionDisplay.collectAsState()
  val activeGatewayStableId by viewModel.activeGatewayStableId.collectAsState()
  val sessionKey by viewModel.chatSessionKey.collectAsState()
  val sessionOwnerAgentId by viewModel.chatSessionOwnerAgentId.collectAsState()
  val mainSessionKey by viewModel.mainSessionKey.collectAsState()
  val gatewayDefaultAgentId by viewModel.gatewayDefaultAgentId.collectAsState()
  val gatewayComposerDefaultAgentOwner by viewModel.gatewayComposerDefaultAgentOwner.collectAsState()
  val gatewayAgents by viewModel.gatewayAgents.collectAsState()
  val thinkingLevel by viewModel.chatThinkingLevel.collectAsState()
  val thinkingLevelSelection by viewModel.chatThinkingLevelSelection.collectAsState()
  val streamingAssistantText by viewModel.chatStreamingAssistantText.collectAsState()
  val pendingToolCalls by viewModel.chatPendingToolCalls.collectAsState()
  val questions by viewModel.chatQuestions.collectAsState()
  val planSteps by viewModel.chatPlanSteps.collectAsState()
  val sessions by viewModel.chatSessions.collectAsState()
  val chatCommands by viewModel.chatCommands.collectAsState()
  val chatDraft by viewModel.chatDraft.collectAsState()
  val chatShareDrafts by viewModel.chatShareDrafts.collectAsState()
  val pendingAssistantAutoSend by viewModel.pendingAssistantAutoSend.collectAsState()
  val assistantAutoSendInFlight by viewModel.assistantAutoSendInFlight.collectAsState()
  val remoteAddress by viewModel.remoteAddress.collectAsState()
  val outboxItems by viewModel.chatOutboxItems.collectAsState()
  val messageSpeechState by viewModel.chatMessageSpeech.collectAsState()
  val manualHost by viewModel.manualHost.collectAsState()
  val manualPort by viewModel.manualPort.collectAsState()
  val manualTls by viewModel.manualTls.collectAsState()
  val modelCatalog by viewModel.chatModelCatalog.collectAsState()
  val modelFavorites by viewModel.modelFavorites.collectAsState()
  val modelRecents by viewModel.modelRecents.collectAsState()
  val selectedModelRef by viewModel.chatSelectedModelRef.collectAsState()
  val micEnabled by viewModel.micEnabled.collectAsState()
  val micIsListening by viewModel.micIsListening.collectAsState()
  val micCooldown by viewModel.micCooldown.collectAsState()
  val talkModeEnabled by viewModel.talkModeEnabled.collectAsState()
  val talkModeListening by viewModel.talkModeListening.collectAsState()
  val thinkingSupported =
    chatThinkingSupported(
      selection = thinkingLevelSelection,
      fallbackSupported = thinkingSupportedForSelection(selectedModelRef, modelCatalog),
    )
  val contextUsage = resolveChatContextUsage(sessionKey = sessionKey, mainSessionKey = mainSessionKey, sessions = sessions)
  val gatewayAddress = gatewayDiagnosticsEndpoint(remoteAddress = remoteAddress, manualHost = manualHost, manualPort = manualPort, manualTls = manualTls)
  val gatewayProblemMessage = gatewayConnectionDisplay.problem?.message?.takeIf { it.isNotBlank() }
  val offlineStatus = gatewayStatusForDisplay(gatewayProblemMessage ?: gatewayConnectionDisplay.statusText)
  val gatewayOffline = !gatewayConnectionDisplay.isConnected
  val effectiveGatewayDefaultAgentId =
    resolveGatewayDefaultAgentId(activeGatewayStableId, gatewayDefaultAgentId, gatewayComposerDefaultAgentOwner)
  val sessionAgentId = resolveAgentIdFromMainSessionKey(sessionKey) ?: sessionOwnerAgentId ?: effectiveGatewayDefaultAgentId ?: "main"
  val composerOwner =
    resolveChatComposerOwner(
      gatewayStableId = activeGatewayStableId,
      gatewayDefaultAgentId = sessionOwnerAgentId ?: gatewayDefaultAgentId,
      lastVerifiedOwner = if (sessionOwnerAgentId == null) gatewayComposerDefaultAgentOwner else null,
      sessionKey = sessionKey,
      mainSessionKey = mainSessionKey,
    )
  val activeAgentId = sessionAgentId
  val workspaceGit = gatewayAgents.firstOrNull { it.id == sessionAgentId }?.workspaceGit == true
  val context = LocalContext.current
  val lifecycleOwner = LocalLifecycleOwner.current
  val lifecycleState by lifecycleOwner.lifecycle.currentStateFlow.collectAsState()
  val resolver = context.applicationContext.contentResolver
  val scope = rememberCoroutineScope()
  val composerState = remember(viewModel) { viewModel.chatComposerState }
  val inputDrafts = composerState.textDrafts
  val imagePickerOwnerCheckpoint =
    rememberSaveable(saver = ChatComposerMediaCheckpoint.Saver) { ChatComposerMediaCheckpoint() }
  val voiceNoteCommitCheckpoint = remember { ChatComposerMediaCheckpoint() }
  val input = inputDrafts[composerOwner]
  val attachmentsByOwner by composerState.attachments.collectAsState()
  val attachments = attachmentsByOwner[composerOwner].orEmpty()
  val sendStates by composerState.sendStates.collectAsState()
  val attachmentNotices by composerState.attachmentNotices.collectAsState()
  val shareOwnerRevision by viewModel.chatShareDraftOwnerRevision.collectAsState()
  val chatShareDraft =
    remember(chatShareDrafts, composerOwner, mainSessionKey, shareOwnerRevision) {
      chatShareDrafts.firstOrNull { draft ->
        viewModel.chatShareDraftTargetsOwner(draft.id, composerOwner, mainSessionKey)
      }
    }
  val shareStaging =
    chatShareDraft?.let { viewModel.chatShareDraftTargetsOwner(it.id, composerOwner, mainSessionKey) } == true
  val pendingSendAdmissionIds = sendStates[composerOwner]?.pendingAdmissionIds.orEmpty()
  val currentPickerOwner by rememberUpdatedState(composerOwner)
  val currentPickerMainSessionKey by rememberUpdatedState(mainSessionKey)
  val sendInFlight = composerOwner in sendStates
  var showModelPicker by rememberSaveable { mutableStateOf(false) }
  var showBackgroundTasks by rememberSaveable { mutableStateOf(false) }
  var sendMessageTooLong by rememberSaveable(composerOwner) { mutableStateOf(false) }
  var sendCheckpointFull by rememberSaveable(composerOwner) { mutableStateOf(false) }

  LaunchedEffect(composerOwner, mainSessionKey, chatShareDraft?.id) {
    viewModel.resolveChatComposerOwnerAliases(to = composerOwner, mainSessionKey = mainSessionKey)
    if (shouldMigrateComposerDraft(voiceNoteCommitCheckpoint.owner, composerOwner, mainSessionKey)) {
      voiceNoteCommitCheckpoint.owner = composerOwner
    }
    viewModel.resolveChatShareDraftOwner(chatShareDraft?.id, composerOwner, mainSessionKey)
  }

  DisposableEffect(viewModel) {
    onDispose(viewModel::stopChatMessageSpeech)
  }
  val modelSections =
    remember(modelCatalog, modelFavorites, modelRecents) {
      chatModelPickerSections(
        catalog = modelCatalog,
        favorites = modelFavorites,
        recents = modelRecents,
      )
    }
  val selectedModelLabel =
    selectedModelRef?.let { selected ->
      modelCatalog.firstOrNull { it.providerQualifiedRef() == selected }?.name?.takeIf { it.isNotBlank() }
        ?: selected.substringAfterLast('/')
    } ?: nativeString("Model")
  val micCaptureActive = micEnabled || micIsListening || micCooldown || talkModeEnabled || talkModeListening
  val voiceNoteRecorder =
    rememberVoiceNoteRecorderController(
      viewModel = viewModel,
      ownerKey = composerOwner,
      mainSessionKey = mainSessionKey,
      onFinished = { recordingId, attachment ->
        val lease = voiceNoteCommitCheckpoint.consume(recordingId) ?: return@rememberVoiceNoteRecorderController
        composerState.addAuthorizedAttachments(lease.owner, lease.authorizationId, listOf(attachment))
      },
    )
  val voiceNoteState by voiceNoteRecorder.state.collectAsState()
  val voiceNoteElapsedMs by voiceNoteRecorder.elapsedMs.collectAsState()
  val voiceNoteLevel by voiceNoteRecorder.inputLevel.collectAsState()
  val pickImages =
    rememberLauncherForActivityResult(ActivityResultContracts.GetMultipleContents()) { uris ->
      val lease = imagePickerOwnerCheckpoint.consume() ?: return@rememberLauncherForActivityResult
      if (uris.isNullOrEmpty()) {
        composerState.cancelMediaAcquisition(lease.authorizationId)
        return@rememberLauncherForActivityResult
      }
      val importOwner =
        if (shouldMigrateComposerDraft(lease.owner, currentPickerOwner, currentPickerMainSessionKey)) {
          currentPickerOwner
        } else {
          lease.owner
        }
      val selectedUris = uris.take(8)
      viewModel.importChatComposerAttachments(
        owner = importOwner,
        mediaAuthorizationId = lease.authorizationId,
        mainSessionKey = currentPickerMainSessionKey,
        expectedCount = uris.size,
      ) {
        selectedUris
          .mapNotNull { uri ->
            try {
              loadSizedImageAttachment(resolver, uri)
            } catch (err: CancellationException) {
              throw err
            } catch (_: Throwable) {
              null
            }
          }
      }
    }

  LaunchedEffect(Unit) {
    val loadSessionKey = resolveInitialChatLoadSessionKey(sessionKey, mainSessionKey)
    if (loadSessionKey != null) {
      viewModel.loadChat(loadSessionKey, sessionOwnerAgentId)
    }
    viewModel.refreshChatSessions(limit = 100)
    viewModel.refreshChatCommands()
  }

  LaunchedEffect(
    pendingAssistantAutoSend,
    assistantAutoSendInFlight,
    sendStates,
    composerOwner,
    healthOk,
    pendingRunCount,
    thinkingLevel,
  ) {
    if (!healthOk) return@LaunchedEffect
    val pending =
      resolvePendingAssistantAutoSend(
        pending = pendingAssistantAutoSend,
        currentOwner = composerOwner,
        healthOk = healthOk,
        pendingRunCount = pendingRunCount,
      ) ?: return@LaunchedEffect
    viewModel.dispatchPendingAssistantAutoSend(
      pending = pending,
      thinking = thinkingLevel,
    )
  }

  val shareImportNotice =
    when (attachmentNotices[composerOwner]) {
      ChatComposerAttachmentNotice.Attachment ->
        NativeText.Resource(source = "Could not stage an attachment for sending.", formatArgs = emptyList())
      ChatComposerAttachmentNotice.Image ->
        nativeText("Some shared images were omitted or could not be added.")
      null ->
        when {
          sendMessageTooLong ->
            joinedNativeText(
              separator = " ",
              parts =
                listOf(
                  chatOutboxQueueFailureText(),
                  verbatimText("${input.length}/$CHAT_COMPOSER_MAX_SEND_CHARS"),
                ),
            )
          sendCheckpointFull -> chatOutboxQueueFailureText()
          else -> null
        }
    }

  LaunchedEffect(chatDraft, composerOwner, mainSessionKey) {
    val pending = chatDraft ?: return@LaunchedEffect
    val claimed =
      viewModel.consumeChatDraft(
        expected = pending,
        owner = composerOwner,
        mainSessionKey = mainSessionKey,
      ) ?: return@LaunchedEffect
    inputDrafts[composerOwner] =
      mergeChatDraft(draft = claimed, currentInput = input, currentOwner = composerOwner) ?: return@LaunchedEffect
  }

  LaunchedEffect(composerOwner, pendingSendAdmissionIds) {
    pendingSendAdmissionIds.forEach { admissionId ->
      viewModel.acknowledgeChatComposerSendAdmission(composerOwner, admissionId)
    }
  }

  // The process queue remembers the first owner; only an explicit alias/identity resolution
  // migrates that claim. Navigating elsewhere must never retarget a shared payload.
  LaunchedEffect(chatShareDraft?.id, lifecycleState, composerOwner, shareOwnerRevision) {
    if (!lifecycleState.isAtLeast(Lifecycle.State.RESUMED)) return@LaunchedEffect
    val share = chatShareDraft ?: return@LaunchedEffect
    val ownerSnapshot = composerOwner
    viewModel.withChatShareDraftLease(share.id, ownerSnapshot) {
      val staged =
        withContext(Dispatchers.IO) {
          stageChatShareDraft(share) { uri ->
            loadSizedImageAttachment(resolver, uri)
          }
        }
      if (!viewModel.isCurrentChatComposerOwner(ownerSnapshot)) return@withChatShareDraftLease
      if (
        !canCommitStagedChatShare(
          stagedId = share.id,
          currentHead = viewModel.chatShareDraftForOwner(ownerSnapshot, mainSessionKey),
          ownerSnapshot = ownerSnapshot,
          currentOwner = ownerSnapshot,
        )
      ) {
        return@withChatShareDraftLease
      }
      // A non-resumed Activity must not acknowledge into its hidden composer; the next visible
      // Activity keeps the process-owned head and retries the complete import instead.
      if (!lifecycleOwner.lifecycle.currentState.isAtLeast(Lifecycle.State.RESUMED)) {
        return@withChatShareDraftLease
      }
      // Keep the head pending through both mutations: Send stays gated until text and images
      // have been merged together, and disposal before this point leaves the head for retry.
      inputDrafts[ownerSnapshot] =
        mergeSharedChatText(sharedText = staged.text, currentInput = inputDrafts[ownerSnapshot])
      val admissionOmissions = composerState.addAttachments(ownerSnapshot, staged.attachments)
      composerState.reportImageOmission(
        ownerSnapshot,
        staged.failedImageCount + staged.droppedImageCount + admissionOmissions,
      )
      viewModel.acknowledgeChatShareDraft(share.id, ownerSnapshot)
    }
  }

  LaunchedEffect(gatewayConnectionDisplay.isConnected) {
    if (!gatewayConnectionDisplay.isConnected) {
      showModelPicker = false
    }
  }

  val newChatEnabled =
    canStartNewChat(
      pendingRunCount = pendingRunCount,
      hasQueuedMessage = pendingAssistantAutoSend != null,
      gatewayReady = healthOk && !gatewayOffline,
    )

  val startNewChat: (Boolean) -> Unit = { worktree ->
    if (newChatEnabled) {
      viewModel.startNewChat(worktree = worktree)
      viewModel.refreshChatSessions(limit = 100)
      viewModel.refreshChatCommands()
    }
  }

  Column(
    modifier =
      Modifier
        .fillMaxSize()
        .padding(horizontal = 16.dp, vertical = 10.dp),
    verticalArrangement = Arrangement.spacedBy(8.dp),
  ) {
    ChatHeader(
      sessionTitle = currentSessionTitle(sessionKey = sessionKey, sessions = sessions),
      healthOk = healthOk,
      pendingRunCount = pendingRunCount,
      newChatEnabled = newChatEnabled,
      workspaceGit = workspaceGit,
      onNewChat = {
        startNewChat(false)
      },
      onNewChatInWorktree = { startNewChat(true) },
      onRefresh = {
        viewModel.refreshChat()
        viewModel.refreshChatSessions(limit = 100)
      },
      onOpenBackgroundTasks = { showBackgroundTasks = true },
    )

    ChatAgentSelector(
      activeAgentId = activeAgentId,
      agents = gatewayAgents,
      onSelectAgent = viewModel::selectChatAgent,
    )

    ChatSessionSwitcher(
      sessionKey = sessionKey,
      sessions = sessions,
      mainSessionKey = mainSessionKey,
      onSelectSession = { entry ->
        viewModel.switchChatSession(entry.key, entry.ownerAgentId)
        viewModel.refreshChatSessions(limit = 100)
      },
      onOpenSessions = onOpenSessions,
    )

    errorText?.takeIf { it.isNotBlank() }?.let { error ->
      ChatNotice(
        title = nativeString("Chat needs attention"),
        body = userFacingChatError(error = error, gatewayConnected = gatewayConnectionDisplay.isConnected),
      )
    }

    ChatMessageList(
      sessionKey = sessionKey,
      messages = messages,
      historyLoading = historyLoading,
      pendingRunCount = pendingRunCount,
      pendingToolCalls = pendingToolCalls,
      questions = questionsForSession(questions, sessionKey, mainSessionKey, activeAgentId),
      streamingAssistantText = streamingAssistantText,
      healthOk = healthOk,
      gatewayOffline = gatewayOffline,
      outboxItems =
        outboxItemsForSession(
          items = outboxItems,
          sessionKey = sessionKey,
          mainSessionKey = mainSessionKey,
          ownerAgentId = composerOwner.agentId,
          messages = messages,
        ),
      recoveryOutboxItems =
        outboxItemsForRecovery(
          items = outboxItems,
        ),
      onRetryOutbox = viewModel::retryChatOutboxCommand,
      onDeleteOutbox = viewModel::deleteChatOutboxCommand,
      onResolveQuestion = viewModel::resolveChatQuestion,
      onStarterPrompt = { prompt -> inputDrafts[composerOwner] = prompt },
      onReplyMessage = { value -> viewModel.setChatReplyDraft(value, composerOwner) },
      speechState = messageSpeechState,
      onToggleListen = viewModel::toggleChatMessageSpeech,
      resolveInlineWidgetResource = viewModel::resolveInlineWidgetResource,
      modifier = Modifier.weight(1f),
    )

    if (pendingRunCount > 0 && planSteps.isNotEmpty()) {
      PlanChecklistPill(steps = planSteps)
    }

    ChatComposer(
      value = input,
      onValueChange = {
        sendMessageTooLong = false
        sendCheckpointFull = false
        inputDrafts[composerOwner] = it
      },
      attachments = attachments,
      thinkingLevel = thinkingLevel,
      thinkingOptions = thinkingLevelSelection.options,
      thinkingSupported = thinkingSupported,
      contextUsage = contextUsage,
      selectedModelLabel = selectedModelLabel,
      modelPickerEnabled = gatewayConnectionDisplay.isConnected,
      healthOk = healthOk,
      gatewayOffline = gatewayOffline,
      offlineStatus = offlineStatus,
      pendingRunCount = pendingRunCount,
      shareStaging = shareStaging,
      sendInFlight = sendInFlight,
      shareImportNotice = shareImportNotice,
      onDismissShareImportNotice = {
        sendMessageTooLong = false
        sendCheckpointFull = false
        composerState.clearAttachmentOmission(composerOwner)
      },
      commands = chatCommands,
      onThinkingLevelChange = viewModel::setChatThinkingLevel,
      onOpenModelPicker = { showModelPicker = true },
      onPickImages = {
        if (!viewModel.isCurrentChatComposerOwner(composerOwner)) return@ChatComposer
        val authorizationId = composerState.beginMediaAcquisition(composerOwner) ?: return@ChatComposer
        imagePickerOwnerCheckpoint.begin(composerOwner, authorizationId)
        pickImages.launch("image/*")
      },
      onRemoveAttachment = { id -> composerState.removeAttachments(composerOwner, setOf(id)) },
      voiceNoteState = voiceNoteState,
      voiceNoteElapsedMs = voiceNoteElapsedMs,
      voiceNoteLevel = voiceNoteLevel,
      recordVoiceNoteEnabled = pendingRunCount == 0 && !micCaptureActive && !sendInFlight,
      onStartVoiceNote = {
        scope.launch {
          val ownerSnapshot = composerOwner
          val mediaAuthorizationId = composerState.beginMediaAcquisition(ownerSnapshot) ?: return@launch
          val recordingId = UUID.randomUUID().toString()
          if (!viewModel.isCurrentChatComposerOwner(ownerSnapshot)) {
            composerState.cancelMediaAcquisition(mediaAuthorizationId)
            return@launch
          }
          if (voiceNoteRecorder.start(recordingId)) {
            if (
              viewModel.isCurrentChatComposerOwner(ownerSnapshot) &&
              composerState.isMediaAcquisitionActive(mediaAuthorizationId)
            ) {
              voiceNoteCommitCheckpoint.begin(ownerSnapshot, mediaAuthorizationId, recordingId)
            } else {
              voiceNoteRecorder.cancel()
              composerState.cancelMediaAcquisition(mediaAuthorizationId)
            }
          } else {
            composerState.cancelMediaAcquisition(mediaAuthorizationId)
          }
        }
      },
      onCancelVoiceNote = {
        voiceNoteCommitCheckpoint.clear()?.let { lease ->
          composerState.cancelMediaAcquisition(lease.authorizationId)
        }
        voiceNoteRecorder.cancel()
      },
      onFinishVoiceNote = voiceNoteRecorder::finish,
      onVoice = onVoice,
      onFixConnection = onOpenGatewaySettings,
      onCopyDiagnostics = {
        copyGatewayDiagnosticsReport(
          context = context,
          screen = "chat composer",
          gatewayAddress = gatewayAddress,
          statusText = offlineStatus,
        )
      },
      onAbort = viewModel::abortChat,
      onSend = {
        // Re-read the ViewModel so a stale click callback cannot beat StateFlow recomposition.
        val currentShare = viewModel.chatShareDraftForOwner(composerOwner, mainSessionKey)
        if (currentShare != null || composerOwner in sendStates) {
          return@ChatComposer
        }
        val ownerSnapshot = composerOwner
        if (!viewModel.isCurrentChatComposerOwner(ownerSnapshot)) return@ChatComposer
        val result =
          viewModel.beginChatComposerSend(
            owner = ownerSnapshot,
            thinking = thinkingLevel,
          )
        sendMessageTooLong = result == ChatComposerSendStartResult.MessageTooLong
        sendCheckpointFull = result == ChatComposerSendStartResult.CheckpointFull
      },
    )
  }

  if (showModelPicker) {
    ChatModelPickerSheet(
      sections = modelSections,
      favorites = modelFavorites.toSet(),
      onDismiss = { showModelPicker = false },
      onSelect = { modelRef ->
        viewModel.setChatSessionModel(sessionKey = sessionKey, modelRef = modelRef)
        showModelPicker = false
      },
      onToggleFavorite = viewModel::toggleModelFavorite,
    )
  }
  if (showBackgroundTasks) {
    BackgroundTasksSheet(
      viewModel = viewModel,
      agentId = sessionAgentId,
      onDismiss = { showBackgroundTasks = false },
    )
  }
}

@Composable
private fun ChatAgentSelector(
  activeAgentId: String,
  agents: List<GatewayAgentSummary>,
  onSelectAgent: (String) -> Unit,
) {
  if (agents.size <= 1) return

  Row(
    modifier = Modifier.fillMaxWidth().horizontalScroll(rememberScrollState()),
    verticalAlignment = Alignment.CenterVertically,
    horizontalArrangement = Arrangement.spacedBy(6.dp),
  ) {
    agents.forEach { agent ->
      ChatSessionChip(
        text = chatAgentChipText(agent),
        avatarSource = agentAvatarSource(agent),
        active = agent.id == activeAgentId,
        onClick = { onSelectAgent(agent.id) },
      )
    }
  }
}

@Composable
private fun ChatSessionSwitcher(
  sessionKey: String,
  sessions: List<ChatSessionEntry>,
  mainSessionKey: String,
  onSelectSession: (ChatSessionEntry) -> Unit,
  onOpenSessions: () -> Unit,
) {
  val allChoices =
    remember(sessionKey, sessions, mainSessionKey) {
      resolveSessionChoices(
        currentSessionKey = sessionKey,
        sessions = sessions,
        mainSessionKey = mainSessionKey,
      )
    }
  val choices =
    remember(sessionKey, allChoices, mainSessionKey) {
      compactSessionChoices(
        choices = allChoices,
        currentSessionKey = sessionKey,
        mainSessionKey = mainSessionKey,
      )
    }
  val hasMoreSessions =
    remember(sessions, choices, mainSessionKey) {
      hasAdditionalSessionChoices(
        sessions = sessions,
        displayedChoices = choices,
        mainSessionKey = mainSessionKey,
      )
    }
  if (choices.size <= 1 && !hasMoreSessions) return

  Row(
    modifier = Modifier.fillMaxWidth().horizontalScroll(rememberScrollState()),
    verticalAlignment = Alignment.CenterVertically,
    horizontalArrangement = Arrangement.spacedBy(6.dp),
  ) {
    choices.forEach { entry ->
      ChatSessionChip(
        text = chatSessionChipText(entry = entry, mainSessionKey = mainSessionKey),
        active = isActiveSessionChoice(entry.key, sessionKey, mainSessionKey),
        onClick = { onSelectSession(entry) },
      )
    }
    if (hasMoreSessions) {
      Surface(
        onClick = onOpenSessions,
        modifier = Modifier.heightIn(min = ClawTheme.spacing.touchTarget),
        shape = RoundedCornerShape(ClawTheme.radii.pill),
        color = ClawTheme.colors.surfaceRaised.copy(alpha = 0.72f),
        contentColor = ClawTheme.colors.textMuted,
        border = BorderStroke(1.dp, ClawTheme.colors.border.copy(alpha = 0.7f)),
      ) {
        Row(
          modifier = Modifier.padding(horizontal = 10.dp, vertical = 7.dp),
          verticalAlignment = Alignment.CenterVertically,
          horizontalArrangement = Arrangement.spacedBy(5.dp),
        ) {
          Icon(imageVector = Icons.Default.MoreHoriz, contentDescription = null, modifier = Modifier.size(16.dp))
          Text(text = nativeString("All"), style = ClawTheme.type.caption, maxLines = 1)
        }
      }
    }
  }
}

@Composable
private fun ChatSessionChip(
  text: String,
  avatarSource: AgentAvatarSource? = null,
  active: Boolean,
  onClick: () -> Unit,
) {
  Surface(
    onClick = onClick,
    modifier = Modifier.heightIn(min = ClawTheme.spacing.touchTarget),
    shape = RoundedCornerShape(ClawTheme.radii.pill),
    color = if (active) ClawTheme.colors.surfacePressed.copy(alpha = 0.9f) else ClawTheme.colors.surfaceRaised.copy(alpha = 0.72f),
    contentColor = ClawTheme.colors.text,
    border = BorderStroke(1.dp, if (active) ClawTheme.colors.borderStrong else ClawTheme.colors.border.copy(alpha = 0.7f)),
  ) {
    Row(
      modifier =
        Modifier.padding(
          horizontal = if (avatarSource == null) 11.dp else 8.dp,
          vertical = if (avatarSource == null) 7.dp else 5.dp,
        ),
      verticalAlignment = Alignment.CenterVertically,
      horizontalArrangement = Arrangement.spacedBy(6.dp),
    ) {
      if (avatarSource != null) {
        ClawAgentAvatar(source = avatarSource, size = 20.dp) {}
      }
      Text(
        text = text,
        style = ClawTheme.type.caption,
        maxLines = 1,
        overflow = TextOverflow.Ellipsis,
      )
    }
  }
}

internal fun canStartNewChat(
  pendingRunCount: Int,
  hasQueuedMessage: Boolean,
  gatewayReady: Boolean,
): Boolean = gatewayReady && pendingRunCount == 0 && !hasQueuedMessage

@Composable
private fun ChatHeader(
  sessionTitle: String,
  healthOk: Boolean,
  pendingRunCount: Int,
  newChatEnabled: Boolean,
  workspaceGit: Boolean,
  onNewChat: () -> Unit,
  onNewChatInWorktree: () -> Unit,
  onRefresh: () -> Unit,
  onOpenBackgroundTasks: () -> Unit,
) {
  var actionsMenuExpanded by remember { mutableStateOf(false) }
  val newChatInWorktreeLabel = stringResource(R.string.new_chat_in_worktree)
  Column(verticalArrangement = Arrangement.spacedBy(10.dp)) {
    Row(
      modifier = Modifier.fillMaxWidth(),
      verticalAlignment = Alignment.CenterVertically,
      horizontalArrangement = Arrangement.spacedBy(10.dp),
    ) {
      OpenClawMascot(modifier = Modifier.size(25.dp))
      Text(
        text = nativeString("OpenClaw"),
        style = ClawTheme.type.title.copy(fontSize = 17.sp, lineHeight = 21.sp),
        color = ClawTheme.colors.text,
        modifier = Modifier.weight(1f),
        maxLines = 1,
        overflow = TextOverflow.Ellipsis,
      )
      ModelPill(
        text =
          when {
            pendingRunCount > 0 -> nativeString("Working")
            healthOk -> nativeString("Ready")
            else -> nativeString("Offline")
          },
        status =
          when {
            pendingRunCount > 0 -> ClawStatus.Warning
            healthOk -> ClawStatus.Success
            else -> ClawStatus.Danger
          },
      )
      HeaderIcon(icon = Icons.Default.Add, contentDescription = nativeString("New chat"), enabled = newChatEnabled, onClick = onNewChat)
      Box {
        HeaderIcon(
          icon = Icons.Default.MoreVert,
          contentDescription = nativeString("Chat actions"),
          onClick = { actionsMenuExpanded = true },
        )
        DropdownMenu(expanded = actionsMenuExpanded, onDismissRequest = { actionsMenuExpanded = false }) {
          DropdownMenuItem(
            text = { Text(nativeString("Refresh chat")) },
            leadingIcon = { Icon(Icons.Default.Refresh, contentDescription = null) },
            onClick = {
              actionsMenuExpanded = false
              onRefresh()
            },
          )
          DropdownMenuItem(
            text = { Text(nativeString("Background tasks")) },
            leadingIcon = { Icon(Icons.Default.HourglassEmpty, contentDescription = null) },
            onClick = {
              actionsMenuExpanded = false
              onOpenBackgroundTasks()
            },
          )
          if (workspaceGit) {
            DropdownMenuItem(
              text = { Text(newChatInWorktreeLabel) },
              enabled = newChatEnabled,
              onClick = {
                actionsMenuExpanded = false
                onNewChatInWorktree()
              },
            )
          }
        }
      }
    }
    Column(verticalArrangement = Arrangement.spacedBy(3.dp)) {
      Text(text = nativeString("Chat"), style = ClawTheme.type.display.copy(fontSize = 24.sp, lineHeight = 28.sp), color = ClawTheme.colors.text, maxLines = 1)
      Text(
        text = sessionTitle,
        style = ClawTheme.type.caption.copy(fontSize = 13.sp, lineHeight = 17.sp),
        color = ClawTheme.colors.textMuted,
        maxLines = 1,
        overflow = TextOverflow.Ellipsis,
      )
    }
  }
}

@Composable
private fun ModelPill(
  text: String,
  status: ClawStatus,
) {
  val borderColor =
    if (status == ClawStatus.Warning) {
      ClawTheme.colors.warning
    } else {
      ClawTheme.colors.border
    }
  Surface(
    shape = RoundedCornerShape(ClawTheme.radii.pill),
    color =
      when (status) {
        ClawStatus.Success -> ClawTheme.colors.successSoft
        ClawStatus.Warning -> ClawTheme.colors.warningSoft
        ClawStatus.Danger -> ClawTheme.colors.dangerSoft
        ClawStatus.Neutral -> ClawTheme.colors.surfaceRaised
      },
    contentColor = ClawTheme.colors.textMuted,
    border = BorderStroke(1.dp, borderColor),
  ) {
    Text(
      text = text,
      modifier = Modifier.padding(horizontal = 7.dp, vertical = 1.5.dp),
      style = ClawTheme.type.caption.copy(fontSize = 12.5.sp, lineHeight = 16.sp),
      maxLines = 1,
    )
  }
}

@Composable
private fun HeaderIcon(
  icon: androidx.compose.ui.graphics.vector.ImageVector,
  contentDescription: String,
  enabled: Boolean = true,
  onClick: () -> Unit,
) {
  val contentColor = if (enabled) ClawTheme.colors.text else ClawTheme.colors.textMuted
  Surface(
    onClick = onClick,
    enabled = enabled,
    modifier = Modifier.size(ClawTheme.spacing.touchTarget),
    shape = CircleShape,
    color = Color.Transparent,
    contentColor = contentColor,
  ) {
    Box(contentAlignment = Alignment.Center) {
      Icon(imageVector = icon, contentDescription = contentDescription, modifier = Modifier.size(20.dp))
    }
  }
}

@Composable
private fun ChatMessageList(
  sessionKey: String,
  messages: List<ChatMessage>,
  historyLoading: Boolean,
  pendingRunCount: Int,
  pendingToolCalls: List<ChatPendingToolCall>,
  questions: List<ChatQuestionPrompt>,
  streamingAssistantText: String?,
  healthOk: Boolean,
  gatewayOffline: Boolean,
  outboxItems: List<ChatOutboxItem>,
  recoveryOutboxItems: List<ChatOutboxItem>,
  onRetryOutbox: (String) -> Unit,
  onDeleteOutbox: (String) -> Unit,
  onResolveQuestion: (String, Map<String, List<String>>) -> Unit,
  onStarterPrompt: (String) -> Unit,
  onReplyMessage: (String) -> Unit,
  speechState: MessageSpeechState?,
  onToggleListen: (String, String) -> Unit,
  resolveInlineWidgetResource: suspend (String, ChatWidgetResource?) -> ChatWidgetResource?,
  modifier: Modifier = Modifier,
) {
  val timeline =
    remember(messages, pendingRunCount, pendingToolCalls, questions, streamingAssistantText, outboxItems, recoveryOutboxItems) {
      buildChatTimeline(
        messages = messages,
        pendingRunCount = pendingRunCount,
        pendingToolCalls = pendingToolCalls,
        streamingAssistantText = streamingAssistantText,
        outboxItems = outboxItems,
        recoveryOutboxItems = recoveryOutboxItems,
        questions = questions,
      )
    }
  val readerScroll =
    rememberChatReaderScrollController(
      sessionKey = sessionKey,
      timeline = timeline,
      historyLoading = historyLoading,
    )

  Box(modifier = modifier.fillMaxWidth()) {
    LazyColumn(
      modifier = Modifier.fillMaxSize(),
      state = readerScroll.listState,
      reverseLayout = true,
      verticalArrangement = Arrangement.spacedBy(5.dp),
      contentPadding = PaddingValues(top = 6.dp, bottom = 3.dp),
    ) {
      itemsIndexed(items = timeline.items, key = { _, item -> chatTimelineItemKey(item) }) { _, item ->
        when (item) {
          is ChatTimelineItem.Message ->
            ChatBubble(
              messageId = item.message.id,
              role = item.message.role,
              live = false,
              content = item.message.content,
              timestampMs = item.message.timestampMs,
              onReplyMessage = onReplyMessage,
              speechState = speechState,
              onToggleListen = onToggleListen,
              inlineWidgetResolverReady = healthOk,
              resolveInlineWidgetResource = resolveInlineWidgetResource,
            )
          is ChatTimelineItem.OutboxCommand ->
            ChatOutboxBubble(
              item = item.item,
              onRetry = { onRetryOutbox(item.item.id) },
              onDelete = { onDeleteOutbox(item.item.id) },
            )
          is ChatTimelineItem.RecoveryOutboxCommand ->
            ChatOutboxBubble(
              item = item.item,
              retryEnabled = false,
              onRetry = { onRetryOutbox(item.item.id) },
              onDelete = { onDeleteOutbox(item.item.id) },
            )
          is ChatTimelineItem.OutboxRecoveryHeader ->
            ChatNotice(
              title = nativeString("Messages to recover"),
              body =
                nativeString(
                  "\${item.count} message(s) need recovery. Re-enter anything you want to keep, then delete these rows.",
                  item.count,
                ),
            )
          is ChatTimelineItem.PendingTools -> ToolBubble(toolCalls = item.toolCalls)
          is ChatTimelineItem.QuestionPrompt ->
            ChatQuestionCard(prompt = item.prompt, onSubmit = onResolveQuestion)
          is ChatTimelineItem.StreamingAssistant ->
            ChatBubble(
              messageId = null,
              role = "assistant",
              live = true,
              content = listOf(ChatMessageContent(text = item.text)),
              timestampMs = null,
              onReplyMessage = onReplyMessage,
              speechState = null,
              onToggleListen = onToggleListen,
              inlineWidgetResolverReady = healthOk,
              resolveInlineWidgetResource = resolveInlineWidgetResource,
            )
          ChatTimelineItem.Thinking -> ChatThinkingBubble()
        }
      }
    }

    if (timeline.items.isEmpty()) {
      if (showChatLoadingPlaceholder(historyLoading = historyLoading, healthOk = healthOk, gatewayOffline = gatewayOffline)) {
        ClawLoadingState(title = nativeString("Loading session"), modifier = Modifier.align(Alignment.Center))
      } else {
        EmptyChatHint(
          healthOk = healthOk,
          gatewayOffline = gatewayOffline,
          onStarterPrompt = onStarterPrompt,
          modifier = Modifier.align(Alignment.Center),
        )
      }
    }

    if (readerScroll.showJumpToLatest) {
      Surface(
        onClick = readerScroll.jumpToLatest,
        modifier = Modifier.align(Alignment.BottomCenter).padding(bottom = 10.dp),
        shape = RoundedCornerShape(999.dp),
        color = ClawTheme.colors.surfaceRaised,
        contentColor = ClawTheme.colors.text,
        shadowElevation = 6.dp,
        border = BorderStroke(1.dp, ClawTheme.colors.border),
      ) {
        Row(
          modifier = Modifier.padding(horizontal = 12.dp, vertical = 7.dp),
          horizontalArrangement = Arrangement.spacedBy(6.dp),
          verticalAlignment = Alignment.CenterVertically,
        ) {
          Icon(imageVector = Icons.Default.ArrowDropDown, contentDescription = null, modifier = Modifier.size(16.dp))
          Text(text = nativeString("Jump to latest"), style = ClawTheme.type.caption.copy(fontWeight = FontWeight.SemiBold))
        }
      }
    }
  }
}

internal fun showChatLoadingPlaceholder(
  historyLoading: Boolean,
  healthOk: Boolean,
  gatewayOffline: Boolean,
): Boolean = historyLoading && !healthOk && !gatewayOffline

@Composable
private fun EmptyChatHint(
  healthOk: Boolean,
  gatewayOffline: Boolean,
  onStarterPrompt: (String) -> Unit,
  modifier: Modifier = Modifier,
) {
  Column(
    modifier = modifier.fillMaxWidth().padding(horizontal = 2.dp),
    horizontalAlignment = Alignment.CenterHorizontally,
    verticalArrangement = Arrangement.spacedBy(12.dp),
  ) {
    Column(horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.spacedBy(5.dp)) {
      Text(text = if (healthOk) nativeString("Ready when you are") else nativeString("Gateway offline"), style = ClawTheme.type.title.copy(fontSize = 18.sp, lineHeight = 23.sp), color = ClawTheme.colors.text)
      Text(
        text =
          if (healthOk) {
            nativeString("Start with a prompt, or use voice.")
          } else if (gatewayOffline) {
            nativeString("Use the recovery options below to reconnect.")
          } else {
            nativeString("Chat is checking Gateway health.")
          },
        style = ClawTheme.type.body,
        color = ClawTheme.colors.textMuted,
        textAlign = TextAlign.Center,
      )
    }
    if (healthOk) {
      StarterPromptList(onStarterPrompt = onStarterPrompt)
    }
  }
}

@Composable
private fun ChatOfflineActions(
  onFixConnection: () -> Unit,
  onCopyDiagnostics: () -> Unit,
  modifier: Modifier = Modifier,
) {
  Column(
    modifier = modifier.fillMaxWidth(),
    verticalArrangement = Arrangement.spacedBy(8.dp),
  ) {
    ClawPrimaryButton(text = nativeString("Fix connection"), icon = Icons.Default.Cloud, onClick = onFixConnection, modifier = Modifier.fillMaxWidth())
    ClawSecondaryButton(text = nativeString("Copy diagnostics"), icon = Icons.Default.ContentCopy, onClick = onCopyDiagnostics, modifier = Modifier.fillMaxWidth())
  }
}

@Composable
private fun StarterPromptList(onStarterPrompt: (String) -> Unit) {
  ClawPanel(contentPadding = PaddingValues(horizontal = 0.dp, vertical = 0.dp)) {
    Column {
      starterPrompts.forEachIndexed { index, prompt ->
        val message = prompt.message.resolveNativeTextResource()
        StarterPromptRow(prompt = prompt, onClick = { onStarterPrompt(message) })
        if (index != starterPrompts.lastIndex) {
          HorizontalDivider(color = ClawTheme.colors.border, thickness = 1.dp)
        }
      }
    }
  }
}

@Composable
private fun StarterPromptRow(
  prompt: StarterPrompt,
  onClick: () -> Unit,
) {
  Surface(onClick = onClick, color = Color.Transparent, contentColor = ClawTheme.colors.text) {
    Row(
      modifier = Modifier.fillMaxWidth().heightIn(min = 54.dp).padding(horizontal = 10.dp, vertical = 6.dp),
      verticalAlignment = Alignment.CenterVertically,
      horizontalArrangement = Arrangement.spacedBy(10.dp),
    ) {
      Box(
        modifier =
          Modifier
            .size(30.dp)
            .background(ClawTheme.colors.surfacePressed, RoundedCornerShape(ClawTheme.radii.row)),
        contentAlignment = Alignment.Center,
      ) {
        Text(text = prompt.mark, style = ClawTheme.type.label, color = ClawTheme.colors.text)
      }
      Column(modifier = Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(1.dp)) {
        Text(text = prompt.title.resolveNativeTextResource(), style = ClawTheme.type.body, color = ClawTheme.colors.text, maxLines = 1)
        Text(text = prompt.subtitle.resolveNativeTextResource(), style = ClawTheme.type.caption, color = ClawTheme.colors.textMuted, maxLines = 1, overflow = TextOverflow.Ellipsis)
      }
    }
  }
}

internal data class StarterPrompt(
  val mark: String,
  val title: NativeText,
  val subtitle: NativeText,
  val message: NativeText,
)

/** Default prompts shown only for an empty, connected session. */
internal val starterPrompts =
  listOf(
    StarterPrompt(
      mark = "1",
      title = nativeText("Catch me up"),
      subtitle = nativeText("Summarize recent sessions and next steps."),
      message = nativeText("Catch me up on my recent OpenClaw sessions and suggest next steps."),
    ),
    StarterPrompt(
      mark = "2",
      title = nativeText("Plan the work"),
      subtitle = nativeText("Turn a goal into an actionable checklist."),
      message = nativeText("Help me turn this goal into a practical checklist: "),
    ),
    StarterPrompt(
      mark = "3",
      title = nativeText("Use this phone"),
      subtitle = nativeText("Ask OpenClaw to use Android capabilities."),
      message = nativeText("What can you help me do from this phone right now?"),
    ),
  )

@Composable
private fun ChatBubble(
  messageId: String?,
  role: String,
  live: Boolean,
  content: List<ChatMessageContent>,
  timestampMs: Long?,
  onReplyMessage: (String) -> Unit,
  speechState: MessageSpeechState?,
  onToggleListen: (String, String) -> Unit,
  inlineWidgetResolverReady: Boolean,
  resolveInlineWidgetResource: suspend (String, ChatWidgetResource?) -> ChatWidgetResource?,
) {
  val normalizedRole = role.trim().lowercase(Locale.US)
  val isUser = normalizedRole == "user"
  val displayableContent =
    content.filter { part ->
      when (part.type) {
        "text" -> !part.text.isNullOrBlank()
        "image" -> !part.base64.isNullOrBlank()
        "canvas" -> normalizedRole == "assistant" && part.widget != null
        else -> part.isAudioAttachment()
      }
    }
  if (displayableContent.isEmpty()) return

  val messageText = chatMessagePlainText(displayableContent)
  val messageSpeech = speechState?.takeIf { it.messageId == messageId }
  val canListen = !live && messageId != null && normalizedRole == "assistant" && messageText.isNotBlank()
  val toggleListen: (() -> Unit)? =
    if (canListen) {
      { onToggleListen(checkNotNull(messageId), messageText) }
    } else {
      null
    }

  Row(
    modifier = Modifier.fillMaxWidth(),
    horizontalArrangement = if (isUser) Arrangement.End else Arrangement.Start,
  ) {
    ChatMessageActionHost(
      text = messageText,
      onReply = onReplyMessage,
      enabled = !live,
      listenActive = messageSpeech != null,
      onToggleListen = toggleListen,
      modifier = Modifier.fillMaxWidth(if (isUser) 0.84f else 0.94f),
    ) {
      Surface(
        modifier = Modifier.fillMaxWidth(),
        shape = RoundedCornerShape(7.dp),
        color = if (isUser) ClawTheme.colors.surfacePressed.copy(alpha = 0.86f) else ClawTheme.colors.surfaceRaised.copy(alpha = 0.84f),
        contentColor = ClawTheme.colors.text,
        border = BorderStroke(1.dp, if (live) ClawTheme.colors.borderStrong else ClawTheme.colors.border.copy(alpha = 0.45f)),
        tonalElevation = 1.dp,
        shadowElevation = 2.dp,
      ) {
        Column(modifier = Modifier.padding(horizontal = 11.dp, vertical = 8.dp), verticalArrangement = Arrangement.spacedBy(4.dp)) {
          Text(
            text =
              when {
                live -> nativeString("OpenClaw · Live")
                isUser -> nativeString("You")
                normalizedRole == "system" -> nativeString("System")
                else -> nativeString("OpenClaw")
              },
            style = ClawTheme.type.caption.copy(fontSize = 12.5.sp, lineHeight = 16.sp, fontWeight = FontWeight.SemiBold),
            color = ClawTheme.colors.text,
          )
          displayableContent.forEach { part ->
            when {
              part.type == "text" -> ChatText(text = part.text.orEmpty(), textColor = ClawTheme.colors.text, isStreaming = live)
              part.isAudioAttachment() -> VoiceNoteMessageRow(durationMs = part.durationMs)
              part.type == "image" ->
                ChatBase64Image(
                  base64 = checkNotNull(part.base64),
                  mimeType = part.mimeType,
                )
              part.type == "canvas" && normalizedRole == "assistant" ->
                ChatInlineWidget(
                  preview = checkNotNull(part.widget),
                  resolverReady = inlineWidgetResolverReady,
                  resolveResource = resolveInlineWidgetResource,
                )
              else -> Text(text = part.fileName ?: nativeString("Attachment"), style = ClawTheme.type.body, color = ClawTheme.colors.textMuted)
            }
          }
          if (messageId != null) {
            ChatMessageLinkPreview(messageId = messageId, role = normalizedRole, content = displayableContent)
          }
          messageSpeech?.let { speech ->
            FullChatSpeechIndicator(
              phase = speech.phase,
              onStop = { onToggleListen(checkNotNull(messageId), messageText) },
            )
          }
          timestampMs?.let {
            Text(
              text = formatChatTimestamp(it),
              style = ClawTheme.type.caption.copy(fontSize = 12.5.sp, lineHeight = 16.sp),
              color = ClawTheme.colors.textMuted,
              modifier = Modifier.align(Alignment.End),
            )
          }
        }
      }
    }
  }
}

@Composable
private fun FullChatSpeechIndicator(
  phase: MessageSpeechPhase,
  onStop: () -> Unit,
) {
  Surface(
    onClick = onStop,
    shape = RoundedCornerShape(999.dp),
    color = ClawTheme.colors.surfacePressed,
  ) {
    Row(
      modifier = Modifier.padding(horizontal = 9.dp, vertical = 5.dp),
      horizontalArrangement = Arrangement.spacedBy(6.dp),
      verticalAlignment = Alignment.CenterVertically,
    ) {
      Icon(
        imageVector =
          if (phase == MessageSpeechPhase.Preparing) {
            Icons.Default.HourglassEmpty
          } else {
            Icons.AutoMirrored.Filled.VolumeUp
          },
        contentDescription = null,
        modifier = Modifier.size(14.dp),
        tint = ClawTheme.colors.textMuted,
      )
      Text(
        text = if (phase == MessageSpeechPhase.Preparing) nativeString("Preparing audio…") else nativeString("Speaking…"),
        style = ClawTheme.type.caption,
        color = ClawTheme.colors.textMuted,
      )
    }
  }
}

@Composable
private fun ChatText(
  text: String,
  textColor: Color,
  isStreaming: Boolean,
) {
  ChatMarkdown(text = text, textColor = textColor, isStreaming = isStreaming)
}

@Composable
private fun ToolBubble(toolCalls: List<ChatPendingToolCall>) {
  ClawPanel {
    Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
      ClawStatusPill(text = nativeString("Tools running"), status = ClawStatus.Warning)
      toolCalls.take(4).forEach { tool ->
        ClawListItem(title = tool.name, subtitle = nativeString("OpenClaw is working"))
      }
      if (toolCalls.size > 4) {
        Text(text = nativeString("+\${toolCalls.size - 4} more", toolCalls.size - 4), style = ClawTheme.type.caption, color = ClawTheme.colors.textSubtle)
      }
    }
  }
}

@Composable
private fun ChatThinkingBubble() {
  ClawPanel {
    Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(10.dp)) {
      ClawStatusPill(text = nativeString("Thinking"), status = ClawStatus.Warning)
      Text(text = nativeString("OpenClaw is preparing a response."), style = ClawTheme.type.body, color = ClawTheme.colors.textMuted)
    }
  }
}

@Composable
private fun ChatNotice(
  title: String,
  body: String,
) {
  Surface(
    modifier = Modifier.fillMaxWidth(),
    shape = RoundedCornerShape(ClawTheme.radii.panel),
    color = ClawTheme.colors.surface,
    contentColor = ClawTheme.colors.text,
    border = BorderStroke(1.dp, ClawTheme.colors.border),
  ) {
    Row(
      modifier = Modifier.padding(horizontal = 11.dp, vertical = 8.dp),
      verticalAlignment = Alignment.CenterVertically,
      horizontalArrangement = Arrangement.spacedBy(9.dp),
    ) {
      Box(modifier = Modifier.size(6.dp).background(ClawTheme.colors.warning, CircleShape))
      Column(modifier = Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(2.dp)) {
        Text(text = title, style = ClawTheme.type.section, color = ClawTheme.colors.text)
        Text(text = body, style = ClawTheme.type.caption, color = ClawTheme.colors.textMuted, maxLines = 1, overflow = TextOverflow.Ellipsis)
      }
    }
  }
}

@Composable
private fun PlanChecklistPill(steps: List<ChatPlanStep>) {
  var expanded by rememberSaveable { mutableStateOf(false) }
  val currentStep =
    steps.firstOrNull { it.status == ChatPlanStepStatus.InProgress }
      ?: steps.lastOrNull { it.status == ChatPlanStepStatus.Completed }
      ?: steps.first()
  val completedCount = steps.count { it.status == ChatPlanStepStatus.Completed }

  Surface(
    onClick = { expanded = !expanded },
    modifier = Modifier.fillMaxWidth(),
    shape = RoundedCornerShape(ClawTheme.radii.pill),
    color = ClawTheme.colors.canvas,
    contentColor = ClawTheme.colors.text,
  ) {
    Column(
      modifier = Modifier.padding(horizontal = 12.dp, vertical = 9.dp),
      verticalArrangement = Arrangement.spacedBy(8.dp),
    ) {
      Row(
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(8.dp),
      ) {
        Box(modifier = Modifier.size(8.dp).background(ClawTheme.colors.primary, CircleShape))
        Text(
          text = currentStep.step,
          style = ClawTheme.type.caption,
          color = ClawTheme.colors.text,
          modifier = Modifier.weight(1f),
          maxLines = 1,
          overflow = TextOverflow.Ellipsis,
        )
        Text(
          text = "$completedCount/${steps.size}",
          style = ClawTheme.type.caption,
          color = ClawTheme.colors.textMuted,
          maxLines = 1,
        )
        Icon(
          imageVector = if (expanded) Icons.Default.KeyboardArrowUp else Icons.Default.KeyboardArrowDown,
          contentDescription = if (expanded) nativeString("Collapse plan checklist") else nativeString("Expand plan checklist"),
          modifier = Modifier.size(16.dp),
          tint = ClawTheme.colors.textSubtle,
        )
      }

      if (expanded) {
        HorizontalDivider(color = ClawTheme.colors.border)
        Column(verticalArrangement = Arrangement.spacedBy(7.dp)) {
          steps.forEach { step ->
            val textColor =
              when (step.status) {
                ChatPlanStepStatus.Completed -> ClawTheme.colors.textMuted
                ChatPlanStepStatus.InProgress -> ClawTheme.colors.primary
                ChatPlanStepStatus.Pending -> ClawTheme.colors.textSubtle
              }
            val textStyle =
              when (step.status) {
                ChatPlanStepStatus.InProgress -> ClawTheme.type.label
                else -> ClawTheme.type.caption
              }
            Row(
              verticalAlignment = Alignment.CenterVertically,
              horizontalArrangement = Arrangement.spacedBy(8.dp),
            ) {
              Box(modifier = Modifier.width(14.dp), contentAlignment = Alignment.Center) {
                when (step.status) {
                  ChatPlanStepStatus.Completed ->
                    Text(
                      text = "✓",
                      style = ClawTheme.type.caption.copy(fontWeight = FontWeight.Bold),
                      color = ClawTheme.colors.success,
                    )
                  ChatPlanStepStatus.InProgress ->
                    Box(modifier = Modifier.size(8.dp).background(ClawTheme.colors.primary, CircleShape))
                  ChatPlanStepStatus.Pending ->
                    Box(modifier = Modifier.size(8.dp).background(ClawTheme.colors.textSubtle, CircleShape))
                }
              }
              Text(
                text = step.step,
                style = textStyle,
                color = textColor,
                textDecoration = if (step.status == ChatPlanStepStatus.Completed) TextDecoration.LineThrough else null,
              )
            }
          }
        }
      }
    }
  }
}

@Composable
private fun ChatComposer(
  value: String,
  onValueChange: (String) -> Unit,
  attachments: List<PendingAttachment>,
  thinkingLevel: String,
  thinkingOptions: List<ChatThinkingLevelOption>,
  thinkingSupported: Boolean,
  contextUsage: ChatContextUsage,
  selectedModelLabel: String,
  modelPickerEnabled: Boolean,
  healthOk: Boolean,
  gatewayOffline: Boolean,
  offlineStatus: String,
  pendingRunCount: Int,
  shareStaging: Boolean,
  sendInFlight: Boolean,
  shareImportNotice: NativeText?,
  onDismissShareImportNotice: () -> Unit,
  commands: List<ChatCommandEntry>,
  onThinkingLevelChange: (String) -> Unit,
  onOpenModelPicker: () -> Unit,
  onPickImages: () -> Unit,
  onRemoveAttachment: (String) -> Unit,
  voiceNoteState: VoiceNoteRecorderState,
  voiceNoteElapsedMs: Long,
  voiceNoteLevel: Float,
  recordVoiceNoteEnabled: Boolean,
  onStartVoiceNote: () -> Unit,
  onCancelVoiceNote: () -> Unit,
  onFinishVoiceNote: () -> Unit,
  onVoice: () -> Unit,
  onFixConnection: () -> Unit,
  onCopyDiagnostics: () -> Unit,
  onAbort: () -> Unit,
  onSend: () -> Unit,
) {
  val slashCommands =
    remember(value, commands) {
      matchingSlashCommands(input = value, commands = commands)
    }
  var thinkingSelectorExpanded by rememberSaveable { mutableStateOf(false) }
  LaunchedEffect(thinkingSupported) {
    if (!thinkingSupported) thinkingSelectorExpanded = false
  }

  // Offline sends queue durably too (text, images, and voice notes), so the gate is identical
  // to the connected one; admission errors keep the draft when the durable queue refuses it.
  val sendEnabled =
    chatComposerSendEnabled(
      voiceNoteState = voiceNoteState,
      pendingRunCount = pendingRunCount,
      hasContent = value.trim().isNotEmpty() || attachments.isNotEmpty(),
      shareStaging = shareStaging,
      sendInFlight = sendInFlight,
    )

  Column(modifier = Modifier.fillMaxWidth().imePadding(), verticalArrangement = Arrangement.spacedBy(4.dp)) {
    if (shareImportNotice != null) {
      Row(
        modifier = Modifier.fillMaxWidth(),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(4.dp),
      ) {
        Text(
          text = shareImportNotice.resolveNativeTextResource(),
          style = ClawTheme.type.caption,
          color = ClawTheme.colors.warning,
          modifier = Modifier.weight(1f),
        )
        IconButton(onClick = onDismissShareImportNotice, modifier = Modifier.size(32.dp)) {
          Icon(Icons.Default.Close, contentDescription = nativeString("Dismiss shared-image warning"))
        }
      }
    }
    if (attachments.isNotEmpty()) {
      AttachmentStrip(attachments = attachments, onRemoveAttachment = onRemoveAttachment)
    }

    Row(
      modifier = Modifier.fillMaxWidth(),
      verticalAlignment = Alignment.CenterVertically,
      horizontalArrangement = Arrangement.spacedBy(6.dp),
    ) {
      ChatModelChip(
        label = selectedModelLabel,
        enabled = modelPickerEnabled,
        onClick = onOpenModelPicker,
        modifier = Modifier.weight(1f),
      )
      ChatContextMeter(
        thinkingLevel = thinkingLevel,
        thinkingSupported = thinkingSupported,
        expanded = thinkingSelectorExpanded,
        contextUsage = contextUsage,
        onClick = { thinkingSelectorExpanded = !thinkingSelectorExpanded },
      )
    }

    if (thinkingSelectorExpanded && thinkingSupported) {
      ChatThinkingLevelSelector(
        options = thinkingOptions,
        selectedId = thinkingLevel,
        onSelect = { selectedId ->
          onThinkingLevelChange(selectedId)
          thinkingSelectorExpanded = false
        },
      )
    }

    if (shouldShowSlashCommandMenu(value)) {
      SlashCommandPanel(
        commands = slashCommands,
        onSelect = { command -> onValueChange(slashCommandCompletion(command)) },
      )
    }

    Row(modifier = Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(6.dp)) {
      if (voiceNoteState is VoiceNoteRecorderState.Recording) {
        VoiceNoteRecordingControls(
          elapsedMs = voiceNoteElapsedMs,
          level = voiceNoteLevel,
          onCancel = onCancelVoiceNote,
          onDone = onFinishVoiceNote,
          modifier = Modifier.weight(1f),
        )
      } else if (voiceNoteState is VoiceNoteRecorderState.Preparing) {
        VoiceNotePreparing(modifier = Modifier.weight(1f))
      } else {
        ChatInputPill(
          value = value,
          onValueChange = onValueChange,
          onPickImages = onPickImages,
          onStartVoiceNote = onStartVoiceNote,
          recordVoiceNoteEnabled = recordVoiceNoteEnabled,
          onVoice = onVoice,
          sendEnabled = sendEnabled,
          onSend = onSend,
          modifier = Modifier.weight(1f),
        )
      }
      SendButton(
        enabled = sendEnabled,
        onClick = onSend,
      )
    }

    VoiceNoteRecorderError(voiceNoteState)

    if (!healthOk && gatewayOffline) {
      ChatOfflineNotice(
        status = offlineStatus,
        onFixConnection = onFixConnection,
        onCopyDiagnostics = onCopyDiagnostics,
      )
    }

    if (pendingRunCount > 0) {
      Row(modifier = Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.Center) {
        Surface(
          onClick = onAbort,
          modifier = Modifier.heightIn(min = ClawTheme.spacing.touchTarget),
          shape = RoundedCornerShape(ClawTheme.radii.pill),
          color = ClawTheme.colors.canvas,
          contentColor = ClawTheme.colors.text,
        ) {
          Row(
            modifier = Modifier.padding(horizontal = 14.dp, vertical = 8.dp),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(8.dp),
          ) {
            Box(modifier = Modifier.size(8.dp).background(ClawTheme.colors.danger, RoundedCornerShape(2.dp)))
            Text(text = nativeString("Stop"), style = ClawTheme.type.label)
          }
        }
      }
    }
  }
}

@Composable
private fun ChatThinkingLevelSelector(
  options: List<ChatThinkingLevelOption>,
  selectedId: String,
  onSelect: (String) -> Unit,
) {
  val rows = remember(options) { chatThinkingOptionRows(options) }
  val normalizedSelected = selectedId.trim().lowercase(Locale.US)
  val languageTag = currentAppLanguage().languageTag
  val selectedLabel =
    options
      .firstOrNull { it.id.trim().lowercase(Locale.US) == normalizedSelected }
      ?.let { option -> chatThinkingOptionLabel(option, languageTag) }
      .orEmpty()
  Column(
    modifier = Modifier.fillMaxWidth(),
    verticalArrangement = Arrangement.spacedBy(4.dp),
  ) {
    rows.forEach { row ->
      val labels = row.map { option -> chatThinkingOptionLabel(option, languageTag) }
      ClawSegmentedControl(
        options = labels,
        selected = selectedLabel,
        onSelect = { selected ->
          row.firstOrNull { option -> chatThinkingOptionLabel(option, languageTag) == selected }?.let { onSelect(it.id) }
        },
        modifier = Modifier.fillMaxWidth(),
      )
    }
  }
}

@Composable
private fun ChatModelChip(
  label: String,
  enabled: Boolean,
  onClick: () -> Unit,
  modifier: Modifier = Modifier,
) {
  Surface(
    onClick = onClick,
    enabled = enabled,
    modifier = modifier.heightIn(min = ClawTheme.spacing.touchTarget),
    shape = RoundedCornerShape(ClawTheme.radii.pill),
    color = ClawTheme.colors.canvas,
    contentColor = if (enabled) ClawTheme.colors.text else ClawTheme.colors.textMuted,
  ) {
    Row(
      modifier = Modifier.padding(horizontal = 8.dp, vertical = 8.dp),
      verticalAlignment = Alignment.CenterVertically,
      horizontalArrangement = Arrangement.spacedBy(6.dp),
    ) {
      Icon(imageVector = Icons.Default.ArrowDropDown, contentDescription = null, modifier = Modifier.size(13.dp), tint = ClawTheme.colors.textSubtle)
      Text(
        text = label,
        style = ClawTheme.type.caption.copy(fontSize = 12.5.sp, lineHeight = 16.sp),
        color = if (enabled) ClawTheme.colors.textMuted else ClawTheme.colors.textSubtle,
        maxLines = 1,
        overflow = TextOverflow.Ellipsis,
      )
    }
  }
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun ChatModelPickerSheet(
  sections: ChatModelPickerSections,
  favorites: Set<String>,
  onDismiss: () -> Unit,
  onSelect: (String?) -> Unit,
  onToggleFavorite: (String) -> Unit,
) {
  ModalBottomSheet(
    onDismissRequest = onDismiss,
    containerColor = ClawTheme.colors.surface,
    contentColor = ClawTheme.colors.text,
  ) {
    LazyColumn(
      modifier = Modifier.fillMaxWidth().heightIn(max = 560.dp),
      contentPadding = PaddingValues(bottom = 24.dp),
    ) {
      item {
        Surface(
          onClick = { onSelect(null) },
          modifier = Modifier.fillMaxWidth().heightIn(min = ClawTheme.spacing.touchTarget),
          color = Color.Transparent,
          contentColor = ClawTheme.colors.text,
        ) {
          Text(
            text = nativeString("Default"),
            modifier = Modifier.padding(horizontal = 20.dp, vertical = 14.dp),
            style = ClawTheme.type.body,
          )
        }
      }
      item {
        HorizontalDivider(color = ClawTheme.colors.border, thickness = 1.dp)
      }
      listOf(
        "Pinned" to sections.pinned,
        "Recent" to sections.recent,
        "Models" to sections.remaining,
      ).forEach { (title, models) ->
        if (models.isNotEmpty()) {
          item(key = "section-$title") {
            Text(
              text = title,
              modifier = Modifier.padding(start = 20.dp, top = 16.dp, end = 20.dp, bottom = 6.dp),
              style = ClawTheme.type.caption,
              color = ClawTheme.colors.textMuted,
            )
          }
          itemsIndexed(
            items = models,
            key = { _, model -> model.providerQualifiedRef() },
          ) { _, model ->
            val ref = model.providerQualifiedRef()
            ChatModelPickerRow(
              model = model,
              pinned = ref in favorites,
              onSelect = { onSelect(ref) },
              onToggleFavorite = { onToggleFavorite(ref) },
            )
          }
        }
      }
    }
  }
}

@Composable
private fun ChatModelPickerRow(
  model: GatewayModelSummary,
  pinned: Boolean,
  onSelect: () -> Unit,
  onToggleFavorite: () -> Unit,
) {
  Surface(
    onClick = onSelect,
    modifier = Modifier.fillMaxWidth().heightIn(min = 58.dp),
    color = Color.Transparent,
    contentColor = ClawTheme.colors.text,
  ) {
    Row(
      modifier = Modifier.padding(start = 20.dp, end = 8.dp, top = 6.dp, bottom = 6.dp),
      verticalAlignment = Alignment.CenterVertically,
      horizontalArrangement = Arrangement.spacedBy(10.dp),
    ) {
      Column(modifier = Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(2.dp)) {
        Text(text = model.name, style = ClawTheme.type.body, color = ClawTheme.colors.text, maxLines = 1, overflow = TextOverflow.Ellipsis)
        Text(text = model.provider, style = ClawTheme.type.caption, color = ClawTheme.colors.textMuted, maxLines = 1, overflow = TextOverflow.Ellipsis)
      }
      IconButton(onClick = onToggleFavorite) {
        Icon(
          imageVector = if (pinned) Icons.Default.Star else Icons.Default.StarBorder,
          contentDescription = if (pinned) nativeString("Unpin model") else nativeString("Pin model"),
          tint = if (pinned) ClawTheme.colors.primary else ClawTheme.colors.textMuted,
        )
      }
    }
  }
}

@Composable
private fun SlashCommandPanel(
  commands: List<ChatCommandEntry>,
  onSelect: (ChatCommandEntry) -> Unit,
) {
  ClawPanel(contentPadding = PaddingValues(horizontal = 0.dp, vertical = 0.dp)) {
    Column {
      if (commands.isEmpty()) {
        Text(
          text = nativeString("No commands found"),
          style = ClawTheme.type.caption,
          color = ClawTheme.colors.textMuted,
          modifier = Modifier.padding(horizontal = 11.dp, vertical = 9.dp),
        )
      } else {
        commands.forEachIndexed { index, command ->
          SlashCommandRow(command = command, onClick = { onSelect(command) })
          if (index != commands.lastIndex) {
            HorizontalDivider(color = ClawTheme.colors.border, thickness = 1.dp)
          }
        }
      }
    }
  }
}

@Composable
private fun SlashCommandRow(
  command: ChatCommandEntry,
  onClick: () -> Unit,
) {
  Surface(onClick = onClick, color = Color.Transparent, contentColor = ClawTheme.colors.text) {
    Row(
      modifier =
        Modifier
          .fillMaxWidth()
          .heightIn(min = 48.dp)
          .padding(horizontal = 10.dp, vertical = 6.dp),
      verticalAlignment = Alignment.CenterVertically,
      horizontalArrangement = Arrangement.spacedBy(10.dp),
    ) {
      Text(
        text = slashCommandText(command),
        style = ClawTheme.type.label,
        color = ClawTheme.colors.text,
        modifier = Modifier.width(82.dp),
        maxLines = 1,
        overflow = TextOverflow.Ellipsis,
      )
      Column(modifier = Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(1.dp)) {
        Text(
          text = command.description.ifBlank { command.category ?: nativeString("Command") },
          style = ClawTheme.type.caption,
          color = ClawTheme.colors.textMuted,
          maxLines = 1,
          overflow = TextOverflow.Ellipsis,
        )
      }
    }
  }
}

@Composable
private fun ChatOfflineNotice(
  status: String,
  onFixConnection: () -> Unit,
  onCopyDiagnostics: () -> Unit,
) {
  ClawPanel(contentPadding = PaddingValues(horizontal = 10.dp, vertical = 9.dp)) {
    Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
      Text(
        text = nativeString("Gateway offline"),
        style = ClawTheme.type.caption.copy(fontSize = 12.5.sp, lineHeight = 16.sp),
        color = ClawTheme.colors.warning,
      )
      Text(
        text = status,
        style = ClawTheme.type.caption.copy(fontSize = 12.5.sp, lineHeight = 16.sp),
        color = ClawTheme.colors.textMuted,
        maxLines = 2,
        overflow = TextOverflow.Ellipsis,
      )
      ChatOfflineActions(onFixConnection = onFixConnection, onCopyDiagnostics = onCopyDiagnostics)
    }
  }
}

@Composable
private fun ChatContextMeter(
  thinkingLevel: String,
  thinkingSupported: Boolean,
  expanded: Boolean,
  contextUsage: ChatContextUsage,
  onClick: () -> Unit,
) {
  val contextFraction = contextMeterWidth(contextUsage) ?: 0f
  Row(
    modifier = Modifier.width(178.dp),
    verticalAlignment = Alignment.CenterVertically,
    horizontalArrangement = Arrangement.spacedBy(7.dp),
  ) {
    Surface(
      onClick = onClick,
      enabled = thinkingSupported,
      modifier = Modifier.heightIn(min = ClawTheme.spacing.touchTarget),
      shape = RoundedCornerShape(ClawTheme.radii.pill),
      color = ClawTheme.colors.canvas,
      contentColor = ClawTheme.colors.text,
    ) {
      Row(
        modifier = Modifier.padding(horizontal = 8.dp, vertical = 8.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(6.dp),
      ) {
        if (thinkingSupported) {
          Icon(
            imageVector = if (expanded) Icons.Default.KeyboardArrowUp else Icons.Default.KeyboardArrowDown,
            contentDescription = if (expanded) nativeString("Close thinking level selector") else nativeString("Open thinking level selector"),
            modifier = Modifier.size(13.dp),
            tint = ClawTheme.colors.textSubtle,
          )
        }
        Text(
          text = contextMeterLabel(contextUsage, thinkingLevel, thinkingSupported),
          style = ClawTheme.type.caption.copy(fontSize = 12.5.sp, lineHeight = 16.sp),
          color = ClawTheme.colors.textMuted,
          maxLines = 1,
          overflow = TextOverflow.Ellipsis,
        )
      }
    }
    Box(
      modifier =
        Modifier
          .weight(1f)
          .height(3.dp)
          .background(ClawTheme.colors.surfacePressed, RoundedCornerShape(999.dp)),
    ) {
      Box(
        modifier =
          Modifier
            .fillMaxWidth(contextFraction)
            .height(3.dp)
            .background(ClawTheme.colors.primary, RoundedCornerShape(999.dp)),
      )
    }
  }
}

@Composable
private fun ChatInputPill(
  value: String,
  onValueChange: (String) -> Unit,
  onPickImages: () -> Unit,
  onStartVoiceNote: () -> Unit,
  recordVoiceNoteEnabled: Boolean,
  onVoice: () -> Unit,
  sendEnabled: Boolean,
  onSend: () -> Unit,
  modifier: Modifier = Modifier,
) {
  val hardwareEnterHandler = remember { PhysicalChatSendKeyHandler() }

  Surface(
    modifier = modifier.heightIn(min = ClawTheme.spacing.touchTarget),
    shape = RoundedCornerShape(ClawTheme.radii.control),
    color = ClawTheme.colors.surfaceRaised,
    contentColor = ClawTheme.colors.text,
    border = BorderStroke(1.dp, ClawTheme.colors.border),
  ) {
    Row(
      modifier = Modifier.padding(horizontal = 9.dp, vertical = 4.dp),
      verticalAlignment = Alignment.CenterVertically,
      horizontalArrangement = Arrangement.spacedBy(7.dp),
    ) {
      Surface(onClick = onPickImages, modifier = Modifier.size(ClawTheme.spacing.touchTarget), shape = CircleShape, color = ClawTheme.colors.surfaceRaised, contentColor = ClawTheme.colors.text) {
        Box(contentAlignment = Alignment.Center) {
          Icon(imageVector = Icons.Default.AttachFile, contentDescription = nativeString("Attach image"), modifier = Modifier.size(16.dp))
        }
      }
      VoiceNoteRecordButton(
        enabled = recordVoiceNoteEnabled,
        onClick = onStartVoiceNote,
      )
      Box(modifier = Modifier.weight(1f)) {
        ChatTextFieldValueAdapter(
          value = value,
          onValueChange = onValueChange,
          keyHandler = hardwareEnterHandler,
        ) { textFieldValue, updateTextFieldValue ->
          BasicTextField(
            value = textFieldValue,
            onValueChange = updateTextFieldValue,
            textStyle = ClawTheme.type.body.copy(color = ClawTheme.colors.text),
            cursorBrush = SolidColor(ClawTheme.colors.primary),
            minLines = 1,
            maxLines = 4,
            modifier =
              Modifier
                .fillMaxWidth()
                .onPreInterceptKeyBeforeSoftKeyboard { event ->
                  hardwareEnterHandler.handle(
                    event = event,
                    sendEnabled = sendEnabled,
                    textEmpty = textFieldValue.text.isEmpty(),
                    compositionActive = textFieldValue.composition != null,
                    onSend = onSend,
                  )
                },
            decorationBox = { innerTextField ->
              Box(modifier = Modifier.fillMaxWidth(), contentAlignment = Alignment.CenterStart) {
                if (value.isEmpty()) {
                  Text(text = nativeString("Message OpenClaw"), style = ClawTheme.type.body, color = ClawTheme.colors.textSubtle)
                }
                innerTextField()
              }
            },
          )
        }
      }
      Surface(
        onClick = onVoice,
        modifier = Modifier.size(ClawTheme.spacing.touchTarget),
        shape = CircleShape,
        color = ClawTheme.colors.surfaceRaised,
        contentColor = ClawTheme.colors.text,
      ) {
        Box(contentAlignment = Alignment.Center) {
          Icon(imageVector = Icons.Default.GraphicEq, contentDescription = nativeString("Open voice"), modifier = Modifier.size(18.dp))
        }
      }
    }
  }
}

@Composable
private fun AttachmentStrip(
  attachments: List<PendingAttachment>,
  onRemoveAttachment: (String) -> Unit,
) {
  Row(modifier = Modifier.fillMaxWidth().horizontalScroll(rememberScrollState()), horizontalArrangement = Arrangement.spacedBy(6.dp)) {
    attachments.forEach { attachment ->
      AttachmentChip(attachment = attachment, onRemove = { onRemoveAttachment(attachment.id) })
    }
  }
}

@Composable
private fun AttachmentChip(
  attachment: PendingAttachment,
  onRemove: () -> Unit,
) {
  Surface(
    shape = RoundedCornerShape(ClawTheme.radii.pill),
    color = ClawTheme.colors.surfaceRaised,
    contentColor = ClawTheme.colors.text,
    border = BorderStroke(1.dp, ClawTheme.colors.border),
  ) {
    Row(
      modifier = Modifier.padding(start = 9.dp, top = 5.dp, end = 5.dp, bottom = 5.dp),
      verticalAlignment = Alignment.CenterVertically,
      horizontalArrangement = Arrangement.spacedBy(6.dp),
    ) {
      if (attachment.mimeType.startsWith("audio/")) {
        Icon(imageVector = Icons.Default.Mic, contentDescription = null, modifier = Modifier.size(14.dp), tint = ClawTheme.colors.textMuted)
      }
      Text(
        text =
          attachment.durationMs?.let { duration -> nativeString("Voice note · \${formatVoiceNoteDuration(duration)}", formatVoiceNoteDuration(duration)) }
            ?: attachment.fileName,
        style = ClawTheme.type.caption,
        color = ClawTheme.colors.textMuted,
        maxLines = 1,
        overflow = TextOverflow.Ellipsis,
      )
      Surface(onClick = onRemove, modifier = Modifier.size(ClawTheme.spacing.touchTarget), shape = CircleShape, color = ClawTheme.colors.canvas, contentColor = ClawTheme.colors.text) {
        Box(contentAlignment = Alignment.Center) {
          Icon(imageVector = Icons.Default.Close, contentDescription = nativeString("Remove attachment"), modifier = Modifier.size(13.dp))
        }
      }
    }
  }
}

private fun currentSessionTitle(
  sessionKey: String,
  sessions: List<ChatSessionEntry>,
): String {
  val entry = sessions.firstOrNull { it.key == sessionKey }
  val name = entry?.displayName?.takeIf { it.isNotBlank() } ?: return nativeString("New chat")
  return friendlySessionName(name)
}

private fun chatSessionChipText(
  entry: ChatSessionEntry,
  mainSessionKey: String,
): String {
  val mainKey = mainSessionKey.trim().ifEmpty { "main" }
  if (entry.key == mainKey || (entry.key == "main" && mainKey == "main")) return nativeString("Main")
  val name = entry.displayName?.takeIf { it.isNotBlank() } ?: entry.key.takeIf { entry.updatedAtMs != null } ?: nativeString("Current")
  return friendlySessionName(name)
}

internal fun chatAgentChipText(agent: GatewayAgentSummary): String {
  val name = agent.name?.trim()?.takeIf { it.isNotEmpty() } ?: agent.id
  val emoji = agent.emoji?.trim()?.takeIf { it.isNotEmpty() } ?: return name
  return nativeString("\$emoji \$name", emoji, name)
}

internal fun selectedChatAgentId(
  mainSessionKey: String,
  gatewayDefaultAgentId: String?,
): String = resolveAgentIdFromMainSessionKey(mainSessionKey) ?: gatewayDefaultAgentId ?: "main"

private fun isActiveSessionChoice(
  choiceKey: String,
  sessionKey: String,
  mainSessionKey: String,
): Boolean {
  val mainKey = mainSessionKey.trim().ifEmpty { "main" }
  val current = sessionKey.trim().let { if (it == "main" && mainKey != "main") mainKey else it }
  return choiceKey == current
}

internal data class ChatContextUsage(
  val totalTokens: Long?,
  val totalTokensFresh: Boolean?,
  val contextTokens: Long?,
)

internal fun resolveChatContextUsage(
  sessionKey: String,
  mainSessionKey: String,
  sessions: List<ChatSessionEntry>,
): ChatContextUsage {
  val entry =
    sessions.firstOrNull {
      isActiveSessionChoice(
        choiceKey = it.key,
        sessionKey = sessionKey,
        mainSessionKey = mainSessionKey,
      )
    }
  return ChatContextUsage(
    totalTokens = entry?.totalTokens,
    totalTokensFresh = entry?.totalTokensFresh,
    contextTokens = entry?.contextTokens,
  )
}

@Composable
private fun SendButton(
  enabled: Boolean,
  onClick: () -> Unit,
) {
  Surface(
    onClick = onClick,
    enabled = enabled,
    modifier = Modifier.size(ClawTheme.spacing.touchTarget),
    shape = CircleShape,
    color = if (enabled) ClawTheme.colors.primary else ClawTheme.colors.surfacePressed,
    contentColor = if (enabled) ClawTheme.colors.primaryText else ClawTheme.colors.textSubtle,
    border = BorderStroke(1.dp, if (enabled) ClawTheme.colors.primary else ClawTheme.colors.border),
  ) {
    Box(contentAlignment = Alignment.Center) {
      Icon(imageVector = Icons.AutoMirrored.Filled.Send, contentDescription = nativeString("Send"), modifier = Modifier.size(18.dp))
    }
  }
}

internal fun userFacingChatError(
  error: String,
  gatewayConnected: Boolean,
): String {
  val lower = error.lowercase(Locale.US)
  return when {
    lower.contains("not connected") && gatewayConnected -> nativeString("Chat is still checking Gateway health.")
    lower.contains("not connected") -> nativeString("Gateway is offline. Fix the connection below or copy diagnostics.")
    lower.contains("unauthorized") || lower.contains("auth") -> nativeString("Gateway authentication needs attention.")
    else -> error
  }
}

internal fun contextMeterWidth(usage: ChatContextUsage): Float? {
  if (usage.totalTokensFresh == false) return null
  val total = usage.totalTokens?.takeIf { it >= 0L } ?: return null
  val context = usage.contextTokens?.takeIf { it > 0L } ?: return null
  return (total.toDouble() / context.toDouble()).coerceIn(0.0, 1.0).toFloat()
}

internal fun contextMeterLabel(
  usage: ChatContextUsage,
  thinkingLevel: String,
  thinkingSupported: Boolean = true,
): String {
  val contextLabel =
    contextMeterWidth(usage)?.let {
      nativeString("Context \${(it * 100).roundToInt()}%", (it * 100).roundToInt())
    } ?: nativeString("Context --")
  return if (thinkingSupported) nativeString("\$contextLabel · \${contextMeterThinkingLabel(thinkingLevel)}", contextLabel, contextMeterThinkingLabel(thinkingLevel)) else contextLabel
}

internal fun contextMeterThinkingLabel(value: String): String {
  val normalized = value.trim().lowercase(Locale.US).ifEmpty { "off" }
  return when (normalized) {
    "off" -> nativeString("Off")
    "low" -> nativeString("Low")
    "medium" -> nativeString("Medium")
    "high" -> nativeString("High")
    else -> normalized
  }
}

internal fun chatThinkingSupported(
  selection: ChatThinkingLevelSelection,
  fallbackSupported: Boolean,
): Boolean =
  if (selection.isGatewayProvided) {
    selection.options.any { it.id.trim().lowercase(Locale.US) != "off" }
  } else {
    fallbackSupported
  }

internal fun chatThinkingOptionRows(options: List<ChatThinkingLevelOption>): List<List<ChatThinkingLevelOption>> {
  if (options.isEmpty()) return emptyList()
  if (options.size <= 4) return listOf(options)
  return options.chunked((options.size + 1) / 2)
}

internal fun chatThinkingOptionLabel(
  option: ChatThinkingLevelOption,
  languageTag: String? = null,
): String {
  val id = option.id.trim()
  val rawLabel = option.label.trim().ifEmpty { id }
  val localizedLabel =
    if (rawLabel.equals(id, ignoreCase = true)) {
      when (id.lowercase(Locale.US)) {
        "off" -> nativeString("Off")
        "minimal" -> nativeString("Minimal")
        "low" -> nativeString("Low")
        "medium" -> nativeString("Medium")
        "high" -> nativeString("High")
        "xhigh" -> nativeString("Xhigh")
        "adaptive" -> nativeString("Adaptive")
        "max" -> nativeString("Max")
        else -> rawLabel
      }
    } else {
      rawLabel
    }
  return localizedUppercase(localizedLabel.take(1), languageTag) + localizedLabel.drop(1)
}

private fun formatChatTimestamp(timestampMs: Long): String = DateFormat.getTimeInstance(DateFormat.SHORT, Locale.getDefault()).format(Date(timestampMs))
