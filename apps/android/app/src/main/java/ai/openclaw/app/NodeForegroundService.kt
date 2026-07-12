package ai.openclaw.app

import ai.openclaw.app.i18n.nativeLocaleChanges
import ai.openclaw.app.i18n.nativeString
import android.Manifest
import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.content.pm.ServiceInfo
import android.util.Log
import androidx.core.app.NotificationCompat
import androidx.core.app.ServiceCompat
import androidx.core.content.ContextCompat
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.combine
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext

/** Foreground service that keeps the Android node connection and voice capture visible to the OS. */
class NodeForegroundService : Service() {
  private val scope: CoroutineScope = CoroutineScope(SupervisorJob() + Dispatchers.Main)
  private var notificationJob: Job? = null
  private var runtimeRestoreJob: Job? = null
  private var activeRuntime: NodeRuntime? = null
  private var latestStartId = 0
  private var voiceCaptureMode = VoiceCaptureMode.Off

  @Volatile private var disconnectRequested = false

  override fun onCreate() {
    super.onCreate()
    ensureChannel()
    val initial =
      buildNotification(
        title = nativeString("OpenClaw Node"),
        text = nativeString("Starting…"),
      )
    startForegroundWithTypes(notification = initial)
  }

  private fun startRuntimeIfNeeded(startId: Int) {
    if (activeRuntime != null || runtimeRestoreJob?.isActive == true || disconnectRequested) return
    val app = application as NodeApp
    runtimeRestoreJob =
      scope.launch(Dispatchers.Default) {
        try {
          restoreStickyRuntime(
            createRuntime = app::ensureBackgroundRuntime,
            disconnectRequested = { disconnectRequested },
            disconnectRuntime = NodeRuntime::disconnect,
          ) { restoredRuntime ->
            withContext(Dispatchers.Main) {
              runtimeRestoreJob = null
              if (disconnectRequested) {
                false
              } else {
                activeRuntime = restoredRuntime
                observeRuntime(restoredRuntime)
                true
              }
            }
          }
        } catch (err: CancellationException) {
          throw err
        } catch (err: Throwable) {
          Log.e("OpenClawNodeService", "Failed to restore node runtime", err)
          withContext(Dispatchers.Main) {
            runtimeRestoreJob = null
            if (!disconnectRequested && !stopSelfResult(startId)) {
              startRuntimeIfNeeded(latestStartId)
            }
          }
        }
      }
  }

  private fun observeRuntime(runtime: NodeRuntime) {
    // Keep the connection tuple atomic, then split connection and capture work so notification text
    // can update without restarting runtime-owned connection work.
    notificationJob =
      scope.launch {
        val notificationStates =
          combine(
            combine(
              runtime.gatewayConnectionDisplay,
              runtime.serverName,
              runtime.voiceCaptureMode,
              runtime.locationMode,
            ) { connection, server, mode, _ ->
              VoiceNotificationBase(
                status = connection.statusText,
                server = server,
                connected = connection.isConnected,
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
          }
        refreshNotificationOnLocaleChanges(
          states = notificationStates,
          localeChanges = nativeLocaleChanges,
        ).collect { update ->
          ensureChannelForLocaleRevision(update.localeRevision)
          val state = update.state
          voiceCaptureMode = state.mode
          val title =
            when {
              state.connected && state.mode == VoiceCaptureMode.TalkMode ->
                nativeString("OpenClaw Node · Talk")
              state.connected -> nativeString("OpenClaw Node · Connected")
              else -> nativeString("OpenClaw Node")
            }
          val displayStatus = gatewayConnectionStatusForDisplay(state.status)
          val text =
            (state.server?.let { nativeString("\$status · \$server", displayStatus, it) } ?: displayStatus) +
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

  private var channelLocaleRevision: Long? = null

  private fun ensureChannelForLocaleRevision(localeRevision: Long) {
    if (channelLocaleRevision == localeRevision) return
    ensureChannel()
    channelLocaleRevision = localeRevision
  }

  override fun onStartCommand(
    intent: Intent?,
    flags: Int,
    startId: Int,
  ): Int {
    latestStartId = maxOf(latestStartId, startId)
    when (intent?.action) {
      ACTION_STOP -> {
        disconnectRequested = true
        runtimeRestoreJob?.cancel()
        runtimeRestoreJob = null
        activeRuntime?.disconnect()
        activeRuntime = null
        (application as NodeApp).disconnectRuntimeAsync()
        stopSelfResult(startId)
        return START_NOT_STICKY
      }
      ACTION_SET_VOICE_CAPTURE_MODE -> {
        voiceCaptureMode = intent.getStringExtra(EXTRA_VOICE_CAPTURE_MODE).toVoiceCaptureMode()
        startForegroundWithTypes(
          notification =
            buildNotification(
              title = nativeString("OpenClaw Node"),
              text =
                if (voiceCaptureMode == VoiceCaptureMode.TalkMode) {
                  nativeString("Talk mode active")
                } else {
                  nativeString("Connected")
                },
            ),
        )
      }
    }
    if (disconnectRequested) {
      // A STOP can lose stopSelfResult to a newer queued start. Let the newest
      // start id close the service instead of leaving a disconnected FGS alive.
      stopSelfResult(startId)
      return START_NOT_STICKY
    }
    // START_STICKY recreates the service in a fresh process and calls this with a null intent.
    startRuntimeIfNeeded(startId)
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
        nativeString("Connection"),
        NotificationManager.IMPORTANCE_LOW,
      ).apply {
        description = nativeString("OpenClaw node connection status")
        setShowBadge(false)
      }
    mgr.createNotificationChannel(channel)
  }

  private fun buildNotification(
    title: String,
    text: String,
  ): Notification {
    val launchPending = mainActivityPendingIntent(this, requestCode = 1)
    val visibleText = text + backgroundLocationNotificationSuffix(isBackgroundLocationActive())

    val stopIntent = Intent(this, NodeForegroundService::class.java).setAction(ACTION_STOP)
    val stopPending =
      PendingIntent.getService(
        this,
        2,
        stopIntent,
        PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
      )

    return NotificationCompat
      .Builder(this, CHANNEL_ID)
      .setSmallIcon(R.mipmap.ic_launcher)
      .setContentTitle(title)
      .setContentText(visibleText)
      .setContentIntent(launchPending)
      .setOngoing(true)
      .setOnlyAlertOnce(true)
      .setForegroundServiceBehavior(NotificationCompat.FOREGROUND_SERVICE_IMMEDIATE)
      .addAction(0, nativeString("Disconnect"), stopPending)
      .build()
  }

  private fun startForegroundWithTypes(notification: Notification) {
    val serviceTypes =
      foregroundServiceTypes(
        voiceMode = voiceCaptureMode,
        backgroundLocationActive = isBackgroundLocationActive(),
      )
    ServiceCompat.startForeground(this, NOTIFICATION_ID, notification, serviceTypes)
  }

  private fun isBackgroundLocationActive(): Boolean {
    if (!SensitiveFeatureConfig.backgroundLocationEnabled) return false
    if ((application as NodeApp).prefs.locationMode.value != LocationMode.Always) return false
    val fineGranted =
      ContextCompat.checkSelfPermission(this, Manifest.permission.ACCESS_FINE_LOCATION) ==
        PackageManager.PERMISSION_GRANTED
    val coarseGranted =
      ContextCompat.checkSelfPermission(this, Manifest.permission.ACCESS_COARSE_LOCATION) ==
        PackageManager.PERMISSION_GRANTED
    val backgroundGranted =
      ContextCompat.checkSelfPermission(this, Manifest.permission.ACCESS_BACKGROUND_LOCATION) ==
        PackageManager.PERMISSION_GRANTED
    return (fineGranted || coarseGranted) && backgroundGranted
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
        // Microphone foreground service type must be declared before Talk capture starts.
        ContextCompat.startForegroundService(context, intent)
      } else {
        context.startService(intent)
      }
    }
  }
}

/** Restores process-local state after Android recreates a sticky service in a fresh process. */
internal suspend fun <T> restoreStickyRuntime(
  createRuntime: () -> T,
  disconnectRequested: () -> Boolean,
  disconnectRuntime: (T) -> Unit,
  activateRuntime: suspend (T) -> Boolean,
) {
  // A queued recovery may begin after STOP; do not construct process state once
  // disconnect has already won. The post-create check still closes the race during construction.
  if (disconnectRequested()) return
  val runtime = createRuntime()
  var activated = false
  try {
    if (!disconnectRequested()) {
      activated = activateRuntime(runtime)
    }
  } finally {
    // Ownership transfers only after activation. Stop/cancellation during the
    // dispatcher hop must disconnect the recovered runtime instead of leaking it.
    if (!activated) {
      disconnectRuntime(runtime)
    }
  }
}

internal fun foregroundServiceTypes(
  voiceMode: VoiceCaptureMode,
  backgroundLocationActive: Boolean,
): Int {
  val base = ServiceInfo.FOREGROUND_SERVICE_TYPE_CONNECTED_DEVICE
  val voiceTypes =
    when (voiceMode) {
      VoiceCaptureMode.Off -> base
      VoiceCaptureMode.ManualMic,
      VoiceCaptureMode.TalkMode,
      -> base or ServiceInfo.FOREGROUND_SERVICE_TYPE_MICROPHONE
    }
  return if (backgroundLocationActive) {
    voiceTypes or ServiceInfo.FOREGROUND_SERVICE_TYPE_LOCATION
  } else {
    voiceTypes
  }
}

internal fun backgroundLocationNotificationSuffix(active: Boolean): String =
  if (active) {
    nativeString(" · Location: Always")
  } else {
    ""
  }

internal fun voiceNotificationSuffix(
  mode: VoiceCaptureMode,
  manualMicEnabled: Boolean,
  manualMicListening: Boolean,
  talkListening: Boolean,
  talkSpeaking: Boolean,
): String =
  when (mode) {
    VoiceCaptureMode.TalkMode ->
      when {
        talkSpeaking -> nativeString(" · Talk: Speaking")
        talkListening -> nativeString(" · Talk: Listening")
        else -> nativeString(" · Talk: On")
      }
    VoiceCaptureMode.ManualMic ->
      if (manualMicEnabled) {
        if (manualMicListening) {
          nativeString(" · Mic: Listening")
        } else {
          nativeString(" · Mic: Pending")
        }
      } else {
        ""
      }
    VoiceCaptureMode.Off -> ""
  }

private fun String?.toVoiceCaptureMode(): VoiceCaptureMode =
  VoiceCaptureMode.entries.firstOrNull {
    it.name == this
  } ?: VoiceCaptureMode.Off

/** Connection fields that drive foreground notification title/body text. */
private data class VoiceNotificationBase(
  val status: String,
  val server: String?,
  val connected: Boolean,
  val mode: VoiceCaptureMode,
)

/** Voice capture fields that affect foreground-service type and suffix. */
private data class VoiceNotificationCapture(
  val micEnabled: Boolean,
  val micListening: Boolean,
  val talkListening: Boolean,
  val talkSpeaking: Boolean,
)

/** Aggregated notification state from runtime flows. */
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

/** Re-emits stable runtime state when app-owned notification copy changes locale. */
internal data class LocaleAwareNotificationState<T>(
  val state: T,
  val localeRevision: Long,
)

internal fun <T> refreshNotificationOnLocaleChanges(
  states: Flow<T>,
  localeChanges: Flow<Long>,
): Flow<LocaleAwareNotificationState<T>> =
  combine(states, localeChanges) { state, localeRevision ->
    LocaleAwareNotificationState(state = state, localeRevision = localeRevision)
  }
