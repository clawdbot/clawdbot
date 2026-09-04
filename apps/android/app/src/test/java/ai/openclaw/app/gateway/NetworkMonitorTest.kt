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
  fun aPlainNetworkAttachWakesEvenWithoutValidation() {
    // A saved Gateway on a private LAN or a split-tunnel VPN route can be reachable without the
    // network ever reporting NET_CAPABILITY_VALIDATED (that capability only confirms general
    // internet reachability), so the wake must not depend on validation. Regression for the P1
    // finding on #127873.
    val context = RuntimeEnvironment.getApplication()
    var wakeCount = 0
    NetworkMonitor(context) { wakeCount += 1 }

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

    val connectivity = context.getSystemService(ConnectivityManager::class.java)
    val callback = shadowOf(connectivity).networkCallbacks.single()
    callback.onAvailable(ShadowNetwork.newInstance(101))
    callback.onAvailable(ShadowNetwork.newInstance(202))

    assertEquals(2, wakeCount)
  }
}
