package ai.openclaw.app

import android.app.PendingIntent
import android.content.Context
import android.content.Intent

/** Reuses the existing app task when a system surface brings OpenClaw forward. */
internal fun mainActivityPendingIntent(
  context: Context,
  requestCode: Int,
): PendingIntent {
  val intent =
    Intent(context, MainActivity::class.java).apply {
      flags = Intent.FLAG_ACTIVITY_SINGLE_TOP or Intent.FLAG_ACTIVITY_CLEAR_TOP
    }
  return PendingIntent.getActivity(
    context,
    requestCode,
    intent,
    PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
  )
}
