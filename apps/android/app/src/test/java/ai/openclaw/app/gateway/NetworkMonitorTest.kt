package ai.openclaw.app.gateway

import android.net.ConnectivityManager
import android.net.LinkProperties
import android.net.NetworkCapabilities
import org.junit.Assert.assertEquals
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import org.robolectric.Shadows.shadowOf
import org.robolectric.annotation.Config
import org.robolectric.shadows.ShadowNetwork
import java.net.InetAddress

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
  fun linkPropertiesChangesWakeAnExistingNetworkWithoutValidationChange() {
    val context = RuntimeEnvironment.getApplication()
    var wakeCount = 0
    NetworkMonitor(context) { wakeCount += 1 }
    val connectivity = context.getSystemService(ConnectivityManager::class.java)
    val callback = shadowOf(connectivity).networkCallbacks.single()
    val network = ShadowNetwork.newInstance(501)
    val properties =
      LinkProperties().apply {
        interfaceName = "wlan0"
        setDnsServers(listOf(InetAddress.getByName("192.0.2.1")))
      }
    callback.onAvailable(network)
    callback.onCapabilitiesChanged(network, NetworkCapabilities())
    callback.onLinkPropertiesChanged(network, properties)
    callback.onLinkPropertiesChanged(network, properties)
    assertEquals("Initial properties and identical snapshots coalesce with availability", 1, wakeCount)

    properties.setDnsServers(listOf(InetAddress.getByName("192.0.2.2")))
    callback.onLinkPropertiesChanged(network, properties)
    assertEquals("A DNS-only link change must wake without onAvailable or validation change", 2, wakeCount)
    callback.onLinkPropertiesChanged(network, properties)
    assertEquals(2, wakeCount)

    callback.onLost(network)
    properties.setDnsServers(listOf(InetAddress.getByName("192.0.2.3")))
    callback.onLinkPropertiesChanged(network, properties)
    assertEquals("A late properties event must not resurrect a lost network", 2, wakeCount)
    callback.onAvailable(network)
    callback.onLinkPropertiesChanged(network, properties)
    assertEquals("Reattachment owns a new initial properties snapshot", 3, wakeCount)
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
