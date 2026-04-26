package ai.openclaw.app

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import androidx.core.app.NotificationCompat
import androidx.core.app.ServiceCompat
import androidx.core.content.ContextCompat
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.flow.combine
import kotlinx.coroutines.launch

class NodeForegroundService : Service() {
  private val scope: CoroutineScope = CoroutineScope(SupervisorJob() + Dispatchers.Main)
  private var notificationJob: Job? = null
  private var didStartForeground = false
  private var voiceCaptureMode = VoiceCaptureMode.Off

  override fun onCreate() {
    super.onCreate()
    ensureChannel()
    val initial = buildNotification(title = "OpenClaw Node", text = "Starting…")
    startForegroundWithTypes(notification = initial)

    val runtime = (application as NodeApp).peekRuntime()
    if (runtime == null) {
      stopSelf()
      return
    }
    notificationJob =
      scope.launch {
        combine(
          combine(
            runtime.statusText,
            runtime.serverName,
            runtime.isConnected,
            runtime.voiceCaptureMode,
          ) { status, server, connected, mode ->
            VoiceNotificationBase(
              status = status,
              server = server,
              connected = connected,
              mode = mode,
            )
          },
          combine(
            runtime.micEnabled,
            runtime.micIsListening,
            runtime.talkModeListening,
            runtime.talkModeSpeaking,
          ) { micEnabled, micListening, talkListening, talkSpeaking ->
            VoiceNotificationCapture(
              micEnabled = micEnabled,
              micListening = micListening,
              talkListening = talkListening,
              talkSpeaking = talkSpeaking,
            )
          },
        ) { base, capture ->
          VoiceNotificationState(base = base, capture = capture)
        }.collect { state ->
          voiceCaptureMode = state.mode
          val title =
            when {
              state.connected && state.mode == VoiceCaptureMode.TalkMode -> "OpenClaw Node · Talk"
              state.connected -> "OpenClaw Node · Connected"
              else -> "OpenClaw Node"
            }
          val text =
            (state.server?.let { "${state.status} · $it" } ?: state.status) +
              voiceNotificationSuffix(
                mode = state.mode,
                manualMicEnabled = state.capture.micEnabled,
                manualMicListening = state.capture.micListening,
                talkListening = state.capture.talkListening,
                talkSpeaking = state.capture.talkSpeaking,
              )

          startForegroundWithTypes(
            notification = buildNotification(title = title, text = text),
          )
        }
      }
  }

  override fun onStartCommand(
    intent: Intent?,
    flags: Int,
    startId: Int,
  ): Int {
    when (intent?.action) {
      ACTION_STOP -> {
        (application as NodeApp).peekRuntime()?.disconnect()
        stopSelf()
        return START_NOT_STICKY
      }
      ACTION_SET_VOICE_CAPTURE_MODE -> {
        voiceCaptureMode = intent.getStringExtra(EXTRA_VOICE_CAPTURE_MODE).toVoiceCaptureMode()
        startForegroundWithTypes(
          notification =
            buildNotification(
              title = "OpenClaw Node",
              text = if (voiceCaptureMode == VoiceCaptureMode.TalkMode) "Talk mode active" else "Connected",
            ),
        )
      }
    }
    // Keep running; connection is managed by NodeRuntime (auto-reconnect + manual).
    return START_STICKY
  }

  override fun onDestroy() {
    notificationJob?.cancel()
    scope.cancel()
    super.onDestroy()
  }

  override fun onBind(intent: Intent?) = null

  private fun ensureChannel() {
    val mgr = getSystemService(NotificationManager::class.java)
    val channel =
      NotificationChannel(
        CHANNEL_ID,
        "Connection",
        NotificationManager.IMPORTANCE_LOW,
      ).apply {
        description = "OpenClaw node connection status"
        setShowBadge(false)
      }
    mgr.createNotificationChannel(channel)
  }

  private fun buildNotification(title: String, text: String): Notification {
    val launchIntent = Intent(this, MainActivity::class.java).apply {
      flags = Intent.FLAG_ACTIVITY_SINGLE_TOP or Intent.FLAG_ACTIVITY_CLEAR_TOP
    }
    val launchPending =
      PendingIntent.getActivity(
        this,
        1,
        launchIntent,
        PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
      )

    val stopIntent = Intent(this, NodeForegroundService::class.java).setAction(ACTION_STOP)
    val stopPending =
      PendingIntent.getService(
        this,
        2,
        stopIntent,
        PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
      )

    return NotificationCompat.Builder(this, CHANNEL_ID)
      .setSmallIcon(R.mipmap.ic_launcher)
      .setContentTitle(title)
      .setContentText(text)
      .setContentIntent(launchPending)
      .setOngoing(true)
      .setOnlyAlertOnce(true)
      .setForegroundServiceBehavior(NotificationCompat.FOREGROUND_SERVICE_IMMEDIATE)
      .addAction(0, "Disconnect", stopPending)
      .build()
  }

  private fun startForegroundWithTypes(notification: Notification) {
    val serviceTypes = foregroundServiceTypesForVoiceMode(voiceCaptureMode)
    if (didStartForeground) {
      ServiceCompat.startForeground(this, NOTIFICATION_ID, notification, serviceTypes)
      return
    }
    ServiceCompat.startForeground(this, NOTIFICATION_ID, notification, serviceTypes)
    didStartForeground = true
  }

  companion object {
    private const val CHANNEL_ID = "connection"
    private const val NOTIFICATION_ID = 1

    private const val ACTION_STOP = "ai.openclaw.app.action.STOP"
    private const val ACTION_SET_VOICE_CAPTURE_MODE = "ai.openclaw.app.action.SET_VOICE_CAPTURE_MODE"
    private const val EXTRA_VOICE_CAPTURE_MODE = "ai.openclaw.app.extra.VOICE_CAPTURE_MODE"

    fun start(context: Context) {
      val intent = Intent(context, NodeForegroundService::class.java)
      context.startForegroundService(intent)
    }

    fun stop(context: Context) {
      val intent = Intent(context, NodeForegroundService::class.java).setAction(ACTION_STOP)
      context.startService(intent)
    }

    fun setVoiceCaptureMode(
      context: Context,
      mode: VoiceCaptureMode,
    ) {
      val intent =
        Intent(context, NodeForegroundService::class.java)
          .setAction(ACTION_SET_VOICE_CAPTURE_MODE)
          .putExtra(EXTRA_VOICE_CAPTURE_MODE, mode.name)
      if (mode == VoiceCaptureMode.TalkMode) {
        ContextCompat.startForegroundService(context, intent)
      } else {
        context.startService(intent)
      }
    }
  }
}

internal fun foregroundServiceTypesForVoiceMode(mode: VoiceCaptureMode): Int {
  val base = ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC
  return if (mode == VoiceCaptureMode.TalkMode) {
    base or ServiceInfo.FOREGROUND_SERVICE_TYPE_MICROPHONE
  } else {
    base
  }
}

internal fun voiceNotificationSuffix(
  mode: VoiceCaptureMode,
  manualMicEnabled: Boolean,
  manualMicListening: Boolean,
  talkListening: Boolean,
  talkSpeaking: Boolean,
): String {
  return when (mode) {
    VoiceCaptureMode.TalkMode ->
      when {
        talkSpeaking -> " · Talk: Speaking"
        talkListening -> " · Talk: Listening"
        else -> " · Talk: On"
      }
    VoiceCaptureMode.ManualMic ->
      if (manualMicEnabled) {
        if (manualMicListening) " · Mic: Listening" else " · Mic: Pending"
      } else {
        ""
      }
    VoiceCaptureMode.Off -> ""
  }
}

private fun String?.toVoiceCaptureMode(): VoiceCaptureMode {
  return VoiceCaptureMode.entries.firstOrNull { it.name == this } ?: VoiceCaptureMode.Off
}

private data class VoiceNotificationBase(
  val status: String,
  val server: String?,
  val connected: Boolean,
  val mode: VoiceCaptureMode,
)

private data class VoiceNotificationCapture(
  val micEnabled: Boolean,
  val micListening: Boolean,
  val talkListening: Boolean,
  val talkSpeaking: Boolean,
)

private data class VoiceNotificationState(
  val base: VoiceNotificationBase,
  val capture: VoiceNotificationCapture,
) {
  val status: String
    get() = base.status
  val server: String?
    get() = base.server
  val connected: Boolean
    get() = base.connected
  val mode: VoiceCaptureMode
    get() = base.mode
}
