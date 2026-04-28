package ai.openclaw.app.node

import ai.openclaw.app.BuildConfig
import ai.openclaw.app.CameraHudKind
import ai.openclaw.app.gateway.GatewaySession
import android.content.Context
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.withContext
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonArray
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.put

internal const val CAMERA_CLIP_MAX_RAW_BYTES: Long = 18L * 1024L * 1024L

internal fun isCameraClipWithinPayloadLimit(rawBytes: Long): Boolean = rawBytes in 0L..CAMERA_CLIP_MAX_RAW_BYTES

class CameraHandler(
  private val appContext: Context,
  private val camera: CameraCaptureManager,
  private val externalAudioCaptureActive: MutableStateFlow<Boolean>,
  private val showCameraHud: (message: String, kind: CameraHudKind, autoHideMs: Long?) -> Unit,
  private val triggerCameraFlash: () -> Unit,
  private val invokeErrorFromThrowable: (err: Throwable) -> Pair<String, String>,
) {
  suspend fun handleList(_paramsJson: String?): GatewaySession.InvokeResult =
    try {
      val devices = camera.listDevices()
      val payload =
        buildJsonObject {
          put(
            "devices",
            buildJsonArray {
              devices.forEach { device ->
                add(
                  buildJsonObject {
                    put("id", JsonPrimitive(device.id))
                    put("name", JsonPrimitive(device.name))
                    put("position", JsonPrimitive(device.position))
                    put("deviceType", JsonPrimitive(device.deviceType))
                  },
                )
              }
            },
          )
        }.toString()
      GatewaySession.InvokeResult.ok(payload)
    } catch (err: Throwable) {
      val (code, message) = invokeErrorFromThrowable(err)
      GatewaySession.InvokeResult.error(code = code, message = message)
    }

  suspend fun handleSnap(paramsJson: String?): GatewaySession.InvokeResult {
    val logFile = if (BuildConfig.DEBUG) java.io.File(appContext.cacheDir, "camera_debug.log") else null

    fun camLog(msg: String) {
      if (!BuildConfig.DEBUG) return
      val ts = java.text.SimpleDateFormat("HH:mm:ss.SSS", java.util.Locale.US).format(java.util.Date())
      logFile?.appendText("[$ts] $msg\n")
      android.util.Log.w("openclaw", "camera.snap: $msg")
    }
    try {
      logFile?.writeText("") // clear
      camLog("starting, params=$paramsJson")
      camLog("calling showCameraHud")
      showCameraHud("Taking photo…", CameraHudKind.Photo, null)
      camLog("calling triggerCameraFlash")
      triggerCameraFlash()
      val res =
        try {
          camLog("calling camera.snap()")
          val r = camera.snap(paramsJson)
          camLog("success, payload size=${r.payloadJson.length}")
          r
        } catch (err: Throwable) {
          camLog("inner error: ${err::class.java.simpleName}: ${err.message}")
          camLog("stack: ${err.stackTraceToString().take(2000)}")
          val (code, message) = invokeErrorFromThrowable(err)
          showCameraHud(message, CameraHudKind.Error, 2200)
          return GatewaySession.InvokeResult.error(code = code, message = message)
        }
      camLog("returning result")
      showCameraHud("Photo captured", CameraHudKind.Success, 1600)
      return GatewaySession.InvokeResult.ok(res.payloadJson)
    } catch (err: Throwable) {
      camLog("outer error: ${err::class.java.simpleName}: ${err.message}")
      camLog("stack: ${err.stackTraceToString().take(2000)}")
      return GatewaySession.InvokeResult.error(code = "UNAVAILABLE", message = err.message ?: "camera snap failed")
    }
  }

  suspend fun handleClip(paramsJson: String?): GatewaySession.InvokeResult {
    val clipLogFile = if (BuildConfig.DEBUG) java.io.File(appContext.cacheDir, "camera_debug.log") else null

    fun clipLog(msg: String) {
      if (!BuildConfig.DEBUG) return
      val ts = java.text.SimpleDateFormat("HH:mm:ss.SSS", java.util.Locale.US).format(java.util.Date())
      clipLogFile?.appendText("[CLIP $ts] $msg\n")
      android.util.Log.w("openclaw", "camera.clip: $msg")
    }
    val includeAudio = parseIncludeAudio(paramsJson) ?: true
    if (includeAudio) externalAudioCaptureActive.value = true
    try {
      clipLogFile?.writeText("") // clear
      clipLog("starting, params=$paramsJson includeAudio=$includeAudio")
      clipLog("calling showCameraHud")
      showCameraHud("Recording…", CameraHudKind.Recording, null)
      val filePayload =
        try {
          clipLog("calling camera.clip()")
          val r = camera.clip(paramsJson)
          clipLog("success, file size=${r.file.length()}")
          r
        } catch (err: Throwable) {
          clipLog("inner error: ${err::class.java.simpleName}: ${err.message}")
          clipLog("stack: ${err.stackTraceToString().take(2000)}")
          val (code, message) = invokeErrorFromThrowable(err)
          showCameraHud(message, CameraHudKind.Error, 2400)
          return GatewaySession.InvokeResult.error(code = code, message = message)
        }
      val rawBytes = filePayload.file.length()
      if (!isCameraClipWithinPayloadLimit(rawBytes)) {
        clipLog("payload too large: bytes=$rawBytes max=$CAMERA_CLIP_MAX_RAW_BYTES")
        withContext(Dispatchers.IO) { filePayload.file.delete() }
        showCameraHud("Clip too large", CameraHudKind.Error, 2400)
        return GatewaySession.InvokeResult.error(
          code = "PAYLOAD_TOO_LARGE",
          message =
            "PAYLOAD_TOO_LARGE: camera clip is $rawBytes bytes; max is $CAMERA_CLIP_MAX_RAW_BYTES bytes. Reduce durationMs and retry.",
        )
      }

      val bytes =
        withContext(Dispatchers.IO) {
          try {
            filePayload.file.readBytes()
          } finally {
            filePayload.file.delete()
          }
        }
      val base64 = android.util.Base64.encodeToString(bytes, android.util.Base64.NO_WRAP)
      clipLog("returning base64 payload")
      showCameraHud("Clip captured", CameraHudKind.Success, 1800)
      return GatewaySession.InvokeResult.ok(
        """{"format":"mp4","base64":"$base64","durationMs":${filePayload.durationMs},"hasAudio":${filePayload.hasAudio}}""",
      )
    } catch (err: Throwable) {
      clipLog("outer error: ${err::class.java.simpleName}: ${err.message}")
      clipLog("stack: ${err.stackTraceToString().take(2000)}")
      return GatewaySession.InvokeResult.error(code = "UNAVAILABLE", message = err.message ?: "camera clip failed")
    } finally {
      if (includeAudio) externalAudioCaptureActive.value = false
    }
  }

  private fun parseIncludeAudio(paramsJson: String?): Boolean? {
    if (paramsJson.isNullOrBlank()) return null
    val root =
      try {
        Json.parseToJsonElement(paramsJson).asObjectOrNull()
      } catch (_: Throwable) {
        null
      } ?: return null
    val value =
      (root["includeAudio"] as? JsonPrimitive)
        ?.contentOrNull
        ?.trim()
        ?.lowercase()
    return when (value) {
      "true" -> true
      "false" -> false
      else -> null
    }
  }
}
