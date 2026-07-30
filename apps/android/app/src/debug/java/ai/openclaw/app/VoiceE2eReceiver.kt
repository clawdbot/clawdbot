package ai.openclaw.app

import android.app.Service
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.os.IBinder
import android.util.Base64
import android.util.Log
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import kotlinx.coroutines.withTimeout
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import java.io.File

private const val tag = "VoiceE2E"
private const val resultFileName = "voice_e2e_result.json"

class VoiceE2eReceiver : BroadcastReceiver() {
  override fun onReceive(
    context: Context,
    intent: Intent,
  ) {
    context.startService(
      Intent(context, VoiceE2eService::class.java)
        .putExtras(intent),
    )
  }
}

class VoiceE2eService : Service() {
  private val serviceScope = CoroutineScope(SupervisorJob() + Dispatchers.IO)

  override fun onBind(intent: Intent?): IBinder? = null

  override fun onStartCommand(
    intent: Intent?,
    flags: Int,
    startId: Int,
  ): Int {
    val command = intent ?: return START_NOT_STICKY
    serviceScope.launch {
      try {
        runCommand(command)
      } finally {
        stopSelf(startId)
      }
    }
    return START_NOT_STICKY
  }

  override fun onDestroy() {
    serviceScope.cancel()
    super.onDestroy()
  }

  private suspend fun runCommand(intent: Intent) {
    try {
      val app = applicationContext as NodeApp
      val runtime = app.ensureRuntime()
      val mode =
        intent
          .getDecodedStringExtra("mode")
          ?.trim()
          .orEmpty()
          .ifEmpty { "both" }
      if (mode == "stop") {
        runtime.cancelMicCapture()
        runtime.setTalkModeEnabled(false)
        writeResult("""{"ok":true,"mode":"stop"}""")
        return
      }

      val connect = !intent.getBooleanExtra("noConnect", false)
      val connectTimeoutMs = intent.getLongExtra("connectTimeoutMs", 20_000L)
      if (connect) {
        configureGateway(runtime = runtime, intent = intent)
      }
      if (connect || !runtime.isConnected.value) {
        awaitGateway(runtime = runtime, timeoutMs = connectTimeoutMs)
      }

      startActivity(
        Intent(actionOpenVoiceE2e)
          .setClass(this, MainActivity::class.java)
          .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_SINGLE_TOP or Intent.FLAG_ACTIVITY_CLEAR_TOP),
      )

      if (mode == "connect") {
        val resultJson = """{"ok":true,"mode":"connect","connected":true}"""
        writeResult(resultJson)
        Log.i(tag, "PASS $resultJson")
        return
      }

      val transcript =
        intent
          .getDecodedStringExtra("transcript")
          ?.trim()
          .orEmpty()
          .ifEmpty { "Reply exactly: Android voice e2e normal path ok." }
      val realtimeReply =
        intent
          .getDecodedStringExtra("realtimeAssistant")
          ?.trim()
          .orEmpty()
          .ifEmpty { "Android realtime voice e2e relay path ok." }
      val timeoutMs = intent.getLongExtra("timeoutMs", 60_000L)
      val result =
        runtime.runVoiceE2e(
          mode = mode,
          transcript = transcript,
          realtimeAssistantText = realtimeReply,
          timeoutMs = timeoutMs,
        )
      val resultJson = encodeResult(result)
      writeResult(resultJson)
      Log.i(tag, "PASS $resultJson")
    } catch (err: Throwable) {
      val resultJson =
        buildJsonObject {
          put("ok", JsonPrimitive(false))
          put("error", JsonPrimitive(err.message ?: err::class.java.simpleName))
        }.toString()
      writeResult(resultJson)
      Log.e(tag, "FAIL $resultJson", err)
    }
  }

  private fun configureGateway(
    runtime: NodeRuntime,
    intent: Intent,
  ) {
    val host =
      intent
        .getDecodedStringExtra("host")
        ?.trim()
        .orEmpty()
        .ifEmpty { "127.0.0.1" }
    val port = intent.getIntExtra("port", 18789)
    runtime.setManualEnabled(true)
    runtime.setManualHost(host)
    runtime.setManualPort(port)
    runtime.setManualTls(intent.getBooleanExtra("tls", false))
    runtime.setOnboardingCompleted(true)
    runtime.connect(
      ai.openclaw.app.gateway.GatewayEndpoint
        .manual(host, port),
      NodeRuntime.GatewayConnectAuth(
        token = intent.getDecodedStringExtra("token"),
        bootstrapToken = intent.getDecodedStringExtra("bootstrapToken"),
        password = intent.getDecodedStringExtra("password"),
      ),
    )
  }

  private suspend fun awaitGateway(
    runtime: NodeRuntime,
    timeoutMs: Long,
  ) {
    withTimeout(timeoutMs) {
      while (!runtime.isConnected.value) {
        delay(100L)
      }
    }
  }

  private fun encodeResult(result: NodeRuntime.VoiceE2eResult): String =
    buildJsonObject {
      put("ok", JsonPrimitive(true))
      put("normal", result.normal?.let(::encodeSlice) ?: JsonNull)
      put("realtime", result.realtime?.let(::encodeSlice) ?: JsonNull)
    }.toString()

  private fun encodeSlice(slice: NodeRuntime.VoiceE2eSliceResult) =
    buildJsonObject {
      put("mode", JsonPrimitive(slice.mode))
      put("status", JsonPrimitive(slice.status))
      put("userText", slice.userText?.let(::JsonPrimitive) ?: JsonNull)
      put("assistantText", slice.assistantText?.let(::JsonPrimitive) ?: JsonNull)
    }

  private fun writeResult(json: String) {
    File(cacheDir, resultFileName).writeText(json)
  }
}

private fun Intent.getDecodedStringExtra(name: String): String? {
  val encoded = getStringExtra("${name}Base64")
  if (!encoded.isNullOrBlank()) {
    return String(Base64.decode(encoded, Base64.NO_WRAP), Charsets.UTF_8)
  }
  return getStringExtra(name)
}
