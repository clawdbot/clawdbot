package ai.openclaw.app.node

import android.content.Context
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.test.runTest
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Test

class MotionHandlerTest : NodeHandlerRobolectricTest() {
  @Test
  fun handleMotionActivity_requiresPermission() =
    runTest {
      val handler = MotionHandler(appContext(), FakeMotionDataSource(hasPermission = false))

      val result = handler.handleMotionActivity(null)

      assertFalse(result.ok)
      assertEquals("MOTION_PERMISSION_REQUIRED", result.error?.code)
    }

  @Test
  fun handleMotionActivity_rejectsInvalidJson() =
    runTest {
      val handler = MotionHandler(appContext(), FakeMotionDataSource(hasPermission = true))

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
        MotionHandler(
          appContext(),
          FakeMotionDataSource(hasPermission = true, activityRecord = activity),
        )

      for (params in listOf(null, "{}", """{"limit":null}""", """{"limit":1}""", """{"limit":2000}""", """{"limit":"invalid"}""", """{"limit":[]}""")) {
        val result = handler.handleMotionActivity(params)

        assertTrue(result.ok)
        assertEquals(
          Json.parseToJsonElement(
            """{"activities":[{"startISO":"2026-02-28T10:00:00Z","endISO":"2026-02-28T10:00:02Z","confidence":"high","isWalking":true,"isRunning":false,"isCycling":false,"isAutomotive":false,"isStationary":false,"isUnknown":false}]}""",
          ),
          Json.parseToJsonElement(result.payloadJson ?: error("missing payload")),
        )
      }
    }

  @Test
  fun handleMotionActivity_treatsJsonNullRangeAsAbsent() =
    runTest {
      val dataSource = FakeMotionDataSource(hasPermission = true)
      val handler = MotionHandler(appContext(), dataSource)

      val result = handler.handleMotionActivity("""{"startISO":null,"endISO":null,"limit":null}""")

      assertTrue(result.ok)
      assertNull(dataSource.lastActivityRequest?.startISO)
      assertNull(dataSource.lastActivityRequest?.endISO)
    }

  @Test
  fun handleMotionPedometer_treatsJsonNullRangeAsAbsent() =
    runTest {
      val dataSource = FakeMotionDataSource(hasPermission = true)
      val handler = MotionHandler(appContext(), dataSource)

      val result = handler.handleMotionPedometer("""{"startISO":null,"endISO":null}""")

      assertTrue(result.ok)
      assertNull(dataSource.lastPedometerRequest?.startISO)
      assertNull(dataSource.lastPedometerRequest?.endISO)
      val payload = Json.parseToJsonElement(result.payloadJson ?: error("missing payload")).jsonObject
      assertEquals(
        1234,
        payload
          .getValue("steps")
          .jsonPrimitive.content
          .toInt(),
      )
    }

  @Test
  fun motionRangeRequests_preserveLiteralNullStrings() =
    runTest {
      val dataSource = FakeMotionDataSource(hasPermission = true)
      val handler = MotionHandler(appContext(), dataSource)

      assertTrue(handler.handleMotionActivity("""{"startISO":" null ","endISO":"null","limit":2000}""").ok)
      assertEquals("null", dataSource.lastActivityRequest?.startISO)
      assertEquals("null", dataSource.lastActivityRequest?.endISO)

      assertTrue(handler.handleMotionPedometer("""{"startISO":"null","endISO":" null "}""").ok)
      assertEquals("null", dataSource.lastPedometerRequest?.startISO)
      assertEquals("null", dataSource.lastPedometerRequest?.endISO)
    }

  @Test
  fun handleMotionPedometer_mapsRangeUnsupportedError() =
    runTest {
      val handler =
        MotionHandler(
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

  @Test
  fun handleMotionActivity_propagatesParentCancellation() =
    runTest {
      val handler =
        MotionHandler(
          appContext(),
          FakeMotionDataSource(
            hasPermission = true,
            activityError = CancellationException("invoke retired"),
          ),
        )

      try {
        handler.handleMotionActivity(null)
        fail("expected cancellation to propagate")
      } catch (err: CancellationException) {
        assertEquals("invoke retired", err.message)
      }
    }

  @Test
  fun handleMotionPedometer_propagatesParentCancellation() =
    runTest {
      val handler =
        MotionHandler(
          appContext(),
          FakeMotionDataSource(
            hasPermission = true,
            pedometerError = CancellationException("invoke retired"),
          ),
        )

      try {
        handler.handleMotionPedometer(null)
        fail("expected cancellation to propagate")
      } catch (err: CancellationException) {
        assertEquals("invoke retired", err.message)
      }
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
  var lastActivityRequest: MotionRangeRequest? = null
  var lastPedometerRequest: MotionRangeRequest? = null

  override fun isActivityAvailable(context: Context): Boolean = activityAvailable

  override fun isPedometerAvailable(context: Context): Boolean = pedometerAvailable

  override fun hasPermission(context: Context): Boolean = hasPermission

  override suspend fun activity(
    context: Context,
    request: MotionRangeRequest,
  ): MotionActivityRecord {
    lastActivityRequest = request
    activityError?.let { throw it }
    return activityRecord
  }

  override suspend fun pedometer(
    context: Context,
    request: MotionRangeRequest,
  ): PedometerRecord {
    lastPedometerRequest = request
    pedometerError?.let { throw it }
    return pedometerRecord
  }
}
