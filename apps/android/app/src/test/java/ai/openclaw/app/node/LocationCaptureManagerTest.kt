package ai.openclaw.app.node

import android.Manifest
import android.content.Context
import android.location.Location
import android.location.LocationManager
import android.os.Looper
import android.os.SystemClock
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.TimeoutCancellationException
import kotlinx.coroutines.async
import kotlinx.coroutines.cancel
import kotlinx.coroutines.runBlocking
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Test
import org.robolectric.RuntimeEnvironment
import org.robolectric.Shadows.shadowOf
import java.time.Duration
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit

class LocationCaptureManagerTest : NodeHandlerRobolectricTest() {
  @Test(timeout = 5_000)
  fun getLocation_ignoresFutureCachedFixWhenCurrentProviderFixExists() {
    val app = RuntimeEnvironment.getApplication()
    shadowOf(app).grantPermissions(Manifest.permission.ACCESS_FINE_LOCATION)
    val manager = app.getSystemService(Context.LOCATION_SERVICE) as LocationManager
    val shadowManager = shadowOf(manager)
    shadowManager.setProviderEnabled(LocationManager.GPS_PROVIDER, true)
    shadowManager.setProviderEnabled(LocationManager.NETWORK_PROVIDER, true)
    val now = System.currentTimeMillis()
    shadowManager.simulateLocation(
      LocationManager.GPS_PROVIDER,
      Location(LocationManager.GPS_PROVIDER).apply {
        latitude = 1.0
        longitude = 1.0
        accuracy = 5f
        time = now + 5_000L
      },
    )
    shadowManager.simulateLocation(
      LocationManager.NETWORK_PROVIDER,
      Location(LocationManager.NETWORK_PROVIDER).apply {
        latitude = 2.0
        longitude = 2.0
        accuracy = 5f
        time = now
      },
    )

    val executor = Executors.newSingleThreadExecutor()
    try {
      val result =
        executor.submit<LocationCaptureManager.Payload> {
          runBlocking {
            LocationCaptureManager(app).getLocation(
              desiredProviders = listOf(LocationManager.GPS_PROVIDER, LocationManager.NETWORK_PROVIDER),
              maxAgeMs = 1_000L,
              timeoutMs = 1_000L,
              isPrecise = true,
            )
          }
        }
      val deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(2)
      while (!result.isDone && System.nanoTime() < deadline) {
        shadowOf(Looper.getMainLooper()).idle()
      }

      assertTrue(result.get(1, TimeUnit.SECONDS).payloadJson.contains("\"lat\":2.0"))
    } finally {
      executor.shutdownNow()
    }
  }

  @Test(timeout = 10_000)
  fun getLocation_rejectsFutureCurrentAndListenerLocationsUntilFreshFixArrives() {
    val app = RuntimeEnvironment.getApplication()
    shadowOf(app).grantPermissions(Manifest.permission.ACCESS_FINE_LOCATION)
    val locationManager = app.getSystemService(Context.LOCATION_SERVICE) as LocationManager
    val shadowManager = shadowOf(locationManager)
    shadowManager.setProviderEnabled(LocationManager.GPS_PROVIDER, true)
    shadowManager.simulateLocation(
      LocationManager.GPS_PROVIDER,
      location(1.0, ageMs = 0).apply { time += 2_000 },
    )

    val captureScope = CoroutineScope(Dispatchers.IO)
    try {
      val result =
        captureScope.async {
          LocationCaptureManager(app).getLocation(
            desiredProviders = listOf(LocationManager.GPS_PROVIDER),
            maxAgeMs = 500,
            timeoutMs = 5_000,
            isPrecise = true,
          )
        }

      idleUntil("future current location callback") {
        result.isCompleted || shadowManager.getLocationRequests(LocationManager.GPS_PROVIDER).isNotEmpty()
      }
      assertFalse("the current-location callback returned a future fix", result.isCompleted)

      shadowManager.simulateLocation(
        LocationManager.GPS_PROVIDER,
        location(2.0, ageMs = 0).apply { time += 2_000 },
      )
      shadowOf(Looper.getMainLooper()).idle()
      assertFalse("the location listener returned a future fix", result.isCompleted)

      shadowManager.simulateLocation(LocationManager.GPS_PROVIDER, location(3.0, ageMs = 0))
      idleUntil("fresh location after future callbacks") { result.isCompleted }

      val payload = runBlocking { result.await() }.payloadJson
      assertTrue("expected the fresh fix, got $payload", payload.contains("\"lat\":3.0"))
      assertTrue(shadowManager.getLocationRequests(LocationManager.GPS_PROVIDER).isEmpty())
    } finally {
      captureScope.cancel()
    }
  }

  @Test(timeout = 10_000)
  fun getLocation_rejectsStaleCurrentAndListenerLocationsUntilFreshFixArrives() {
    val app = RuntimeEnvironment.getApplication()
    shadowOf(app).grantPermissions(Manifest.permission.ACCESS_FINE_LOCATION)
    val locationManager = app.getSystemService(Context.LOCATION_SERVICE) as LocationManager
    val shadowManager = shadowOf(locationManager)
    shadowManager.setProviderEnabled(LocationManager.GPS_PROVIDER, true)
    shadowManager.simulateLocation(LocationManager.GPS_PROVIDER, location(1.0, ageMs = 2_000))

    val captureScope = CoroutineScope(Dispatchers.IO)
    try {
      val result =
        captureScope.async {
          LocationCaptureManager(app).getLocation(
            desiredProviders = listOf(LocationManager.GPS_PROVIDER),
            maxAgeMs = 500,
            timeoutMs = 5_000,
            isPrecise = true,
          )
        }

      idleUntil("current location callback") {
        result.isCompleted || shadowManager.getLocationRequests(LocationManager.GPS_PROVIDER).isNotEmpty()
      }
      assertFalse("the current-location callback returned a stale fix", result.isCompleted)

      shadowManager.simulateLocation(LocationManager.GPS_PROVIDER, location(2.0, ageMs = 1_000))
      shadowOf(Looper.getMainLooper()).idle()
      assertFalse("the location listener returned a stale fix", result.isCompleted)
      assertTrue(
        "the listener must stay registered after a stale update",
        shadowManager.getLocationRequests(LocationManager.GPS_PROVIDER).isNotEmpty(),
      )

      shadowManager.simulateLocation(LocationManager.GPS_PROVIDER, location(3.0, ageMs = 0))
      idleUntil("fresh location callback") { result.isCompleted }

      val payload = runBlocking { result.await() }.payloadJson
      assertTrue("expected the fresh fix, got $payload", payload.contains("\"lat\":3.0"))
      assertTrue(shadowManager.getLocationRequests(LocationManager.GPS_PROVIDER).isEmpty())
    } finally {
      captureScope.cancel()
    }
  }

  @Test(timeout = 10_000)
  fun getLocation_timesOutAndRemovesListenerWhenNoFreshFixArrives() {
    val app = RuntimeEnvironment.getApplication()
    shadowOf(app).grantPermissions(Manifest.permission.ACCESS_FINE_LOCATION)
    val locationManager = app.getSystemService(Context.LOCATION_SERVICE) as LocationManager
    val shadowManager = shadowOf(locationManager)
    shadowManager.setProviderEnabled(LocationManager.GPS_PROVIDER, true)
    shadowManager.simulateLocation(LocationManager.GPS_PROVIDER, location(1.0, ageMs = 2_000))

    val captureScope = CoroutineScope(Dispatchers.IO)
    try {
      val result =
        captureScope.async {
          LocationCaptureManager(app).getLocation(
            desiredProviders = listOf(LocationManager.GPS_PROVIDER),
            maxAgeMs = 500,
            timeoutMs = 250,
            isPrecise = true,
          )
        }

      idleUntil("location listener registration") {
        shadowManager.getLocationRequests(LocationManager.GPS_PROVIDER).isNotEmpty()
      }
      shadowOf(Looper.getMainLooper()).idleFor(Duration.ofMillis(300))
      idleUntil("stale location timeout") { result.isCompleted }
      try {
        runBlocking { result.await() }
        fail("a stale location must time out rather than satisfy the request")
      } catch (_: TimeoutCancellationException) {
        assertTrue(shadowManager.getLocationRequests(LocationManager.GPS_PROVIDER).isEmpty())
      }
    } finally {
      captureScope.cancel()
    }
  }

  @Test(timeout = 10_000)
  fun getLocation_removesRegisteredListenerWhenCallerCancels() {
    val app = RuntimeEnvironment.getApplication()
    shadowOf(app).grantPermissions(Manifest.permission.ACCESS_FINE_LOCATION)
    val locationManager = app.getSystemService(Context.LOCATION_SERVICE) as LocationManager
    val shadowManager = shadowOf(locationManager)
    shadowManager.setProviderEnabled(LocationManager.GPS_PROVIDER, true)
    shadowManager.simulateLocation(LocationManager.GPS_PROVIDER, location(1.0, ageMs = 2_000))

    val captureScope = CoroutineScope(Dispatchers.IO)
    try {
      val result =
        captureScope.async {
          LocationCaptureManager(app).getLocation(
            desiredProviders = listOf(LocationManager.GPS_PROVIDER),
            maxAgeMs = 500,
            timeoutMs = 5_000,
            isPrecise = true,
          )
        }

      idleUntil("cancellable location listener") {
        shadowManager.getLocationRequests(LocationManager.GPS_PROVIDER).isNotEmpty()
      }
      result.cancel()
      idleUntil("location listener cancellation") {
        shadowManager.getLocationRequests(LocationManager.GPS_PROVIDER).isEmpty()
      }
      assertTrue(result.isCancelled)
    } finally {
      captureScope.cancel()
    }
  }

  private fun location(
    latitude: Double,
    ageMs: Long,
  ): Location =
    Location(LocationManager.GPS_PROVIDER).apply {
      this.latitude = latitude
      longitude = latitude
      accuracy = 5f
      time = System.currentTimeMillis() - ageMs
      elapsedRealtimeNanos = (SystemClock.elapsedRealtime() - ageMs) * 1_000_000
    }

  private fun idleUntil(
    description: String,
    condition: () -> Boolean,
  ) {
    val deadline = System.currentTimeMillis() + 2_000
    while (!condition() && System.currentTimeMillis() < deadline) {
      shadowOf(Looper.getMainLooper()).idle()
      Thread.sleep(10)
    }
    assertTrue("timed out waiting for $description", condition())
  }
}
