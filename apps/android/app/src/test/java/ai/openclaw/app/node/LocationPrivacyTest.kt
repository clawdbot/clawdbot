package ai.openclaw.app.node

import ai.openclaw.app.LocationMode
import ai.openclaw.app.gateway.GatewaySession
import android.Manifest
import android.content.Context
import android.location.Location
import android.location.LocationManager
import android.os.Looper
import android.os.SystemClock
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.async
import kotlinx.coroutines.cancel
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.boolean
import kotlinx.serialization.json.double
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import org.robolectric.RuntimeEnvironment
import org.robolectric.Shadows.shadowOf
import java.util.concurrent.atomic.AtomicBoolean

/** Exercises the real permission -> capture -> response boundary, not a fake payload. */
class LocationPrivacyTest : NodeHandlerRobolectricTest() {
  @Test(timeout = 10_000)
  fun cachedLocation_obeysAppAndSystemPrecisionLimits() {
    for (
    (fineGranted, preciseEnabled, requestedAccuracy) in
    listOf(Triple(true, false, "precise"), Triple(false, true, "precise"), Triple(true, true, "coarse"))
    ) {
      val context = RuntimeEnvironment.getApplication()
      shadowOf(context).grantPermissions(Manifest.permission.ACCESS_COARSE_LOCATION)
      if (fineGranted) {
        shadowOf(context).grantPermissions(Manifest.permission.ACCESS_FINE_LOCATION)
      } else {
        shadowOf(context).denyPermissions(Manifest.permission.ACCESS_FINE_LOCATION)
      }
      val manager = context.getSystemService(Context.LOCATION_SERVICE) as LocationManager
      val provider = if (fineGranted) LocationManager.GPS_PROVIDER else LocationManager.NETWORK_PROVIDER
      shadowOf(manager).setProviderEnabled(provider, true)
      val fix = location(provider)
      shadowOf(manager).simulateLocation(provider, fix)
      val handler = handler(context) { preciseEnabled }

      val first = invoke(handler, requestedAccuracy)
      val second = invoke(handler, requestedAccuracy)

      assertApproximate(first, fix)
      assertEquals(first["lat"], second["lat"])
      assertEquals(first["lon"], second["lon"])
      assertEquals("cached source must not be mutated", 5f, fix.accuracy, 0f)
      assertTrue(fix.hasAltitude())
    }
  }

  @Test(timeout = 10_000)
  fun cachedLocation_preservesPreciseOptInAndAlreadyPoorAccuracy() {
    val context = RuntimeEnvironment.getApplication()
    shadowOf(context).grantPermissions(Manifest.permission.ACCESS_FINE_LOCATION, Manifest.permission.ACCESS_COARSE_LOCATION)
    val manager = context.getSystemService(Context.LOCATION_SERVICE) as LocationManager
    shadowOf(manager).setProviderEnabled(LocationManager.GPS_PROVIDER, true)
    val fix = location(LocationManager.GPS_PROVIDER)
    shadowOf(manager).simulateLocation(LocationManager.GPS_PROVIDER, fix)

    val precise = invoke(handler(context) { true }, "precise")
    assertEquals(fix.latitude, precise.getValue("lat").jsonPrimitive.double, 0.0)
    assertEquals(fix.longitude, precise.getValue("lon").jsonPrimitive.double, 0.0)
    assertEquals(5.0, precise.getValue("accuracyMeters").jsonPrimitive.double, 0.0)
    assertEquals(fix.altitude, precise.getValue("altitudeMeters").jsonPrimitive.double, 0.0)
    assertTrue(precise.getValue("isPrecise").jsonPrimitive.boolean)

    fix.accuracy = 5_000f
    shadowOf(manager).simulateLocation(LocationManager.GPS_PROVIDER, fix)
    val approximate = invoke(handler(context) { false }, "precise")
    assertEquals(5_000.0, approximate.getValue("accuracyMeters").jsonPrimitive.double, 0.0)
    assertApproximate(approximate, fix)
  }

  @Test(timeout = 10_000)
  fun liveLocation_respectsPrecisionDisabledBeforeCapture() {
    verifyLiveLocation(initiallyPrecise = false)
  }

  @Test(timeout = 10_000)
  fun liveLocation_respectsPrecisionDisabledDuringCapture() {
    verifyLiveLocation(initiallyPrecise = true)
  }

  @Test(timeout = 10_000)
  fun liveLocation_doesNotUpgradeRequestThatBeganApproximate() {
    verifyLiveLocation(initiallyPrecise = false, finallyPrecise = true)
  }

  @Test(timeout = 10_000)
  fun approximateLocation_staysFiniteAtPolesAndAntimeridian() {
    val context = RuntimeEnvironment.getApplication()
    shadowOf(context).grantPermissions(Manifest.permission.ACCESS_FINE_LOCATION, Manifest.permission.ACCESS_COARSE_LOCATION)
    val manager = context.getSystemService(Context.LOCATION_SERVICE) as LocationManager
    shadowOf(manager).setProviderEnabled(LocationManager.GPS_PROVIDER, true)
    val handler = handler(context) { false }
    for ((latitude, longitude) in listOf(90.0 to 180.0, -90.0 to -180.0, 0.0 to 179.999999, 0.0 to -179.999999)) {
      val fix =
        location(LocationManager.GPS_PROVIDER).apply {
          this.latitude = latitude
          this.longitude = longitude
        }
      shadowOf(manager).simulateLocation(LocationManager.GPS_PROVIDER, fix)
      val result = invoke(handler, "precise")
      val coarseLatitude = result.getValue("lat").jsonPrimitive.double
      val coarseLongitude = result.getValue("lon").jsonPrimitive.double
      assertTrue(coarseLatitude.isFinite() && coarseLatitude in -90.0..90.0)
      assertTrue(coarseLongitude.isFinite() && coarseLongitude >= -180.0 && coarseLongitude < 180.0)
      assertFalse(result.getValue("isPrecise").jsonPrimitive.boolean)
      assertTrue(result.getValue("accuracyMeters").jsonPrimitive.double >= 2_000.0)
    }
  }

  private fun verifyLiveLocation(
    initiallyPrecise: Boolean,
    finallyPrecise: Boolean = false,
  ) {
    val context = RuntimeEnvironment.getApplication()
    shadowOf(context).grantPermissions(Manifest.permission.ACCESS_FINE_LOCATION, Manifest.permission.ACCESS_COARSE_LOCATION)
    val manager = context.getSystemService(Context.LOCATION_SERVICE) as LocationManager
    val shadowManager = shadowOf(manager)
    shadowManager.setProviderEnabled(LocationManager.NETWORK_PROVIDER, false)
    shadowManager.setProviderEnabled(LocationManager.GPS_PROVIDER, true)
    shadowManager.simulateLocation(LocationManager.GPS_PROVIDER, location(LocationManager.GPS_PROVIDER, ageMs = 5_000))
    val preciseEnabled = AtomicBoolean(initiallyPrecise)
    val handler = handler(context, preciseEnabled::get)
    val scope = CoroutineScope(Dispatchers.IO)
    try {
      val result =
        scope.async {
          handler.handleLocationGet("""{"desiredAccuracy":"precise","maxAgeMs":500,"timeoutMs":5000}""")
        }
      idleUntil { shadowManager.getLocationRequests(LocationManager.GPS_PROVIDER).isNotEmpty() }
      assertFalse("request must still be waiting for a fresh fix", result.isCompleted)
      preciseEnabled.set(finallyPrecise)
      val fix = location(LocationManager.GPS_PROVIDER)
      shadowManager.simulateLocation(LocationManager.GPS_PROVIDER, fix)
      idleUntil { result.isCompleted }

      assertApproximate(payload(runBlocking { result.await() }), fix)
      assertTrue(shadowManager.getLocationRequests(LocationManager.GPS_PROVIDER).isEmpty())
    } finally {
      scope.cancel()
    }
  }

  private fun handler(
    context: Context,
    preciseEnabled: () -> Boolean,
  ): LocationHandler =
    LocationHandler(
      appContext = context,
      location = LocationCaptureManager(context),
      json = Json,
      isForeground = { true },
      locationMode = { LocationMode.WhileUsing },
      backgroundLocationEnabled = { false },
      locationPreciseEnabled = preciseEnabled,
    )

  private fun invoke(
    handler: LocationHandler,
    accuracy: String,
  ): JsonObject {
    val scope = CoroutineScope(Dispatchers.IO)
    try {
      val result = scope.async { handler.handleLocationGet("""{"desiredAccuracy":"$accuracy"}""") }
      idleUntil { result.isCompleted }
      return payload(runBlocking { result.await() })
    } finally {
      scope.cancel()
    }
  }

  private fun payload(result: GatewaySession.InvokeResult): JsonObject {
    assertTrue("location command failed: " + result.error, result.ok)
    return Json.parseToJsonElement(requireNotNull(result.payloadJson)).jsonObject
  }

  private fun assertApproximate(
    payload: JsonObject,
    original: Location,
  ) {
    assertFalse(payload.getValue("isPrecise").jsonPrimitive.boolean)
    assertTrue("approximate response must not advertise fine accuracy", payload.getValue("accuracyMeters").jsonPrimitive.double >= 2_000.0)
    assertNotEquals(original.latitude, payload.getValue("lat").jsonPrimitive.double, 0.0)
    assertNotEquals(original.longitude, payload.getValue("lon").jsonPrimitive.double, 0.0)
    for (field in listOf("altitudeMeters", "speedMps", "headingDeg")) {
      assertFalse("approximate response leaked $field", payload.containsKey(field))
    }
  }

  private fun location(
    provider: String,
    ageMs: Long = 0,
  ): Location =
    Location(provider).apply {
      latitude = 12.345678
      longitude = 45.678912
      accuracy = 5f
      altitude = 123.456
      speed = 2.5f
      bearing = 87.5f
      time = System.currentTimeMillis() - ageMs
      elapsedRealtimeNanos = (SystemClock.elapsedRealtime() - ageMs) * 1_000_000
    }

  private fun idleUntil(condition: () -> Boolean) {
    val deadline = System.currentTimeMillis() + 2_000
    while (!condition() && System.currentTimeMillis() < deadline) {
      shadowOf(Looper.getMainLooper()).idle()
      Thread.sleep(10)
    }
    assertTrue("timed out waiting for location request", condition())
  }
}
