package ai.openclaw.app.node

import android.content.Context
import kotlinx.coroutines.test.runTest
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class MotionHandlerTest : NodeHandlerRobolectricTest() {
  @Test
  fun handleMotionActivity_requiresPermission() =
    runTest {
      val handler = MotionHandler.forTesting(appContext(), FakeMotionDataSource(hasPermission = false))

      val result = handler.handleMotionActivity(null)

      assertFalse(result.ok)
      assertEquals("MOTION_PERMISSION_REQUIRED", result.error?.code)
    }

  @Test
  fun handleMotionActivity_rejectsInvalidJson() =
    runTest {
      val handler = MotionHandler.forTesting(appContext(), FakeMotionDataSource(hasPermission = true))

      val result = handler.handleMotionActivity("[]")

      assertFalse(result.ok)
      assertEquals("INVALID_REQUEST", result.error?.code)
    }

  @Test
  fun handleMotionActivity_returnsActivityPayload() =
    runTest {
      val activity =
        MotionActivityRecord(
          startISO = "2026-02-28T10:00:00Z",
          endISO = "2026-02-28T10:00:02Z",
          confidence = "high",
          isWalking = true,
          isRunning = false,
          isCycling = false,
          isAutomotive = false,
          isStationary = false,
          isUnknown = false,
        )
      val handler =
        MotionHandler.forTesting(
          appContext(),
          FakeMotionDataSource(hasPermission = true, activityRecord = activity),
        )

      val result = handler.handleMotionActivity(null)

      assertTrue(result.ok)
      val payload = Json.parseToJsonElement(result.payloadJson ?: error("missing payload")).jsonObject
      val activities = payload.getValue("activities").jsonArray
      assertEquals(1, activities.size)
      assertEquals(
        "high",
        activities
          .first()
          .jsonObject
          .getValue("confidence")
          .jsonPrimitive.content,
      )
    }

  @Test
  fun handleMotionPedometer_mapsRangeUnsupportedError() =
    runTest {
      val handler =
        MotionHandler.forTesting(
          appContext(),
          FakeMotionDataSource(
            hasPermission = true,
            pedometerError = IllegalArgumentException("PEDOMETER_RANGE_UNAVAILABLE: not supported"),
          ),
        )

      val result = handler.handleMotionPedometer("""{"startISO":"2026-02-01T00:00:00Z"}""")

      assertFalse(result.ok)
      assertEquals("MOTION_UNAVAILABLE", result.error?.code)
      assertTrue(result.error?.message?.contains("PEDOMETER_RANGE_UNAVAILABLE") == true)
    }
}

private class FakeMotionDataSource(
  private val hasPermission: Boolean,
  private val activityAvailable: Boolean = true,
  private val pedometerAvailable: Boolean = true,
  private val activityRecord: MotionActivityRecord =
    MotionActivityRecord(
      startISO = "2026-02-28T00:00:00Z",
      endISO = "2026-02-28T00:00:02Z",
      confidence = "medium",
      isWalking = false,
      isRunning = false,
      isCycling = false,
      isAutomotive = false,
      isStationary = true,
      isUnknown = false,
    ),
  private val pedometerRecord: PedometerRecord =
    PedometerRecord(
      startISO = "2026-02-28T00:00:00Z",
      endISO = "2026-02-28T01:00:00Z",
      steps = 1234,
      distanceMeters = null,
      floorsAscended = null,
      floorsDescended = null,
    ),
  private val activityError: Throwable? = null,
  private val pedometerError: Throwable? = null,
) : MotionDataSource {
  override fun isActivityAvailable(context: Context): Boolean = activityAvailable

  override fun isPedometerAvailable(context: Context): Boolean = pedometerAvailable

  override fun hasPermission(context: Context): Boolean = hasPermission

  override suspend fun activity(
    context: Context,
    request: MotionActivityRequest,
  ): MotionActivityRecord {
    activityError?.let { throw it }
    return activityRecord
  }

  override suspend fun pedometer(
    context: Context,
    request: MotionPedometerRequest,
  ): PedometerRecord {
    pedometerError?.let { throw it }
    return pedometerRecord
  }
}
