package ai.openclaw.app.gateway

import android.net.ConnectivityManager
import android.net.NetworkCapabilities
import android.net.NetworkRequest
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import org.robolectric.Shadows.shadowOf
import org.robolectric.annotation.Config
import org.robolectric.annotation.Implementation
import org.robolectric.annotation.Implements
import org.robolectric.shadow.api.Shadow
import org.robolectric.shadows.ShadowConnectivityManager
import org.robolectric.shadows.ShadowNetwork
import org.robolectric.shadows.ShadowNetworkCapabilities

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34], shadows = [RecordingGatewayConnectivityManager::class])
class NetworkMonitorTest {
  @Test
  fun privateLanAttachmentWakesWhileCellularRemainsValidated() {
    var wakes = 0
    val monitor = registerMonitor { wakes += 1 }
    val cellular = ShadowNetwork.newInstance(1)
    val wifi = ShadowNetwork.newInstance(2)

    monitor.callback.onAvailable(cellular)
    monitor.callback.onCapabilitiesChanged(cellular, capabilities(NetworkCapabilities.TRANSPORT_CELLULAR, validated = true))
    assertEquals(1, wakes)
    monitor.callback.onAvailable(wifi)
    monitor.callback.onCapabilitiesChanged(wifi, capabilities(NetworkCapabilities.TRANSPORT_WIFI))
    assertEquals(2, wakes)
    monitor.callback.onLost(wifi)
    assertEquals(2, wakes)
    monitor.callback.onAvailable(wifi)
    assertEquals(3, wakes)
  }

  @Test
  fun coalescesOneAvailabilityEpisodeWithoutDebouncingOtherNetworks() {
    var wakes = 0
    val monitor = registerMonitor { wakes += 1 }
    val wifi = ShadowNetwork.newInstance(1)
    monitor.callback.onAvailable(wifi)
    monitor.callback.onAvailable(wifi)
    for (validated in listOf(false, true, false, true)) {
      monitor.callback.onCapabilitiesChanged(wifi, capabilities(NetworkCapabilities.TRANSPORT_WIFI, validated))
    }
    assertEquals(1, wakes)
    monitor.callback.onAvailable(ShadowNetwork.newInstance(2))
    assertEquals(2, wakes)
  }

  @Test
  fun requestIncludesPrivateLanAndVpnButRetainsAppVisibleConstraints() {
    val request = registerMonitor {}.request
    assertTrue(request.canBeSatisfiedBy(capabilities(NetworkCapabilities.TRANSPORT_WIFI)))
    val vpn = capabilities(NetworkCapabilities.TRANSPORT_VPN)
    assertTrue(request.canBeSatisfiedBy(vpn))
    for (required in listOf(NetworkCapabilities.NET_CAPABILITY_TRUSTED, NetworkCapabilities.NET_CAPABILITY_NOT_RESTRICTED)) {
      val unavailable = capabilities(NetworkCapabilities.TRANSPORT_VPN)
      shadowOf(unavailable).removeCapability(required)
      assertFalse("Missing app-visible capability $required", request.canBeSatisfiedBy(unavailable))
    }
  }

  private fun registerMonitor(onAvailable: () -> Unit): RecordingGatewayConnectivityManager {
    val app = RuntimeEnvironment.getApplication()
    NetworkMonitor(app, onAvailable)
    return Shadow.extract(app.getSystemService(ConnectivityManager::class.java))
  }

  private fun capabilities(
    transport: Int,
    validated: Boolean = false,
  ): NetworkCapabilities =
    ShadowNetworkCapabilities.newInstance().also { capabilities ->
      val shadow = shadowOf(capabilities)
      // Include platform defaults such as NOT_VCN_MANAGED without hard-coding hidden SDK constants.
      NetworkRequest
        .Builder()
        .build()
        .capabilities
        .forEach(shadow::addCapability)
      shadow.addTransportType(transport)
      if (transport == NetworkCapabilities.TRANSPORT_VPN) shadow.removeCapability(NetworkCapabilities.NET_CAPABILITY_NOT_VPN)
      if (validated) shadow.addCapability(NetworkCapabilities.NET_CAPABILITY_VALIDATED)
    }
}

/** Robolectric records callbacks but discards requests; retain the actual production registration. */
@Implements(ConnectivityManager::class)
class RecordingGatewayConnectivityManager : ShadowConnectivityManager() {
  lateinit var request: NetworkRequest
  lateinit var callback: ConnectivityManager.NetworkCallback

  @Implementation
  override fun registerNetworkCallback(
    request: NetworkRequest,
    networkCallback: ConnectivityManager.NetworkCallback,
  ) {
    this.request = request
    callback = networkCallback
    super.registerNetworkCallback(request, networkCallback)
  }
}
