package ai.openclaw.app.node

import android.Manifest
import android.content.Context
import android.location.Location
import android.location.LocationManager
import android.os.Looper
import kotlinx.coroutines.runBlocking
import org.junit.Assert.assertTrue
import org.junit.Test
import org.robolectric.RuntimeEnvironment
import org.robolectric.Shadows.shadowOf
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
}
