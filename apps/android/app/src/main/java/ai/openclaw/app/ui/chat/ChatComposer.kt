package ai.openclaw.app.ui.chat

import ai.openclaw.app.ChatDraft
import ai.openclaw.app.ChatDraftPlacement
import ai.openclaw.app.ChatShareDraft
import ai.openclaw.app.chat.OUTBOX_MAX_COMMAND_ATTACHMENT_BYTES
import ai.openclaw.app.chat.VoiceNoteRecorderState
import android.net.Uri
import kotlinx.coroutines.CancellationException

internal fun mergeChatDraft(
  draft: ChatDraft?,
  currentInput: String,
): String? {
  val text = draft?.text?.takeIf { it.isNotBlank() } ?: return null
  return when (draft.placement) {
    ChatDraftPlacement.Replace -> text
    ChatDraftPlacement.BeforeExisting -> text + currentInput
  }
}

/** Appends system shares so existing drafts stay first and queued shares remain FIFO. */
internal fun mergeSharedChatText(
  sharedText: String?,
  currentInput: String,
): String {
  val shared = sharedText?.trim()?.takeIf { it.isNotEmpty() } ?: return currentInput
  return if (currentInput.isEmpty()) shared else listOf(currentInput, shared).joinToString(separator = "\n\n")
}

internal data class StagedChatShare(
  val text: String?,
  val attachments: List<PendingAttachment>,
  val failedImageCount: Int,
  val droppedImageCount: Int,
)

internal const val CHAT_COMPOSER_MAX_ATTACHMENTS = 8
internal const val CHAT_COMPOSER_MAX_DECODED_ATTACHMENT_BYTES = OUTBOX_MAX_COMMAND_ATTACHMENT_BYTES
internal const val CHAT_COMPOSER_MAX_BASE64_CHARS = ((CHAT_COMPOSER_MAX_DECODED_ATTACHMENT_BYTES + 2) / 3) * 4

internal data class ChatAttachmentAdmission(
  val accepted: List<PendingAttachment>,
  val omittedCount: Int,
)

internal fun admitChatAttachments(
  currentAttachments: List<PendingAttachment>,
  candidates: List<PendingAttachment>,
  maxAttachmentCount: Int = CHAT_COMPOSER_MAX_ATTACHMENTS,
  maxBase64Chars: Long = CHAT_COMPOSER_MAX_BASE64_CHARS,
  maxDecodedBytes: Long = CHAT_COMPOSER_MAX_DECODED_ATTACHMENT_BYTES,
): ChatAttachmentAdmission {
  require(maxAttachmentCount >= 0 && maxBase64Chars >= 0 && maxDecodedBytes >= 0)
  val accepted = mutableListOf<PendingAttachment>()
  var base64Chars = currentAttachments.sumOf { it.base64.length.toLong() }
  var decodedBytes = currentAttachments.sumOf { decodedBase64ByteCount(it.base64) }
  var omittedCount = 0
  for (candidate in candidates) {
    val candidateBase64Chars = candidate.base64.length.toLong()
    val candidateDecodedBytes = decodedBase64ByteCount(candidate.base64)
    val withinCount = currentAttachments.size + accepted.size < maxAttachmentCount
    val withinBase64 = candidateBase64Chars <= maxBase64Chars - base64Chars
    val withinDecoded = candidateDecodedBytes <= maxDecodedBytes - decodedBytes
    if (withinCount && withinBase64 && withinDecoded) {
      accepted += candidate
      base64Chars += candidateBase64Chars
      decodedBytes += candidateDecodedBytes
    } else {
      omittedCount += 1
    }
  }
  return ChatAttachmentAdmission(accepted = accepted, omittedCount = omittedCount)
}

private fun decodedBase64ByteCount(base64: String): Long {
  val padding =
    when {
      base64.endsWith("==") -> 2
      base64.endsWith('=') -> 1
      else -> 0
    }
  return ((base64.length.toLong() * 3) / 4 - padding).coerceAtLeast(0)
}

/** Loads a complete queue head before any part of it becomes visible in the composer. */
internal suspend fun stageChatShareDraft(
  draft: ChatShareDraft,
  currentAttachments: List<PendingAttachment>,
  loadImage: suspend (Uri) -> PendingAttachment,
): StagedChatShare {
  val attachments = mutableListOf<PendingAttachment>()
  var failedImageCount = 0
  var droppedImageCount = draft.droppedImageCount
  for (uri in draft.imageUris) {
    try {
      val candidate = loadImage(uri)
      val admission = admitChatAttachments(currentAttachments + attachments, listOf(candidate))
      attachments += admission.accepted
      droppedImageCount += admission.omittedCount
    } catch (error: CancellationException) {
      // Screen disposal must leave the queue head unacknowledged for the next ChatScreen.
      throw error
    } catch (_: Exception) {
      failedImageCount += 1
    }
  }
  return StagedChatShare(
    text = draft.text,
    attachments = attachments,
    failedImageCount = failedImageCount,
    droppedImageCount = droppedImageCount,
  )
}

internal data class ChatShareComposerMerge(
  val input: String,
  val attachments: List<PendingAttachment>,
  val failedImageCount: Int,
  val droppedImageCount: Int,
)

internal fun mergeStagedChatShare(
  staged: StagedChatShare,
  currentInput: String,
  currentAttachments: List<PendingAttachment>,
): ChatShareComposerMerge {
  val admission = admitChatAttachments(currentAttachments, staged.attachments)
  return ChatShareComposerMerge(
    input = mergeSharedChatText(sharedText = staged.text, currentInput = currentInput),
    attachments = currentAttachments + admission.accepted,
    failedImageCount = staged.failedImageCount,
    droppedImageCount = staged.droppedImageCount + admission.omittedCount,
  )
}

internal fun canCommitStagedChatShare(
  stagedId: Long,
  currentHead: ChatShareDraft?,
): Boolean = currentHead?.id == stagedId

internal fun chatComposerSendEnabled(
  voiceNoteState: VoiceNoteRecorderState,
  pendingRunCount: Int,
  hasContent: Boolean,
  shareStaging: Boolean,
): Boolean =
  !shareStaging &&
    voiceNoteState !is VoiceNoteRecorderState.Recording &&
    voiceNoteState !is VoiceNoteRecorderState.Preparing &&
    pendingRunCount == 0 &&
    hasContent
