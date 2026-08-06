package ai.openclaw.wear

import android.Manifest
import android.annotation.SuppressLint
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.os.Build
import android.util.Log
import androidx.core.app.NotificationCompat
import androidx.core.app.NotificationManagerCompat
import androidx.core.app.Person
import androidx.core.app.RemoteInput
import androidx.core.content.ContextCompat
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.TimeoutCancellationException
import kotlinx.coroutines.launch
import kotlinx.coroutines.withTimeout
import java.security.MessageDigest

internal class WearReplyNotifier(
  private val context: Context,
) {
  fun show(inbound: WearInboundEvent) {
    val event = parseWearChatEvent(inbound.payload) ?: return
    if (event.state != "final") return
    val message = event.message ?: return
    if (message.role != "assistant") return
    val sessionKey = event.sessionKey ?: return
    if (!notificationsAllowed()) return

    createChannel()
    val fallbackIdentity =
      event.runId
        ?: listOf(
          "source:${inbound.sourceNodeId}",
          "stream:${inbound.streamId ?: "legacy"}",
          "sequence:${inbound.sequence}",
        ).joinToString("\u0000")
    val notificationTag = replyNotificationTag(sessionKey, message, fallbackIdentity)
    val requestCode = NOTIFICATION_ID
    val replyAction = createReplyAction(sessionKey, notificationTag, inbound.sourceNodeId)
    val openPendingIntent = createOpenAppIntent(requestCode)
    val agent = Person.Builder().setName("OpenClaw").build()
    val notification =
      NotificationCompat
        .Builder(context, CHANNEL_ID)
        .setSmallIcon(R.drawable.ic_notification)
        .setContentTitle(context.getString(R.string.notification_title))
        .setContentText(message.text)
        .setContentIntent(openPendingIntent)
        .setAutoCancel(true)
        .setLocalOnly(true)
        .setOnlyAlertOnce(true)
        .setStyle(
          NotificationCompat
            .MessagingStyle(agent)
            .addMessage(message.text, message.timestamp ?: System.currentTimeMillis(), agent),
        ).addAction(replyAction)
        .build()
    notify(notificationTag, notification)
  }

  fun showReplyFailure(
    sessionKey: String,
    notificationTag: String,
    phoneNodeId: String,
  ) {
    if (!notificationsAllowed()) return
    createChannel()
    val notification =
      NotificationCompat
        .Builder(context, CHANNEL_ID)
        .setSmallIcon(R.drawable.ic_notification)
        .setContentTitle(context.getString(R.string.notification_reply_failed_title))
        .setContentText(context.getString(R.string.notification_reply_failed_text))
        .setAutoCancel(true)
        .setLocalOnly(true)
        .addAction(createReplyAction(sessionKey, notificationTag, phoneNodeId))
        .build()
    notify(notificationTag, notification)
  }

  fun showPreferredPhoneChanged(notificationTag: String) {
    if (!notificationsAllowed()) return
    createChannel()
    val notification =
      NotificationCompat
        .Builder(context, CHANNEL_ID)
        .setSmallIcon(R.drawable.ic_notification)
        .setContentTitle(context.getString(R.string.notification_phone_changed_title))
        .setContentText(context.getString(R.string.notification_phone_changed_text))
        .setContentIntent(createOpenAppIntent(NOTIFICATION_ID))
        .setAutoCancel(true)
        .setLocalOnly(true)
        .build()
    notify(notificationTag, notification)
  }

  private fun createOpenAppIntent(requestCode: Int): PendingIntent =
    PendingIntent.getActivity(
      context,
      requestCode,
      Intent(context, MainActivity::class.java),
      PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
    )

  private fun createReplyAction(
    sessionKey: String,
    notificationTag: String,
    phoneNodeId: String,
  ): NotificationCompat.Action {
    val replyIntent =
      Intent(context, WearReplyReceiver::class.java).apply {
        action = replyPendingIntentAction(sessionKey, notificationTag)
        putExtra(EXTRA_SESSION_KEY, sessionKey)
        putExtra(EXTRA_NOTIFICATION_TAG, notificationTag)
        putExtra(EXTRA_PHONE_NODE_ID, phoneNodeId)
      }
    val replyPendingIntent =
      PendingIntent.getBroadcast(
        context,
        NOTIFICATION_ID,
        replyIntent,
        PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_MUTABLE or PendingIntent.FLAG_ONE_SHOT,
      )
    val remoteInput =
      RemoteInput
        .Builder(REPLY_RESULT_KEY)
        .setLabel(context.getString(R.string.notification_reply))
        .build()
    return NotificationCompat.Action
      .Builder(
        R.drawable.ic_notification,
        context.getString(R.string.notification_reply),
        replyPendingIntent,
      ).addRemoteInput(remoteInput)
      .setAllowGeneratedReplies(true)
      .build()
  }

  private fun createChannel() {
    val manager = context.getSystemService(NotificationManager::class.java)
    if (manager.getNotificationChannel(CHANNEL_ID) != null) return
    manager.createNotificationChannel(
      NotificationChannel(
        CHANNEL_ID,
        context.getString(R.string.notification_channel_name),
        NotificationManager.IMPORTANCE_DEFAULT,
      ),
    )
  }

  private fun notificationsAllowed(): Boolean =
    Build.VERSION.SDK_INT < Build.VERSION_CODES.TIRAMISU ||
      ContextCompat.checkSelfPermission(context, Manifest.permission.POST_NOTIFICATIONS) == PackageManager.PERMISSION_GRANTED

  @SuppressLint("MissingPermission")
  private fun notify(
    notificationTag: String,
    notification: android.app.Notification,
  ) {
    if (!notificationsAllowed()) return
    try {
      NotificationManagerCompat.from(context).notify(notificationTag, NOTIFICATION_ID, notification)
    } catch (_: SecurityException) {
      // Permission can be revoked between the explicit check and notify().
    }
  }

  private companion object {
    const val CHANNEL_ID = "openclaw_wear_replies"
  }
}

class WearReplyReceiver : BroadcastReceiver() {
  override fun onReceive(
    context: Context,
    intent: Intent,
  ) {
    val sessionKey = intent.getStringExtra(EXTRA_SESSION_KEY)?.takeIf { it.isNotBlank() } ?: return
    val notificationTag = intent.getStringExtra(EXTRA_NOTIFICATION_TAG)?.takeIf { it.isNotBlank() } ?: return
    val phoneNodeId = intent.getStringExtra(EXTRA_PHONE_NODE_ID)?.takeIf { it.isNotBlank() } ?: return
    val reply =
      RemoteInput
        .getResultsFromIntent(intent)
        ?.getCharSequence(REPLY_RESULT_KEY)
        ?.toString()
        ?.trim()
        ?.takeIf { it.isNotEmpty() } ?: return
    val pendingResult = goAsync()
    val app =
      context.applicationContext as? WearApplication
        ?: run {
          pendingResult.finish()
          return
        }
    app.processScope.launch {
      try {
        // Broadcast receivers have a short execution window. Bound discovery,
        // transport, and response wait together so finish() always wins the race.
        withTimeout(REPLY_BROADCAST_TIMEOUT_MS) {
          app.gatewayRepository.send(
            WearSendAttempt(
              sessionKey = sessionKey,
              message = reply,
              idempotencyKey = notificationReplyIdempotencyKey(sessionKey, notificationTag, reply),
              phoneNodeId = phoneNodeId,
            ),
            requirePreferredPhone = true,
          )
        }
        NotificationManagerCompat.from(context).cancel(notificationTag, NOTIFICATION_ID)
      } catch (err: TimeoutCancellationException) {
        Log.w(LOG_TAG, "Wear notification reply timed out", err)
        WearReplyNotifier(context.applicationContext).showReplyFailure(sessionKey, notificationTag, phoneNodeId)
      } catch (err: CancellationException) {
        throw err
      } catch (err: Throwable) {
        Log.w(LOG_TAG, "Wear notification reply failed", err)
        val notifier = WearReplyNotifier(context.applicationContext)
        when (notificationReplyFailureAction(err)) {
          NotificationReplyFailureAction.RetrySamePhone ->
            notifier.showReplyFailure(sessionKey, notificationTag, phoneNodeId)
          NotificationReplyFailureAction.OpenApp -> notifier.showPreferredPhoneChanged(notificationTag)
        }
      } finally {
        pendingResult.finish()
      }
    }
  }
}

internal const val EXTRA_SESSION_KEY = "openclaw_wear_session_key"
internal const val EXTRA_NOTIFICATION_TAG = "openclaw_wear_notification_tag"
internal const val EXTRA_PHONE_NODE_ID = "openclaw_wear_phone_node_id"

internal fun replyNotificationTag(
  sessionKey: String,
  message: WearChatMessage,
  fallbackIdentity: String,
): String {
  val messageIdentity =
    when {
      message.id != null -> "id:${message.id}"
      message.timestamp != null -> "timestamp:${message.timestamp}\u0000${message.role}\u0000${message.text}"
      else -> "fallback:$fallbackIdentity"
    }
  return "ai.openclaw.wear.NOTIFICATION.${sha256("$sessionKey\u0000$messageIdentity")}"
}

internal fun replyPendingIntentAction(
  sessionKey: String,
  notificationTag: String,
): String = "ai.openclaw.wear.REPLY.${sha256("$sessionKey\u0000$notificationTag")}"

internal fun notificationReplyIdempotencyKey(
  sessionKey: String,
  notificationTag: String,
  reply: String,
): String = "wear-notification-${sha256("$sessionKey\u0000$notificationTag\u0000$reply")}"

internal enum class NotificationReplyFailureAction {
  RetrySamePhone,
  OpenApp,
}

internal fun notificationReplyFailureAction(error: Throwable): NotificationReplyFailureAction =
  if (error is WearProxyException && error.code == "phone_changed") {
    NotificationReplyFailureAction.OpenApp
  } else {
    NotificationReplyFailureAction.RetrySamePhone
  }

private fun sha256(value: String): String {
  val digest = MessageDigest.getInstance("SHA-256").digest(value.encodeToByteArray())
  return digest.joinToString(separator = "") { byte -> "%02x".format(byte.toInt() and 0xff) }
}

private const val LOG_TAG = "OpenClawWear"
private const val NOTIFICATION_ID = 7301
private const val REPLY_BROADCAST_TIMEOUT_MS = 5_000L
