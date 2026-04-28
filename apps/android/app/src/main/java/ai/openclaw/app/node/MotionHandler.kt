package ai.openclaw.app.node

import ai.openclaw.app.gateway.GatewaySession
import android.Manifest
import android.content.Context
import android.hardware.Sensor
import android.hardware.SensorEvent
import android.hardware.SensorEventListener
import android.hardware.SensorManager
import android.os.SystemClock
import androidx.core.content.ContextCompat
import kotlinx.coroutines.InternalCoroutinesApi
import kotlinx.coroutines.suspendCancellableCoroutine
import kotlinx.coroutines.withTimeoutOrNull
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonArray
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import java.time.Instant
import kotlin.math.abs
import kotlin.math.max
import kotlin.math.sqrt

private const val ACCELEROMETER_SAMPLE_TARGET = 20
private const val ACCELEROMETER_SAMPLE_TIMEOUT_MS = 6_000L

internal data class MotionActivityRequest(
  val startISO: String?,
  val endISO: String?,
  val limit: Int,
)

internal data class MotionPedometerRequest(
  val startISO: String?,
  val endISO: String?,
)

internal data class MotionActivityRecord(
  val startISO: String,
  val endISO: String,
  val confidence: String,
  val isWalking: Boolean,
  val isRunning: Boolean,
  val isCycling: Boolean,
  val isAutomotive: Boolean,
  val isStationary: Boolean,
  val isUnknown: Boolean,
)

internal data class PedometerRecord(
  val startISO: String,
  val endISO: String,
  val steps: Int?,
  val distanceMeters: Double?,
  val floorsAscended: Int?,
  val floorsDescended: Int?,
)

internal interface MotionDataSource {
  fun isActivityAvailable(context: Context): Boolean

  fun isPedometerAvailable(context: Context): Boolean

  fun isAvailable(context: Context): Boolean = isActivityAvailable(context) || isPedometerAvailable(context)

  fun hasPermission(context: Context): Boolean

  suspend fun activity(
    context: Context,
    request: MotionActivityRequest,
  ): MotionActivityRecord

  suspend fun pedometer(
    context: Context,
    request: MotionPedometerRequest,
  ): PedometerRecord
}

private object SystemMotionDataSource : MotionDataSource {
  override fun isActivityAvailable(context: Context): Boolean {
    val sensorManager = context.getSystemService(SensorManager::class.java)
    return sensorManager?.getDefaultSensor(Sensor.TYPE_ACCELEROMETER) != null
  }

  override fun isPedometerAvailable(context: Context): Boolean {
    val sensorManager = context.getSystemService(SensorManager::class.java)
    return sensorManager?.getDefaultSensor(Sensor.TYPE_STEP_COUNTER) != null
  }

  override fun hasPermission(context: Context): Boolean =
    ContextCompat.checkSelfPermission(context, Manifest.permission.ACTIVITY_RECOGNITION) ==
      android.content.pm.PackageManager.PERMISSION_GRANTED

  override suspend fun activity(
    context: Context,
    request: MotionActivityRequest,
  ): MotionActivityRecord {
    if (!request.startISO.isNullOrBlank() || !request.endISO.isNullOrBlank()) {
      throw IllegalArgumentException("MOTION_RANGE_UNAVAILABLE: historical activity range not supported on Android")
    }
    val sensorManager =
      context.getSystemService(SensorManager::class.java)
        ?: throw IllegalStateException("MOTION_UNAVAILABLE: sensor manager unavailable")
    val accelerometer =
      sensorManager.getDefaultSensor(Sensor.TYPE_ACCELEROMETER)
        ?: throw IllegalStateException("MOTION_UNAVAILABLE: accelerometer not available")

    val sample =
      readAccelerometerSample(sensorManager, accelerometer)
        ?: throw IllegalStateException("MOTION_UNAVAILABLE: no accelerometer sample")
    val end = Instant.now()
    val start = end.minusSeconds(2)
    val classification = classifyActivity(sample.averageDelta)
    return MotionActivityRecord(
      startISO = start.toString(),
      endISO = end.toString(),
      confidence = classifyConfidence(sample.samples, sample.averageDelta),
      isWalking = classification == "walking",
      isRunning = classification == "running",
      isCycling = false,
      isAutomotive = false,
      isStationary = classification == "stationary",
      isUnknown = classification == "unknown",
    )
  }

  override suspend fun pedometer(
    context: Context,
    request: MotionPedometerRequest,
  ): PedometerRecord {
    if (!request.startISO.isNullOrBlank() || !request.endISO.isNullOrBlank()) {
      throw IllegalArgumentException("PEDOMETER_RANGE_UNAVAILABLE: historical pedometer range not supported on Android")
    }
    val sensorManager =
      context.getSystemService(SensorManager::class.java)
        ?: throw IllegalStateException("PEDOMETER_UNAVAILABLE: sensor manager unavailable")
    val stepCounter =
      sensorManager.getDefaultSensor(Sensor.TYPE_STEP_COUNTER)
        ?: throw IllegalStateException("PEDOMETER_UNAVAILABLE: step counting not supported")

    val steps =
      readStepCounter(sensorManager, stepCounter)
        ?: throw IllegalStateException("PEDOMETER_UNAVAILABLE: no step counter sample")
    val bootMs = System.currentTimeMillis() - SystemClock.elapsedRealtime()
    return PedometerRecord(
      startISO = Instant.ofEpochMilli(max(0L, bootMs)).toString(),
      endISO = Instant.now().toString(),
      steps = steps,
      distanceMeters = null,
      floorsAscended = null,
      floorsDescended = null,
    )
  }

  private data class AccelerometerSample(
    val samples: Int,
    val averageDelta: Double,
  )

  @OptIn(InternalCoroutinesApi::class)
  private suspend fun readStepCounter(
    sensorManager: SensorManager,
    sensor: Sensor,
  ): Int? {
    val sample =
      withTimeoutOrNull(1200L) {
        suspendCancellableCoroutine<Float?> { cont ->
          val listener =
            object : SensorEventListener {
              override fun onSensorChanged(event: SensorEvent?) {
                val value = event?.values?.firstOrNull()
                val token = cont.tryResume(value) ?: return
                cont.completeResume(token)
                sensorManager.unregisterListener(this)
              }

              override fun onAccuracyChanged(
                sensor: Sensor?,
                accuracy: Int,
              ) = Unit
            }
          val registered = sensorManager.registerListener(listener, sensor, SensorManager.SENSOR_DELAY_NORMAL)
          if (!registered) {
            sensorManager.unregisterListener(listener)
            cont.resume(null) { _, _, _ -> }
            return@suspendCancellableCoroutine
          }
          cont.invokeOnCancellation { sensorManager.unregisterListener(listener) }
        }
      }
    return sample?.toInt()?.takeIf { it >= 0 }
  }

  @OptIn(InternalCoroutinesApi::class)
  private suspend fun readAccelerometerSample(
    sensorManager: SensorManager,
    sensor: Sensor,
  ): AccelerometerSample? {
    val sample =
      withTimeoutOrNull(ACCELEROMETER_SAMPLE_TIMEOUT_MS) {
        suspendCancellableCoroutine<AccelerometerSample?> { cont ->
          var count = 0
          var sumDelta = 0.0
          val listener =
            object : SensorEventListener {
              override fun onSensorChanged(event: SensorEvent?) {
                val values = event?.values ?: return
                if (values.size < 3) return
                val magnitude =
                  sqrt(
                    values[0] * values[0] +
                      values[1] * values[1] +
                      values[2] * values[2],
                  ).toDouble()
                sumDelta += abs(magnitude - SensorManager.GRAVITY_EARTH.toDouble())
                count += 1
                if (count >= ACCELEROMETER_SAMPLE_TARGET) {
                  val result =
                    AccelerometerSample(
                      samples = count,
                      averageDelta = sumDelta / count,
                    )
                  val token = cont.tryResume(result) ?: return
                  cont.completeResume(token)
                  sensorManager.unregisterListener(this)
                }
              }

              override fun onAccuracyChanged(
                sensor: Sensor?,
                accuracy: Int,
              ) = Unit
            }
          val registered = sensorManager.registerListener(listener, sensor, SensorManager.SENSOR_DELAY_NORMAL)
          if (!registered) {
            cont.resume(null) { _, _, _ -> }
            return@suspendCancellableCoroutine
          }
          cont.invokeOnCancellation { sensorManager.unregisterListener(listener) }
        }
      }
    return sample
  }

  private fun classifyActivity(averageDelta: Double): String =
    when {
      averageDelta <= 0.55 -> "stationary"
      averageDelta <= 1.80 -> "walking"
      else -> "running"
    }

  private fun classifyConfidence(
    samples: Int,
    averageDelta: Double,
  ): String {
    if (samples < 6) return "low"
    if (samples >= 14 && averageDelta > 0.4) return "high"
    return "medium"
  }
}

class MotionHandler private constructor(
  private val appContext: Context,
  private val dataSource: MotionDataSource,
) {
  constructor(appContext: Context) : this(appContext = appContext, dataSource = SystemMotionDataSource)

  suspend fun handleMotionActivity(paramsJson: String?): GatewaySession.InvokeResult {
    if (!dataSource.hasPermission(appContext)) {
      return GatewaySession.InvokeResult.error(
        code = "MOTION_PERMISSION_REQUIRED",
        message = "MOTION_PERMISSION_REQUIRED: grant Motion permission",
      )
    }
    val request =
      parseActivityRequest(paramsJson)
        ?: return GatewaySession.InvokeResult.error(
          code = "INVALID_REQUEST",
          message = "INVALID_REQUEST: expected JSON object",
        )
    return try {
      val activity = dataSource.activity(appContext, request)
      GatewaySession.InvokeResult.ok(
        buildJsonObject {
          put(
            "activities",
            buildJsonArray {
              add(
                buildJsonObject {
                  put("startISO", JsonPrimitive(activity.startISO))
                  put("endISO", JsonPrimitive(activity.endISO))
                  put("confidence", JsonPrimitive(activity.confidence))
                  put("isWalking", JsonPrimitive(activity.isWalking))
                  put("isRunning", JsonPrimitive(activity.isRunning))
                  put("isCycling", JsonPrimitive(activity.isCycling))
                  put("isAutomotive", JsonPrimitive(activity.isAutomotive))
                  put("isStationary", JsonPrimitive(activity.isStationary))
                  put("isUnknown", JsonPrimitive(activity.isUnknown))
                },
              )
            },
          )
        }.toString(),
      )
    } catch (err: IllegalArgumentException) {
      GatewaySession.InvokeResult.error(code = "MOTION_UNAVAILABLE", message = err.message ?: "MOTION_UNAVAILABLE")
    } catch (err: Throwable) {
      GatewaySession.InvokeResult.error(
        code = "MOTION_UNAVAILABLE",
        message = "MOTION_UNAVAILABLE: ${err.message ?: "motion activity failed"}",
      )
    }
  }

  suspend fun handleMotionPedometer(paramsJson: String?): GatewaySession.InvokeResult {
    if (!dataSource.hasPermission(appContext)) {
      return GatewaySession.InvokeResult.error(
        code = "MOTION_PERMISSION_REQUIRED",
        message = "MOTION_PERMISSION_REQUIRED: grant Motion permission",
      )
    }
    val request =
      parsePedometerRequest(paramsJson)
        ?: return GatewaySession.InvokeResult.error(
          code = "INVALID_REQUEST",
          message = "INVALID_REQUEST: expected JSON object",
        )
    return try {
      val payload = dataSource.pedometer(appContext, request)
      GatewaySession.InvokeResult.ok(
        buildJsonObject {
          put("startISO", JsonPrimitive(payload.startISO))
          put("endISO", JsonPrimitive(payload.endISO))
          payload.steps?.let { put("steps", JsonPrimitive(it)) }
          payload.distanceMeters?.let { put("distanceMeters", JsonPrimitive(it)) }
          payload.floorsAscended?.let { put("floorsAscended", JsonPrimitive(it)) }
          payload.floorsDescended?.let { put("floorsDescended", JsonPrimitive(it)) }
        }.toString(),
      )
    } catch (err: IllegalArgumentException) {
      GatewaySession.InvokeResult.error(code = "MOTION_UNAVAILABLE", message = err.message ?: "MOTION_UNAVAILABLE")
    } catch (err: Throwable) {
      GatewaySession.InvokeResult.error(
        code = "MOTION_UNAVAILABLE",
        message = "MOTION_UNAVAILABLE: ${err.message ?: "pedometer query failed"}",
      )
    }
  }

  fun isAvailable(): Boolean = dataSource.isAvailable(appContext)

  fun isActivityAvailable(): Boolean = dataSource.isActivityAvailable(appContext)

  fun isPedometerAvailable(): Boolean = dataSource.isPedometerAvailable(appContext)

  private fun parseActivityRequest(paramsJson: String?): MotionActivityRequest? {
    if (paramsJson.isNullOrBlank()) {
      return MotionActivityRequest(startISO = null, endISO = null, limit = 200)
    }
    val params =
      try {
        Json.parseToJsonElement(paramsJson).asObjectOrNull()
      } catch (_: Throwable) {
        null
      } ?: return null
    val limit = ((params["limit"] as? JsonPrimitive)?.content?.toIntOrNull() ?: 200).coerceIn(1, 1000)
    return MotionActivityRequest(
      startISO = (params["startISO"] as? JsonPrimitive)?.content?.trim()?.ifEmpty { null },
      endISO = (params["endISO"] as? JsonPrimitive)?.content?.trim()?.ifEmpty { null },
      limit = limit,
    )
  }

  private fun parsePedometerRequest(paramsJson: String?): MotionPedometerRequest? {
    if (paramsJson.isNullOrBlank()) {
      return MotionPedometerRequest(startISO = null, endISO = null)
    }
    val params =
      try {
        Json.parseToJsonElement(paramsJson).asObjectOrNull()
      } catch (_: Throwable) {
        null
      } ?: return null
    return MotionPedometerRequest(
      startISO = (params["startISO"] as? JsonPrimitive)?.content?.trim()?.ifEmpty { null },
      endISO = (params["endISO"] as? JsonPrimitive)?.content?.trim()?.ifEmpty { null },
    )
  }

  companion object {
    fun isMotionCapabilityAvailable(context: Context): Boolean = SystemMotionDataSource.isAvailable(context)

    internal fun forTesting(
      appContext: Context,
      dataSource: MotionDataSource,
    ): MotionHandler = MotionHandler(appContext = appContext, dataSource = dataSource)
  }
}
