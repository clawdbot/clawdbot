package ai.openclaw.app.node

import ai.openclaw.app.PermissionRequester
import android.Manifest
import android.annotation.SuppressLint
import android.content.Context
import android.content.pm.PackageManager
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.graphics.Matrix
import android.hardware.camera2.CameraCharacteristics
import android.util.Base64
import androidx.camera.camera2.interop.Camera2CameraInfo
import androidx.camera.core.CameraInfo
import androidx.camera.core.CameraSelector
import androidx.camera.core.ImageCapture
import androidx.camera.core.ImageCaptureException
import androidx.camera.lifecycle.ProcessCameraProvider
import androidx.camera.video.FallbackStrategy
import androidx.camera.video.FileOutputOptions
import androidx.camera.video.Quality
import androidx.camera.video.QualitySelector
import androidx.camera.video.Recorder
import androidx.camera.video.Recording
import androidx.camera.video.VideoCapture
import androidx.camera.video.VideoRecordEvent
import androidx.core.content.ContextCompat
import androidx.core.content.ContextCompat.checkSelfPermission
import androidx.core.graphics.scale
import androidx.exifinterface.media.ExifInterface
import androidx.lifecycle.LifecycleOwner
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.suspendCancellableCoroutine
import kotlinx.coroutines.withContext
import kotlinx.coroutines.withTimeout
import kotlinx.serialization.json.JsonObject
import java.io.ByteArrayOutputStream
import java.io.File
import java.util.concurrent.Executor
import kotlin.coroutines.resume
import kotlin.coroutines.resumeWithException
import kotlin.math.roundToInt

class CameraCaptureManager(
  private val context: Context,
) {
  data class Payload(
    val payloadJson: String,
  )

  data class FilePayload(
    val file: File,
    val durationMs: Long,
    val hasAudio: Boolean,
  )

  data class CameraDeviceInfo(
    val id: String,
    val name: String,
    val position: String,
    val deviceType: String,
  )

  @Volatile private var lifecycleOwner: LifecycleOwner? = null

  @Volatile private var permissionRequester: PermissionRequester? = null

  fun attachLifecycleOwner(owner: LifecycleOwner) {
    lifecycleOwner = owner
  }

  fun attachPermissionRequester(requester: PermissionRequester) {
    permissionRequester = requester
  }

  suspend fun listDevices(): List<CameraDeviceInfo> =
    withContext(Dispatchers.Main) {
      val provider = context.cameraProvider()
      provider.availableCameraInfos
        .mapNotNull { info -> cameraDeviceInfoOrNull(info) }
        .sortedBy { it.id }
    }

  private suspend fun ensureCameraPermission() {
    val granted = checkSelfPermission(context, Manifest.permission.CAMERA) == PackageManager.PERMISSION_GRANTED
    if (granted) return

    val requester =
      permissionRequester
        ?: throw IllegalStateException("CAMERA_PERMISSION_REQUIRED: grant Camera permission")
    val results = requester.requestIfMissing(listOf(Manifest.permission.CAMERA))
    if (results[Manifest.permission.CAMERA] != true) {
      throw IllegalStateException("CAMERA_PERMISSION_REQUIRED: grant Camera permission")
    }
  }

  private suspend fun ensureMicPermission() {
    val granted = checkSelfPermission(context, Manifest.permission.RECORD_AUDIO) == PackageManager.PERMISSION_GRANTED
    if (granted) return

    val requester =
      permissionRequester
        ?: throw IllegalStateException("MIC_PERMISSION_REQUIRED: grant Microphone permission")
    val results = requester.requestIfMissing(listOf(Manifest.permission.RECORD_AUDIO))
    if (results[Manifest.permission.RECORD_AUDIO] != true) {
      throw IllegalStateException("MIC_PERMISSION_REQUIRED: grant Microphone permission")
    }
  }

  suspend fun snap(paramsJson: String?): Payload =
    withContext(Dispatchers.Main) {
      ensureCameraPermission()
      val owner = lifecycleOwner ?: throw IllegalStateException("UNAVAILABLE: camera not ready")
      val params = parseJsonParamsObject(paramsJson)
      val facing = parseFacing(params) ?: "front"
      val quality = (parseQuality(params) ?: 0.95).coerceIn(0.1, 1.0)
      val maxWidth = parseMaxWidth(params) ?: 1600
      val deviceId = parseDeviceId(params)

      val provider = context.cameraProvider()
      val capture = ImageCapture.Builder().build()
      val selector = resolveCameraSelector(provider, facing, deviceId)

      provider.unbindAll()
      provider.bindToLifecycle(owner, selector, capture)

      val (bytes, orientation) = capture.takeJpegWithExif(context.mainExecutor(), context.cacheDir)
      val decoded =
        BitmapFactory.decodeByteArray(bytes, 0, bytes.size)
          ?: throw IllegalStateException("UNAVAILABLE: failed to decode captured image")
      val rotated = rotateBitmapByExif(decoded, orientation)
      val scaled =
        if (maxWidth > 0 && rotated.width > maxWidth) {
          val h =
            (rotated.height.toDouble() * (maxWidth.toDouble() / rotated.width.toDouble()))
              .toInt()
              .coerceAtLeast(1)
          val s = rotated.scale(maxWidth, h)
          if (s !== rotated) rotated.recycle()
          s
        } else {
          rotated
        }

      try {
        val maxPayloadBytes = 5 * 1024 * 1024
        // Base64 inflates payloads by ~4/3; cap encoded bytes so the payload stays under 5MB (API limit).
        val maxEncodedBytes = (maxPayloadBytes / 4) * 3
        val result =
          JpegSizeLimiter.compressToLimit(
            initialWidth = scaled.width,
            initialHeight = scaled.height,
            startQuality = (quality * 100.0).roundToInt().coerceIn(10, 100),
            maxBytes = maxEncodedBytes,
            encode = { width, height, q ->
              val bitmap =
                if (width == scaled.width && height == scaled.height) {
                  scaled
                } else {
                  scaled.scale(width, height)
                }
              val out = ByteArrayOutputStream()
              if (!bitmap.compress(Bitmap.CompressFormat.JPEG, q, out)) {
                if (bitmap !== scaled) bitmap.recycle()
                throw IllegalStateException("UNAVAILABLE: failed to encode JPEG")
              }
              if (bitmap !== scaled) {
                bitmap.recycle()
              }
              out.toByteArray()
            },
          )
        val base64 = Base64.encodeToString(result.bytes, Base64.NO_WRAP)
        Payload(
          """{"format":"jpg","base64":"$base64","width":${result.width},"height":${result.height}}""",
        )
      } finally {
        scaled.recycle()
      }
    }

  @SuppressLint("MissingPermission")
  suspend fun clip(paramsJson: String?): FilePayload =
    withContext(Dispatchers.Main) {
      ensureCameraPermission()
      val owner = lifecycleOwner ?: throw IllegalStateException("UNAVAILABLE: camera not ready")
      val params = parseJsonParamsObject(paramsJson)
      val facing = parseFacing(params) ?: "front"
      val durationMs = (parseDurationMs(params) ?: 3_000).coerceIn(200, 60_000)
      val includeAudio = parseIncludeAudio(params) ?: true
      val deviceId = parseDeviceId(params)
      if (includeAudio) ensureMicPermission()

      android.util.Log.w(
        "CameraCaptureManager",
        "clip: start facing=$facing duration=$durationMs audio=$includeAudio deviceId=${deviceId ?: "-"}",
      )

      val provider = context.cameraProvider()
      android.util.Log.w("CameraCaptureManager", "clip: got camera provider")

      // Use LOWEST quality for smallest files over WebSocket
      val recorder =
        Recorder
          .Builder()
          .setQualitySelector(
            QualitySelector.from(Quality.LOWEST, FallbackStrategy.lowerQualityOrHigherThan(Quality.LOWEST)),
          ).build()
      val videoCapture = VideoCapture.withOutput(recorder)
      val selector = resolveCameraSelector(provider, facing, deviceId)

      // CameraX requires a Preview use case for the camera to start producing frames;
      // without it, the encoder may get no data (ERROR_NO_VALID_DATA).
      val preview =
        androidx.camera.core.Preview
          .Builder()
          .build()
      // Provide a dummy SurfaceTexture so the preview pipeline activates
      val surfaceTexture = android.graphics.SurfaceTexture(0)
      surfaceTexture.setDefaultBufferSize(640, 480)
      preview.setSurfaceProvider { request ->
        val surface = android.view.Surface(surfaceTexture)
        request.provideSurface(surface, context.mainExecutor()) { result ->
          surface.release()
          surfaceTexture.release()
        }
      }

      provider.unbindAll()
      android.util.Log.w("CameraCaptureManager", "clip: binding preview + videoCapture to lifecycle")
      val camera = provider.bindToLifecycle(owner, selector, preview, videoCapture)
      android.util.Log.w("CameraCaptureManager", "clip: bound, cameraInfo=${camera.cameraInfo}")

      // Give camera pipeline time to initialize before recording
      android.util.Log.w("CameraCaptureManager", "clip: warming up camera 1.5s...")
      kotlinx.coroutines.delay(1_500)

      val file = File.createTempFile("openclaw-clip-", ".mp4", context.cacheDir)
      val outputOptions = FileOutputOptions.Builder(file).build()

      val finalized = kotlinx.coroutines.CompletableDeferred<VideoRecordEvent.Finalize>()
      android.util.Log.w("CameraCaptureManager", "clip: starting recording to ${file.absolutePath}")
      val recording: Recording =
        videoCapture.output
          .prepareRecording(context, outputOptions)
          .apply {
            if (includeAudio) withAudioEnabled()
          }.start(context.mainExecutor()) { event ->
            android.util.Log.w("CameraCaptureManager", "clip: event ${event.javaClass.simpleName}")
            if (event is VideoRecordEvent.Status) {
              android.util.Log.w("CameraCaptureManager", "clip: recording status update")
            }
            if (event is VideoRecordEvent.Finalize) {
              android.util.Log.w(
                "CameraCaptureManager",
                "clip: finalize hasError=${event.hasError()} error=${event.error} cause=${event.cause}",
              )
              finalized.complete(event)
            }
          }

      android.util.Log.w("CameraCaptureManager", "clip: recording started, delaying ${durationMs}ms")
      try {
        kotlinx.coroutines.delay(durationMs.toLong())
      } finally {
        android.util.Log.w("CameraCaptureManager", "clip: stopping recording")
        recording.stop()
      }

      val finalizeEvent =
        try {
          withTimeout(15_000) { finalized.await() }
        } catch (err: Throwable) {
          android.util.Log.e("CameraCaptureManager", "clip: finalize timed out", err)
          withContext(Dispatchers.IO) { file.delete() }
          provider.unbindAll()
          throw IllegalStateException("UNAVAILABLE: camera clip finalize timed out")
        }
      if (finalizeEvent.hasError()) {
        android.util.Log.e(
          "CameraCaptureManager",
          "clip: FAILED error=${finalizeEvent.error}, cause=${finalizeEvent.cause}",
          finalizeEvent.cause,
        )
        // Check file size for debugging
        val fileSize = withContext(Dispatchers.IO) { if (file.exists()) file.length() else -1 }
        android.util.Log.e("CameraCaptureManager", "clip: file exists=${file.exists()} size=$fileSize")
        withContext(Dispatchers.IO) { file.delete() }
        provider.unbindAll()
        throw IllegalStateException("UNAVAILABLE: camera clip failed (error=${finalizeEvent.error})")
      }

      val fileSize = withContext(Dispatchers.IO) { file.length() }
      android.util.Log.w("CameraCaptureManager", "clip: SUCCESS file size=$fileSize")

      provider.unbindAll()

      FilePayload(file = file, durationMs = durationMs.toLong(), hasAudio = includeAudio)
    }

  private fun rotateBitmapByExif(
    bitmap: Bitmap,
    orientation: Int,
  ): Bitmap {
    val matrix = Matrix()
    when (orientation) {
      ExifInterface.ORIENTATION_ROTATE_90 -> matrix.postRotate(90f)
      ExifInterface.ORIENTATION_ROTATE_180 -> matrix.postRotate(180f)
      ExifInterface.ORIENTATION_ROTATE_270 -> matrix.postRotate(270f)
      ExifInterface.ORIENTATION_FLIP_HORIZONTAL -> matrix.postScale(-1f, 1f)
      ExifInterface.ORIENTATION_FLIP_VERTICAL -> matrix.postScale(1f, -1f)
      ExifInterface.ORIENTATION_TRANSPOSE -> {
        matrix.postRotate(90f)
        matrix.postScale(-1f, 1f)
      }
      ExifInterface.ORIENTATION_TRANSVERSE -> {
        matrix.postRotate(-90f)
        matrix.postScale(-1f, 1f)
      }
      else -> return bitmap
    }
    val rotated = Bitmap.createBitmap(bitmap, 0, 0, bitmap.width, bitmap.height, matrix, true)
    if (rotated !== bitmap) {
      bitmap.recycle()
    }
    return rotated
  }

  private fun parseFacing(params: JsonObject?): String? {
    val value = parseJsonString(params, "facing")?.trim()?.lowercase() ?: return null
    return when (value) {
      "front", "back" -> value
      else -> null
    }
  }

  private fun parseQuality(params: JsonObject?): Double? = parseJsonDouble(params, "quality")

  private fun parseMaxWidth(params: JsonObject?): Int? =
    parseJsonInt(params, "maxWidth")
      ?.takeIf { it > 0 }

  private fun parseDurationMs(params: JsonObject?): Int? = parseJsonInt(params, "durationMs")

  private fun parseDeviceId(params: JsonObject?): String? =
    parseJsonString(params, "deviceId")
      ?.trim()
      ?.takeIf { it.isNotEmpty() }

  private fun parseIncludeAudio(params: JsonObject?): Boolean? = parseJsonBooleanFlag(params, "includeAudio")

  private fun Context.mainExecutor(): Executor = ContextCompat.getMainExecutor(this)

  private fun resolveCameraSelector(
    provider: ProcessCameraProvider,
    facing: String,
    deviceId: String?,
  ): CameraSelector {
    if (deviceId.isNullOrEmpty()) {
      return if (facing == "front") CameraSelector.DEFAULT_FRONT_CAMERA else CameraSelector.DEFAULT_BACK_CAMERA
    }
    val availableIds = provider.availableCameraInfos.mapNotNull { cameraIdOrNull(it) }.toSet()
    if (!availableIds.contains(deviceId)) {
      throw IllegalStateException("INVALID_REQUEST: unknown camera deviceId '$deviceId'")
    }
    return CameraSelector
      .Builder()
      .addCameraFilter { infos -> infos.filter { cameraIdOrNull(it) == deviceId } }
      .build()
  }

  @SuppressLint("UnsafeOptInUsageError")
  private fun cameraDeviceInfoOrNull(info: CameraInfo): CameraDeviceInfo? {
    val cameraId = cameraIdOrNull(info) ?: return null
    val lensFacing =
      runCatching {
        Camera2CameraInfo.from(info).getCameraCharacteristic(CameraCharacteristics.LENS_FACING)
      }.getOrNull()
    val position =
      when (lensFacing) {
        CameraCharacteristics.LENS_FACING_FRONT -> "front"
        CameraCharacteristics.LENS_FACING_BACK -> "back"
        CameraCharacteristics.LENS_FACING_EXTERNAL -> "external"
        else -> "unspecified"
      }
    val deviceType =
      if (lensFacing == CameraCharacteristics.LENS_FACING_EXTERNAL) "external" else "builtIn"
    val name =
      when (position) {
        "front" -> "Front Camera"
        "back" -> "Back Camera"
        "external" -> "External Camera"
        else -> "Camera $cameraId"
      }
    return CameraDeviceInfo(
      id = cameraId,
      name = name,
      position = position,
      deviceType = deviceType,
    )
  }

  @SuppressLint("UnsafeOptInUsageError")
  private fun cameraIdOrNull(info: CameraInfo): String? = runCatching { Camera2CameraInfo.from(info).cameraId }.getOrNull()
}

private suspend fun Context.cameraProvider(): ProcessCameraProvider =
  suspendCancellableCoroutine { cont ->
    val future = ProcessCameraProvider.getInstance(this)
    future.addListener(
      {
        try {
          cont.resume(future.get())
        } catch (e: Exception) {
          cont.resumeWithException(e)
        }
      },
      ContextCompat.getMainExecutor(this),
    )
  }

/** Returns (jpegBytes, exifOrientation) so caller can rotate the decoded bitmap. */
private suspend fun ImageCapture.takeJpegWithExif(
  executor: Executor,
  tempDir: File,
): Pair<ByteArray, Int> =
  suspendCancellableCoroutine { cont ->
    val file = File.createTempFile("openclaw-snap-", ".jpg", tempDir)
    val options = ImageCapture.OutputFileOptions.Builder(file).build()
    takePicture(
      options,
      executor,
      object : ImageCapture.OnImageSavedCallback {
        override fun onError(exception: ImageCaptureException) {
          file.delete()
          cont.resumeWithException(exception)
        }

        override fun onImageSaved(outputFileResults: ImageCapture.OutputFileResults) {
          try {
            val exif = ExifInterface(file.absolutePath)
            val orientation =
              exif.getAttributeInt(
                ExifInterface.TAG_ORIENTATION,
                ExifInterface.ORIENTATION_NORMAL,
              )
            val bytes = file.readBytes()
            cont.resume(Pair(bytes, orientation))
          } catch (e: Exception) {
            cont.resumeWithException(e)
          } finally {
            file.delete()
          }
        }
      },
    )
  }
