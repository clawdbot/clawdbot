package ai.openclaw.app

import android.content.ContentResolver
import android.content.Intent
import android.net.Uri
import androidx.core.content.IntentCompat

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
  val imageUris: List<Uri>,
  val droppedImageCount: Int,
)

private data class SharedImageSelection(
  val uris: List<Uri>,
  val droppedCount: Int,
)

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

/** Parses Android Sharesheet content without reading external providers on the main thread. */
fun parseShareLaunchIntent(intent: Intent?): ShareLaunchRequest? {
  val action = intent?.action ?: return null
  if (action != Intent.ACTION_SEND && action != Intent.ACTION_SEND_MULTIPLE) return null

  val text =
    listOf(intent.getStringExtra(Intent.EXTRA_SUBJECT), intent.getCharSequenceExtra(Intent.EXTRA_TEXT)?.toString())
      .mapNotNull { value -> value?.trim()?.takeIf { it.isNotEmpty() } }
      .distinct()
      .joinToString(separator = "\n\n")
      .ifEmpty { null }
  val imageSelection =
    if (intent.type?.startsWith("image/", ignoreCase = true) == true) {
      sharedImageUris(intent, action)
    } else {
      SharedImageSelection(uris = emptyList(), droppedCount = 0)
    }

  if (text == null && imageSelection.uris.isEmpty()) return null
  return ShareLaunchRequest(
    text = text,
    imageUris = imageSelection.uris,
    droppedImageCount = imageSelection.droppedCount,
  )
}

private fun sharedImageUris(
  intent: Intent,
  action: String,
): SharedImageSelection {
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
  return SharedImageSelection(
    uris = validUris.take(MAX_SHARED_IMAGE_COUNT),
    droppedCount = (validUris.size - MAX_SHARED_IMAGE_COUNT).coerceAtLeast(0),
  )
}

private const val MAX_SHARED_IMAGE_COUNT = 8
