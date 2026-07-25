package ai.openclaw.app.ui.chat

import ai.openclaw.app.chat.ChatComposerOwner
import ai.openclaw.app.chat.OutgoingAttachment
import ai.openclaw.app.chat.VOICE_NOTE_MIME_TYPE
import ai.openclaw.app.chat.VoiceNoteRecording
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import java.util.Base64
import java.util.concurrent.atomic.AtomicLong

/** Attachment staged in a composer until the next chat.send call. */
data class PendingAttachment(
  val id: String,
  val fileName: String,
  val mimeType: String,
  val base64: String,
  val durationMs: Long? = null,
)

internal data class ChatComposerAttachmentMigration(
  val sources: Set<ChatComposerOwner>,
  val omittedCount: Int,
)

/** ViewModel-owned heap state; attachment payloads are too large for Android saved state. */
internal class ChatComposerAttachmentStore(
  private val maxTotalAttachmentCount: Int = CHAT_COMPOSER_MAX_TOTAL_ATTACHMENTS,
  private val maxTotalBase64Chars: Long = CHAT_COMPOSER_MAX_TOTAL_BASE64_CHARS,
  private val maxTotalDecodedBytes: Long = CHAT_COMPOSER_MAX_TOTAL_DECODED_ATTACHMENT_BYTES,
) {
  init {
    require(maxTotalAttachmentCount >= 0 && maxTotalBase64Chars >= 0 && maxTotalDecodedBytes >= 0)
  }

  private val lock = Any()
  private val importSequence = AtomicLong()
  private val importOwners = mutableMapOf<Long, ChatComposerOwner>()
  private val _attachments = MutableStateFlow<Map<ChatComposerOwner, List<PendingAttachment>>>(emptyMap())
  val attachments: StateFlow<Map<ChatComposerOwner, List<PendingAttachment>>> = _attachments.asStateFlow()

  fun add(
    owner: ChatComposerOwner,
    candidates: List<PendingAttachment>,
  ): Int =
    synchronized(lock) {
      addLocked(owner, candidates)
    }

  fun beginImport(owner: ChatComposerOwner): Long =
    synchronized(lock) {
      importSequence.incrementAndGet().also { importOwners[it] = owner }
    }

  fun completeImport(
    id: Long,
    candidates: List<PendingAttachment>,
  ): Pair<ChatComposerOwner, Int>? =
    synchronized(lock) {
      val owner = importOwners.remove(id) ?: return@synchronized null
      owner to addLocked(owner, candidates)
    }

  fun cancelImport(id: Long) {
    synchronized(lock) {
      importOwners.remove(id)
    }
  }

  fun remove(
    owner: ChatComposerOwner,
    ids: Set<String>,
  ) {
    if (ids.isEmpty()) return
    synchronized(lock) {
      replaceLocked(owner, _attachments.value[owner].orEmpty().filterNot { it.id in ids })
    }
  }

  fun removeOwners(matches: (ChatComposerOwner) -> Boolean) {
    synchronized(lock) {
      importOwners.entries.removeAll { matches(it.value) }
      _attachments.value = _attachments.value.filterKeys { !matches(it) }
    }
  }

  fun migrate(
    from: ChatComposerOwner,
    to: ChatComposerOwner,
  ): Int {
    if (from == to) return 0
    return synchronized(lock) { migrateLocked(from = from, to = to) }
  }

  /** Resolves every parked alias and in-flight import, not only the visible composer. */
  fun migrateMatching(
    to: ChatComposerOwner,
    mainSessionKey: String,
  ): ChatComposerAttachmentMigration =
    synchronized(lock) {
      val sources =
        (_attachments.value.keys + importOwners.values)
          .filterTo(linkedSetOf()) { source -> shouldMigrateComposerDraft(source, to, mainSessionKey) }
      val omitted = sources.sumOf { source -> migrateLocked(from = source, to = to) }
      ChatComposerAttachmentMigration(sources = sources, omittedCount = omitted)
    }

  fun get(owner: ChatComposerOwner): List<PendingAttachment> = synchronized(lock) { _attachments.value[owner].orEmpty() }

  private fun addLocked(
    owner: ChatComposerOwner,
    candidates: List<PendingAttachment>,
  ): Int {
    val current = _attachments.value[owner].orEmpty()
    val admission = admitWithAggregateLimit(owner = owner, current = current, candidates = candidates)
    replaceLocked(owner, current + admission.accepted)
    return admission.omittedCount
  }

  private fun migrateLocked(
    from: ChatComposerOwner,
    to: ChatComposerOwner,
  ): Int {
    for ((id, owner) in importOwners.toMap()) {
      if (owner == from) importOwners[id] = to
    }
    val source = _attachments.value[from].orEmpty()
    if (source.isEmpty()) return 0
    val destination = _attachments.value[to].orEmpty()
    val admission = admitChatAttachments(currentAttachments = destination, candidates = source)
    var next = _attachments.value - from
    val merged = destination + admission.accepted
    next = if (merged.isEmpty()) next - to else next + (to to merged)
    _attachments.value = next
    return admission.omittedCount
  }

  private fun admitWithAggregateLimit(
    owner: ChatComposerOwner,
    current: List<PendingAttachment>,
    candidates: List<PendingAttachment>,
  ): ChatAttachmentAdmission {
    val otherAttachments =
      _attachments.value
        .asSequence()
        .filter { it.key != owner }
        .flatMap { it.value.asSequence() }
    var otherCount = 0
    var otherBase64Chars = 0L
    var otherDecodedBytes = 0L
    for (attachment in otherAttachments) {
      otherCount += 1
      otherBase64Chars += attachment.base64.length.toLong()
      otherDecodedBytes += decodedBase64ByteCount(attachment.base64)
    }
    return admitChatAttachments(
      currentAttachments = current,
      candidates = candidates,
      maxAttachmentCount = minOf(CHAT_COMPOSER_MAX_ATTACHMENTS, (maxTotalAttachmentCount - otherCount).coerceAtLeast(0)),
      maxBase64Chars = minOf(CHAT_COMPOSER_MAX_BASE64_CHARS, (maxTotalBase64Chars - otherBase64Chars).coerceAtLeast(0)),
      maxDecodedBytes = minOf(CHAT_COMPOSER_MAX_DECODED_ATTACHMENT_BYTES, (maxTotalDecodedBytes - otherDecodedBytes).coerceAtLeast(0)),
    )
  }

  private fun replaceLocked(
    owner: ChatComposerOwner,
    next: List<PendingAttachment>,
  ) {
    _attachments.value = if (next.isEmpty()) _attachments.value - owner else _attachments.value + (owner to next)
  }
}

internal fun PendingAttachment.toOutgoingAttachment(): OutgoingAttachment =
  OutgoingAttachment(
    type = attachmentTypeForMimeType(mimeType),
    mimeType = mimeType,
    fileName = fileName,
    base64 = base64,
    durationMs = durationMs,
  )

internal fun attachmentTypeForMimeType(mimeType: String): String =
  when {
    mimeType.startsWith("audio/") -> "audio"
    mimeType.startsWith("image/") -> "image"
    else -> "file"
  }

internal fun stageVoiceNoteAttachment(recording: VoiceNoteRecording): PendingAttachment =
  try {
    PendingAttachment(
      id = recording.file.absolutePath + "#" + recording.durationMs,
      fileName = recording.file.name,
      mimeType = VOICE_NOTE_MIME_TYPE,
      base64 = Base64.getEncoder().encodeToString(recording.file.readBytes()),
      durationMs = recording.durationMs,
    )
  } finally {
    recording.file.delete()
  }

internal fun formatVoiceNoteDuration(durationMs: Long): String {
  val totalSeconds = durationMs.coerceAtLeast(0L) / 1_000L
  val minutes = totalSeconds / 60L
  val seconds = totalSeconds % 60L
  return "$minutes:${seconds.toString().padStart(2, '0')}"
}
