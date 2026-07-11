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

/**
 * CameraX-backed capture service used by gateway camera commands.
 */
internal class CameraClipSession(
  private val unbind: () -> Unit,
  private val deleteTemporaryFile: (File) -> Unit,
) : AutoCloseable {
  private var recording: AutoCloseable? = null
  private var temporaryFile: File? = null
  private var closed = false

  fun ownRecording(recording: AutoCloseable) {
    check(!closed) { "camera clip session is closed" }
    this.recording = recording
  }

  fun ownFile(file: File): File {
    check(!closed) { "camera clip session is closed" }
    check(temporaryFile == null) { "camera clip session already owns a file" }
    temporaryFile = file
    return file
  }

  fun transferFile(): File {
    check(!closed) { "camera clip session is closed" }
    return checkNotNull(temporaryFile) { "camera clip session has no file" }
      .also { temporaryFile = null }
  }

  override fun close() {
    if (closed) return
    closed = true

    var failure: Throwable? = null

    fun cleanup(action: () -> Unit) {
      try {
        action()
      } catch (err: Throwable) {
        failure?.addSuppressed(err) ?: run { failure = err }
      }
    }

    // Keep teardown symmetric across bind, warmup, recording, finalize, and success exits.
    cleanup { recording?.close() }
    cleanup(unbind)
    temporaryFile?.let { file -> cleanup { deleteTemporaryFile(file) } }
    failure?.let { throw it }
  }
}

class CameraCaptureManager(
  private val context: Context,
) {
  /** Base64 JSON response for camera.snap after resize and JPEG budget enforcement. */
  data class Payload(
    val payloadJson: String,
  )

  /** Temporary MP4 response for camera.clip before CameraHandler validates invoke size. */
  data class FilePayload(
    val file: File,
    val durationMs: Long,
    val hasAudio: Boolean,
  )

  /** Camera device metadata exposed through camera.list. */
  data class CameraDeviceInfo(
    val id: String,
    val name: String,
    val position: String,
    val deviceType: String,
  )

  @Volatile private var lifecycleOwner: LifecycleOwner? = null

  @Volatile private var permissionRequester: PermissionRequester? = null

  /** Supplies the foreground Activity lifecycle required by CameraX use-case binding. */
  fun attachLifecycleOwner(owner: LifecycleOwner) {
    // CameraX binds use cases to an Activity lifecycle; background services cannot capture alone.
    lifecycleOwner = owner
  }

  /** Supplies the Activity-owned permission requester used by camera and microphone commands. */
  fun attachPermissionRequester(requester: PermissionRequester) {
    // Runtime permission callbacks belong to the foreground Activity, not the background node service.
    permissionRequester = requester
  }

  /** Lists CameraX devices with stable Camera2 ids where available. */
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

  /** Captures one still image and returns a gateway-sized JPEG payload. */
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
      // Bind only the still capture use case; CameraX owns camera open/close through the lifecycle owner.
      provider.bindToLifecycle(owner, selector, capture)

      val (bytes, orientation) =
        try {
          capture.takeJpegWithExif(context.mainExecutor(), context.cacheDir)
        } finally {
          // The JPEG bytes are self-contained; release CameraX before decoding and recompressing them.
          provider.unbind(capture)
        }
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

  /** Records a short MP4 clip into a temporary cache file for the caller to encode/delete. */
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

      val provider = context.cameraProvider()

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
      // Allocate the dummy preview surface only after CameraX requests it; its result owns release.
      preview.setSurfaceProvider { request ->
        val surfaceTexture = android.graphics.SurfaceTexture(0)
        surfaceTexture.setDefaultBufferSize(640, 480)
        val surface = android.view.Surface(surfaceTexture)
        request.provideSurface(surface, context.mainExecutor()) {
          surface.release()
          surfaceTexture.release()
        }
      }

      provider.unbindAll()
      CameraClipSession(
        unbind = { provider.unbind(preview, videoCapture) },
        deleteTemporaryFile = { file ->
          check(!file.exists() || file.delete()) { "failed to delete temporary camera clip" }
        },
      ).use { session ->
        provider.bindToLifecycle(owner, selector, preview, videoCapture)

        // Give camera pipeline time to initialize before recording
        kotlinx.coroutines.delay(1_500)

        val clipFile = session.ownFile(File.createTempFile("openclaw-clip-", ".mp4", context.cacheDir))
        val outputOptions = FileOutputOptions.Builder(clipFile).build()

        val finalized = kotlinx.coroutines.CompletableDeferred<VideoRecordEvent.Finalize>()
        val recording =
          videoCapture.output
            .prepareRecording(context, outputOptions)
            .apply {
              if (includeAudio) withAudioEnabled()
            }.start(context.mainExecutor()) { event ->
              if (event is VideoRecordEvent.Finalize) {
                finalized.complete(event)
              }
            }
        session.ownRecording(recording)

        kotlinx.coroutines.delay(durationMs.toLong())
        recording.close()

        val finalizeEvent =
          try {
            withTimeout(15_000) { finalized.await() }
          } catch (_: kotlinx.coroutines.TimeoutCancellationException) {
            throw IllegalStateException("UNAVAILABLE: camera clip finalize timed out")
          }
        if (finalizeEvent.hasError()) {
          throw IllegalStateException("UNAVAILABLE: camera clip failed (error=${finalizeEvent.error})")
        }

        FilePayload(
          file = session.transferFile(),
          durationMs = durationMs.toLong(),
          hasAudio = includeAudio,
        )
      }
    }

  private fun rotateBitmapByExif(
    bitmap: Bitmap,
    orientation: Int,
  ): Bitmap {
    val matrix = Matrix()
    // CameraX JPEG bytes keep sensor orientation in EXIF; normalize before resizing/encoding.
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
      // CameraX selectors are filters over CameraInfo; pin by Camera2 id for stable device selection.
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

/**
 * Returns JPEG bytes plus EXIF orientation so callers can normalize the decoded bitmap.
 */
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
