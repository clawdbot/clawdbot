package ai.openclaw.app.gateway

import android.net.ConnectivityManager
import android.net.NetworkCapabilities
import org.junit.Assert.assertEquals
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import org.robolectric.Shadows.shadowOf
import org.robolectric.annotation.Config
import org.robolectric.shadows.ShadowNetwork

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34])
class NetworkMonitorTest {
  @Test
  fun networkAvailabilityWakesOncePerEpisode() {
    val state = NetworkRestoreState<String>()

    assertEquals(true, state.onAvailable("wifi"))
    assertEquals(false, state.onAvailable("wifi"))
    state.onLost("wifi")
    assertEquals(true, state.onAvailable("wifi"))
  }

  @Test
  fun initialCapabilitiesAfterAvailabilityDoNotWakeTwice() {
    val state = NetworkRestoreState<String>()

    assertEquals(true, state.onAvailable("wifi"))
    assertEquals(false, state.onCapabilitiesChanged("wifi", isValidated = true))
    assertEquals(false, state.onCapabilitiesChanged("wifi", isValidated = true))
  }

  @Test
  fun validationReturningOnAnAvailableNetworkWakes() {
    val state = NetworkRestoreState<String>()

    assertEquals(true, state.onAvailable("wifi"))
    assertEquals(false, state.onCapabilitiesChanged("wifi", isValidated = false))
    assertEquals(true, state.onCapabilitiesChanged("wifi", isValidated = true))
  }

  @Test
  fun eachNetworkAvailabilityIsIndependent() {
    val state = NetworkRestoreState<String>()

    assertEquals(true, state.onAvailable("cellular"))
    assertEquals(true, state.onAvailable("wifi"))
  }

  @Test
  fun initialValidatedNetworkSuppressesRegistrationSnapshot() {
    val state = NetworkRestoreState(setOf("wifi"))

    assertEquals(false, state.onAvailable("wifi"))
    assertEquals(false, state.onCapabilitiesChanged("wifi", isValidated = true))
  }

  @Test
  fun bootstrapGraceCoversTheRegistrationReplayWindow() {
    // registerNetworkCallback() replays every already-validated network's state right after
    // registration, and there is no non-deprecated synchronous way to seed all of them up front
    // (only the single active network). Without this grace window, a second already-validated
    // network's replay would misread as a fresh restore at every cold start. Regression for the
    // P2 finding on #127873.
    val registeredAt = 1_000_000_000L

    assertEquals(true, isWithinNetworkMonitorBootstrapGrace(registeredAt, registeredAt))
    assertEquals(
      true,
      isWithinNetworkMonitorBootstrapGrace(registeredAt, registeredAt + NETWORK_MONITOR_BOOTSTRAP_GRACE_NANOS - 1),
    )
  }

  @Test
  fun bootstrapGraceExpiresSoALaterRestoreStillWakes() {
    val registeredAt = 1_000_000_000L

    assertEquals(
      false,
      isWithinNetworkMonitorBootstrapGrace(registeredAt, registeredAt + NETWORK_MONITOR_BOOTSTRAP_GRACE_NANOS),
    )
    assertEquals(
      false,
      isWithinNetworkMonitorBootstrapGrace(registeredAt, registeredAt + NETWORK_MONITOR_BOOTSTRAP_GRACE_NANOS * 100),
    )
  }

  @Test
  fun aPlainNetworkAttachWakesEvenWithoutValidation() {
    // A saved Gateway on a private LAN or a split-tunnel VPN route can be reachable without the
    // network ever reporting NET_CAPABILITY_VALIDATED (that capability only confirms general
    // internet reachability), so the wake must not depend on validation. Regression for the P1
    // finding on #127873.
    val context = RuntimeEnvironment.getApplication()
    var wakeCount = 0
    NetworkMonitor(context) { wakeCount += 1 }
    // Outlast NETWORK_MONITOR_BOOTSTRAP_GRACE_NANOS so this attach reads as a genuine restore,
    // not registerNetworkCallback()'s own registration replay.
    Thread.sleep(600)

    val connectivity = context.getSystemService(ConnectivityManager::class.java)
    val callback = shadowOf(connectivity).networkCallbacks.single()
    callback.onAvailable(ShadowNetwork.newInstance(101))

    assertEquals(1, wakeCount)
  }

  @Test
  fun callbackRequestIncludesVpnRoutes() {
    val request = appUsableNetworkRequest()

    assertEquals(
      false,
      request.hasCapability(NetworkCapabilities.NET_CAPABILITY_NOT_VPN),
    )
  }

  @Test
  fun differentNetworkAttachesEachWakeTheFleet() {
    val context = RuntimeEnvironment.getApplication()
    var wakeCount = 0
    NetworkMonitor(context) { wakeCount += 1 }
    Thread.sleep(600)

    val connectivity = context.getSystemService(ConnectivityManager::class.java)
    val callback = shadowOf(connectivity).networkCallbacks.single()
    callback.onAvailable(ShadowNetwork.newInstance(101))
    callback.onAvailable(ShadowNetwork.newInstance(202))

    assertEquals(2, wakeCount)
  }

  @Test
  fun networkAttachDuringBootstrapGraceDoesNotWake() {
    val context = RuntimeEnvironment.getApplication()
    var wakeCount = 0
    NetworkMonitor(context) { wakeCount += 1 }

    val connectivity = context.getSystemService(ConnectivityManager::class.java)
    val callback = shadowOf(connectivity).networkCallbacks.single()
    callback.onAvailable(ShadowNetwork.newInstance(101))

    assertEquals(0, wakeCount)
  }
}
