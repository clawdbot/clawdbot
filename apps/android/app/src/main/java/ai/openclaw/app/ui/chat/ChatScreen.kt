package ai.openclaw.app.ui.chat

import ai.openclaw.app.ChatDraft
import ai.openclaw.app.ChatDraftPlacement
import ai.openclaw.app.GatewayAgentSummary
import ai.openclaw.app.GatewayModelSummary
import ai.openclaw.app.GatewayModelUnavailableReason
import ai.openclaw.app.MainViewModel
import ai.openclaw.app.PendingAssistantAutoSend
import ai.openclaw.app.R
import ai.openclaw.app.SHARED_AUDIO_DOCUMENT_MIME_TYPES
import ai.openclaw.app.SHARED_VIDEO_MIME_TYPES
import ai.openclaw.app.SessionCatalog
import ai.openclaw.app.chat.ChatCommandEntry
import ai.openclaw.app.chat.ChatComposerOwner
import ai.openclaw.app.chat.ChatController
import ai.openclaw.app.chat.ChatDiffStat
import ai.openclaw.app.chat.ChatFastMode
import ai.openclaw.app.chat.ChatMessage
import ai.openclaw.app.chat.ChatMessageContent
import ai.openclaw.app.chat.ChatMessageCost
import ai.openclaw.app.chat.ChatMessageUsage
import ai.openclaw.app.chat.ChatOutboxItem
import ai.openclaw.app.chat.ChatOutboxStatus
import ai.openclaw.app.chat.ChatPendingToolCall
import ai.openclaw.app.chat.ChatPermissionMode
import ai.openclaw.app.chat.ChatPlanStepStatus
import ai.openclaw.app.chat.ChatProgressCard
import ai.openclaw.app.chat.ChatQuestionDraft
import ai.openclaw.app.chat.ChatQuestionPrompt
import ai.openclaw.app.chat.ChatSessionEntry
import ai.openclaw.app.chat.ChatSubagentActivity
import ai.openclaw.app.chat.ChatThinkingLevelOption
import ai.openclaw.app.chat.ChatThinkingLevelSelection
import ai.openclaw.app.chat.ChatTranscriptAnchorState
import ai.openclaw.app.chat.ChatWidgetResource
import ai.openclaw.app.chat.MessageSpeechPhase
import ai.openclaw.app.chat.MessageSpeechState
import ai.openclaw.app.chat.SessionBranch
import ai.openclaw.app.chat.VoiceNoteRecorderState
import ai.openclaw.app.chat.chatOutboxQueueFailureText
import ai.openclaw.app.chat.isTranscriptOnlyOpenClawAssistant
import ai.openclaw.app.chat.questionsForSession
import ai.openclaw.app.chat.resolveChatComposerOwner
import ai.openclaw.app.chat.resolveGatewayDefaultAgentId
import ai.openclaw.app.currentAppLanguage
import ai.openclaw.app.gateway.GatewayLoadedImage
import ai.openclaw.app.gateway.GatewayLoadedMedia
import ai.openclaw.app.gateway.GatewayMediaKind
import ai.openclaw.app.i18n.NativeText
import ai.openclaw.app.i18n.joinedNativeText
import ai.openclaw.app.i18n.nativeString
import ai.openclaw.app.i18n.nativeText
import ai.openclaw.app.i18n.resolveNativeTextResource
import ai.openclaw.app.i18n.verbatimText
import ai.openclaw.app.operatorScopesAllowAdmin
import ai.openclaw.app.operatorScopesAllowWrite
import ai.openclaw.app.resolveAgentIdFromMainSessionKey
import ai.openclaw.app.ui.copyGatewayDiagnosticsReport
import ai.openclaw.app.ui.design.ClawAgentAvatar
import ai.openclaw.app.ui.design.ClawListItem
import ai.openclaw.app.ui.design.ClawLoadingState
import ai.openclaw.app.ui.design.ClawPanel
import ai.openclaw.app.ui.design.ClawPrimaryButton
import ai.openclaw.app.ui.design.ClawSecondaryButton
import ai.openclaw.app.ui.design.ClawStatus
import ai.openclaw.app.ui.design.ClawStatusPill
import ai.openclaw.app.ui.design.ClawTheme
import ai.openclaw.app.ui.design.ProviderBrandIcon
import ai.openclaw.app.ui.design.agentAvatarSource
import ai.openclaw.app.ui.design.sessionColor
import ai.openclaw.app.ui.gatewayDiagnosticsEndpoint
import ai.openclaw.app.ui.gatewayStatusForDisplay
import ai.openclaw.app.ui.localizedUppercase
import ai.openclaw.app.ui.relativeSessionTime
import ai.openclaw.app.ui.rememberSystemAnimationsEnabled
import ai.openclaw.app.ui.sessionPresentationTitle
import ai.openclaw.app.ui.sidebarCatalogHosts
import android.os.SystemClock
import androidx.activity.compose.BackHandler
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.animation.AnimatedContent
import androidx.compose.animation.animateContentSize
import androidx.compose.animation.core.LinearEasing
import androidx.compose.animation.core.RepeatMode
import androidx.compose.animation.core.animateFloat
import androidx.compose.animation.core.infiniteRepeatable
import androidx.compose.animation.core.rememberInfiniteTransition
import androidx.compose.animation.core.tween
import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.Canvas
import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.FlowRow
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
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.itemsIndexed
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.KeyboardArrowRight
import androidx.compose.material.icons.automirrored.filled.VolumeUp
import androidx.compose.material.icons.filled.Add
import androidx.compose.material.icons.filled.AdminPanelSettings
import androidx.compose.material.icons.filled.ArrowDownward
import androidx.compose.material.icons.filled.ArrowDropDown
import androidx.compose.material.icons.filled.ArrowUpward
import androidx.compose.material.icons.filled.AttachFile
import androidx.compose.material.icons.filled.Bolt
import androidx.compose.material.icons.filled.Check
import androidx.compose.material.icons.filled.Close
import androidx.compose.material.icons.filled.Cloud
import androidx.compose.material.icons.filled.ContentCopy
import androidx.compose.material.icons.filled.Dashboard
import androidx.compose.material.icons.filled.GppMaybe
import androidx.compose.material.icons.filled.HourglassEmpty
import androidx.compose.material.icons.filled.KeyboardArrowUp
import androidx.compose.material.icons.filled.Lock
import androidx.compose.material.icons.filled.Menu
import androidx.compose.material.icons.filled.Mic
import androidx.compose.material.icons.filled.MoreVert
import androidx.compose.material.icons.filled.Photo
import androidx.compose.material.icons.filled.Policy
import androidx.compose.material.icons.filled.Refresh
import androidx.compose.material.icons.filled.Security
import androidx.compose.material.icons.filled.Shield
import androidx.compose.material.icons.filled.Star
import androidx.compose.material.icons.filled.StarBorder
import androidx.compose.material.icons.filled.Stop
import androidx.compose.material.icons.filled.Videocam
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.LinearProgressIndicator
import androidx.compose.material3.LocalContentColor
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.ModalBottomSheetProperties
import androidx.compose.material3.Slider
import androidx.compose.material3.SliderState
import androidx.compose.material3.Surface
import androidx.compose.material3.Switch
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.rememberModalBottomSheetState
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
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
import androidx.compose.ui.draw.clip
import androidx.compose.ui.geometry.CornerRadius
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.graphics.StrokeCap
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.graphics.drawscope.rotate
import androidx.compose.ui.graphics.drawscope.translate
import androidx.compose.ui.input.key.onPreInterceptKeyBeforeSoftKeyboard
import androidx.compose.ui.input.nestedscroll.nestedScroll
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.role
import androidx.compose.ui.semantics.selected
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.semantics.stateDescription
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.LayoutDirection
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.compose.LocalLifecycleOwner
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import java.text.DateFormat
import java.time.Instant
import java.util.Date
import java.util.Locale
import java.util.UUID
import kotlin.math.abs
import kotlin.math.roundToInt
import kotlin.math.sin

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

internal enum class ChatComposerPrimaryAction {
  StartTalk,
  None,
  Stop,
  Send,
}

/** New drafts can steer an active run; Talk retains its independent voice controls. */
internal fun resolveChatComposerPrimaryAction(
  talkActive: Boolean,
  runActive: Boolean,
  hasContent: Boolean,
): ChatComposerPrimaryAction =
  when {
    hasContent && !talkActive -> ChatComposerPrimaryAction.Send
    runActive -> ChatComposerPrimaryAction.Stop
    talkActive -> ChatComposerPrimaryAction.None
    else -> ChatComposerPrimaryAction.StartTalk
  }

internal object ChatUserMessageDisclosurePolicy {
  const val collapsedLineLimit = 12
  const val collapsedCharacterLimit = 700

  fun collapsedPreview(text: String): String? {
    var end = minOf(text.length, collapsedCharacterLimit)
    if (end in 1 until text.length && text[end - 1].isHighSurrogate() && text[end].isLowSurrogate()) {
      end -= 1
    }
    var lineCount = 1
    for (index in 0 until end) {
      if (text[index] != '\n') continue
      if (lineCount == collapsedLineLimit) {
        end = index
        break
      }
      lineCount += 1
    }
    if (end == text.length) return null
    return text.substring(0, end).trimEnd() + "…"
  }
}

internal fun shouldUseUserMessageDisclosure(
  isUser: Boolean,
  content: List<ChatMessageContent>,
): Boolean =
  isUser &&
    content.isNotEmpty() &&
    content.all { it.type == "text" } &&
    ChatUserMessageDisclosurePolicy.collapsedPreview(chatMessagePlainText(content)) != null

/** Full chat surface that wires MainViewModel state to messages, attachments, voice, and composer actions. */
@Composable
fun ChatScreen(
  viewModel: MainViewModel,
  talkActive: Boolean,
  showSidebarButton: Boolean,
  onOpenSidebar: () -> Unit,
  onToggleTalk: () -> Unit,
  onOpenDashboard: (String) -> Unit,
  onOpenGatewaySettings: () -> Unit,
  onOpenProvidersModels: () -> Unit = onOpenGatewaySettings,
) {
  val messages by viewModel.chatMessages.collectAsState()
  val transcriptAnchor by viewModel.chatTranscriptAnchor.collectAsState()
  val historyLoading by viewModel.chatHistoryLoading.collectAsState()
  val sessionCreating by viewModel.chatSessionCreating.collectAsState()
  val errorText by viewModel.chatError.collectAsState()
  val pendingRunCount by viewModel.pendingRunCount.collectAsState()
  val selectedActiveRun by viewModel.chatSelectedActiveRunPresentation.collectAsState()
  val healthOk by viewModel.chatHealthOk.collectAsState()
  val gatewayConnectionDisplay by viewModel.gatewayConnectionDisplay.collectAsState()
  val operatorScopes by viewModel.operatorScopes.collectAsState()
  val permissionSettingsAvailable by viewModel.chatPermissionSettingsAvailable.collectAsState()
  val canWriteSessionSettings = operatorScopesAllowWrite(operatorScopes)
  val canAdminSessionSettings = operatorScopesAllowAdmin(operatorScopes)
  val activeGatewayStableId by viewModel.activeGatewayStableId.collectAsState()
  val sessionKey by viewModel.chatSessionKey.collectAsState()
  val selectionGeneration by viewModel.chatSelectionGeneration.collectAsState()
  val gatewayCatalogRevision by viewModel.gatewayCatalogRevision.collectAsState()
  val sessionOwnerAgentId by viewModel.chatSessionOwnerAgentId.collectAsState()
  val mainSessionKey by viewModel.mainSessionKey.collectAsState()
  val gatewayDefaultAgentId by viewModel.gatewayDefaultAgentId.collectAsState()
  val gatewayComposerDefaultAgentOwner by viewModel.gatewayComposerDefaultAgentOwner.collectAsState()
  val gatewayAgents by viewModel.gatewayAgents.collectAsState()
  val thinkingLevel by viewModel.chatThinkingLevel.collectAsState()
  val thinkingLevelSelection by viewModel.chatThinkingLevelSelection.collectAsState()
  val streamingAssistantText by viewModel.chatStreamingAssistantText.collectAsState()
  val pendingToolCalls by viewModel.chatPendingToolCalls.collectAsState()
  val subagentActivities by viewModel.chatSubagentActivities.collectAsState()
  val questions by viewModel.chatQuestions.collectAsState()
  val progressCard by viewModel.chatProgressCard.collectAsState()
  val sessions by viewModel.chatSessions.collectAsState()
  val swarmGroups by viewModel.chatSwarmGroups.collectAsState()
  val sessionBranches by viewModel.chatSessionBranches.collectAsState()
  val sessionBranchesLoading by viewModel.chatSessionBranchesLoading.collectAsState()
  val sessionBranchSwitching by viewModel.chatSessionBranchSwitching.collectAsState()
  val chatCommands by viewModel.chatCommands.collectAsState()
  val chatDraft by viewModel.chatDraft.collectAsState()
  val chatShareDrafts by viewModel.chatShareDrafts.collectAsState()
  val pendingAssistantAutoSend by viewModel.pendingAssistantAutoSend.collectAsState()
  val assistantAutoSendInFlight by viewModel.assistantAutoSendInFlight.collectAsState()
  val remoteAddress by viewModel.remoteAddress.collectAsState()
  val outboxItems by viewModel.chatOutboxItems.collectAsState()
  val outboxPresentationRestored by viewModel.chatOutboxPresentationRestored.collectAsState()
  val messageSpeechState by viewModel.chatMessageSpeech.collectAsState()
  val manualHost by viewModel.manualHost.collectAsState()
  val manualPort by viewModel.manualPort.collectAsState()
  val manualTls by viewModel.manualTls.collectAsState()
  val modelCatalog by viewModel.chatModelCatalog.collectAsState()
  val modelFavorites by viewModel.modelFavorites.collectAsState()
  val modelRecents by viewModel.modelRecents.collectAsState()
  val selectedModelRef by viewModel.chatSelectedModelRef.collectAsState()
  val pendingSessionSettingsKeys by viewModel.chatPendingSessionSettingsKeys.collectAsState()
  val micEnabled by viewModel.micEnabled.collectAsState()
  val micIsListening by viewModel.micIsListening.collectAsState()
  val micCooldown by viewModel.micCooldown.collectAsState()
  val talkModeEnabled by viewModel.talkModeEnabled.collectAsState()
  val talkModeListening by viewModel.talkModeListening.collectAsState()
  val inlineMediaPlaybackBlocked = messageSpeechState?.isActive == true || talkModeEnabled || talkModeListening
  val thinkingSupported =
    chatThinkingSupported(
      selection = thinkingLevelSelection,
      fallbackSupported = thinkingSupportedForSelection(selectedModelRef, modelCatalog),
    )
  val contextUsage = resolveChatContextUsage(sessionKey = sessionKey, mainSessionKey = mainSessionKey, sessions = sessions)
  val activeSession =
    sessions.firstOrNull {
      isActiveSessionChoice(
        choiceKey = it.key,
        sessionKey = sessionKey,
        mainSessionKey = mainSessionKey,
      )
    }
  val fastMode = (activeSession?.effectiveFastMode ?: activeSession?.fastMode ?: ChatFastMode.Off).isEnabled
  val modelSelectionLocked = activeSession?.modelSelectionLocked == true
  val permissionModePending = activeSession?.permissionModePending == true
  val sessionSettingsPending = sessionKey in pendingSessionSettingsKeys
  val fastModeProviderSupported =
    fastModeProviderSupportedForSelection(
      selectedModelRef = selectedModelRef,
      sessionModelProvider = activeSession?.modelProvider,
      catalog = modelCatalog,
    )
  val fastModeSupported =
    fastModeSupportedForSelection(
      providerSupported = fastModeProviderSupported,
      hasConfiguredFastModeOverride = activeSession?.fastMode != null,
    )
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
  val currentSessionOutboxItems =
    outboxItemsForSession(
      items = outboxItems,
      sessionKey = sessionKey,
      mainSessionKey = mainSessionKey,
      ownerAgentId = composerOwner.agentId,
      messages = messages,
    )
  val activeAgentId = sessionAgentId
  val activeAgent = gatewayAgents.firstOrNull { it.id == activeAgentId }
  val headerCatalogState by viewModel.sessionCatalogState.collectAsState()
  val activeSessionTitle = chatHeaderSessionTitle(activeSession) { nativeString("New chat") }
  val activeProjectLabel = chatHeaderProjectLabel(sessionKey = sessionKey, catalogs = headerCatalogState.catalogs)
  val workspaceGit = activeAgent?.workspaceGit == true
  val context = LocalContext.current
  val lifecycleOwner = LocalLifecycleOwner.current
  val lifecycleState by lifecycleOwner.lifecycle.currentStateFlow.collectAsState()
  val resolver = context.applicationContext.contentResolver
  val scope = rememberCoroutineScope()
  val composerState = remember(viewModel) { viewModel.chatComposerState }
  val inputDrafts = composerState.textDrafts
  val imagePickerOwnerCheckpoint =
    rememberSaveable(saver = ChatComposerMediaCheckpoint.Saver) { ChatComposerMediaCheckpoint() }
  val filePickerOwnerCheckpoint =
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
  var showBranchSwitcher by rememberSaveable { mutableStateOf(false) }
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
    if (modelSelectionLocked) {
      if (activeSession.agentRuntimeId == "codex") nativeString("Native Codex model") else nativeString("Locked session model")
    } else {
      selectedModelRef?.let { selected ->
        modelCatalog.firstOrNull { it.providerQualifiedRef() == selected }?.name?.takeIf { it.isNotBlank() }
          ?: selected.substringAfterLast('/')
      } ?: nativeString("Model")
    }
  val modelUnavailableReason =
    selectedChatModelSendBlockingReason(
      gatewayReady = healthOk,
      selectedModelRef = selectedModelRef,
      catalog = modelCatalog,
    )
  val modelUnavailableMessage = chatModelUnavailableText(modelUnavailableReason)
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
  val dictationController = rememberChatDictationController(viewModel)
  val dictationState by dictationController.state.collectAsState()
  val dictationActive =
    dictationState is ChatDictationState.Starting || dictationState is ChatDictationState.Listening
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
  val pickMediaOrDocument =
    rememberLauncherForActivityResult(ActivityResultContracts.OpenDocument()) { uri ->
      val lease = filePickerOwnerCheckpoint.consume() ?: return@rememberLauncherForActivityResult
      if (uri == null) {
        composerState.cancelMediaAcquisition(lease.authorizationId)
        return@rememberLauncherForActivityResult
      }
      val importOwner =
        if (shouldMigrateComposerDraft(lease.owner, currentPickerOwner, currentPickerMainSessionKey)) {
          currentPickerOwner
        } else {
          lease.owner
        }
      viewModel.importChatComposerAttachments(
        owner = importOwner,
        mediaAuthorizationId = lease.authorizationId,
        mainSessionKey = currentPickerMainSessionKey,
        expectedCount = 1,
      ) {
        listOfNotNull(
          try {
            loadPickedMediaOrDocumentAttachment(resolver, uri)
          } catch (err: CancellationException) {
            throw err
          } catch (_: Throwable) {
            null
          },
        )
      }
    }

  LaunchedEffect(composerOwner) {
    dictationController.cancel()
  }

  LaunchedEffect(Unit) {
    viewModel.loadCurrentChat()
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
      ChatComposerAttachmentNotice.Attachment -> {
        NativeText.Resource(source = "Could not stage an attachment for sending.", formatArgs = emptyList())
      }

      ChatComposerAttachmentNotice.Image -> {
        nativeText("Some shared images were omitted or could not be added.")
      }

      null -> {
        when {
          sendMessageTooLong -> {
            joinedNativeText(
              separator = " ",
              parts =
                listOf(
                  chatOutboxQueueFailureText(),
                  verbatimText("${input.length}/$CHAT_COMPOSER_MAX_SEND_CHARS"),
                ),
            )
          }

          sendCheckpointFull -> {
            chatOutboxQueueFailureText()
          }

          else -> {
            null
          }
        }
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
    val merged =
      mergeChatDraft(draft = claimed, currentInput = input, currentOwner = composerOwner) ?: return@LaunchedEffect
    inputDrafts[composerOwner] = merged
    // Rewind/fork replace the composer wholesale; an attachment staged during the
    // in-flight round-trip is accepted collateral rather than a draft revision field.
    claimed.attachments?.let { composerState.replaceAttachments(composerOwner, it) }
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
          stageChatShareDraft(share) { attachment ->
            loadSharedAttachment(resolver, attachment)
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
      composerState.reportAttachmentOmission(
        ownerSnapshot,
        staged.failedAttachmentCount + staged.droppedAttachmentCount + admissionOmissions,
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
    !sessionCreating && !modelSelectionLocked &&
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
        .padding(vertical = 10.dp),
    verticalArrangement = Arrangement.spacedBy(8.dp),
  ) {
    ChatMessageList(
      sessionKey = sessionKey,
      fullMessageOwner = composerOwner,
      selectionGeneration = selectionGeneration,
      gatewayCatalogRevision = gatewayCatalogRevision,
      prepareFullMessageRead = { message -> viewModel.prepareFullMessageRead(composerOwner, selectionGeneration, gatewayCatalogRevision, message) },
      session = activeSession,
      messages = messages,
      transcriptAnchor = transcriptAnchor,
      historyLoading = historyLoading,
      activeRunCount = selectedActiveRun.count,
      activeRunId = selectedActiveRun.runId,
      activeRunClockKey = selectedActiveRun.clockKey,
      activeRunOutputTokens = selectedActiveRun.outputTokens,
      pendingToolCalls = pendingToolCalls,
      subagentActivities = subagentActivities,
      questions = questionsForSession(questions, sessionKey, mainSessionKey, activeAgentId),
      streamingAssistantText = streamingAssistantText,
      healthOk = healthOk,
      gatewayOffline = gatewayOffline,
      outboxItems = currentSessionOutboxItems,
      recoveryOutboxItems =
        outboxItemsForRecovery(
          items = outboxItems,
        ),
      onRetryOutbox = viewModel::retryChatOutboxCommand,
      onDeleteOutbox = viewModel::deleteChatOutboxCommand,
      onResolveQuestion = viewModel::resolveChatQuestion,
      onQuestionDraftChanged = viewModel::updateChatQuestionDraft,
      onSkipQuestion = viewModel::skipChatQuestion,
      onStarterPrompt = { prompt -> inputDrafts[composerOwner] = prompt },
      onReplyMessage = { value -> viewModel.setChatReplyDraft(value, composerOwner) },
      sessionActionsEnabled =
        pendingRunCount == 0 &&
          !sessionBranchSwitching &&
          outboxPresentationRestored &&
          currentSessionOutboxItems.none { it.status != ChatOutboxStatus.Failed },
      onRewindMessage = { entryId ->
        val expectedInput = inputDrafts[composerOwner].orEmpty()
        scope.launch {
          val result = viewModel.rewindChatAtEntry(entryId) ?: return@launch
          viewModel.setChatDraft(
            ChatDraft(
              text = result.editorText.orEmpty(),
              placement = ChatDraftPlacement.Replace,
              owner = composerOwner,
              expectedExistingText = expectedInput,
              acceptsEmptyText = true,
              attachments = result.editorAttachments.toPendingAttachments(),
            ),
          )
        }
      },
      onForkMessage = { entryId ->
        scope.launch {
          val result = viewModel.forkChatAtEntry(entryId) ?: return@launch
          val newOwner = composerOwner.copy(sessionKey = result.sessionKey)
          val expectedInput = inputDrafts[newOwner].orEmpty()
          viewModel.switchChatSession(result.sessionKey, composerOwner.agentId)
          viewModel.setChatDraft(
            ChatDraft(
              text = result.editorText.orEmpty(),
              placement = ChatDraftPlacement.Replace,
              owner = newOwner,
              expectedExistingText = expectedInput,
              acceptsEmptyText = true,
              attachments = result.editorAttachments.toPendingAttachments(),
            ),
          )
        }
      },
      speechState = messageSpeechState,
      onToggleListen = viewModel::toggleChatMessageSpeech,
      inlineMediaPlaybackBlocked = inlineMediaPlaybackBlocked,
      resolveInlineWidgetResource = viewModel::resolveInlineWidgetResource,
      loadImageArtifact = viewModel::loadChatImageArtifact,
      loadMediaArtifact = viewModel::loadChatMediaArtifact,
      modifier = Modifier.weight(1f),
      header = { onJumpToLatest ->
        ChatHeader(
          activeAgent = activeAgent,
          projectLabel = activeProjectLabel,
          sessionTitle = activeSessionTitle,
          sessionColor = activeSession?.color,
          showSidebarButton = showSidebarButton,
          onOpenSidebar = onOpenSidebar,
          onJumpToLatest = onJumpToLatest,
          healthOk = healthOk,
          pendingRunCount = pendingRunCount,
          sessionCreating = sessionCreating,
          newChatEnabled = newChatEnabled,
          workspaceGit = workspaceGit,
          branches = sessionBranches,
          branchesLoading = sessionBranchesLoading,
          branchSwitchEnabled =
            outboxPresentationRestored && pendingRunCount == 0 && !sessionBranchSwitching && currentSessionOutboxItems.isEmpty(),
          onNewChatInWorktree = { startNewChat(true) },
          onRefresh = {
            viewModel.refreshChat()
            viewModel.refreshChatSessions(limit = 100)
          },
          onOpenDashboard = { onOpenDashboard(sessionKey) },
          onOpenBackgroundTasks = { showBackgroundTasks = true },
          onOpenBranchSwitcher = {
            showBranchSwitcher = true
            scope.launch { viewModel.refreshChatSessionBranches() }
          },
        )

        errorText?.takeIf { it.isNotBlank() }?.let { error ->
          ChatNotice(
            title = nativeString("Chat needs attention"),
            body = userFacingChatError(error = error, gatewayConnected = gatewayConnectionDisplay.isConnected),
          )
        }
      },
    )

    ChatSwarmProgress(groups = swarmGroups)

    ChatComposer(
      progressCard = progressCard,
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
      thinkingLevelEnabled = canAdminSessionSettings,
      fastMode = fastMode,
      fastModeEnabled =
        chatFastModeControlEnabled(
          supported = fastModeSupported,
          adminAuthorized = canAdminSessionSettings,
          connected = gatewayConnectionDisplay.isConnected,
          gatewayAvailable = healthOk,
          loading = historyLoading || sessionCreating,
          sending = sendInFlight,
          activeRun = pendingRunCount > 0,
          streaming = streamingAssistantText != null,
          settingsMutationPending = sessionSettingsPending,
        ),
      contextUsage = contextUsage,
      selectedModelLabel = selectedModelLabel,
      modelPickerEnabled = gatewayConnectionDisplay.isConnected && canWriteSessionSettings,
      healthOk = healthOk,
      gatewayOffline = gatewayOffline,
      offlineStatus = offlineStatus,
      pendingRunCount = pendingRunCount,
      shareStaging = shareStaging,
      sendInFlight = sendInFlight,
      shareImportNotice = shareImportNotice,
      modelUnavailableMessage = modelUnavailableMessage,
      onDismissShareImportNotice = {
        sendMessageTooLong = false
        sendCheckpointFull = false
        composerState.clearAttachmentOmission(composerOwner)
      },
      commands = chatCommands,
      onThinkingLevelChange = viewModel::setChatThinkingLevel,
      onFastModeChange = { enabled ->
        viewModel.setChatSessionFastMode(
          sessionKey = sessionKey,
          enabled = enabled,
          clearOverride = !fastModeProviderSupported,
        )
      },
      onOpenModelPicker = { showModelPicker = true },
      onPickImages = {
        if (!viewModel.isCurrentChatComposerOwner(composerOwner)) return@ChatComposer
        val authorizationId = composerState.beginMediaAcquisition(composerOwner) ?: return@ChatComposer
        imagePickerOwnerCheckpoint.begin(composerOwner, authorizationId)
        pickImages.launch("image/*")
      },
      onPickAudioOrDocument = {
        if (!viewModel.isCurrentChatComposerOwner(composerOwner)) return@ChatComposer
        val authorizationId = composerState.beginMediaAcquisition(composerOwner) ?: return@ChatComposer
        filePickerOwnerCheckpoint.begin(composerOwner, authorizationId)
        pickMediaOrDocument.launch(SHARED_AUDIO_DOCUMENT_MIME_TYPES)
      },
      onPickVideo = {
        if (!viewModel.isCurrentChatComposerOwner(composerOwner)) return@ChatComposer
        val authorizationId = composerState.beginMediaAcquisition(composerOwner) ?: return@ChatComposer
        filePickerOwnerCheckpoint.begin(composerOwner, authorizationId)
        pickMediaOrDocument.launch(SHARED_VIDEO_MIME_TYPES)
      },
      onRemoveAttachment = { id -> composerState.removeAttachments(composerOwner, setOf(id)) },
      voiceNoteState = voiceNoteState,
      voiceNoteElapsedMs = voiceNoteElapsedMs,
      voiceNoteLevel = voiceNoteLevel,
      recordVoiceNoteEnabled =
        !talkActive &&
          !composerOwner.gatewayStableId.isNullOrBlank() &&
          pendingRunCount == 0 &&
          !micCaptureActive &&
          !dictationActive &&
          !sendInFlight,
      onStartVoiceNote = {
        scope.launch {
          val ownerSnapshot = composerOwner
          val mediaAuthorizationId = composerState.beginMediaAcquisition(ownerSnapshot) ?: return@launch
          val recordingId = UUID.randomUUID().toString()
          if (!viewModel.isCurrentChatComposerOwner(ownerSnapshot)) {
            composerState.cancelMediaAcquisition(mediaAuthorizationId)
            return@launch
          }
          dictationController.cancel()
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
      dictationState = dictationState,
      dictationEnabled =
        !talkActive &&
          pendingRunCount == 0 &&
          !micCaptureActive &&
          !sendInFlight &&
          (voiceNoteState is VoiceNoteRecorderState.Idle || voiceNoteState is VoiceNoteRecorderState.Failure),
      onToggleDictation = {
        if (dictationActive) {
          dictationController.finish()
        } else {
          scope.launch {
            val ownerSnapshot = composerOwner
            val transcript = dictationController.start()
            // Recognition can finish after navigation. Only the composer that started
            // dictation may receive its transcript; otherwise a late result crosses drafts.
            if (transcript != null && viewModel.isCurrentChatComposerOwner(ownerSnapshot)) {
              inputDrafts[ownerSnapshot] =
                appendChatDictationTranscript(inputDrafts[ownerSnapshot], transcript)
            }
          }
        }
      },
      talkActive = talkActive,
      onToggleTalk = onToggleTalk,
      onFixConnection = onOpenGatewaySettings,
      onOpenProvidersModels = onOpenProvidersModels,
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
      selectedModelLabel = selectedModelLabel,
      modelSelectionLocked = modelSelectionLocked,
      contextUsage = contextUsage,
      messages = messages,
      permissionMode = activeSession?.permissionMode,
      permissionModePending = permissionModePending,
      permissionPickerEnabled =
        permissionSettingsAvailable &&
          !activeSession?.sessionId.isNullOrBlank() &&
          gatewayConnectionDisplay.isConnected &&
          canWriteSessionSettings &&
          !permissionModePending &&
          !sessionSettingsPending,
      permissionUnavailableReason =
        when {
          !permissionSettingsAvailable -> nativeString("Update the Gateway to change session permissions.")
          activeSession?.sessionId.isNullOrBlank() -> nativeString("Refresh this chat before changing permissions.")
          else -> null
        },
      canSelectFullPermission = canAdminSessionSettings,
      onPermissionModeChange = { mode -> viewModel.setChatSessionPermissionMode(sessionKey, mode) },
      onDismiss = { showModelPicker = false },
      onSelect = { modelRef ->
        viewModel.setChatSessionModel(sessionKey = sessionKey, modelRef = modelRef)
        showModelPicker = false
      },
      onOpenProviders = {
        showModelPicker = false
        onOpenProvidersModels()
      },
      onToggleFavorite = viewModel::toggleModelFavorite,
    )
  }

  if (showBranchSwitcher) {
    BranchSwitcherSheet(
      branches = sessionBranches,
      loading = sessionBranchesLoading || sessionBranchSwitching,
      onDismiss = { showBranchSwitcher = false },
      onSelect = { leafEntryId ->
        scope.launch {
          if (viewModel.switchChatSessionBranch(leafEntryId)) {
            showBranchSwitcher = false
            viewModel.refreshChatSessionBranches()
          }
        }
      },
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

internal fun canStartNewChat(
  pendingRunCount: Int,
  hasQueuedMessage: Boolean,
  gatewayReady: Boolean,
): Boolean = gatewayReady && pendingRunCount == 0 && !hasQueuedMessage

internal fun chatHeaderSessionTitle(
  session: ChatSessionEntry?,
  unnamedTitle: () -> String,
): String = session?.let { sessionPresentationTitle(it, unnamedTitle) } ?: unnamedTitle()

internal fun chatHeaderProjectLabel(
  sessionKey: String,
  catalogs: List<SessionCatalog>,
): String? {
  val normalizedKey = sessionKey.trim().takeIf(String::isNotEmpty) ?: return null
  return sidebarCatalogHosts(catalogs)
    .asSequence()
    .flatMap { it.workspaces.asSequence() }
    .firstOrNull { workspace -> workspace.sessions.any { it.sessionKey == normalizedKey } }
    ?.label
}

@Composable
private fun ChatHeader(
  activeAgent: GatewayAgentSummary?,
  projectLabel: String?,
  sessionTitle: String,
  sessionColor: String?,
  showSidebarButton: Boolean,
  onOpenSidebar: () -> Unit,
  onJumpToLatest: (() -> Unit)?,
  healthOk: Boolean,
  pendingRunCount: Int,
  sessionCreating: Boolean,
  newChatEnabled: Boolean,
  workspaceGit: Boolean,
  branches: List<SessionBranch>,
  branchesLoading: Boolean,
  branchSwitchEnabled: Boolean,
  onNewChatInWorktree: () -> Unit,
  onRefresh: () -> Unit,
  onOpenDashboard: () -> Unit,
  onOpenBackgroundTasks: () -> Unit,
  onOpenBranchSwitcher: () -> Unit,
) {
  var actionsMenuExpanded by remember { mutableStateOf(false) }
  val newChatInWorktreeLabel = stringResource(R.string.new_chat_in_worktree)
  val statusLabel =
    when {
      sessionCreating -> nativeString("Loading")
      pendingRunCount > 0 -> nativeString("Working")
      healthOk -> nativeString("Ready")
      else -> nativeString("Offline")
    }
  val statusColor =
    when {
      pendingRunCount > 0 -> ClawTheme.colors.warning
      healthOk -> ClawTheme.colors.success
      else -> ClawTheme.colors.danger
    }

  Box(modifier = Modifier.fillMaxWidth().heightIn(min = ClawTheme.spacing.touchTarget)) {
    Box(
      modifier = Modifier.align(Alignment.CenterStart).size(ClawTheme.spacing.touchTarget),
      contentAlignment = Alignment.Center,
    ) {
      if (showSidebarButton) {
        HeaderIcon(
          icon = Icons.Default.Menu,
          contentDescription = nativeString("Show Sidebar"),
          onClick = onOpenSidebar,
        )
      }
    }
    Row(
      modifier =
        Modifier
          .align(Alignment.CenterStart)
          .fillMaxWidth()
          .padding(start = 52.dp, end = if (onJumpToLatest != null) 100.dp else 52.dp)
          .clearAndSetSemantics {
            contentDescription = listOfNotNull(projectLabel, sessionTitle, statusLabel).joinToString(", ")
          },
      verticalAlignment = Alignment.CenterVertically,
      horizontalArrangement = Arrangement.spacedBy(9.dp),
    ) {
      val resolvedSessionColor = ClawTheme.colors.sessionColor(sessionColor)
      val avatarFallback =
        activeAgent
          ?.emoji
          ?.trim()
          ?.takeIf(String::isNotEmpty)
          ?: activeAgent
            ?.name
            ?.trim()
            ?.firstOrNull()
            ?.uppercaseChar()
            ?.toString()
          ?: "O"
      Box(
        modifier =
          Modifier
            .size(30.dp)
            .background(resolvedSessionColor ?: Color.Transparent, CircleShape),
        contentAlignment = Alignment.Center,
      ) {
        ClawAgentAvatar(
          source = activeAgent?.let(::agentAvatarSource),
          size = 26.dp,
        ) {
          Box(
            modifier = Modifier.size(26.dp).background(ClawTheme.colors.surfaceRaised, CircleShape),
            contentAlignment = Alignment.Center,
          ) {
            Text(
              text = avatarFallback,
              style = ClawTheme.type.caption.copy(fontWeight = FontWeight.Medium),
              color = ClawTheme.colors.text,
              maxLines = 1,
            )
          }
        }
      }
      Column(modifier = Modifier.weight(1f)) {
        projectLabel?.let { project ->
          Text(
            text = project,
            style = ClawTheme.type.caption.copy(fontSize = 11.sp, lineHeight = 13.sp, fontWeight = FontWeight.Normal),
            color = ClawTheme.colors.textMuted,
            maxLines = 1,
            overflow = TextOverflow.Ellipsis,
          )
        }
        Row(
          verticalAlignment = Alignment.CenterVertically,
          horizontalArrangement = Arrangement.spacedBy(6.dp),
        ) {
          Text(
            text = sessionTitle,
            style = ClawTheme.type.title.copy(fontSize = 14.sp, lineHeight = 18.sp, fontWeight = FontWeight.Medium),
            color = ClawTheme.colors.text,
            maxLines = 1,
            overflow = TextOverflow.Ellipsis,
            modifier = Modifier.weight(1f, fill = false),
          )
          if (sessionCreating) {
            CircularProgressIndicator(modifier = Modifier.size(12.dp), strokeWidth = 1.5.dp, color = ClawTheme.colors.textMuted)
          } else {
            Box(modifier = Modifier.size(6.dp).background(statusColor, CircleShape))
          }
        }
      }
    }
    Row(modifier = Modifier.align(Alignment.CenterEnd)) {
      if (onJumpToLatest != null) {
        HeaderIcon(
          icon = Icons.Default.ArrowDownward,
          contentDescription = nativeString("Jump to latest"),
          onClick = onJumpToLatest,
        )
      }
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
          if (branches.size > 1) {
            DropdownMenuItem(
              text = { Text(nativeString("Switch branch")) },
              leadingIcon = { Icon(Icons.Default.ArrowDropDown, contentDescription = null) },
              enabled = branchSwitchEnabled && !branchesLoading,
              onClick = {
                actionsMenuExpanded = false
                onOpenBranchSwitcher()
              },
            )
          }
          DropdownMenuItem(
            text = { Text(nativeString("Dashboard")) },
            leadingIcon = { Icon(Icons.Default.Dashboard, contentDescription = null) },
            onClick = {
              actionsMenuExpanded = false
              onOpenDashboard()
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
  fullMessageOwner: ChatComposerOwner,
  selectionGeneration: Long,
  gatewayCatalogRevision: Long,
  prepareFullMessageRead: (ChatMessage) -> ChatController.FullMessageRead?,
  session: ChatSessionEntry?,
  messages: List<ChatMessage>,
  transcriptAnchor: ChatTranscriptAnchorState?,
  historyLoading: Boolean,
  activeRunCount: Int,
  activeRunId: String?,
  activeRunClockKey: String?,
  activeRunOutputTokens: Long?,
  pendingToolCalls: List<ChatPendingToolCall>,
  subagentActivities: Map<String, ChatSubagentActivity>,
  questions: List<ChatQuestionPrompt>,
  streamingAssistantText: String?,
  healthOk: Boolean,
  gatewayOffline: Boolean,
  outboxItems: List<ChatOutboxItem>,
  recoveryOutboxItems: List<ChatOutboxItem>,
  onRetryOutbox: (String) -> Unit,
  onDeleteOutbox: (String) -> Unit,
  onResolveQuestion: (ChatQuestionPrompt, Map<String, List<String>>) -> Unit,
  onQuestionDraftChanged: (ChatQuestionPrompt, (ChatQuestionDraft) -> ChatQuestionDraft) -> Unit,
  onSkipQuestion: (ChatQuestionPrompt) -> Unit,
  onStarterPrompt: (String) -> Unit,
  onReplyMessage: (String) -> Unit,
  sessionActionsEnabled: Boolean,
  onRewindMessage: (String) -> Unit,
  onForkMessage: (String) -> Unit,
  speechState: MessageSpeechState?,
  onToggleListen: (String, String) -> Unit,
  inlineMediaPlaybackBlocked: Boolean,
  resolveInlineWidgetResource: suspend (String, ChatWidgetResource?) -> ChatWidgetResource?,
  loadImageArtifact: suspend (String) -> GatewayLoadedImage?,
  loadMediaArtifact: suspend (String, GatewayMediaKind, Boolean) -> GatewayLoadedMedia?,
  modifier: Modifier = Modifier,
  header: @Composable ((() -> Unit)?) -> Unit,
) {
  val baseTimeline =
    remember(messages, activeRunCount, pendingToolCalls, subagentActivities, questions, streamingAssistantText, outboxItems, recoveryOutboxItems) {
      buildChatTimeline(
        messages = messages,
        pendingRunCount = activeRunCount,
        pendingToolCalls = pendingToolCalls,
        streamingAssistantText = streamingAssistantText,
        subagentActivities = subagentActivities,
        outboxItems = outboxItems,
        recoveryOutboxItems = recoveryOutboxItems,
        questions = questions,
      )
    }
  val indicatorVisible = activeRunCount > 0
  val workingRunTracker = remember(sessionKey) { ChatWorkingRunTracker(sessionKey) }
  val workingRun =
    workingRunTracker.resolve(
      indicatorVisible = indicatorVisible,
      clockKey = activeRunClockKey,
      authoritativeRunId = activeRunId,
      nowElapsedMs = SystemClock.elapsedRealtime(),
      outputTokens = activeRunOutputTokens,
    )
  val turnRecapResolver = remember { TurnRecapResolver() }
  val turnRecap =
    turnRecapResolver.resolve(
      sessionKey = sessionKey,
      indicatorVisible = indicatorVisible,
      row = session,
      transcript =
        TurnRecapTranscriptState(
          sessionKey = transcriptAnchor?.sessionKey,
          newestItemId = transcriptAnchor?.newestItemId,
          completedEndedAt = transcriptAnchor?.completedEndedAt,
          completedNewestItemId = transcriptAnchor?.completedNewestItemId,
        ),
    )
  val timeline = remember(baseTimeline, turnRecap) { baseTimeline.withTurnRecap(turnRecap) }
  val readerScroll =
    rememberChatReaderScrollController(
      sessionKey = sessionKey,
      timeline = timeline,
      historyLoading = historyLoading,
    )
  DisposableEffect(sessionKey, turnRecapResolver) {
    onDispose { turnRecapResolver.abandonActiveWatch(sessionKey) }
  }

  // The header stays outside the weighted transcript so composer panels cannot collapse it.
  header(readerScroll.jumpToLatest.takeIf { readerScroll.showJumpToLatest })
  CompositionLocalProvider(LocalChatReaderNavigation provides readerScroll.onManualNavigation) {
    ChatMessageDisclosure(
      messages = messages,
      owner = fullMessageOwner,
      selectionGeneration = selectionGeneration,
      catalogRevision = gatewayCatalogRevision,
      prepareRead = prepareFullMessageRead,
    ) { visibleContent, disclosure ->
      Box(modifier = modifier.fillMaxWidth().padding(horizontal = 16.dp)) {
        LazyColumn(
          modifier = Modifier.fillMaxSize().nestedScroll(readerScroll.nestedScrollConnection),
          state = readerScroll.listState,
          reverseLayout = true,
          verticalArrangement = Arrangement.spacedBy(12.dp),
          contentPadding = PaddingValues(top = 6.dp, bottom = 3.dp),
        ) {
          itemsIndexed(items = timeline.items, key = { _, item -> chatTimelineItemKey(item) }) { _, item ->
            when (item) {
              is ChatTimelineItem.Message -> {
                ChatBubble(
                  messageId = item.message.id,
                  entryId = item.message.entryId,
                  role = item.message.role,
                  live = false,
                  content = visibleContent(item.message),
                  timestampMs = item.message.timestampMs,
                  onReplyMessage = onReplyMessage,
                  sessionActionsEnabled = sessionActionsEnabled,
                  onRewindMessage = onRewindMessage,
                  onForkMessage = onForkMessage,
                  speechState = speechState,
                  onToggleListen = onToggleListen,
                  inlineMediaPlaybackBlocked = inlineMediaPlaybackBlocked,
                  inlineWidgetResolverReady = healthOk,
                  resolveInlineWidgetResource = resolveInlineWidgetResource,
                  loadImageArtifact = loadImageArtifact,
                  loadMediaArtifact = loadMediaArtifact,
                  senderLabel = item.message.senderLabel,
                  disclosure = { disclosure(item.message) },
                )
              }

              is ChatTimelineItem.OutboxCommand -> {
                ChatOutboxBubble(
                  item = item.item,
                  onRetry = { onRetryOutbox(item.item.id) },
                  onDelete = { onDeleteOutbox(item.item.id) },
                )
              }

              is ChatTimelineItem.RecoveryOutboxCommand -> {
                ChatOutboxBubble(
                  item = item.item,
                  retryEnabled = false,
                  onRetry = { onRetryOutbox(item.item.id) },
                  onDelete = { onDeleteOutbox(item.item.id) },
                )
              }

              is ChatTimelineItem.OutboxRecoveryHeader -> {
                ChatNotice(
                  title = nativeString("Messages to recover"),
                  body =
                    nativeString(
                      "\${item.count} message(s) need recovery. Re-enter anything you want to keep, then delete these rows.",
                      item.count,
                    ),
                )
              }

              is ChatTimelineItem.PendingTools -> {
                ToolBubble(toolCalls = item.toolCalls)
              }

              is ChatTimelineItem.SubagentActivity -> {
                SubagentActivityRows(
                  activities = item.activities,
                  moreWorkingCount = item.moreWorkingCount,
                )
              }

              is ChatTimelineItem.QuestionPrompt -> {
                ChatQuestionCard(prompt = item.prompt, onDraftChanged = onQuestionDraftChanged, onSubmit = onResolveQuestion, onSkip = onSkipQuestion)
              }

              is ChatTimelineItem.TurnRecapSummary -> {
                ChatTurnRecapRow(item.recap)
              }

              is ChatTimelineItem.SystemNotice -> {
                ChatSystemNoticeRow(item)
              }

              is ChatTimelineItem.SystemDivider -> {
                ChatSystemDividerRow(item)
              }

              is ChatTimelineItem.StreamingAssistant -> {
                ChatBubble(
                  messageId = null,
                  entryId = null,
                  role = "assistant",
                  live = true,
                  content = listOf(ChatMessageContent(text = item.text)),
                  timestampMs = null,
                  onReplyMessage = onReplyMessage,
                  sessionActionsEnabled = false,
                  onRewindMessage = onRewindMessage,
                  onForkMessage = onForkMessage,
                  speechState = null,
                  onToggleListen = onToggleListen,
                  inlineMediaPlaybackBlocked = inlineMediaPlaybackBlocked,
                  inlineWidgetResolverReady = healthOk,
                  resolveInlineWidgetResource = resolveInlineWidgetResource,
                  loadImageArtifact = loadImageArtifact,
                  loadMediaArtifact = loadMediaArtifact,
                )
              }

              ChatTimelineItem.Thinking -> {
                val run = workingRun
                if (run != null) {
                  ChatTypingIndicatorBubble(
                    runKey = run.clockKey,
                    observedAtElapsedMs = run.observedAtElapsedMs,
                    outputTokens = run.outputTokens,
                  )
                }
              }
            }
          }
        }

        if (timeline.items.isEmpty()) {
          if (showChatLoadingPlaceholder(historyLoading = historyLoading, healthOk = healthOk, gatewayOffline = gatewayOffline)) {
            ClawLoadingState(title = nativeString("Loading thread"), modifier = Modifier.align(Alignment.Center))
          } else {
            EmptyChatHint(
              healthOk = healthOk,
              gatewayOffline = gatewayOffline,
              onStarterPrompt = onStarterPrompt,
              modifier = Modifier.align(Alignment.Center),
            )
          }
        }
      }
    }
  }
}

internal data class ChatWorkingRun(
  val clockKey: String,
  val observedAtElapsedMs: Long,
  val authoritativeRunId: String?,
  val outputTokens: Long?,
)

internal class ChatWorkingRunTracker(
  private val sessionKey: String,
) {
  private var current: ChatWorkingRun? = null

  fun resolve(
    indicatorVisible: Boolean,
    clockKey: String?,
    authoritativeRunId: String?,
    nowElapsedMs: Long,
    outputTokens: Long?,
  ): ChatWorkingRun? {
    if (!indicatorVisible) {
      current = null
      return null
    }
    val resolvedClockKey = clockKey ?: "$sessionKey:active"
    val previous = current
    if (previous == null || previous.clockKey != resolvedClockKey) {
      return ChatWorkingRun(
        clockKey = resolvedClockKey,
        observedAtElapsedMs = nowElapsedMs,
        authoritativeRunId = authoritativeRunId,
        outputTokens = outputTokens,
      ).also { current = it }
    }
    if (previous.authoritativeRunId != authoritativeRunId || previous.outputTokens != outputTokens) {
      current =
        previous.copy(
          authoritativeRunId = authoritativeRunId,
          outputTokens = outputTokens,
        )
    }
    return current
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
      subtitle = nativeText("Summarize recent threads and next steps."),
      message = nativeText("Catch me up on my recent OpenClaw threads and suggest next steps."),
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
internal fun ChatBubble(
  messageId: String?,
  entryId: String?,
  role: String,
  live: Boolean,
  content: List<ChatMessageContent>,
  timestampMs: Long?,
  onReplyMessage: (String) -> Unit,
  sessionActionsEnabled: Boolean,
  onRewindMessage: (String) -> Unit,
  onForkMessage: (String) -> Unit,
  speechState: MessageSpeechState?,
  onToggleListen: (String, String) -> Unit,
  inlineMediaPlaybackBlocked: Boolean,
  inlineWidgetResolverReady: Boolean,
  resolveInlineWidgetResource: suspend (String, ChatWidgetResource?) -> ChatWidgetResource?,
  loadImageArtifact: suspend (String) -> GatewayLoadedImage?,
  loadMediaArtifact: suspend (String, GatewayMediaKind, Boolean) -> GatewayLoadedMedia?,
  senderLabel: String? = null,
  disclosure: @Composable () -> Unit = {},
) {
  val normalizedRole = role.trim().lowercase(Locale.US)
  val isUser = normalizedRole == "user"
  val peerSenderLabel = senderLabel?.trim()?.takeIf { isUser && it.isNotEmpty() }
  val speaker =
    when {
      isUser -> peerSenderLabel ?: nativeString("You")
      normalizedRole == "system" -> nativeString("System")
      else -> nativeString("OpenClaw")
    }
  val caption =
    when {
      live -> nativeString("OpenClaw · Live")
      normalizedRole == "system" -> nativeString("System")
      peerSenderLabel != null -> peerSenderLabel
      else -> null
    }
  var visibleImageCount = 0
  val displayableContent =
    content.filter { part ->
      when (part.type) {
        "text" -> {
          !part.text.isNullOrBlank()
        }

        "image" -> {
          val visible = visibleImageCount < 4
          visibleImageCount += 1
          visible
        }

        "canvas" -> {
          normalizedRole == "assistant" && part.widget != null
        }

        else -> {
          part.type == "file" || part.isAudioAttachment() || part.isVideoAttachment()
        }
      }
    }
  val omittedImageCount = (visibleImageCount - 4).coerceAtLeast(0)
  if (displayableContent.isEmpty()) return

  val messageText = chatMessagePlainText(displayableContent)
  val collapsibleUserText = shouldUseUserMessageDisclosure(isUser, displayableContent)
  var userMessageExpanded by rememberSaveable(messageId, messageText) { mutableStateOf(false) }
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
      showSessionActions = isUser && entryId != null && sessionActionsEnabled,
      onRewind = entryId?.let { value -> { onRewindMessage(value) } },
      onFork = entryId?.let { value -> { onForkMessage(value) } },
      enabled = !live,
      listenActive = messageSpeech?.isActive == true,
      onToggleListen = toggleListen,
      modifier =
        Modifier
          .fillMaxWidth(chatBubbleWidthFraction(isUser))
          .semantics(mergeDescendants = true) { contentDescription = speaker },
    ) {
      Surface(
        modifier = Modifier.fillMaxWidth(),
        shape = RoundedCornerShape(if (isUser) CHAT_BUBBLE_CORNER_RADIUS_DP.dp else 0.dp),
        color = if (isUser) ClawTheme.colors.userMessageSurface else Color.Transparent,
        contentColor = ClawTheme.colors.text,
        border = null,
        tonalElevation = 0.dp,
        shadowElevation = 0.dp,
      ) {
        Column(
          modifier =
            if (isUser) {
              Modifier.padding(horizontal = 11.dp, vertical = 8.dp)
            } else {
              Modifier.padding(vertical = 4.dp)
            },
          verticalArrangement = Arrangement.spacedBy(4.dp),
        ) {
          caption?.let {
            Text(
              text = it,
              style = ClawTheme.type.caption.copy(fontSize = 12.sp, lineHeight = 15.sp, fontWeight = FontWeight.Medium),
              color = ClawTheme.colors.textMuted,
            )
          }
          if (collapsibleUserText && messageText.isNotBlank()) {
            ChatUserMessageText(
              textParts = displayableContent.mapNotNull { it.text },
              plainText = messageText,
              expanded = userMessageExpanded,
              onToggleExpanded = { userMessageExpanded = !userMessageExpanded },
            )
          }
          displayableContent.forEach { part ->
            when {
              part.type == "text" && !collapsibleUserText -> {
                ChatText(text = part.text.orEmpty(), textColor = ClawTheme.colors.text, isStreaming = live)
              }

              part.type == "text" -> {}

              part.isAudioAttachment() && part.hasPlayableMediaArtifact() -> {
                ChatAudioPlayerCard(
                  content = part,
                  playbackBlocked = inlineMediaPlaybackBlocked,
                  loadMedia = loadMediaArtifact,
                )
              }

              part.isVideoAttachment() && part.hasPlayableMediaArtifact() -> {
                ChatVideoPlayerCard(
                  content = part,
                  playbackBlocked = inlineMediaPlaybackBlocked,
                  loadMedia = loadMediaArtifact,
                )
              }

              part.isAudioAttachment() || part.isVideoAttachment() -> {
                ChatMediaAttachmentLabel(content = part)
              }

              part.type == "image" && !part.base64.isNullOrBlank() -> {
                ChatBase64Image(base64 = part.base64, mimeType = part.mimeType)
              }

              part.type == "image" && !part.artifactId.isNullOrBlank() -> {
                ChatManagedImage(
                  artifactId = part.artifactId,
                  label = part.alt?.takeIf(String::isNotBlank) ?: part.fileName ?: nativeString("Image"),
                  resolverReady = inlineWidgetResolverReady,
                  loadImage = loadImageArtifact,
                )
              }

              part.type == "canvas" && normalizedRole == "assistant" -> {
                ChatInlineWidget(
                  preview = checkNotNull(part.widget),
                  resolverReady = inlineWidgetResolverReady,
                  resolveResource = resolveInlineWidgetResource,
                )
              }

              else -> {
                Text(text = part.fileName ?: nativeString("Attachment"), style = ClawTheme.type.body, color = ClawTheme.colors.textMuted)
              }
            }
          }
          if (omittedImageCount > 0) {
            Text(
              text = nativeString("Additional images hidden: \${omittedImageCount}", omittedImageCount),
              style = ClawTheme.type.caption,
              color = ClawTheme.colors.textMuted,
            )
          }
          if (messageId != null) {
            ChatMessageLinkPreview(messageId = messageId, role = normalizedRole, content = displayableContent)
          }
          disclosure()
          messageSpeech?.let { speech ->
            FullChatSpeechIndicator(
              phase = speech.phase,
              onToggle = { onToggleListen(checkNotNull(messageId), messageText) },
            )
          }
          timestampMs?.let {
            Text(
              text = formatChatTimestamp(it),
              style = ClawTheme.type.caption.copy(fontSize = 11.5.sp, lineHeight = 14.sp, fontWeight = FontWeight.Normal),
              color = ClawTheme.colors.textSubtle,
              modifier = Modifier.align(if (isUser) Alignment.End else Alignment.Start),
            )
          }
        }
      }
    }
  }
}

internal fun chatBubbleWidthFraction(isUser: Boolean): Float = if (isUser) 0.78f else 1f

internal const val CHAT_BUBBLE_CORNER_RADIUS_DP = 24

@Composable
private fun FullChatSpeechIndicator(
  phase: MessageSpeechPhase,
  onToggle: () -> Unit,
) {
  Surface(
    onClick = onToggle,
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
          when (phase) {
            MessageSpeechPhase.Preparing -> Icons.Default.HourglassEmpty
            MessageSpeechPhase.Speaking -> Icons.AutoMirrored.Filled.VolumeUp
            MessageSpeechPhase.Failed -> Icons.Default.Refresh
          },
        contentDescription = null,
        modifier = Modifier.size(14.dp),
        tint = ClawTheme.colors.textMuted,
      )
      Text(
        text =
          when (phase) {
            MessageSpeechPhase.Preparing -> nativeString("Preparing audio…")
            MessageSpeechPhase.Speaking -> nativeString("Speaking…")
            MessageSpeechPhase.Failed -> nativeString("Audio error · Retry")
          },
        style = ClawTheme.type.caption,
        color = ClawTheme.colors.textMuted,
      )
    }
  }
}

@Composable
private fun ChatUserMessageText(
  textParts: List<String>,
  plainText: String,
  expanded: Boolean,
  onToggleExpanded: () -> Unit,
) {
  val preview = ChatUserMessageDisclosurePolicy.collapsedPreview(plainText)
  if (preview != null && !expanded) {
    Text(
      text = preview,
      style = ClawTheme.type.body.copy(fontWeight = FontWeight.Normal),
      color = ClawTheme.colors.text,
    )
  } else {
    Column(verticalArrangement = Arrangement.spacedBy(4.dp)) {
      textParts.forEach { text ->
        ChatMarkdown(
          text = text,
          textColor = ClawTheme.colors.text,
          isStreaming = false,
          bodyStyle = ClawTheme.type.body.copy(fontWeight = FontWeight.Normal),
        )
      }
    }
  }

  if (preview != null) {
    val toggleLabel = if (expanded) nativeString("Close") else nativeString("View all")
    ChatMessageDisclosureButton(toggleLabel, onToggleExpanded)
  }
}

@Composable
private fun ChatText(
  text: String,
  textColor: Color,
  isStreaming: Boolean,
) {
  ChatMarkdown(
    text = text,
    textColor = textColor,
    isStreaming = isStreaming,
    bodyStyle = ClawTheme.type.body.copy(fontWeight = FontWeight.Normal),
  )
}

@Composable
private fun ToolBubble(toolCalls: List<ChatPendingToolCall>) {
  ClawPanel {
    Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
      ClawStatusPill(text = nativeString("Tools running"), status = ClawStatus.Warning)
      toolCalls.take(4).forEach { tool ->
        ClawListItem(
          title = tool.name,
          subtitle = nativeString("OpenClaw is working"),
          trailing = { tool.liveDiff?.let { DiffStatChips(it) } },
        )
      }
      if (toolCalls.size > 4) {
        Text(text = nativeString("+\${toolCalls.size - 4} more", toolCalls.size - 4), style = ClawTheme.type.caption, color = ClawTheme.colors.textSubtle)
      }
    }
  }
}

@Composable
private fun SubagentActivityRows(
  activities: List<ChatSubagentActivity>,
  moreWorkingCount: Int,
) {
  val animationsEnabled = rememberSystemAnimationsEnabled()
  ClawPanel {
    Column(
      modifier = if (animationsEnabled) Modifier.animateContentSize() else Modifier,
      verticalArrangement = Arrangement.spacedBy(5.dp),
    ) {
      activities.forEach { activity -> SubagentActivityRow(activity, animationsEnabled) }
      if (moreWorkingCount > 0) {
        Text(
          text = nativeString("+\${moreWorkingCount} more working", moreWorkingCount),
          style = ClawTheme.type.caption,
          color = ClawTheme.colors.textSubtle,
        )
      }
    }
  }
}

@Composable
private fun SubagentActivityRow(
  activity: ChatSubagentActivity,
  animationsEnabled: Boolean,
) {
  val completed = activity.status == "completed"
  val summary = if (activity.isWorking) activity.snippet else activity.terminalSummary ?: activity.error ?: activity.snippet
  Row(
    verticalAlignment = Alignment.CenterVertically,
    horizontalArrangement = Arrangement.spacedBy(8.dp),
  ) {
    if (activity.isWorking) {
      WorkingClawIcon(runKey = activity.id, color = ClawTheme.colors.primary)
    } else {
      Icon(
        imageVector = if (completed) Icons.Default.Check else Icons.Default.Close,
        contentDescription = null,
        modifier = Modifier.size(15.dp),
        tint = if (completed) ClawTheme.colors.success else ClawTheme.colors.danger,
      )
    }
    Text(
      text = subagentActivityStatusLabel(activity.status),
      style = ClawTheme.type.label,
      color = ClawTheme.colors.text,
      maxLines = 1,
    )
    if (summary.isNullOrBlank()) {
      Box(modifier = Modifier.weight(1f))
    } else if (animationsEnabled) {
      AnimatedContent(
        targetState = summary,
        modifier = Modifier.weight(1f),
      ) { text ->
        SubagentActivitySnippet(text)
      }
    } else {
      SubagentActivitySnippet(summary, Modifier.weight(1f))
    }
    activity.diffStat?.takeIf { it.added > 0 || it.removed > 0 }?.let { DiffStatChips(it) }
  }
}

@Composable
private fun SubagentActivitySnippet(
  text: String,
  modifier: Modifier = Modifier,
) {
  Text(
    text = text,
    modifier = modifier,
    style = ClawTheme.type.caption,
    color = ClawTheme.colors.textMuted,
    maxLines = 1,
    overflow = TextOverflow.Ellipsis,
  )
}

@Composable
private fun DiffStatChips(diff: ChatDiffStat) {
  Row(horizontalArrangement = Arrangement.spacedBy(4.dp)) {
    if (diff.added > 0) {
      DiffStatChip(text = nativeString("+\${diff.added}", diff.added), color = ClawTheme.colors.success, background = ClawTheme.colors.successSoft)
    }
    if (diff.removed > 0) {
      DiffStatChip(text = nativeString("−\${diff.removed}", diff.removed), color = ClawTheme.colors.danger, background = ClawTheme.colors.dangerSoft)
    }
  }
}

@Composable
private fun DiffStatChip(
  text: String,
  color: Color,
  background: Color,
) {
  Surface(shape = RoundedCornerShape(ClawTheme.radii.control), color = background) {
    Text(
      text = text,
      modifier = Modifier.padding(horizontal = 5.dp, vertical = 1.dp),
      style = ClawTheme.type.caption.copy(fontWeight = FontWeight.SemiBold),
      color = color,
      maxLines = 1,
    )
  }
}

@Composable
private fun subagentActivityStatusLabel(status: String): String =
  when (status) {
    "queued", "running" -> nativeString("Subagent working")
    "completed" -> nativeString("Subagent finished")
    "failed", "timed_out" -> nativeString("Subagent failed")
    "cancelled" -> nativeString("Subagent cancelled")
    else -> nativeString("Subagent finished")
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

internal fun progressCardIsComplete(
  card: ChatProgressCard,
  hasActiveRun: Boolean,
): Boolean =
  if (card.steps.isEmpty()) {
    !hasActiveRun
  } else {
    card.steps.all { it.status == ChatPlanStepStatus.Completed }
  }

@Composable
private fun ProgressCardPill(
  card: ChatProgressCard,
  hasActiveRun: Boolean,
  modifier: Modifier = Modifier,
  attachedToComposer: Boolean = false,
) {
  val steps = card.steps
  val currentStep =
    steps.firstOrNull { it.status == ChatPlanStepStatus.InProgress }
      ?: steps.firstOrNull { it.status == ChatPlanStepStatus.Pending }
      ?: steps.lastOrNull { it.status == ChatPlanStepStatus.Completed }
  val complete = progressCardIsComplete(card, hasActiveRun)
  val currentPosition = if (complete) steps.size else (steps.indexOf(currentStep) + 1).coerceAtLeast(1)
  var expanded by rememberSaveable { mutableStateOf(false) }
  LaunchedEffect(complete) {
    if (complete) expanded = false
  }
  val activityTime = relativeSessionTime(card.updatedAt.takeIf { it > 0L } ?: System.currentTimeMillis())
  val activityLabel =
    if (complete) {
      nativeString("Completed \$activityTime", activityTime)
    } else {
      nativeString("Updated \$activityTime", activityTime)
    }
  val expandedActivityLabel =
    if (steps.isEmpty()) {
      activityLabel
    } else {
      nativeString("\$activityLabel \u00b7 \$currentPosition/\${steps.size}", activityLabel, currentPosition, steps.size)
    }

  val attachedShape = RoundedCornerShape(topStart = 20.dp, topEnd = 20.dp)
  val baseModifier = modifier.fillMaxWidth().heightIn(max = 240.dp).testTag("chat-progress-card")
  val progressModifier =
    if (attachedToComposer) {
      baseModifier
        .clip(attachedShape)
        .background(ClawTheme.colors.surface)
        .border(1.dp, ClawTheme.colors.borderStrong, attachedShape)
        .padding(bottom = 18.dp)
    } else {
      baseModifier
    }
  Column(modifier = progressModifier) {
    Surface(
      onClick = { expanded = !expanded },
      modifier = Modifier.fillMaxWidth().heightIn(min = 42.dp),
      shape = RoundedCornerShape(0.dp),
      color = Color.Transparent,
      contentColor = ClawTheme.colors.text,
    ) {
      Row(
        modifier = Modifier.fillMaxWidth().padding(start = 12.dp, end = 15.dp, top = 8.dp, bottom = 8.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(12.dp),
      ) {
        if (expanded) {
          Text(
            text = nativeString("Task progress"),
            style = ClawTheme.type.caption.copy(fontWeight = FontWeight.SemiBold),
            color = ClawTheme.colors.text,
            modifier = Modifier.weight(1f),
            maxLines = 1,
            overflow = TextOverflow.Ellipsis,
          )
          Text(
            text = expandedActivityLabel,
            style = ClawTheme.type.caption.copy(fontSize = 12.sp, fontWeight = FontWeight.Medium),
            color = ClawTheme.colors.textMuted,
            maxLines = 1,
          )
        } else {
          when {
            complete -> {
              Icon(
                imageVector = Icons.Default.Check,
                contentDescription = nativeString("Completed"),
                modifier = Modifier.size(14.dp),
                tint = ClawTheme.colors.success,
              )
            }

            currentStep != null -> {
              PlanStepMarker(status = currentStep.status)
            }

            else -> {
              Box(modifier = Modifier.width(14.dp))
            }
          }
          Text(
            text = currentStep?.step ?: nativeString("Progress note"),
            style = ClawTheme.type.caption.copy(fontWeight = FontWeight.Medium),
            color = ClawTheme.colors.text,
            modifier = Modifier.weight(1f),
            maxLines = 1,
            overflow = TextOverflow.Ellipsis,
          )
          if (steps.isNotEmpty()) {
            Text(
              text = nativeString("\$currentPosition/\${steps.size}", currentPosition, steps.size),
              style = ClawTheme.type.caption,
              color = ClawTheme.colors.textMuted,
              maxLines = 1,
            )
          }
        }
        Icon(
          imageVector = if (expanded) Icons.Default.KeyboardArrowUp else Icons.AutoMirrored.Filled.KeyboardArrowRight,
          contentDescription = if (expanded) nativeString("Collapse progress card") else nativeString("Expand progress card"),
          modifier = Modifier.size(18.dp),
          tint = ClawTheme.colors.textMuted,
        )
      }
    }

    if (expanded) {
      Column(
        modifier =
          Modifier
            .weight(1f, fill = false)
            .fillMaxWidth()
            .verticalScroll(rememberScrollState())
            .padding(start = 12.dp, end = 16.dp, bottom = 14.dp),
        verticalArrangement = Arrangement.spacedBy(8.dp),
      ) {
        card.markdown?.let { markdown ->
          ChatMarkdown(
            text = markdown,
            textColor = ClawTheme.colors.text,
            isStreaming = false,
            progressBars = true,
          )
        }
        steps.forEach { step ->
          val textColor =
            when (step.status) {
              ChatPlanStepStatus.Completed -> ClawTheme.colors.textMuted
              ChatPlanStepStatus.InProgress -> ClawTheme.colors.text
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
            PlanStepMarker(status = step.status)
            Text(text = step.step, style = textStyle, color = textColor)
          }
        }
      }
    }
  }
}

@Composable
private fun PlanStepMarker(status: ChatPlanStepStatus) {
  Box(modifier = Modifier.width(14.dp), contentAlignment = Alignment.Center) {
    when (status) {
      ChatPlanStepStatus.Completed -> {
        Text(
          text = "✓",
          style = ClawTheme.type.caption.copy(fontWeight = FontWeight.Bold),
          color = ClawTheme.colors.success,
        )
      }

      ChatPlanStepStatus.InProgress -> {
        Box(modifier = Modifier.size(8.dp).background(ClawTheme.colors.primary, CircleShape))
      }

      ChatPlanStepStatus.Pending -> {
        Box(modifier = Modifier.size(8.dp).background(ClawTheme.colors.textSubtle, CircleShape))
      }
    }
  }
}

@Composable
private fun ChatComposer(
  progressCard: ChatProgressCard?,
  value: String,
  onValueChange: (String) -> Unit,
  attachments: List<PendingAttachment>,
  thinkingLevel: String,
  thinkingOptions: List<ChatThinkingLevelOption>,
  thinkingSupported: Boolean,
  thinkingLevelEnabled: Boolean,
  fastMode: Boolean,
  fastModeEnabled: Boolean,
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
  modelUnavailableMessage: NativeText?,
  onDismissShareImportNotice: () -> Unit,
  commands: List<ChatCommandEntry>,
  onThinkingLevelChange: (String) -> Unit,
  onFastModeChange: (Boolean) -> Unit,
  onOpenModelPicker: () -> Unit,
  onPickImages: () -> Unit,
  onPickAudioOrDocument: () -> Unit,
  onPickVideo: () -> Unit,
  onRemoveAttachment: (String) -> Unit,
  voiceNoteState: VoiceNoteRecorderState,
  voiceNoteElapsedMs: Long,
  voiceNoteLevel: Float,
  recordVoiceNoteEnabled: Boolean,
  onStartVoiceNote: () -> Unit,
  onCancelVoiceNote: () -> Unit,
  onFinishVoiceNote: () -> Unit,
  dictationState: ChatDictationState,
  dictationEnabled: Boolean,
  onToggleDictation: () -> Unit,
  talkActive: Boolean,
  onToggleTalk: () -> Unit,
  onFixConnection: () -> Unit,
  onOpenProvidersModels: () -> Unit,
  onCopyDiagnostics: () -> Unit,
  onAbort: () -> Unit,
  onSend: () -> Unit,
) {
  val slashCommands =
    remember(value, commands) {
      matchingSlashCommands(input = value, commands = commands)
    }
  val dictationActive =
    dictationState is ChatDictationState.Starting || dictationState is ChatDictationState.Listening
  val hasContent = value.trim().isNotEmpty() || attachments.isNotEmpty()
  // Offline sends queue durably too (text, images, and voice notes), so the gate is identical
  // to the connected one; admission errors keep the draft when the durable queue refuses it.
  val sendEnabled =
    chatComposerSendEnabled(
      voiceNoteState = voiceNoteState,
      talkActive = talkActive,
      hasContent = hasContent,
      shareStaging = shareStaging,
      sendInFlight = sendInFlight,
      dictationActive = dictationActive,
      modelUnavailable = modelUnavailableMessage != null,
    )

  Column(modifier = Modifier.fillMaxWidth().padding(horizontal = 8.dp).imePadding(), verticalArrangement = Arrangement.spacedBy(4.dp)) {
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
    if (modelUnavailableMessage != null) {
      Row(
        modifier = Modifier.fillMaxWidth(),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(4.dp),
      ) {
        Text(
          text = modelUnavailableMessage.resolveNativeTextResource(),
          style = ClawTheme.type.caption,
          color = ClawTheme.colors.warning,
          modifier = Modifier.weight(1f),
        )
        TextButton(onClick = onOpenProvidersModels) {
          Text(nativeString("Providers"))
        }
      }
    }
    if (attachments.isNotEmpty()) {
      AttachmentStrip(attachments = attachments, onRemoveAttachment = onRemoveAttachment)
    }

    if (shouldShowSlashCommandMenu(value)) {
      SlashCommandPanel(
        commands = slashCommands,
        onSelect = { command -> onValueChange(slashCommandCompletion(command)) },
        // Reserve the editor and run controls before measuring suggestions.
        modifier = Modifier.weight(1f, fill = false),
      )
    }

    val attachedProgress = progressCard != null && voiceNoteState !is VoiceNoteRecorderState.Recording && voiceNoteState !is VoiceNoteRecorderState.Preparing
    Column(verticalArrangement = Arrangement.spacedBy(if (attachedProgress) (-18).dp else 4.dp)) {
      progressCard?.let { card -> ProgressCardPill(card, pendingRunCount > 0, Modifier.weight(1f, fill = false), attachedProgress) }
      Row(modifier = Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
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
            onPickAudioOrDocument = onPickAudioOrDocument,
            onPickVideo = onPickVideo,
            onStartVoiceNote = onStartVoiceNote,
            recordVoiceNoteEnabled = recordVoiceNoteEnabled,
            dictationActive = dictationActive,
            dictationEnabled = dictationEnabled,
            onToggleDictation = onToggleDictation,
            talkActive = talkActive,
            onToggleTalk = onToggleTalk,
            runActive = pendingRunCount > 0,
            onAbort = onAbort,
            hasContent = hasContent,
            sendEnabled = sendEnabled,
            onSend = onSend,
            selectedModelLabel = selectedModelLabel,
            modelPickerEnabled = modelPickerEnabled,
            onOpenModelPicker = onOpenModelPicker,
            thinkingLevel = thinkingLevel,
            thinkingOptions = thinkingOptions,
            thinkingSupported = thinkingSupported,
            thinkingLevelEnabled = thinkingLevelEnabled,
            fastMode = fastMode,
            fastModeEnabled = fastModeEnabled,
            onFastModeChange = onFastModeChange,
            onThinkingLevelChange = onThinkingLevelChange,
            contextUsage = contextUsage,
            modifier = Modifier.weight(1f),
          )
        }
      }
    }

    VoiceNoteRecorderError(voiceNoteState)
    ChatDictationError(dictationState)
    if (recordVoiceNoteEnabled && (dictationState as? ChatDictationState.Failure)?.reason == ChatDictationFailure.Unavailable) {
      TextButton(onClick = onStartVoiceNote) { Text(voiceNoteRecordLabel()) }
    }

    if (!healthOk && gatewayOffline) {
      ChatOfflineNotice(
        status = offlineStatus,
        onFixConnection = onFixConnection,
        onCopyDiagnostics = onCopyDiagnostics,
      )
    }
  }
}

internal data class ChatEffortPosition(
  val optionIndex: Int,
  val fraction: Float?,
) {
  val anchored: Boolean
    get() = fraction != null
}

internal fun chatEffortStopFractions(optionCount: Int): List<Float> =
  when {
    optionCount <= 0 -> emptyList()
    optionCount == 1 -> listOf(1f)
    else -> List(optionCount) { index -> index.toFloat() / (optionCount - 1) }
  }

internal fun resolveChatEffortPosition(
  selectedId: String,
  options: List<ChatThinkingLevelOption>,
): ChatEffortPosition {
  val normalizedSelected = selectedId.trim().lowercase(Locale.US)
  val selectedIndex = options.indexOfFirst { it.id.trim().lowercase(Locale.US) == normalizedSelected }
  val stopFractions = chatEffortStopFractions(options.size)
  val fraction =
    when {
      selectedIndex < 0 -> null
      normalizedSelected == "off" -> 0f
      else -> stopFractions[selectedIndex]
    }
  return ChatEffortPosition(optionIndex = selectedIndex, fraction = fraction)
}

internal fun chatEffortNeedleAngle(position: ChatEffortPosition): Float? = position.fraction?.let { 150f + it * 240f }

internal fun chatEffortVisualFraction(
  fraction: Float,
  layoutDirection: LayoutDirection,
): Float = if (layoutDirection == LayoutDirection.Rtl) 1f - fraction else fraction

@Composable
private fun ChatThinkingLevelPicker(
  options: List<ChatThinkingLevelOption>,
  selectedId: String,
  thinkingSupported: Boolean,
  thinkingLevelEnabled: Boolean,
  fastMode: Boolean,
  fastModeEnabled: Boolean,
  onSelect: (String) -> Unit,
  onFastModeChange: (Boolean) -> Unit,
) {
  var expanded by rememberSaveable { mutableStateOf(false) }
  val enabled = (thinkingSupported && thinkingLevelEnabled) || fastModeEnabled
  LaunchedEffect(enabled) {
    if (!enabled) expanded = false
  }
  val languageTag = currentAppLanguage().languageTag
  val position = resolveChatEffortPosition(selectedId, options)
  val description = nativeString("Thinking")
  val dialColor = if (enabled) ClawTheme.colors.textMuted else ClawTheme.colors.textSubtle
  val needleColor = if (enabled) ClawTheme.colors.text else ClawTheme.colors.textSubtle
  Surface(
    onClick = { expanded = true },
    enabled = enabled,
    modifier =
      Modifier.size(ClawTheme.spacing.touchTarget).semantics {
        contentDescription = description
        stateDescription = chatThinkingChipStateDescription(fastMode, selectedId, options, languageTag)
      },
    shape = CircleShape,
    color = Color.Transparent,
  ) {
    Box(contentAlignment = Alignment.Center) {
      Box(modifier = Modifier.size(20.dp).testTag("chat-thinking-gauge")) {
        Canvas(modifier = Modifier.matchParentSize()) {
          val dialStrokeWidth = 1.5.dp.toPx()
          val needleStrokeWidth = 2.dp.toPx()
          // The dial omits its bottom arc; center the visible ink with the other controls.
          translate(top = size.height / 8f) {
            drawArc(color = dialColor, startAngle = 150f, sweepAngle = 240f, useCenter = false, style = Stroke(width = dialStrokeWidth, cap = StrokeCap.Round))
            // An unadvertised effective level is not the minimum/Off position.
            chatEffortNeedleAngle(position)?.let { angle ->
              rotate(angle) {
                drawLine(
                  color = needleColor,
                  start = center,
                  end = Offset(size.width * 0.82f, center.y),
                  strokeWidth = needleStrokeWidth,
                  cap = StrokeCap.Round,
                )
              }
              drawCircle(color = needleColor, radius = 1.25.dp.toPx(), center = center)
            }
          }
        }
        if (fastMode) {
          Box(
            modifier =
              Modifier
                .align(Alignment.BottomEnd)
                .size(8.dp)
                .background(ClawTheme.colors.surface, CircleShape)
                .testTag("chat-fast-mode-badge"),
            contentAlignment = Alignment.Center,
          ) {
            Icon(Icons.Default.Bolt, contentDescription = null, modifier = Modifier.size(7.dp), tint = ClawTheme.colors.primary)
          }
        }
      }
    }
  }
  if (expanded) {
    ChatEffortSheet(
      options = options,
      selectedId = selectedId,
      thinkingSupported = thinkingSupported,
      thinkingLevelEnabled = thinkingLevelEnabled,
      fastMode = fastMode,
      fastModeEnabled = fastModeEnabled,
      onSelect = onSelect,
      onFastModeChange = onFastModeChange,
      onDismiss = { expanded = false },
    )
  }
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
internal fun ChatEffortSliderControl(
  options: List<ChatThinkingLevelOption>,
  selectedId: String,
  enabled: Boolean,
  onSelect: (String) -> Unit,
) {
  val languageTag = currentAppLanguage().languageTag
  val selectedPosition = resolveChatEffortPosition(selectedId, options)
  var previewing by remember(selectedId, options) { mutableStateOf(false) }
  val sliderState =
    remember(selectedId, options) {
      SliderState(
        value = selectedPosition.optionIndex.coerceAtLeast(0).toFloat(),
        steps = (options.size - 2).coerceAtLeast(0),
        valueRange = 0f..options.lastIndex.coerceAtLeast(0).toFloat(),
      )
    }
  sliderState.onValueChange = { value ->
    sliderState.value = value
    previewing = true
  }
  sliderState.onValueChangeFinished = {
    options.getOrNull(sliderState.value.roundToInt())?.let { option ->
      if (!option.id.equals(selectedId, ignoreCase = true)) onSelect(option.id)
    }
    sliderState.value = selectedPosition.optionIndex.coerceAtLeast(0).toFloat()
    previewing = false
  }
  val sliderIndex = sliderState.value.roundToInt()
  val selectedLabel =
    sliderIndex
      .takeIf { previewing }
      ?.let(options::getOrNull)
      ?.let { option -> chatThinkingOptionLabel(option, languageTag) }
      ?: chatThinkingOptionLabel(
        options.getOrNull(selectedPosition.optionIndex) ?: ChatThinkingLevelOption(selectedId, selectedId),
        languageTag,
      )

  Column {
    Row(
      modifier = Modifier.fillMaxWidth().padding(horizontal = 20.dp, vertical = 12.dp),
      horizontalArrangement = Arrangement.SpaceBetween,
      verticalAlignment = Alignment.CenterVertically,
    ) {
      Text(nativeString("Effort"), style = ClawTheme.type.label.copy(fontWeight = FontWeight.SemiBold))
      Text(selectedLabel, style = ClawTheme.type.label, color = ClawTheme.colors.primary)
    }
    // Material treats two endpoints as continuous; use explicit choices for binary
    // profiles and unknown selections so accessibility can reach every option.
    if (options.size > 2 && selectedPosition.anchored) {
      Slider(
        state = sliderState,
        enabled = enabled,
        modifier =
          Modifier.padding(horizontal = 20.dp).semantics {
            contentDescription = nativeString("Thinking")
            stateDescription = selectedLabel
          },
        thumb = {
          Box(
            Modifier
              .size(width = 28.dp, height = 20.dp)
              .background(
                color = if (enabled) ClawTheme.colors.text else ClawTheme.colors.textSubtle,
                shape = RoundedCornerShape(10.dp),
              ),
          )
        },
        track = { state -> ChatEffortSliderTrack(state, options.size, enabled) },
      )
      Row(
        modifier = Modifier.fillMaxWidth().padding(horizontal = 20.dp),
        horizontalArrangement = Arrangement.SpaceBetween,
      ) {
        Text(nativeString("Faster"), style = ClawTheme.type.caption, color = ClawTheme.colors.textMuted)
        Text(nativeString("Smarter"), style = ClawTheme.type.caption, color = ClawTheme.colors.textMuted)
      }
    } else {
      options.forEachIndexed { index, option ->
        val optionSelected = selectedPosition.optionIndex == index
        Surface(
          onClick = { if (!optionSelected) onSelect(option.id) },
          enabled = enabled,
          modifier = Modifier.fillMaxWidth().heightIn(min = ClawTheme.spacing.touchTarget).semantics { selected = optionSelected },
          color = Color.Transparent,
        ) {
          Row(
            modifier = Modifier.padding(horizontal = 20.dp, vertical = 12.dp),
            horizontalArrangement = Arrangement.SpaceBetween,
            verticalAlignment = Alignment.CenterVertically,
          ) {
            Text(chatThinkingOptionLabel(option, languageTag), style = ClawTheme.type.body)
            if (optionSelected) Icon(Icons.Default.Check, contentDescription = nativeString("Selected"))
          }
        }
      }
    }
  }
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun ChatEffortSliderTrack(
  state: SliderState,
  optionCount: Int,
  enabled: Boolean,
) {
  val activeFraction =
    if (optionCount > 1) {
      (state.value / (optionCount - 1)).coerceIn(0f, 1f)
    } else {
      0f
    }
  val inactiveColor = ClawTheme.colors.text.copy(alpha = if (enabled) 0.07f else 0.04f)
  val activeColor = ClawTheme.colors.text.copy(alpha = if (enabled) 0.18f else 0.08f)
  val dotColor = ClawTheme.colors.text.copy(alpha = if (enabled) 0.28f else 0.12f)
  Canvas(modifier = Modifier.fillMaxWidth().height(26.dp)) {
    val cornerRadius = CornerRadius(size.height / 2f, size.height / 2f)
    drawRoundRect(color = inactiveColor, cornerRadius = cornerRadius)
    if (activeFraction > 0f) {
      val activeWidth = size.width * activeFraction
      drawRoundRect(
        color = activeColor,
        topLeft = Offset(x = if (layoutDirection == LayoutDirection.Rtl) size.width - activeWidth else 0f, y = 0f),
        size = Size(width = activeWidth, height = size.height),
        cornerRadius = cornerRadius,
      )
    }
    val dotRadius = 2.dp.toPx()
    chatEffortStopFractions(optionCount).forEach { fraction ->
      val visualFraction = chatEffortVisualFraction(fraction, layoutDirection)
      drawCircle(color = dotColor, radius = dotRadius, center = Offset(size.width * visualFraction, size.height / 2f))
    }
  }
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun ChatEffortSheet(
  options: List<ChatThinkingLevelOption>,
  selectedId: String,
  thinkingSupported: Boolean,
  thinkingLevelEnabled: Boolean,
  fastMode: Boolean,
  fastModeEnabled: Boolean,
  onSelect: (String) -> Unit,
  onFastModeChange: (Boolean) -> Unit,
  onDismiss: () -> Unit,
) {
  val thinkingOptions = if (thinkingSupported) options else emptyList()
  ModalBottomSheet(
    onDismissRequest = onDismiss,
    sheetState = rememberModalBottomSheetState(skipPartiallyExpanded = true),
    containerColor = ClawTheme.colors.surface,
    contentColor = ClawTheme.colors.text,
  ) {
    Column(
      modifier =
        Modifier
          .fillMaxWidth()
          .heightIn(max = 560.dp)
          .verticalScroll(rememberScrollState())
          .padding(bottom = 24.dp),
    ) {
      if (thinkingOptions.isNotEmpty()) {
        ChatEffortSliderControl(
          options = thinkingOptions,
          selectedId = selectedId,
          enabled = thinkingLevelEnabled,
          onSelect = onSelect,
        )
      }
      if (thinkingOptions.isNotEmpty()) {
        HorizontalDivider(color = ClawTheme.colors.border, modifier = Modifier.padding(top = 14.dp))
      }
      Row(
        modifier = Modifier.fillMaxWidth().padding(horizontal = 20.dp, vertical = 14.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(12.dp),
      ) {
        Icon(Icons.Default.Bolt, contentDescription = null, tint = ClawTheme.colors.primary, modifier = Modifier.size(20.dp))
        Column(modifier = Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(2.dp)) {
          Text(nativeString("Fast mode"), style = ClawTheme.type.body.copy(fontWeight = FontWeight.Medium))
          Text(
            nativeString("Faster responses, higher usage of limits."),
            style = ClawTheme.type.caption,
            color = ClawTheme.colors.textMuted,
          )
        }
        Switch(
          checked = fastMode,
          onCheckedChange = onFastModeChange,
          enabled = fastModeEnabled,
          modifier = Modifier.semantics { contentDescription = nativeString("Fast mode") },
        )
      }
    }
  }
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun BranchSwitcherSheet(
  branches: List<SessionBranch>,
  loading: Boolean,
  onDismiss: () -> Unit,
  onSelect: (String) -> Unit,
) {
  ModalBottomSheet(
    onDismissRequest = onDismiss,
    sheetState = rememberModalBottomSheetState(skipPartiallyExpanded = true),
    containerColor = ClawTheme.colors.surface,
    contentColor = ClawTheme.colors.text,
  ) {
    Column(modifier = Modifier.fillMaxWidth().heightIn(max = 560.dp)) {
      Text(
        text = nativeString("Switch branch"),
        modifier = Modifier.padding(horizontal = 20.dp, vertical = 12.dp),
        style = ClawTheme.type.title,
        color = ClawTheme.colors.text,
      )
      HorizontalDivider(color = ClawTheme.colors.border, thickness = 1.dp)
      LazyColumn(
        modifier = Modifier.fillMaxWidth(),
        contentPadding = PaddingValues(bottom = 24.dp),
      ) {
        itemsIndexed(branches, key = { _, branch -> branch.leafEntryId }) { _, branch ->
          Surface(
            onClick = { if (!branch.active) onSelect(branch.leafEntryId) },
            enabled = !loading && !branch.active,
            color = if (branch.active) ClawTheme.colors.surfacePressed else Color.Transparent,
            contentColor = ClawTheme.colors.text,
          ) {
            Row(
              modifier = Modifier.fillMaxWidth().heightIn(min = ClawTheme.spacing.touchTarget).padding(horizontal = 20.dp, vertical = 12.dp),
              verticalAlignment = Alignment.CenterVertically,
              horizontalArrangement = Arrangement.spacedBy(12.dp),
            ) {
              Column(modifier = Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(3.dp)) {
                Text(
                  text = branch.headline.trim().takeIf(String::isNotEmpty) ?: nativeString("Untitled branch"),
                  style = ClawTheme.type.body,
                  color = ClawTheme.colors.text,
                  maxLines = 2,
                  overflow = TextOverflow.Ellipsis,
                )
                Text(
                  text = branchMetadataText(branch),
                  style = ClawTheme.type.caption,
                  color = ClawTheme.colors.textMuted,
                )
              }
              if (branch.active) {
                Icon(
                  imageVector = Icons.Default.Check,
                  contentDescription = nativeString("Current branch"),
                  tint = ClawTheme.colors.primary,
                )
              }
            }
          }
        }
      }
    }
  }
}

internal fun branchMessageCountText(count: Int): String = nativeString("Messages: \$count", count)

internal fun branchMetadataText(branch: SessionBranch): String {
  val count = branchMessageCountText(branch.messageCount)
  val updated =
    branch.updatedAt
      ?.let { timestamp -> runCatching { Instant.parse(timestamp).toEpochMilli() }.getOrNull() }
      ?.let(::relativeSessionTime)
  return if (updated == null) count else nativeString("\$count · \$updated", count, updated)
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun ChatModelPickerSheet(
  sections: ChatModelPickerSections,
  favorites: Set<String>,
  selectedModelLabel: String,
  modelSelectionLocked: Boolean,
  contextUsage: ChatContextUsage,
  messages: List<ChatMessage>,
  permissionMode: ChatPermissionMode?,
  permissionModePending: Boolean,
  permissionPickerEnabled: Boolean,
  permissionUnavailableReason: String?,
  canSelectFullPermission: Boolean,
  onPermissionModeChange: (ChatPermissionMode?) -> Unit,
  onDismiss: () -> Unit,
  onSelect: (String?) -> Unit,
  onOpenProviders: () -> Unit,
  onToggleFavorite: (String) -> Unit,
) {
  var showPermissionPicker by rememberSaveable { mutableStateOf(false) }
  var showUsageDetails by rememberSaveable { mutableStateOf(false) }
  LaunchedEffect(permissionPickerEnabled) {
    if (!permissionPickerEnabled) showPermissionPicker = false
  }
  ModalBottomSheet(
    onDismissRequest = onDismiss,
    // IME dismissal can remove a partial-height anchor while the selector opens.
    sheetState = rememberModalBottomSheetState(skipPartiallyExpanded = true),
    containerColor = ClawTheme.colors.surface,
    contentColor = ClawTheme.colors.text,
    properties =
      ModalBottomSheetProperties(
        shouldDismissOnBackPress = false,
        shouldDismissOnClickOutside = true,
      ),
  ) {
    // Material captures its Back callback's enabled state when the dialog is created.
    // Own both pages here so recreation cannot leave the model page without Back.
    BackHandler {
      if (showPermissionPicker) showPermissionPicker = false else onDismiss()
    }
    // Keep the outer sheet unconstrained: Material anchors use the full window height.
    // Cap only its scrollable content against the actual inset-adjusted available bounds.
    BoxWithConstraints {
      Box(Modifier.heightIn(max = maxHeight * 0.5f)) {
        if (showPermissionPicker) {
          ChatPermissionPicker(
            selectedMode = permissionMode,
            canSelectFull = canSelectFullPermission,
            onBack = { showPermissionPicker = false },
            onSelect = { mode ->
              showPermissionPicker = false
              onPermissionModeChange(mode)
            },
          )
        } else {
          LazyColumn(
            modifier = Modifier.fillMaxWidth(),
            contentPadding = PaddingValues(bottom = 24.dp),
          ) {
            item {
              Column(modifier = Modifier.padding(horizontal = 20.dp, vertical = 12.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                Text(text = selectedModelLabel, style = ClawTheme.type.label, color = ClawTheme.colors.text)
                if (modelSelectionLocked) {
                  Text(text = nativeString("Model selection is locked for this session."), style = ClawTheme.type.caption, color = ClawTheme.colors.textMuted)
                }
                chatContextSummary(contextUsage)?.let { summary ->
                  val (pressureLabel, contextColor) =
                    when {
                      summary.percent >= 90 -> nativeString("Critical") to ClawTheme.colors.danger
                      summary.percent >= 75 -> nativeString("Warning") to ClawTheme.colors.warning
                      else -> null to ClawTheme.colors.primary
                    }
                  FlowRow(
                    modifier = Modifier.fillMaxWidth(),
                    horizontalArrangement = Arrangement.spacedBy(8.dp),
                    verticalArrangement = Arrangement.spacedBy(2.dp),
                  ) {
                    Text(text = nativeString("Context window"), style = ClawTheme.type.caption, color = ClawTheme.colors.textMuted)
                    Text(text = summary.detail, style = ClawTheme.type.caption.copy(fontWeight = FontWeight.SemiBold), color = ClawTheme.colors.text)
                    pressureLabel?.let { Text(text = it, style = ClawTheme.type.caption, color = contextColor) }
                  }
                  LinearProgressIndicator(
                    progress = { summary.fraction },
                    modifier = Modifier.fillMaxWidth().height(4.dp),
                    color = contextColor,
                    trackColor = ClawTheme.colors.surfacePressed,
                  )
                }
                Row(modifier = Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.SpaceBetween) {
                  Text(text = nativeString("Latest run"), style = ClawTheme.type.caption, color = ClawTheme.colors.textMuted)
                  TextButton(
                    onClick = { showUsageDetails = !showUsageDetails },
                    modifier = Modifier.semantics { stateDescription = if (showUsageDetails) nativeString("Expanded") else nativeString("Collapsed") },
                  ) {
                    Text(nativeString("Details"))
                    Icon(if (showUsageDetails) Icons.Default.KeyboardArrowUp else Icons.Default.ArrowDropDown, contentDescription = null)
                  }
                }
                Row(modifier = Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(12.dp)) {
                  ChatContextStat(label = nativeString("Non-cached input"), value = formatContextUsageTokens(contextUsage.inputTokens), modifier = Modifier.weight(1f))
                  ChatContextStat(label = nativeString("Output"), value = formatContextUsageTokens(contextUsage.outputTokens), modifier = Modifier.weight(1f))
                  ChatContextStat(label = nativeString("Est. cost"), value = formatContextEstimatedCost(contextUsage.estimatedCostUsd), modifier = Modifier.weight(1f))
                }
                if (showUsageDetails) {
                  Text(text = nativeString("Non-cached input excludes cache reads."), style = ClawTheme.type.caption, color = ClawTheme.colors.textSubtle)
                }
                val latestCallUsage = latestChatMessageUsage(messages)
                val latestCallCostStats = latestChatMessageCost(messages)?.let(::availableChatCostStats).orEmpty()
                if (showUsageDetails && (latestCallUsage != null || latestCallCostStats.isNotEmpty())) {
                  Text(text = nativeString("Latest model call"), style = ClawTheme.type.caption, color = ClawTheme.colors.textMuted)
                  latestCallUsage?.let { usage ->
                    Row(modifier = Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(12.dp)) {
                      ChatContextStat(label = nativeString("Non-cached input"), value = formatContextUsageTokens(usage.input), modifier = Modifier.weight(1f))
                      ChatContextStat(label = nativeString("Output"), value = formatContextUsageTokens(usage.output), modifier = Modifier.weight(1f))
                      ChatContextStat(label = nativeString("Cache read"), value = formatContextUsageTokens(usage.cacheRead), modifier = Modifier.weight(1f))
                    }
                  }
                  latestCallCostStats.chunked(2).forEach { row ->
                    Row(modifier = Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(12.dp)) {
                      row.forEach { (label, value) ->
                        ChatContextStat(label = label, value = formatContextEstimatedCost(value), modifier = Modifier.weight(1f))
                      }
                      if (row.size == 1) Box(modifier = Modifier.weight(1f))
                    }
                  }
                }
              }
            }
            item {
              Row(
                modifier = Modifier.fillMaxWidth().heightIn(min = ClawTheme.spacing.touchTarget),
                verticalAlignment = Alignment.CenterVertically,
              ) {
                Surface(
                  onClick = { showPermissionPicker = true },
                  enabled = permissionPickerEnabled,
                  modifier = Modifier.weight(1f).heightIn(min = ClawTheme.spacing.touchTarget),
                  color = Color.Transparent,
                ) {
                  Row(modifier = Modifier.padding(horizontal = 20.dp, vertical = 12.dp), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                    ChatPermissionIcon(mode = permissionMode, contentDescription = null, modifier = Modifier.size(20.dp))
                    Text(nativeString("Permissions"), style = ClawTheme.type.body, modifier = Modifier.weight(1f))
                    Icon(Icons.Default.ArrowDropDown, contentDescription = null, modifier = Modifier.size(18.dp))
                  }
                }
                Text(
                  text = if (permissionModePending) nativeString("Applying permissions…") else chatPermissionModeLabel(permissionMode),
                  style = ClawTheme.type.caption,
                  color = ClawTheme.colors.textMuted,
                  modifier = Modifier.padding(end = 20.dp),
                )
              }
              permissionUnavailableReason?.let { reason ->
                Text(reason, style = ClawTheme.type.caption, color = ClawTheme.colors.textMuted, modifier = Modifier.padding(horizontal = 20.dp, vertical = 4.dp))
              }
            }
            if (modelSelectionLocked) return@LazyColumn
            item {
              HorizontalDivider(color = ClawTheme.colors.border)
            }
            item {
              Surface(
                onClick = { onSelect(null) },
                modifier = Modifier.fillMaxWidth().heightIn(min = ClawTheme.spacing.touchTarget),
                color = Color.Transparent,
                contentColor = ClawTheme.colors.text,
              ) {
                Text(
                  text = nativeString("Default model"),
                  modifier = Modifier.padding(horizontal = 20.dp, vertical = 14.dp),
                  style = ClawTheme.type.body,
                )
              }
            }
            item {
              HorizontalDivider(color = ClawTheme.colors.border, thickness = 1.dp)
            }
            listOf(
              nativeString("Pinned") to sections.pinned,
              nativeString("Recent") to sections.recent,
              nativeString("Models") to sections.remaining,
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
                    onOpenProviders = onOpenProviders,
                    onToggleFavorite = { onToggleFavorite(ref) },
                  )
                }
              }
            }
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
  onOpenProviders: () -> Unit,
  onToggleFavorite: () -> Unit,
) {
  val action = chatModelPickerAction(model)
  val unavailable = model.available == false
  val availabilityLabel =
    if (!unavailable) {
      null
    } else {
      when (model.unavailableReason) {
        GatewayModelUnavailableReason.MissingAuth,
        GatewayModelUnavailableReason.AuthFailed,
        -> nativeString("Authentication needed")

        GatewayModelUnavailableReason.Cooldown -> nativeString("Unavailable")

        null -> nativeString("Unavailable")
      }
    }
  Surface(
    onClick = {
      when (action) {
        ChatModelPickerAction.Select -> onSelect()
        ChatModelPickerAction.OpenProviders -> onOpenProviders()
        ChatModelPickerAction.Disabled -> Unit
      }
    },
    enabled = action != ChatModelPickerAction.Disabled,
    modifier = Modifier.fillMaxWidth().heightIn(min = 58.dp),
    color = Color.Transparent,
    contentColor = if (unavailable) ClawTheme.colors.textMuted else ClawTheme.colors.text,
  ) {
    Row(
      modifier = Modifier.padding(start = 20.dp, end = 8.dp, top = 6.dp, bottom = 6.dp),
      verticalAlignment = Alignment.CenterVertically,
      horizontalArrangement = Arrangement.spacedBy(10.dp),
    ) {
      ProviderBrandIcon(provider = model.provider, size = 24.dp)
      Column(modifier = Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(3.dp)) {
        Text(
          text = model.name,
          style = ClawTheme.type.body.copy(fontWeight = FontWeight.Medium),
          color = if (unavailable) ClawTheme.colors.textMuted else ClawTheme.colors.text,
          maxLines = 1,
          overflow = TextOverflow.Ellipsis,
        )
        Text(
          text = listOfNotNull(model.provider, availabilityLabel).joinToString(" · "),
          style = ClawTheme.type.caption.copy(fontWeight = FontWeight.Normal),
          color = if (unavailable) ClawTheme.colors.warning else ClawTheme.colors.textMuted,
          maxLines = 1,
          overflow = TextOverflow.Ellipsis,
        )
      }
      IconButton(onClick = onToggleFavorite, enabled = !unavailable) {
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
  modifier: Modifier,
) {
  ClawPanel(modifier = modifier, contentPadding = PaddingValues(horizontal = 0.dp, vertical = 0.dp)) {
    Column(modifier = Modifier.verticalScroll(rememberScrollState())) {
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

internal data class ChatPermissionOption(
  val mode: ChatPermissionMode?,
  val label: String,
  val description: String,
)

internal fun chatPermissionOptions(): List<ChatPermissionOption> =
  listOf(
    ChatPermissionOption(null, nativeString("Policy default"), nativeString("Follow the agent's configured policy.")),
    ChatPermissionOption(
      ChatPermissionMode.ReadOnly,
      nativeString("Read only"),
      nativeString("Read-only access; native tool approval rules still apply."),
    ),
    ChatPermissionOption(
      ChatPermissionMode.Guarded,
      nativeString("Guarded"),
      nativeString("Human review for requests beyond the session's access."),
    ),
    ChatPermissionOption(
      ChatPermissionMode.Workspace,
      nativeString("Workspace"),
      nativeString("AI review, with human fallback, for additional access."),
    ),
    ChatPermissionOption(
      ChatPermissionMode.Full,
      nativeString("Full access"),
      nativeString("Run without approval prompts, subject to host and tool policy."),
    ),
  )

internal fun chatPermissionModeLabel(mode: ChatPermissionMode?): String = chatPermissionOptions().first { it.mode == mode }.label

internal fun canSelectChatPermissionMode(
  mode: ChatPermissionMode?,
  canSelectFull: Boolean,
): Boolean = mode != ChatPermissionMode.Full || canSelectFull

@Composable
private fun ChatInputPill(
  value: String,
  onValueChange: (String) -> Unit,
  onPickImages: () -> Unit,
  onPickAudioOrDocument: () -> Unit,
  onPickVideo: () -> Unit,
  onStartVoiceNote: () -> Unit,
  recordVoiceNoteEnabled: Boolean,
  dictationActive: Boolean,
  dictationEnabled: Boolean,
  onToggleDictation: () -> Unit,
  talkActive: Boolean,
  onToggleTalk: () -> Unit,
  runActive: Boolean,
  onAbort: () -> Unit,
  hasContent: Boolean,
  sendEnabled: Boolean,
  onSend: () -> Unit,
  selectedModelLabel: String,
  modelPickerEnabled: Boolean,
  onOpenModelPicker: () -> Unit,
  thinkingLevel: String,
  thinkingOptions: List<ChatThinkingLevelOption>,
  thinkingSupported: Boolean,
  thinkingLevelEnabled: Boolean,
  fastMode: Boolean,
  fastModeEnabled: Boolean,
  onFastModeChange: (Boolean) -> Unit,
  onThinkingLevelChange: (String) -> Unit,
  contextUsage: ChatContextUsage,
  modifier: Modifier = Modifier,
) {
  val hardwareEnterHandler = remember { PhysicalChatSendKeyHandler() }
  var attachmentMenuExpanded by rememberSaveable { mutableStateOf(false) }
  val draftStyle = ClawTheme.type.body.copy(fontSize = 16.sp, lineHeight = 22.sp)

  Surface(
    modifier = modifier.testTag("chat-composer-surface"),
    shape = RoundedCornerShape(20.dp),
    color = ClawTheme.colors.surfaceRaised,
    contentColor = ClawTheme.colors.text,
    border = BorderStroke(1.dp, ClawTheme.colors.borderStrong),
    shadowElevation = 1.dp,
  ) {
    Column {
      ChatTextFieldValueAdapter(
        value = value,
        onValueChange = onValueChange,
        keyHandler = hardwareEnterHandler,
      ) { textFieldValue, updateTextFieldValue ->
        BasicTextField(
          value = textFieldValue,
          onValueChange = updateTextFieldValue,
          textStyle = draftStyle.copy(color = ClawTheme.colors.text),
          cursorBrush = SolidColor(ClawTheme.colors.primary),
          minLines = 1,
          maxLines = 6,
          modifier =
            Modifier
              .fillMaxWidth()
              // Reserve the action row before measuring the draft in the IME viewport.
              .weight(1f, fill = false)
              .heightIn(min = ClawTheme.spacing.touchTarget)
              .padding(start = 14.dp, end = 14.dp, top = 8.dp, bottom = 4.dp)
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
                // BasicTextField's line limit does not constrain its decoration.
                Text(text = nativeString("Message OpenClaw"), style = draftStyle, color = ClawTheme.colors.textMuted, maxLines = 1, overflow = TextOverflow.Ellipsis)
              }
              innerTextField()
            }
          },
        )
      }
      Row(
        modifier = Modifier.padding(horizontal = 4.dp, vertical = 4.dp),
        verticalAlignment = Alignment.CenterVertically,
      ) {
        Box {
          Surface(onClick = { attachmentMenuExpanded = true }, modifier = Modifier.size(ClawTheme.spacing.touchTarget), shape = CircleShape, color = Color.Transparent, contentColor = ClawTheme.colors.textMuted) {
            Box(contentAlignment = Alignment.Center) {
              Icon(imageVector = Icons.Default.Add, contentDescription = nativeString("Add attachment"), modifier = Modifier.size(20.dp))
            }
          }
          DropdownMenu(expanded = attachmentMenuExpanded, onDismissRequest = { attachmentMenuExpanded = false }) {
            DropdownMenuItem(text = { Text(nativeString("Photos")) }, leadingIcon = { Icon(Icons.Default.Photo, contentDescription = null) }, onClick = {
              attachmentMenuExpanded = false
              onPickImages()
            })
            DropdownMenuItem(text = { Text(nativeString("Videos")) }, leadingIcon = { Icon(Icons.Default.Videocam, contentDescription = null) }, onClick = {
              attachmentMenuExpanded = false
              onPickVideo()
            })
            DropdownMenuItem(text = { Text(nativeString("Files")) }, leadingIcon = { Icon(Icons.Default.AttachFile, contentDescription = null) }, onClick = {
              attachmentMenuExpanded = false
              onPickAudioOrDocument()
            })
          }
        }
        Row(modifier = Modifier.weight(1f), verticalAlignment = Alignment.CenterVertically) {
          ChatComposerModelPicker(
            label = selectedModelLabel,
            contextUsage = contextUsage,
            enabled = modelPickerEnabled,
            onClick = onOpenModelPicker,
            modifier = Modifier.weight(1f, fill = false),
          )
          if (thinkingSupported || fastModeEnabled || fastMode) {
            ChatThinkingLevelPicker(
              options = thinkingOptions,
              selectedId = thinkingLevel,
              thinkingSupported = thinkingSupported,
              thinkingLevelEnabled = thinkingLevelEnabled,
              fastMode = fastMode,
              fastModeEnabled = fastModeEnabled,
              onSelect = onThinkingLevelChange,
              onFastModeChange = onFastModeChange,
            )
          }
        }
        if (talkActive) {
          LiveTalkButton(active = true, onClick = onToggleTalk)
        } else {
          ChatComposerMicButton(
            dictationActive = dictationActive,
            dictationEnabled = dictationEnabled,
            voiceNoteEnabled = recordVoiceNoteEnabled,
            onToggleDictation = onToggleDictation,
            onStartVoiceNote = onStartVoiceNote,
          )
        }
        when (resolveChatComposerPrimaryAction(talkActive = talkActive, runActive = runActive, hasContent = hasContent)) {
          ChatComposerPrimaryAction.Send -> SendButton(enabled = sendEnabled, onClick = onSend)
          ChatComposerPrimaryAction.StartTalk -> LiveTalkButton(active = false, onClick = onToggleTalk)
          ChatComposerPrimaryAction.Stop -> StopButton(onClick = onAbort)
          ChatComposerPrimaryAction.None -> Unit
        }
      }
    }
  }
}

@Composable
private fun ChatPermissionIcon(
  mode: ChatPermissionMode?,
  contentDescription: String?,
  modifier: Modifier = Modifier,
) {
  val icon =
    when (mode) {
      null -> Icons.Default.Security
      ChatPermissionMode.ReadOnly -> Icons.Default.GppMaybe
      ChatPermissionMode.Guarded -> Icons.Default.Policy
      ChatPermissionMode.Workspace -> Icons.Default.AdminPanelSettings
      ChatPermissionMode.Full -> Icons.Default.Shield
    }
  Icon(icon, contentDescription = contentDescription, modifier = modifier)
}

@Composable
private fun ChatPermissionPicker(
  selectedMode: ChatPermissionMode?,
  canSelectFull: Boolean,
  onBack: () -> Unit,
  onSelect: (ChatPermissionMode?) -> Unit,
) {
  val options = chatPermissionOptions()
  LazyColumn(
    modifier = Modifier.fillMaxWidth().heightIn(max = 560.dp),
    contentPadding = PaddingValues(bottom = 24.dp),
  ) {
    item {
      Row(
        modifier = Modifier.fillMaxWidth().padding(horizontal = 12.dp, vertical = 4.dp),
        verticalAlignment = Alignment.CenterVertically,
      ) {
        TextButton(onClick = onBack) { Text(nativeString("Back")) }
        Text(
          text = nativeString("Permissions"),
          style = ClawTheme.type.label.copy(fontWeight = FontWeight.SemiBold),
          modifier = Modifier.padding(start = 4.dp),
        )
      }
      HorizontalDivider(color = ClawTheme.colors.border)
    }
    itemsIndexed(options, key = { _, option -> option.mode?.wireValue ?: "policy-default" }) { _, option ->
      val selected = option.mode == selectedMode
      val selectable = canSelectChatPermissionMode(option.mode, canSelectFull)
      Surface(
        onClick = { onSelect(option.mode) },
        enabled = selectable,
        modifier = Modifier.fillMaxWidth().heightIn(min = 68.dp).semantics { this.selected = selected },
        color = Color.Transparent,
      ) {
        Row(
          modifier = Modifier.padding(horizontal = 20.dp, vertical = 10.dp),
          verticalAlignment = Alignment.CenterVertically,
          horizontalArrangement = Arrangement.spacedBy(12.dp),
        ) {
          ChatPermissionIcon(mode = option.mode, contentDescription = null, modifier = Modifier.size(18.dp))
          Column(modifier = Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(4.dp)) {
            Text(
              text = option.label,
              style = ClawTheme.type.body.copy(fontWeight = FontWeight.Medium),
            )
            Text(
              text = option.description,
              style = ClawTheme.type.caption.copy(fontWeight = FontWeight.Normal),
              color = ClawTheme.colors.textMuted,
            )
            if (!selectable) {
              Text(
                text = nativeString("Full access requires operator.admin access."),
                style = ClawTheme.type.caption,
                color = ClawTheme.colors.warning,
              )
            }
          }
          when {
            !selectable -> Icon(Icons.Default.Lock, contentDescription = nativeString("Requires operator.admin"))
            selected -> Icon(Icons.Default.Check, contentDescription = nativeString("Selected"))
          }
        }
      }
    }
  }
}

internal data class ChatContextSummary(
  val fraction: Float,
  val percent: Int,
  val approximate: Boolean,
  val detail: String,
)

internal fun chatContextSummary(
  usage: ChatContextUsage,
  locale: Locale = Locale.getDefault(),
): ChatContextSummary? {
  val fraction = contextMeterWidth(usage) ?: return null
  val used = usage.totalTokens?.takeIf { it >= 0L } ?: return null
  val context = usage.contextTokens?.takeIf { it > 0L } ?: return null
  val approximate = usage.totalTokensFresh == false
  val approximation = if (approximate) "~" else ""
  val percent = (fraction * 100).roundToInt()
  return ChatContextSummary(
    fraction = fraction,
    percent = percent,
    approximate = approximate,
    detail = "$approximation${formatCompactTokenCount(used, locale)} / ${formatCompactTokenCount(context, locale)} \u00b7 $approximation$percent%",
  )
}

internal fun formatContextUsageTokens(
  value: Long?,
  locale: Locale = Locale.getDefault(),
): String = value?.takeIf { it >= 0L }?.let { formatCompactTokenCount(it, locale) } ?: "\u2014"

internal fun formatContextEstimatedCost(value: Double?): String {
  val cost = value?.takeIf { it.isFinite() && it >= 0.0 } ?: return "\u2014"
  val format =
    when {
      cost == 0.0 -> "%.2f"
      cost < 0.01 -> "%.4f"
      cost < 1.0 -> "%.3f"
      else -> "%.2f"
    }
  return "\u0024" + String.format(Locale.US, format, cost)
}

private fun ChatMessage.isContextBoundary(): Boolean =
  when (transcriptMarker?.kind) {
    "compaction", "reset" -> true
    else -> false
  }

private fun latestRealAssistantMessage(messages: List<ChatMessage>): ChatMessage? {
  for (message in messages.asReversed()) {
    if (message.isContextBoundary()) return null
    if (message.role != "assistant" || message.isSyntheticDisplay) continue
    if (message.isTranscriptOnlyOpenClawAssistant()) continue
    return message
  }
  return null
}

internal fun latestChatMessageUsage(messages: List<ChatMessage>): ChatMessageUsage? = latestRealAssistantMessage(messages)?.usage

internal fun latestChatMessageCost(messages: List<ChatMessage>): ChatMessageCost? = latestRealAssistantMessage(messages)?.cost

internal fun availableChatCostStats(cost: ChatMessageCost): List<Pair<String, Double>> {
  val components =
    listOf(
      nativeString("Input cost") to cost.input,
      nativeString("Output cost") to cost.output,
      nativeString("Cache read cost") to cost.cacheRead,
      nativeString("Cache write cost") to cost.cacheWrite,
    ).mapNotNull { (label, value) -> value?.takeIf { it.isFinite() && it >= 0.0 }?.let { label to it } }
  if (components.isNotEmpty()) return components
  return cost.total
    ?.takeIf { it.isFinite() && it >= 0.0 }
    ?.let { listOf(nativeString("Est. cost") to it) }
    .orEmpty()
}

@Composable
private fun ChatContextStat(
  label: String,
  value: String,
  modifier: Modifier = Modifier,
) {
  Column(modifier = modifier, verticalArrangement = Arrangement.spacedBy(2.dp)) {
    Text(text = label, style = ClawTheme.type.caption, color = ClawTheme.colors.textSubtle)
    Text(
      text = value,
      style = ClawTheme.type.caption.copy(fontWeight = FontWeight.SemiBold),
      color = ClawTheme.colors.text,
    )
  }
}

internal fun chatThinkingChipStateDescription(
  fastMode: Boolean,
  thinkingLevel: String,
  thinkingOptions: List<ChatThinkingLevelOption>,
  languageTag: String? = null,
): String {
  val normalizedLevel = thinkingLevel.trim().ifEmpty { "off" }
  val selectedOption =
    thinkingOptions.firstOrNull { it.id.trim().equals(normalizedLevel, ignoreCase = true) }
      ?: ChatThinkingLevelOption(id = normalizedLevel, label = normalizedLevel)
  val selectedLabel = chatThinkingOptionLabel(selectedOption, languageTag)
  val fastModeState =
    if (fastMode) {
      nativeString("On")
    } else {
      nativeString("Off")
    }
  return nativeString(
    "\$selectedLabel, \$fastModeLabel: \$fastModeState",
    selectedLabel,
    nativeString("Fast mode"),
    fastModeState,
  )
}

@Composable
private fun ChatComposerModelPicker(
  label: String,
  contextUsage: ChatContextUsage,
  enabled: Boolean,
  onClick: () -> Unit,
  modifier: Modifier = Modifier,
) {
  val description = nativeString("Model")
  val contextDescription = chatContextSummary(contextUsage)?.let { nativeString("Context: \$detail", it.detail) }
  Surface(
    onClick = onClick,
    enabled = enabled,
    modifier =
      modifier.heightIn(min = ClawTheme.spacing.touchTarget).semantics {
        contentDescription = description
        contextDescription?.let { stateDescription = it }
        role = Role.Button
      },
    shape = RoundedCornerShape(ClawTheme.radii.pill),
    color = Color.Transparent,
    contentColor = if (enabled) ClawTheme.colors.textMuted else ClawTheme.colors.textSubtle,
  ) {
    Box(modifier = Modifier.padding(horizontal = 4.dp), contentAlignment = Alignment.CenterStart) {
      Text(
        text = label,
        style = ClawTheme.type.caption,
        // Android supports middle ellipsis only on one line; keep both ends of the model name visible.
        maxLines = 1,
        overflow = TextOverflow.MiddleEllipsis,
      )
    }
  }
}

@Composable
private fun LiveTalkButton(
  active: Boolean,
  onClick: () -> Unit,
) {
  val buttonDescription = if (active) nativeString("End Talk") else nativeString("Start Talk")
  Surface(
    onClick = onClick,
    modifier =
      Modifier
        .size(ClawTheme.spacing.touchTarget)
        .semantics { contentDescription = buttonDescription },
    shape = CircleShape,
    color = Color.Transparent,
    contentColor = if (active) ClawTheme.colors.accent else ClawTheme.colors.primaryText,
  ) {
    Box(modifier = Modifier.padding(8.dp).background(if (active) Color.Transparent else ClawTheme.colors.primary, CircleShape), contentAlignment = Alignment.Center) {
      LiveTalkWaveform(active = active, modifier = Modifier.size(20.dp))
    }
  }
}

@Composable
private fun StopButton(onClick: () -> Unit) {
  Surface(
    onClick = onClick,
    modifier = Modifier.size(ClawTheme.spacing.touchTarget),
    shape = CircleShape,
    color = Color.Transparent,
    contentColor = ClawTheme.colors.danger,
  ) {
    Box(modifier = Modifier.padding(8.dp).background(ClawTheme.colors.dangerSoft, CircleShape), contentAlignment = Alignment.Center) {
      Icon(imageVector = Icons.Default.Stop, contentDescription = nativeString("Stop"), modifier = Modifier.size(20.dp))
    }
  }
}

@Composable
private fun LiveTalkWaveform(
  active: Boolean,
  modifier: Modifier = Modifier,
) {
  val color = LocalContentColor.current
  val phase =
    if (active) {
      val value by rememberInfiniteTransition().animateFloat(
        initialValue = 0f,
        targetValue = (Math.PI * 2).toFloat(),
        animationSpec = infiniteRepeatable(animation = tween(durationMillis = 720, easing = LinearEasing), repeatMode = RepeatMode.Restart),
      )
      value
    } else {
      0f
    }

  Canvas(modifier = modifier) {
    val strokeWidth = 1.5.dp.toPx()
    repeat(5) { index ->
      val envelope = 1f - abs(index - 2) * 0.28f
      val pulse = if (active) 0.7f + 0.3f * ((sin(phase + index * 0.9f) + 1f) / 2f) else 1f
      val halfHeight = (size.height - strokeWidth * 2f) * envelope * pulse / 2f
      val x = size.width * (index + 0.5f) / 5f
      drawLine(
        color = color,
        start = Offset(x, center.y - halfHeight),
        end = Offset(x, center.y + halfHeight),
        strokeWidth = strokeWidth,
        cap = StrokeCap.Round,
      )
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
  val videoThumbnail =
    remember(attachment.videoThumbnailBase64) {
      attachment.videoThumbnailBase64?.let(::decodeBase64Bitmap)
    }
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
      } else if (attachment.mimeType.startsWith("video/")) {
        if (videoThumbnail != null) {
          Image(
            bitmap = videoThumbnail.asImageBitmap(),
            contentDescription = null,
            contentScale = ContentScale.Crop,
            modifier = Modifier.size(28.dp).clip(RoundedCornerShape(5.dp)),
          )
        } else {
          Icon(imageVector = Icons.Default.Videocam, contentDescription = null, modifier = Modifier.size(14.dp), tint = ClawTheme.colors.textMuted)
        }
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
  val inputTokens: Long? = null,
  val outputTokens: Long? = null,
  val estimatedCostUsd: Double? = null,
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
    // sessions.list owns run-cumulative usage across model calls, tools, and retries.
    // Transcript message usage remains a separate latest-model-call detail below.
    inputTokens = entry?.inputTokens,
    outputTokens = entry?.outputTokens,
    estimatedCostUsd = entry?.estimatedCostUsd,
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
    color = Color.Transparent,
    contentColor = if (enabled) ClawTheme.colors.primaryText else ClawTheme.colors.textSubtle,
  ) {
    Box(modifier = Modifier.padding(8.dp).background(if (enabled) ClawTheme.colors.primary else ClawTheme.colors.surfacePressed, CircleShape), contentAlignment = Alignment.Center) {
      Icon(imageVector = Icons.Default.ArrowUpward, contentDescription = nativeString("Send"), modifier = Modifier.size(20.dp))
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
  val total = usage.totalTokens?.takeIf { it >= 0L } ?: return null
  val context = usage.contextTokens?.takeIf { it > 0L } ?: return null
  return (total.toDouble() / context.toDouble()).coerceIn(0.0, 1.0).toFloat()
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

internal fun chatFastModeControlEnabled(
  supported: Boolean,
  adminAuthorized: Boolean,
  connected: Boolean,
  gatewayAvailable: Boolean,
  loading: Boolean,
  sending: Boolean,
  activeRun: Boolean,
  streaming: Boolean,
  settingsMutationPending: Boolean,
): Boolean =
  supported &&
    adminAuthorized &&
    connected &&
    gatewayAvailable &&
    !loading &&
    !sending &&
    !activeRun &&
    !streaming &&
    !settingsMutationPending

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
