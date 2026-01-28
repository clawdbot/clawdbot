package bot.molt.android.node

import android.Manifest
import android.content.Context
import android.content.pm.PackageManager
import android.location.Location
import android.location.LocationManager
import android.os.CancellationSignal
import androidx.core.content.ContextCompat
import java.time.Instant
import java.time.format.DateTimeFormatter
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import kotlinx.coroutines.withTimeout
import kotlin.coroutines.resume
import kotlin.coroutines.resumeWithException
import kotlinx.coroutines.suspendCancellableCoroutine

class LocationCaptureManager(private val context: Context) {
  data class Payload(val payloadJson: String)

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

      val cached = bestLastKnown(manager, desiredProviders, maxAgeMs)
      val location =
        cached ?: requestCurrent(manager, desiredProviders, timeoutMs)

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
    val now = System.currentTimeMillis()
    val candidates =
      providers.mapNotNull { provider -> manager.getLastKnownLocation(provider) }
    val freshest = candidates.maxByOrNull { it.time } ?: return null
    if (maxAgeMs != null && now - freshest.time > maxAgeMs) return null
    return freshest
  }

  private suspend fun requestCurrent(
    manager: LocationManager,
    providers: List<String>,
    timeoutMs: Long,
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
    return withTimeout(timeoutMs.coerceAtLeast(1)) {
      suspendCancellableCoroutine { cont ->
        val signal = CancellationSignal()
        cont.invokeOnCancellation { signal.cancel() }
        manager.getCurrentLocation(resolved, signal, context.mainExecutor) { location ->
          if (location != null) {
            cont.resume(location)
          } else {
            cont.resumeWithException(IllegalStateException("LOCATION_UNAVAILABLE: no fix"))
          }
        }
      }
    }
  }
}
