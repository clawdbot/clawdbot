package ai.openclaw.app.ui.chat

import ai.openclaw.app.chat.ChatComposerOwner
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import java.util.UUID

internal enum class ChatComposerAttachmentNotice {
  Attachment,
  Image,
}

internal enum class ChatComposerSendStartResult {
  Started,
  Unavailable,
  MessageTooLong,
  CheckpointFull,
}

internal data class ChatComposerSendRequest(
  val commandId: String,
  val owner: ChatComposerOwner,
  val inputSnapshot: String,
  val message: String,
  val attachments: List<PendingAttachment>,
)

internal data class ChatComposerSendStart(
  val result: ChatComposerSendStartResult,
  val request: ChatComposerSendRequest? = null,
)

internal data class ChatComposerSendState(
  // Stable ids let each completion release its own operation after owner aliases merge.
  val activeOperationIds: Set<String> = emptySet(),
  val pendingAdmissionIds: Set<String> = emptySet(),
) {
  val isEmpty: Boolean get() = activeOperationIds.isEmpty() && pendingAdmissionIds.isEmpty()
}

/** Owns all mutable state keyed by a composer owner and resolves aliases as one transaction. */
internal class ChatComposerStateStore(
  initialDrafts: ChatComposerDraftSnapshot = ChatComposerDraftSnapshot(),
  onDraftSnapshotChanged: (ArrayList<String>) -> Unit = {},
) {
  private val lock = Any()
  private val attachmentStore = ChatComposerAttachmentStore()
  private val mediaOwners = linkedMapOf<String, ChatComposerOwner>()

  val textDrafts =
    ChatComposerTextDraftStore(
      initial = initialDrafts,
      onSnapshotChanged = onDraftSnapshotChanged,
    )
  val attachments = attachmentStore.attachments

  private val attachmentNoticesState =
    MutableStateFlow<Map<ChatComposerOwner, ChatComposerAttachmentNotice>>(emptyMap())
  val attachmentNotices: StateFlow<Map<ChatComposerOwner, ChatComposerAttachmentNotice>> =
    attachmentNoticesState.asStateFlow()

  private val recoveredSends = textDrafts.pendingAdmissions()
  private val sendStatesState =
    MutableStateFlow(
      recoveredSends
        .groupBy(PendingChatComposerSend::owner, PendingChatComposerSend::commandId)
        .mapValues { (_, commandIds) -> ChatComposerSendState(activeOperationIds = commandIds.toSet()) },
    )
  val sendStates: StateFlow<Map<ChatComposerOwner, ChatComposerSendState>> = sendStatesState.asStateFlow()

  fun recoveredSends(): List<PendingChatComposerSend> = recoveredSends

  fun resolveRecoveredSend(
    commandId: String,
    fallbackOwner: ChatComposerOwner,
    admitted: Boolean,
  ) {
    synchronized(lock) {
      val resolvedOwner = textDrafts.resolveAdmission(commandId, admitted)?.owner ?: fallbackOwner
      finishActiveSendLocked(setOf(fallbackOwner, resolvedOwner), resolvedOwner, commandId)
    }
  }

  fun tryBeginTrackedSend(owner: ChatComposerOwner): String? =
    synchronized(lock) {
      if (hasSendGateLocked(owner)) return@synchronized null
      UUID.randomUUID().toString().also { id ->
        sendStatesState.value =
          sendStatesState.value + (owner to ChatComposerSendState(activeOperationIds = setOf(id)))
      }
    }

  fun finishTrackedSend(id: String) {
    synchronized(lock) {
      val (owner, current) =
        sendStatesState.value.entries.firstOrNull { (_, state) -> id in state.activeOperationIds } ?: return
      val next = current.copy(activeOperationIds = current.activeOperationIds - id)
      sendStatesState.value =
        if (next.isEmpty) sendStatesState.value - owner else sendStatesState.value + (owner to next)
    }
  }

  fun beginSend(owner: ChatComposerOwner): ChatComposerSendStart =
    synchronized(lock) {
      if (hasSendGateLocked(owner)) {
        return@synchronized ChatComposerSendStart(ChatComposerSendStartResult.Unavailable)
      }
      val inputSnapshot = textDrafts[owner]
      val attachments = attachmentStore.get(owner)
      if (inputSnapshot.isBlank() && attachments.isEmpty()) {
        return@synchronized ChatComposerSendStart(ChatComposerSendStartResult.Unavailable)
      }
      if (inputSnapshot.length > CHAT_COMPOSER_MAX_SEND_CHARS) {
        return@synchronized ChatComposerSendStart(ChatComposerSendStartResult.MessageTooLong)
      }
      val commandId = UUID.randomUUID().toString()
      if (!textDrafts.beginAdmission(commandId, owner, inputSnapshot)) {
        return@synchronized ChatComposerSendStart(ChatComposerSendStartResult.CheckpointFull)
      }
      sendStatesState.value =
        sendStatesState.value + (owner to ChatComposerSendState(activeOperationIds = setOf(commandId)))
      ChatComposerSendStart(
        result = ChatComposerSendStartResult.Started,
        request = ChatComposerSendRequest(commandId, owner, inputSnapshot, inputSnapshot.trim(), attachments),
      )
    }

  fun completeSend(
    request: ChatComposerSendRequest,
    accepted: Boolean?,
  ) {
    synchronized(lock) {
      if (accepted == null) {
        val currentOwner = textDrafts.pendingAdmission(request.commandId)?.owner ?: request.owner
        finishActiveSendLocked(setOf(request.owner, currentOwner), currentOwner, request.commandId)
        return
      }
      val pending = textDrafts.resolveAdmission(request.commandId, accepted)
      val resolvedOwner = pending?.owner ?: request.owner
      if (pending == null) {
        finishActiveSendLocked(setOf(request.owner), request.owner, request.commandId)
        return
      }
      if (accepted) {
        attachmentStore.remove(
          resolvedOwner,
          request.attachments.mapTo(linkedSetOf()) { attachment -> attachment.id },
        )
      }
      finishActiveSendLocked(
        owners = setOf(request.owner, resolvedOwner),
        resolvedOwner = resolvedOwner,
        activeOperationId = request.commandId,
        pendingAdmissionId = request.commandId,
      )
    }
  }

  fun acknowledgeSendAdmission(
    owner: ChatComposerOwner,
    id: String,
  ) {
    synchronized(lock) {
      val current = sendStatesState.value[owner] ?: return
      if (id !in current.pendingAdmissionIds) return
      val next = current.copy(pendingAdmissionIds = current.pendingAdmissionIds - id)
      sendStatesState.value =
        if (next.isEmpty) sendStatesState.value - owner else sendStatesState.value + (owner to next)
    }
  }

  fun beginMediaAcquisition(owner: ChatComposerOwner): String? {
    owner.gatewayStableId?.trim()?.takeIf { it.isNotEmpty() } ?: return null
    return synchronized(lock) {
      while (mediaOwners.size >= CHAT_COMPOSER_MAX_MEDIA_AUTHORIZATIONS) {
        mediaOwners.remove(mediaOwners.keys.firstOrNull() ?: break)
      }
      UUID.randomUUID().toString().also { id -> mediaOwners[id] = owner }
    }
  }

  fun isMediaAcquisitionActive(id: String): Boolean = synchronized(lock) { id in mediaOwners }

  fun cancelMediaAcquisition(id: String) = synchronized(lock) { mediaOwners.remove(id) }

  fun addAttachments(
    owner: ChatComposerOwner,
    candidates: List<PendingAttachment>,
  ): Int =
    synchronized(lock) {
      attachmentStore.add(owner, candidates).also { omitted ->
        recordAttachmentOmissionLocked(owner, omitted, ChatComposerAttachmentNotice.Attachment)
      }
    }

  fun addAuthorizedAttachments(
    owner: ChatComposerOwner,
    mediaAuthorizationId: String,
    candidates: List<PendingAttachment>,
  ): Int? =
    synchronized(lock) {
      if (mediaOwners.remove(mediaAuthorizationId) != owner) return@synchronized null
      attachmentStore.add(owner, candidates).also { omitted ->
        recordAttachmentOmissionLocked(owner, omitted, ChatComposerAttachmentNotice.Attachment)
      }
    }

  fun removeAttachments(
    owner: ChatComposerOwner,
    ids: Set<String>,
  ) = synchronized(lock) { attachmentStore.remove(owner, ids) }

  fun beginMediaImport(
    owner: ChatComposerOwner,
    mediaAuthorizationId: String,
    mainSessionKey: String,
  ): Long? =
    synchronized(lock) {
      val authorizedOwner = mediaOwners.remove(mediaAuthorizationId) ?: return@synchronized null
      if (authorizedOwner != owner && !shouldMigrateComposerDraft(authorizedOwner, owner, mainSessionKey)) {
        return@synchronized null
      }
      attachmentStore.beginImport(owner)
    }

  fun completeMediaImport(
    importId: Long,
    candidates: List<PendingAttachment>,
    failedCount: Int,
  ) {
    synchronized(lock) {
      attachmentStore.completeImport(importId, candidates)?.let { (owner, omitted) ->
        recordAttachmentOmissionLocked(
          owner,
          omitted + failedCount.coerceAtLeast(0),
          ChatComposerAttachmentNotice.Image,
        )
      }
    }
  }

  fun cancelMediaImport(importId: Long) = synchronized(lock) { attachmentStore.cancelImport(importId) }

  fun clearAttachmentOmission(owner: ChatComposerOwner) = synchronized(lock) { attachmentNoticesState.value = attachmentNoticesState.value - owner }

  fun reportImageOmission(
    owner: ChatComposerOwner,
    omitted: Int,
  ) = synchronized(lock) { recordAttachmentOmissionLocked(owner, omitted, ChatComposerAttachmentNotice.Image) }

  /** Migrates every state surface and returns aliases owned by external queues. */
  fun resolveAliases(
    to: ChatComposerOwner,
    mainSessionKey: String,
  ): Set<ChatComposerOwner> =
    synchronized(lock) {
      val mediaSources =
        mediaOwners.values.filterTo(linkedSetOf()) { source ->
          shouldMigrateComposerDraft(source, to, mainSessionKey)
        }
      if (mediaSources.isNotEmpty()) {
        for ((id, owner) in mediaOwners.toMap()) {
          if (owner in mediaSources) mediaOwners[id] = to
        }
      }

      val textSources = textDrafts.migrateMatching(to = to, mainSessionKey = mainSessionKey)
      val attachmentMigration = attachmentStore.migrateMatching(to = to, mainSessionKey = mainSessionKey)
      val sendSources = sendStatesState.value.keys.filterTo(linkedSetOf()) { source -> shouldMigrateComposerDraft(source, to, mainSessionKey) }
      val noticeSources =
        attachmentNoticesState.value.keys.filterTo(linkedSetOf()) { source ->
          shouldMigrateComposerDraft(source, to, mainSessionKey)
        }
      val sources = textSources + attachmentMigration.sources + sendSources + mediaSources + noticeSources

      if (sendSources.isNotEmpty()) {
        val owners = sendSources + to
        val merged = mergeSendStatesLocked(owners)
        sendStatesState.value = (sendStatesState.value - owners) + (to to merged)
      }

      val currentNotices = attachmentNoticesState.value
      val sourceNotices = sources.mapNotNull(currentNotices::get)
      var nextNotices = currentNotices - sources
      val nextNotice =
        when {
          attachmentMigration.omittedCount > 0 ||
            currentNotices[to] == ChatComposerAttachmentNotice.Attachment ||
            ChatComposerAttachmentNotice.Attachment in sourceNotices -> ChatComposerAttachmentNotice.Attachment
          currentNotices[to] == ChatComposerAttachmentNotice.Image ||
            ChatComposerAttachmentNotice.Image in sourceNotices -> ChatComposerAttachmentNotice.Image
          else -> null
        }
      if (nextNotice != null) nextNotices += (to to nextNotice)
      attachmentNoticesState.value = nextNotices
      sources
    }

  fun removeMediaOwners(matches: (ChatComposerOwner) -> Boolean) {
    synchronized(lock) { removeMediaOwnersLocked(matches) }
  }

  fun removeOwners(
    matches: (ChatComposerOwner) -> Boolean,
    retainedSendId: String? = null,
  ) {
    synchronized(lock) {
      removeMediaOwnersLocked(matches)
      textDrafts.removeOwners(matches)
      val currentSendStates = sendStatesState.value
      var nextSendStates = currentSendStates.filterKeys { !matches(it) }
      val retainedEntry =
        retainedSendId?.let { id ->
          currentSendStates.entries.firstOrNull { (_, state) -> id in state.activeOperationIds }
        }
      if (retainedEntry != null && matches(retainedEntry.key)) {
        val retainedState =
          ChatComposerSendState(activeOperationIds = setOf(requireNotNull(retainedSendId)))
        nextSendStates += retainedEntry.key to retainedState
      }
      sendStatesState.value = nextSendStates
      attachmentNoticesState.value = attachmentNoticesState.value.filterKeys { !matches(it) }
    }
  }

  private fun hasSendGateLocked(owner: ChatComposerOwner): Boolean = owner in sendStatesState.value

  private fun finishActiveSendLocked(
    owners: Set<ChatComposerOwner>,
    resolvedOwner: ChatComposerOwner,
    activeOperationId: String,
    pendingAdmissionId: String? = null,
  ) {
    val sources = owners + resolvedOwner
    val merged = mergeSendStatesLocked(sources)
    val pendingAdmissionIds =
      pendingAdmissionId?.let { merged.pendingAdmissionIds + it } ?: merged.pendingAdmissionIds
    val next =
      merged.copy(
        activeOperationIds = merged.activeOperationIds - activeOperationId,
        pendingAdmissionIds = pendingAdmissionIds,
      )
    sendStatesState.value =
      (sendStatesState.value - sources).let { retained ->
        if (next.isEmpty) retained else retained + (resolvedOwner to next)
      }
  }

  private fun mergeSendStatesLocked(owners: Set<ChatComposerOwner>): ChatComposerSendState =
    owners
      .mapNotNull(sendStatesState.value::get)
      .fold(ChatComposerSendState()) { merged, current ->
        ChatComposerSendState(
          activeOperationIds = merged.activeOperationIds + current.activeOperationIds,
          pendingAdmissionIds = merged.pendingAdmissionIds + current.pendingAdmissionIds,
        )
      }

  private fun removeMediaOwnersLocked(matches: (ChatComposerOwner) -> Boolean) {
    mediaOwners.entries.removeAll { matches(it.value) }
    attachmentStore.removeOwners(matches)
  }

  private fun recordAttachmentOmissionLocked(
    owner: ChatComposerOwner,
    omitted: Int,
    notice: ChatComposerAttachmentNotice,
  ) {
    if (omitted <= 0) return
    val current = attachmentNoticesState.value[owner]
    val resolved = if (current == ChatComposerAttachmentNotice.Attachment) current else notice
    attachmentNoticesState.value = attachmentNoticesState.value + (owner to resolved)
  }

  private companion object {
    const val CHAT_COMPOSER_MAX_MEDIA_AUTHORIZATIONS = 32
  }
}
