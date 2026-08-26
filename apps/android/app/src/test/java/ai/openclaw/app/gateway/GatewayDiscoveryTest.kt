package ai.openclaw.app.gateway

import android.net.nsd.NsdServiceInfo
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import org.robolectric.annotation.Config
import org.xbill.DNS.Rcode
import java.net.Inet6Address
import java.net.InetAddress

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34])
class GatewayDiscoveryTest {
  private val scope = CoroutineScope(SupervisorJob())

  @After
  fun tearDown() {
    scope.cancel()
  }

  @Test
  fun discoveredGatewaySkipsScopedIpv6WhenIpv4IsAvailable() {
    val discovery = discoverGateway(scopedIpv6(), InetAddress.getByName("127.0.0.1"))

    assertEquals("127.0.0.1", discovery.discoveredHost())
  }

  @Test
  fun discoveredGatewayOmitsUndialableScopedIpv6OnlyAddress() {
    val discovery = discoverGateway(scopedIpv6())

    assertTrue(discovery.gateways.value.isEmpty())
  }

  @Test
  fun discoveredGatewayPreservesFirstUnscopedIpv6Address() {
    val ipv6 = InetAddress.getByName("2001:db8::1")
    val discovery = discoverGateway(ipv6, InetAddress.getByName("127.0.0.1"))

    assertEquals(ipv6.hostAddress, discovery.discoveredHost())
  }

  @Test
  fun discoveredGatewayPreservesIpv4BeforeScopedIpv6() {
    val discovery = discoverGateway(InetAddress.getByName("127.0.0.1"), scopedIpv6())

    assertEquals("127.0.0.1", discovery.discoveredHost())
  }

  @Test
  @Config(sdk = [33])
  fun discoveredGatewayPreservesLegacyAndroidHost() {
    val service =
      NsdServiceInfo().apply {
        serviceName = "Gateway"
        serviceType = "_openclaw-gw._tcp."
        port = 18789
        @Suppress("DEPRECATION")
        host = InetAddress.getByName("127.0.0.1")
      }

    assertEquals("127.0.0.1", discoverGateway(service).discoveredHost())
  }

  @Test
  fun statusTextFormatsLocalAndWideAreaDiscoveryStates() {
    val cases =
      listOf(
        StatusCase(
          localCount = 0,
          wideAreaRcode = null,
          wideAreaCount = 0,
          expected = "Searching for gateways…",
        ),
        StatusCase(
          localCount = 0,
          wideAreaRcode = Rcode.NOERROR,
          wideAreaCount = 2,
          expected = "Wide: 2",
        ),
        StatusCase(
          localCount = 1,
          wideAreaRcode = Rcode.NOERROR,
          wideAreaCount = 2,
          expected = "Local: 1 • Wide: 2",
        ),
        StatusCase(
          localCount = 1,
          wideAreaRcode = null,
          wideAreaCount = 0,
          expected = "Local: 1 • Wide: ?",
        ),
        StatusCase(
          localCount = 0,
          wideAreaRcode = Rcode.NXDOMAIN,
          wideAreaCount = 0,
          expected = "Wide: NXDOMAIN",
        ),
        StatusCase(
          localCount = 2,
          wideAreaRcode = Rcode.SERVFAIL,
          wideAreaCount = 0,
          expected = "Local: 2 • Wide: SERVFAIL",
        ),
      )

    for (case in cases) {
      assertEquals(
        case.expected,
        gatewayDiscoveryStatusText(
          localCount = case.localCount,
          wideAreaRcode = case.wideAreaRcode,
          wideAreaCount = case.wideAreaCount,
        ),
      )
    }
  }

  private fun discoverGateway(vararg addresses: InetAddress): GatewayDiscovery =
    discoverGateway(
      NsdServiceInfo().apply {
        serviceName = "Gateway"
        serviceType = "_openclaw-gw._tcp."
        port = 18789
        hostAddresses = addresses.toList()
      },
    )

  private fun discoverGateway(service: NsdServiceInfo): GatewayDiscovery {
    val discovery = GatewayDiscovery(RuntimeEnvironment.getApplication(), scope)
    GatewayDiscovery::class.java.getDeclaredMethod("upsertResolvedService", NsdServiceInfo::class.java).apply {
      isAccessible = true
      invoke(discovery, service)
    }
    return discovery
  }

  private fun GatewayDiscovery.discoveredHost(): String {
    val endpoints = gateways.value
    return endpoints.single().host
  }

  private fun scopedIpv6(): Inet6Address =
    Inet6Address.getByAddress(
      null,
      byteArrayOf(0xfe.toByte(), 0x80.toByte(), 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1),
      3,
    )
}

private data class StatusCase(
  val localCount: Int,
  val wideAreaRcode: Int?,
  val wideAreaCount: Int,
  val expected: String,
)
