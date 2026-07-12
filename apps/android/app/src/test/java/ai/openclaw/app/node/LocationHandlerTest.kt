package ai.openclaw.app.node

import ai.openclaw.app.LocationMode
import android.content.Context
import android.location.LocationManager
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.test.runTest
import kotlinx.serialization.json.Json
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Test

class LocationHandlerTest : NodeHandlerRobolectricTest() {
  @Test
  fun handleLocationGet_requiresLocationPermissionWhenNeitherFineNorCoarse() =
    runTest {
      val handler =
        LocationHandler.forTesting(
          appContext = appContext(),
          dataSource =
            FakeLocationDataSource(
              fineGranted = false,
              coarseGranted = false,
            ),
        )

      val result = handler.handleLocationGet(null)

      assertFalse(result.ok)
      assertEquals("LOCATION_PERMISSION_REQUIRED", result.error?.code)
    }

  @Test
  fun handleLocationGet_requiresForegroundBeforeLocationPermission() =
    runTest {
      val handler =
        LocationHandler.forTesting(
          appContext = appContext(),
          dataSource =
            FakeLocationDataSource(
              fineGranted = true,
              coarseGranted = true,
            ),
          isForeground = { false },
        )

      val result = handler.handleLocationGet(null)

      assertFalse(result.ok)
      assertEquals("LOCATION_BACKGROUND_UNAVAILABLE", result.error?.code)
    }

  @Test
  fun handleLocationGet_allowsBackgroundWhenThirdPartyAlwaysGrantIsEffective() =
    runTest {
      val source =
        FakeLocationDataSource(
          fineGranted = false,
          coarseGranted = true,
          backgroundGranted = true,
          payload = LocationCaptureManager.Payload("""{"ok":true}"""),
        )
      val handler =
        LocationHandler.forTesting(
          appContext = appContext(),
          dataSource = source,
          isForeground = { false },
          locationMode = { LocationMode.Always },
          backgroundLocationEnabled = { true },
        )

      val result = handler.handleLocationGet(null)

      assertTrue(result.ok)
    }

  @Test
  fun handleLocationGet_deniesBackgroundWhenFlavorDisablesAlwaysMode() =
    runTest {
      val handler =
        LocationHandler.forTesting(
          appContext = appContext(),
          dataSource =
            FakeLocationDataSource(
              fineGranted = true,
              coarseGranted = true,
              backgroundGranted = true,
            ),
          isForeground = { false },
          locationMode = { LocationMode.Always },
          backgroundLocationEnabled = { false },
        )

      val result = handler.handleLocationGet(null)

      assertFalse(result.ok)
      assertEquals("LOCATION_BACKGROUND_UNAVAILABLE", result.error?.code)
    }

  @Test
  fun hasFineLocationPermission_reflectsDataSource() {
    val denied =
      LocationHandler.forTesting(
        appContext = appContext(),
        dataSource = FakeLocationDataSource(fineGranted = false, coarseGranted = true),
      )
    assertFalse(denied.hasFineLocationPermission())
    assertTrue(denied.hasCoarseLocationPermission())

    val granted =
      LocationHandler.forTesting(
        appContext = appContext(),
        dataSource = FakeLocationDataSource(fineGranted = true, coarseGranted = false),
      )
    assertTrue(granted.hasFineLocationPermission())
    assertFalse(granted.hasCoarseLocationPermission())
  }

  @Test
  fun handleLocationGet_usesPreciseGpsFirstWhenFinePermissionAndPreciseEnabled() =
    runTest {
      val source =
        FakeLocationDataSource(
          fineGranted = true,
          coarseGranted = true,
          payload = LocationCaptureManager.Payload("""{"ok":true}"""),
        )
      val handler =
        LocationHandler.forTesting(
          appContext = appContext(),
          dataSource = source,
          locationPreciseEnabled = { true },
        )

      val result = handler.handleLocationGet("""{"desiredAccuracy":"precise","maxAgeMs":1234,"timeoutMs":2000}""")

      assertTrue(result.ok)
      assertEquals(listOf(LocationManager.GPS_PROVIDER, LocationManager.NETWORK_PROVIDER), source.lastDesiredProviders)
      assertEquals(1234L, source.lastMaxAgeMs)
      assertEquals(2000L, source.lastTimeoutMs)
      assertTrue(source.lastIsPrecise)
    }

  @Test
  fun handleLocationGet_fallsBackToBalancedWhenPreciseUnavailable() =
    runTest {
      val source =
        FakeLocationDataSource(
          fineGranted = false,
          coarseGranted = true,
          payload = LocationCaptureManager.Payload("""{"ok":true}"""),
        )
      val handler =
        LocationHandler.forTesting(
          appContext = appContext(),
          dataSource = source,
          locationPreciseEnabled = { true },
        )

      val result = handler.handleLocationGet("""{"desiredAccuracy":"precise"}""")

      assertTrue(result.ok)
      assertEquals(listOf(LocationManager.NETWORK_PROVIDER, LocationManager.GPS_PROVIDER), source.lastDesiredProviders)
      assertFalse(source.lastIsPrecise)
    }

  @Test
  fun handleLocationGet_mapsTimeoutToLocationTimeout() =
    runTest {
      val handler =
        LocationHandler.forTesting(
          appContext = appContext(),
          dataSource =
            FakeLocationDataSource(
              fineGranted = true,
              coarseGranted = true,
              timeout = true,
            ),
        )

      val result = handler.handleLocationGet(null)

      assertFalse(result.ok)
      assertEquals("LOCATION_TIMEOUT", result.error?.code)
      assertEquals("LOCATION_TIMEOUT: no fix in time", result.error?.message)
    }

  @Test
  fun handleLocationGet_mapsOtherFailuresToLocationUnavailable() =
    runTest {
      val handler =
        LocationHandler.forTesting(
          appContext = appContext(),
          dataSource =
            FakeLocationDataSource(
              fineGranted = true,
              coarseGranted = true,
              failure = IllegalStateException("gps offline"),
            ),
        )

      val result = handler.handleLocationGet(null)

      assertFalse(result.ok)
      assertEquals("LOCATION_UNAVAILABLE", result.error?.code)
      assertEquals("gps offline", result.error?.message)
    }

  @Test
  fun handleLocationGet_propagatesParentCancellation() =
    runTest {
      val handler =
        LocationHandler.forTesting(
          appContext = appContext(),
          dataSource =
            FakeLocationDataSource(
              fineGranted = true,
              coarseGranted = true,
              failure = CancellationException("request retired"),
            ),
        )

      try {
        handler.handleLocationGet(null)
        fail("expected cancellation to propagate")
      } catch (err: CancellationException) {
        assertEquals("request retired", err.message)
      }
    }
}

private class FakeLocationDataSource(
  private val fineGranted: Boolean,
  private val coarseGranted: Boolean,
  private val backgroundGranted: Boolean = false,
  private val payload: LocationCaptureManager.Payload? = null,
  private val failure: Throwable? = null,
  private val timeout: Boolean = false,
) : LocationDataSource {
  var lastDesiredProviders: List<String> = emptyList()
  var lastMaxAgeMs: Long? = null
  var lastTimeoutMs: Long? = null
  var lastIsPrecise: Boolean = false

  override fun hasFinePermission(context: Context): Boolean = fineGranted

  override fun hasCoarsePermission(context: Context): Boolean = coarseGranted

  override fun hasBackgroundPermission(context: Context): Boolean = backgroundGranted

  override suspend fun fetchLocation(
    desiredProviders: List<String>,
    maxAgeMs: Long?,
    timeoutMs: Long,
    isPrecise: Boolean,
  ): LocationCaptureManager.Payload {
    lastDesiredProviders = desiredProviders
    lastMaxAgeMs = maxAgeMs
    lastTimeoutMs = timeoutMs
    lastIsPrecise = isPrecise
    if (timeout) {
      kotlinx.coroutines.withTimeout(1) {
        kotlinx.coroutines.delay(5)
      }
    }
    failure?.let { throw it }
    return payload ?: LocationCaptureManager.Payload(Json.encodeToString(mapOf("ok" to true)))
  }
}
