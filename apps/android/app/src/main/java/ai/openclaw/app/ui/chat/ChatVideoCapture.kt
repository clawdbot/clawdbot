package ai.openclaw.app.ui.chat

import android.app.Activity
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.net.Uri
import android.provider.MediaStore
import androidx.activity.result.contract.ActivityResultContract
import androidx.core.content.FileProvider
import java.io.File

internal const val CHAT_VIDEO_CAPTURE_CACHE_DIR = "chat-captures"
internal const val CHAT_VIDEO_CAPTURE_MIME_TYPE = "video/mp4"

/** Output target for system video capture that the composer can stage as an attachment. */
internal data class ChatVideoCaptureTarget(
  val file: File,
  val uri: Uri,
)

/** True when a handler for [MediaStore.ACTION_VIDEO_CAPTURE] is installed. */
internal fun canLaunchSystemVideoCapture(context: Context): Boolean {
  val intent = Intent(MediaStore.ACTION_VIDEO_CAPTURE)
  return intent.resolveActivity(context.packageManager) != null
}

/** Creates a cache FileProvider destination for one camera recording. */
internal fun createChatVideoCaptureTarget(context: Context): ChatVideoCaptureTarget {
  val dir = File(context.cacheDir, CHAT_VIDEO_CAPTURE_CACHE_DIR).apply { mkdirs() }
  val file = File(dir, "capture-${System.currentTimeMillis()}.mp4")
  val uri =
    FileProvider.getUriForFile(
      context,
      "${context.packageName}.fileprovider",
      file,
    )
  return ChatVideoCaptureTarget(file = file, uri = uri)
}

/** Best-effort cleanup for cancelled or failed capture outputs. */
internal fun deleteChatVideoCaptureTarget(target: ChatVideoCaptureTarget?) {
  if (target == null) return
  runCatching { if (target.file.exists()) target.file.delete() }
}

/**
 * System camera video capture into a FileProvider URI.
 *
 * Grants write/read access to every resolved camera activity so OEM handlers can write the clip.
 */
internal class CaptureVideoToUri : ActivityResultContract<Uri, Boolean>() {
  override fun createIntent(
    context: Context,
    input: Uri,
  ): Intent {
    val intent =
      Intent(MediaStore.ACTION_VIDEO_CAPTURE)
        .putExtra(MediaStore.EXTRA_OUTPUT, input)
        .addFlags(Intent.FLAG_GRANT_WRITE_URI_PERMISSION or Intent.FLAG_GRANT_READ_URI_PERMISSION)
    val flags = Intent.FLAG_GRANT_WRITE_URI_PERMISSION or Intent.FLAG_GRANT_READ_URI_PERMISSION
    context.packageManager
      .queryIntentActivities(intent, PackageManager.MATCH_DEFAULT_ONLY)
      .forEach { resolveInfo ->
        context.grantUriPermission(resolveInfo.activityInfo.packageName, input, flags)
      }
    return intent
  }

  override fun parseResult(
    resultCode: Int,
    intent: Intent?,
  ): Boolean = resultCode == Activity.RESULT_OK
}
