package ai.openclaw.app.node

import android.Manifest
import android.content.Context
import android.content.pm.PackageManager
import android.location.Location
import android.location.LocationListener
import android.location.LocationManager
import android.os.CancellationSignal
import android.os.Looper
import androidx.core.content.ContextCompat
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.suspendCancellableCoroutine
import kotlinx.coroutines.withContext
import kotlinx.coroutines.withTimeout
import java.time.Instant
import java.time.format.DateTimeFormatter

/**
 * Android LocationManager-backed capture used by gateway location commands.
 */
class LocationCaptureManager(
  private val context: Context,
) {
  data class Payload(
    val payloadJson: String,
  )

  suspend fun getLocation(
    desiredProviders: List<String>,
    maxAgeMs: Long?,
    timeoutMs: Long,
    isPrecise: Boolean,
  ): Payload =
    withContext(Dispatchers.Main) {
      val manager = context.getSystemService(Context.LOCATION_SERVICE) as LocationManager
      if (!manager.isProviderEnabled(LocationManager.GPS_PROVIDER) &&
        !manager.isProviderEnabled(LocationManager.NETWORK_PROVIDER)
      ) {
        throw IllegalStateException("LOCATION_UNAVAILABLE: no location providers enabled")
      }

      // Prefer a recent cached fix before waking GPS/network providers.
      val location =
        bestLastKnown(manager, desiredProviders, maxAgeMs)
          ?: requestCurrent(manager, desiredProviders, timeoutMs, maxAgeMs)

      val timestamp = DateTimeFormatter.ISO_INSTANT.format(Instant.ofEpochMilli(location.time))
      val source = location.provider
      val altitudeMeters = if (location.hasAltitude()) location.altitude else null
      val speedMps = if (location.hasSpeed()) location.speed.toDouble() else null
      val headingDeg = if (location.hasBearing()) location.bearing.toDouble() else null
      Payload(
        buildString {
          append("{\"lat\":")
          append(location.latitude)
          append(",\"lon\":")
          append(location.longitude)
          append(",\"accuracyMeters\":")
          append(location.accuracy.toDouble())
          if (altitudeMeters != null) append(",\"altitudeMeters\":").append(altitudeMeters)
          if (speedMps != null) append(",\"speedMps\":").append(speedMps)
          if (headingDeg != null) append(",\"headingDeg\":").append(headingDeg)
          append(",\"timestamp\":\"").append(timestamp).append('"')
          append(",\"isPrecise\":").append(isPrecise)
          append(",\"source\":\"").append(source).append('"')
          append('}')
        },
      )
    }

  private fun bestLastKnown(
    manager: LocationManager,
    providers: List<String>,
    maxAgeMs: Long?,
  ): Location? {
    val fineOk =
      ContextCompat.checkSelfPermission(context, Manifest.permission.ACCESS_FINE_LOCATION) ==
        PackageManager.PERMISSION_GRANTED
    val coarseOk =
      ContextCompat.checkSelfPermission(context, Manifest.permission.ACCESS_COARSE_LOCATION) ==
        PackageManager.PERMISSION_GRANTED
    if (!fineOk && !coarseOk) {
      throw IllegalStateException("LOCATION_PERMISSION_REQUIRED: grant Location permission")
    }
    // maxAgeMs applies to every successful fix, regardless of which Android API supplied it.
    return providers
      .mapNotNull { provider -> manager.getLastKnownLocation(provider) }
      .filter { it.isFresh(maxAgeMs) }
      .maxByOrNull { it.time }
  }

  private fun Location.isFresh(maxAgeMs: Long?): Boolean {
    val ageMs = System.currentTimeMillis() - time
    return ageMs >= 0 && (maxAgeMs == null || ageMs <= maxAgeMs)
  }

  private suspend fun requestCurrent(
    manager: LocationManager,
    providers: List<String>,
    timeoutMs: Long,
    maxAgeMs: Long?,
  ): Location {
    val fineOk =
      ContextCompat.checkSelfPermission(context, Manifest.permission.ACCESS_FINE_LOCATION) ==
        PackageManager.PERMISSION_GRANTED
    val coarseOk =
      ContextCompat.checkSelfPermission(context, Manifest.permission.ACCESS_COARSE_LOCATION) ==
        PackageManager.PERMISSION_GRANTED
    if (!fineOk && !coarseOk) {
      throw IllegalStateException("LOCATION_PERMISSION_REQUIRED: grant Location permission")
    }
    val resolved =
      providers.firstOrNull { manager.isProviderEnabled(it) }
        ?: throw IllegalStateException("LOCATION_UNAVAILABLE: no providers available")
    // getCurrentLocation can return null; the handler maps timeout/null fixes to gateway error shapes.
    val location =
      withTimeout(timeoutMs.coerceAtLeast(1)) {
        suspendCancellableCoroutine<Location?> { cont ->
          val signal = CancellationSignal()
          var activeListener: LocationListener? = null
          cont.invokeOnCancellation {
            signal.cancel()
            activeListener?.let(manager::removeUpdates)
          }
          manager.getCurrentLocation(resolved, signal, context.mainExecutor) { location ->
            if (!cont.isActive) return@getCurrentLocation
            if (location == null || location.isFresh(maxAgeMs)) {
              cont.resume(location) { _, _, _ -> }
              return@getCurrentLocation
            }
            val listener =
              object : LocationListener {
                override fun onLocationChanged(update: Location) {
                  if (!cont.isActive) {
                    manager.removeUpdates(this)
                    return
                  }
                  if (!update.isFresh(maxAgeMs)) return
                  manager.removeUpdates(this)
                  cont.resume(update) { _, _, _ -> }
                }
              }
            activeListener = listener
            // Cancellation can remove before registration; fence both sides to avoid a live leak.
            if (!cont.isActive) return@getCurrentLocation
            manager.requestLocationUpdates(resolved, 0L, 0f, listener, Looper.getMainLooper())
            if (!cont.isActive) manager.removeUpdates(listener)
          }
        }
      }
    return location ?: throw IllegalStateException("LOCATION_UNAVAILABLE: no fix")
  }
}
