package ai.openclaw.app.node

import ai.openclaw.app.LocationMode
import ai.openclaw.app.gateway.GatewaySession
import android.Manifest
import android.content.Context
import android.content.pm.PackageManager
import android.location.Location
import android.location.LocationManager
import androidx.core.content.ContextCompat
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.TimeoutCancellationException
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import java.time.Instant
import java.time.format.DateTimeFormatter

/**
 * Injectable location facade for command tests and Android runtime access.
 */
internal interface LocationDataSource {
  fun hasFinePermission(context: Context): Boolean

  fun hasCoarsePermission(context: Context): Boolean

  fun hasBackgroundPermission(context: Context): Boolean

  suspend fun fetchLocation(
    desiredProviders: List<String>,
    maxAgeMs: Long?,
    timeoutMs: Long,
  ): Location
}

private class DefaultLocationDataSource(
  private val capture: LocationCaptureManager,
) : LocationDataSource {
  override fun hasFinePermission(context: Context): Boolean =
    ContextCompat.checkSelfPermission(context, Manifest.permission.ACCESS_FINE_LOCATION) ==
      PackageManager.PERMISSION_GRANTED

  override fun hasCoarsePermission(context: Context): Boolean =
    ContextCompat.checkSelfPermission(context, Manifest.permission.ACCESS_COARSE_LOCATION) ==
      PackageManager.PERMISSION_GRANTED

  override fun hasBackgroundPermission(context: Context): Boolean =
    ContextCompat.checkSelfPermission(context, Manifest.permission.ACCESS_BACKGROUND_LOCATION) ==
      PackageManager.PERMISSION_GRANTED

  override suspend fun fetchLocation(
    desiredProviders: List<String>,
    maxAgeMs: Long?,
    timeoutMs: Long,
  ): Location =
    capture.getLocation(
      desiredProviders = desiredProviders,
      maxAgeMs = maxAgeMs,
      timeoutMs = timeoutMs,
    )
}

class LocationHandler private constructor(
  private val appContext: Context,
  private val dataSource: LocationDataSource,
  private val json: Json,
  private val isForeground: () -> Boolean,
  private val locationMode: () -> LocationMode,
  private val backgroundLocationEnabled: () -> Boolean,
  private val locationPreciseEnabled: () -> Boolean,
) {
  private val coarsener by lazy { LocationCoarsener() }

  constructor(
    appContext: Context,
    location: LocationCaptureManager,
    json: Json,
    isForeground: () -> Boolean,
    locationMode: () -> LocationMode,
    backgroundLocationEnabled: () -> Boolean,
    locationPreciseEnabled: () -> Boolean,
  ) : this(
    appContext = appContext,
    dataSource = DefaultLocationDataSource(location),
    json = json,
    isForeground = isForeground,
    locationMode = locationMode,
    backgroundLocationEnabled = backgroundLocationEnabled,
    locationPreciseEnabled = locationPreciseEnabled,
  )

  /** Reports whether precise GPS-backed location can be requested from Android. */
  fun hasFineLocationPermission(): Boolean = dataSource.hasFinePermission(appContext)

  /** Reports whether network/coarse location can be requested from Android. */
  fun hasCoarseLocationPermission(): Boolean = dataSource.hasCoarsePermission(appContext)

  companion object {
    /** Creates a handler with injected location state for permission and payload tests. */
    internal fun forTesting(
      appContext: Context,
      dataSource: LocationDataSource,
      json: Json = Json { ignoreUnknownKeys = true },
      isForeground: () -> Boolean = { true },
      locationMode: () -> LocationMode = { LocationMode.WhileUsing },
      backgroundLocationEnabled: () -> Boolean = { false },
      locationPreciseEnabled: () -> Boolean = { true },
    ): LocationHandler =
      LocationHandler(
        appContext = appContext,
        dataSource = dataSource,
        json = json,
        isForeground = isForeground,
        locationMode = locationMode,
        backgroundLocationEnabled = backgroundLocationEnabled,
        locationPreciseEnabled = locationPreciseEnabled,
      )
  }

  /** Handles location.get with foreground, permission, and user precision gates applied. */
  suspend fun handleLocationGet(paramsJson: String?): GatewaySession.InvokeResult {
    if (!isForeground() && !allowsBackgroundLocation()) {
      // Android foreground restrictions and user expectation keep live location tied to the visible app.
      return GatewaySession.InvokeResult.error(
        code = "LOCATION_BACKGROUND_UNAVAILABLE",
        message =
          "LOCATION_BACKGROUND_UNAVAILABLE: choose Always and grant background location access",
      )
    }
    if (!dataSource.hasFinePermission(appContext) && !dataSource.hasCoarsePermission(appContext)) {
      return GatewaySession.InvokeResult.error(
        code = "LOCATION_PERMISSION_REQUIRED",
        message = "LOCATION_PERMISSION_REQUIRED: grant Location permission",
      )
    }
    val (maxAgeMs, timeoutMs, desiredAccuracy) = parseLocationParams(paramsJson)
    // A request may ask for less precision, but cannot override the user's limits.
    val initiallyPrecise =
      desiredAccuracy != "coarse" && locationPreciseEnabled() && dataSource.hasFinePermission(appContext)
    val providers =
      if (initiallyPrecise) {
        listOf(LocationManager.GPS_PROVIDER, LocationManager.NETWORK_PROVIDER)
      } else {
        listOf(LocationManager.NETWORK_PROVIDER, LocationManager.GPS_PROVIDER)
      }
    try {
      val fix = dataSource.fetchLocation(providers, maxAgeMs, timeoutMs)
      // Capture can suspend and switch dispatchers. Recheck at the response producer,
      // without another suspension, and never upgrade a request that began approximate.
      val isPrecise = initiallyPrecise && locationPreciseEnabled() && dataSource.hasFinePermission(appContext)
      val location = if (isPrecise) fix else coarsener.coarsen(fix)
      val payload =
        buildJsonObject {
          put("lat", location.latitude)
          put("lon", location.longitude)
          put("accuracyMeters", location.accuracy.toDouble())
          if (location.hasAltitude()) put("altitudeMeters", location.altitude)
          if (location.hasSpeed()) put("speedMps", location.speed.toDouble())
          if (location.hasBearing()) put("headingDeg", location.bearing.toDouble())
          put("timestamp", DateTimeFormatter.ISO_INSTANT.format(Instant.ofEpochMilli(location.time)))
          put("isPrecise", isPrecise)
          put("source", location.provider)
        }
      return GatewaySession.InvokeResult.ok(payload.toString())
    } catch (err: TimeoutCancellationException) {
      return GatewaySession.InvokeResult.error(
        code = "LOCATION_TIMEOUT",
        message = "LOCATION_TIMEOUT: no fix in time",
      )
    } catch (err: CancellationException) {
      throw err
    } catch (err: Throwable) {
      val message = err.message ?: "LOCATION_UNAVAILABLE: no fix"
      return GatewaySession.InvokeResult.error(code = "LOCATION_UNAVAILABLE", message = message)
    }
  }

  private fun allowsBackgroundLocation(): Boolean =
    backgroundLocationEnabled() &&
      locationMode() == LocationMode.Always &&
      dataSource.hasBackgroundPermission(appContext)

  private fun parseLocationParams(paramsJson: String?): Triple<Long?, Long, String?> {
    if (paramsJson.isNullOrBlank()) {
      return Triple(null, 10_000L, null)
    }
    val root =
      try {
        json.parseToJsonElement(paramsJson).asObjectOrNull()
      } catch (_: Throwable) {
        null
      }
    val maxAgeMs = (root?.get("maxAgeMs") as? JsonPrimitive)?.content?.toLongOrNull()
    val timeoutMs =
      (root?.get("timeoutMs") as? JsonPrimitive)?.content?.toLongOrNull()?.coerceIn(1_000L, 60_000L)
        ?: 10_000L
    // desiredAccuracy is advisory; invalid values fall through to the default policy.
    val desiredAccuracy =
      (root?.get("desiredAccuracy") as? JsonPrimitive)?.content?.trim()?.lowercase()
    return Triple(maxAgeMs, timeoutMs, desiredAccuracy)
  }
}
