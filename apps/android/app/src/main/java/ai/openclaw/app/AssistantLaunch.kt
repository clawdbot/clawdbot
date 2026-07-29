package ai.openclaw.app

import android.content.ContentResolver
import android.content.Intent
import android.net.Uri
import androidx.core.content.IntentCompat
import java.util.Locale

/** Android Assistant entry point used by manifest-declared app actions. */
const val actionAskOpenClaw = "ai.openclaw.app.action.ASK_OPENCLAW"

/** Debug action that opens the Voice tab directly for Android E2E automation. */
const val actionOpenVoiceE2e = "ai.openclaw.app.debug.OPEN_VOICE_E2E"

/** Intent extra that carries an optional assistant prompt for app actions. */
const val extraAssistantPrompt = "prompt"

/**
 * Top-level home destinations that external actions may request.
 */
enum class HomeDestination {
  Connect,
  Chat,
  Voice,
  Screen,
  Settings,
}

/**
 * Normalized launch request from Android Assistant or explicit app actions.
 */
data class AssistantLaunchRequest(
  val source: String,
  val prompt: String?,
  val autoSend: Boolean,
)

/** Shared content staged in chat for user review before sending. */
data class ShareLaunchRequest(
  val text: String?,
  val attachments: List<SharedAttachment>,
  val droppedAttachmentCount: Int,
)

enum class SharedAttachmentKind {
  Image,
  Audio,
  Document,
}

data class SharedAttachment(
  val uri: Uri,
  val kind: SharedAttachmentKind,
  val mimeType: String,
)

private data class SharedAttachmentSelection(
  val attachments: List<SharedAttachment>,
  val droppedCount: Int,
)

internal val SHARED_ATTACHMENT_MIME_ALLOWLIST =
  setOf(
    "image/*",
    "audio/*",
    "application/pdf",
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    "text/csv",
    "text/markdown",
  )

internal val SHARED_AUDIO_DOCUMENT_MIME_TYPES = SHARED_ATTACHMENT_MIME_ALLOWLIST.filterNot { it == "image/*" }.toTypedArray()

/**
 * Parses app-owned navigation actions that should open a specific home tab.
 */
fun parseHomeDestinationIntent(intent: Intent?): HomeDestination? {
  val action = intent?.action ?: return null
  return when {
    // Debug-only shortcut keeps E2E navigation out of release builds.
    BuildConfig.DEBUG && action == actionOpenVoiceE2e -> HomeDestination.Voice
    else -> null
  }
}

/**
 * Parse external assistant entry points without starting any UI side effects.
 */
fun parseAssistantLaunchIntent(intent: Intent?): AssistantLaunchRequest? {
  val action = intent?.action ?: return null
  return when (action) {
    Intent.ACTION_ASSIST ->
      AssistantLaunchRequest(
        source = "assist",
        prompt = null,
        autoSend = false,
      )

    actionAskOpenClaw -> {
      val prompt = intent.getStringExtra(extraAssistantPrompt)?.trim()?.ifEmpty { null }
      AssistantLaunchRequest(
        source = "app_action",
        prompt = prompt,
        autoSend = false,
      )
    }

    else -> null
  }
}

/** Parses Android Sharesheet metadata without opening or reading shared payload bytes. */
fun parseShareLaunchIntent(
  intent: Intent?,
  resolveMimeType: (Uri) -> String?,
): ShareLaunchRequest? {
  val action = intent?.action ?: return null
  if (action != Intent.ACTION_SEND && action != Intent.ACTION_SEND_MULTIPLE) return null

  val text =
    listOf(intent.getStringExtra(Intent.EXTRA_SUBJECT), intent.getCharSequenceExtra(Intent.EXTRA_TEXT)?.toString())
      .mapNotNull { value -> value?.trim()?.takeIf { it.isNotEmpty() } }
      .distinct()
      .joinToString(separator = "\n\n")
      .ifEmpty { null }
  val attachmentSelection = sharedAttachments(intent, action, resolveMimeType)

  if (text == null && attachmentSelection.attachments.isEmpty() && attachmentSelection.droppedCount == 0) return null
  return ShareLaunchRequest(
    text = text,
    attachments = attachmentSelection.attachments,
    droppedAttachmentCount = attachmentSelection.droppedCount,
  )
}

private fun sharedAttachments(
  intent: Intent,
  action: String,
  resolveMimeType: (Uri) -> String?,
): SharedAttachmentSelection {
  val streamUris =
    when (action) {
      Intent.ACTION_SEND ->
        listOfNotNull(IntentCompat.getParcelableExtra(intent, Intent.EXTRA_STREAM, Uri::class.java))

      Intent.ACTION_SEND_MULTIPLE ->
        IntentCompat.getParcelableArrayListExtra(intent, Intent.EXTRA_STREAM, Uri::class.java).orEmpty()

      else -> emptyList()
    }
  val clipUris =
    intent.clipData
      ?.let { clip ->
        (0 until clip.itemCount).mapNotNull { index -> clip.getItemAt(index).uri }
      }.orEmpty()

  // Only provider-backed content URIs use the sender's temporary read grant. Rejecting file://
  // prevents an external intent from turning OpenClaw into a reader for its own private files.
  val validUris =
    (streamUris + clipUris)
      .filter { uri -> uri.scheme.equals(ContentResolver.SCHEME_CONTENT, ignoreCase = true) }
      .distinct()
  val fallbackMimeType =
    normalizeSharedAttachmentMimeType(intent.type)
      ?.takeIf(::isStageableSharedAttachmentMimeType)
  val resolved = mutableListOf<SharedAttachment>()
  var droppedCount = 0
  for ((index, uri) in validUris.withIndex()) {
    if (resolved.size >= MAX_SHARED_ATTACHMENT_COUNT) {
      droppedCount += validUris.size - index
      break
    }
    val providerMimeType =
      try {
        normalizeSharedAttachmentMimeType(resolveMimeType(uri))
      } catch (_: Exception) {
        null
      }
    val mimeType = providerMimeType ?: fallbackMimeType
    val kind = sharedAttachmentKindForMimeType(mimeType)
    if (!isStageableSharedAttachmentMimeType(mimeType) || kind == null) {
      droppedCount += 1
      continue
    }
    resolved += SharedAttachment(uri = uri, kind = kind, mimeType = requireNotNull(mimeType))
  }
  return SharedAttachmentSelection(
    attachments = resolved,
    droppedCount = droppedCount,
  )
}

internal fun sharedAttachmentKindForMimeType(mimeType: String?): SharedAttachmentKind? {
  val normalized = normalizeSharedAttachmentMimeType(mimeType) ?: return null
  return when {
    normalized.startsWith("image/") -> SharedAttachmentKind.Image
    normalized.startsWith("audio/") -> SharedAttachmentKind.Audio
    normalized in SHARED_ATTACHMENT_MIME_ALLOWLIST -> SharedAttachmentKind.Document
    else -> null
  }
}

internal fun isStageableSharedAttachmentMimeType(mimeType: String?): Boolean {
  val normalized = normalizeSharedAttachmentMimeType(mimeType) ?: return false
  val kind = sharedAttachmentKindForMimeType(normalized) ?: return false
  return kind == SharedAttachmentKind.Image || !normalized.endsWith("/*")
}

internal fun normalizeSharedAttachmentMimeType(mimeType: String?): String? =
  mimeType
    ?.substringBefore(';')
    ?.trim()
    ?.lowercase(Locale.US)
    ?.takeIf { it.isNotEmpty() }

private const val MAX_SHARED_ATTACHMENT_COUNT = 8
