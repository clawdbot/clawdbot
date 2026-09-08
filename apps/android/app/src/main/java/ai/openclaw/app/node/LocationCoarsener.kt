package ai.openclaw.app.node

import android.location.Location
import android.os.SystemClock
import java.security.SecureRandom
import kotlin.math.cos
import kotlin.math.sqrt

/** App-owned disclosure limit, independent of Android's retained fine-location grant. */
internal class LocationCoarsener {
  private val random = SecureRandom()
  private var latitudeOffsetMeters = nextOffset()
  private var longitudeOffsetMeters = nextOffset()
  private var nextUpdateMs = SystemClock.elapsedRealtime() + OFFSET_INTERVAL_MS

  // One instance survives across requests/providers; handler continuations can run concurrently.
  @Synchronized
  fun coarsen(fine: Location): Location {
    val now = SystemClock.elapsedRealtime()
    if (now >= nextUpdateMs) {
      // Slowly changing offsets resist boundary tracking without fresh per-request noise
      // that repeated requests could average away. Keep the Gaussian variance constant.
      val oldWeight = sqrt(1.0 - OFFSET_CHANGE * OFFSET_CHANGE)
      latitudeOffsetMeters = oldWeight * latitudeOffsetMeters + OFFSET_CHANGE * nextOffset()
      longitudeOffsetMeters = oldWeight * longitudeOffsetMeters + OFFSET_CHANGE * nextOffset()
      nextUpdateMs = now + OFFSET_INTERVAL_MS
    }

    // Follow AOSP LocationFudger's offset + meter-grid algorithm. Quantize latitude
    // before deriving longitude spacing, so that spacing cannot reveal fine latitude.
    // https://android.googlesource.com/platform/frameworks/base/+/81f52b053da6/services/core/java/com/android/server/location/fudger/LocationFudger.java
    val latitude = fine.latitude.coerceIn(-MAX_LATITUDE, MAX_LATITUDE)
    val shiftedLatitude = (latitude + latitudeOffsetMeters / METERS_PER_DEGREE).coerceIn(-MAX_LATITUDE, MAX_LATITUDE)
    val latitudeStep = COARSE_METERS / METERS_PER_DEGREE
    val coarseLatitude = (Math.round(shiftedLatitude / latitudeStep) * latitudeStep).coerceIn(-MAX_LATITUDE, MAX_LATITUDE)
    val shiftedLongitude = wrapLongitude(fine.longitude + longitudeOffsetMeters / metersPerLongitudeDegree(latitude))
    val longitudeStep = COARSE_METERS / metersPerLongitudeDegree(coarseLatitude)
    val coarseLongitude = wrapLongitude(Math.round(shiftedLongitude / longitudeStep) * longitudeStep)

    return Location(fine).apply {
      this.latitude = coarseLatitude
      longitude = coarseLongitude
      accuracy = maxOf(accuracy, COARSE_METERS.toFloat())
      removeAltitude()
      removeSpeed()
      removeBearing()
      extras = null
    }
  }

  private fun nextOffset(): Double = random.nextGaussian() * COARSE_METERS / 4.0

  private fun metersPerLongitudeDegree(latitude: Double): Double = METERS_PER_DEGREE * cos(Math.toRadians(latitude))

  private fun wrapLongitude(longitude: Double): Double {
    val wrapped = longitude % 360.0
    return when {
      wrapped >= 180.0 -> wrapped - 360.0
      wrapped < -180.0 -> wrapped + 360.0
      else -> wrapped
    }
  }

  private companion object {
    const val COARSE_METERS = 2_000.0
    const val METERS_PER_DEGREE = 111_000.0

    // Stay one meter away from either pole to keep longitude conversion finite.
    const val MAX_LATITUDE = 90.0 - 1.0 / METERS_PER_DEGREE
    const val OFFSET_INTERVAL_MS = 60 * 60 * 1_000L
    const val OFFSET_CHANGE = 0.03
  }
}
