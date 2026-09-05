package ai.openclaw.app.gateway

import android.net.nsd.NsdManager
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
import org.robolectric.Shadows.shadowOf
import org.robolectric.annotation.Config
import org.robolectric.annotation.Implementation
import org.robolectric.annotation.Implements
import org.robolectric.shadows.ShadowNsdManager
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
    val harness = legacyDiscovery()
    val service = legacyService("Gateway")
    harness.listener.onServiceFound(service)
    harness.resolvers(service).single().onServiceResolved(service)

    assertEquals("127.0.0.1", harness.discovery.discoveredHost())
  }

  @Test
  @Config(sdk = [33])
  fun legacyDiscoveryResolvesServicesThroughOnePlatformSlot() {
    val harness = legacyDiscovery()
    val services = listOf(legacyService("First"), legacyService("Second"), legacyService("Third"))
    services.forEach(harness.listener::onServiceFound)

    assertEquals(listOf(1, 0, 0), services.map { harness.resolvers(it).size })
    harness.resolvers(services[0]).single().onServiceResolved(services[0])
    assertEquals(listOf(1, 1, 0), services.map { harness.resolvers(it).size })
    harness.resolvers(services[1]).single().onServiceResolved(services[1])
    harness.resolvers(services[2]).single().onServiceResolved(services[2])

    assertEquals(
      services.map { it.serviceName },
      harness.discovery.gateways.value
        .map { it.name },
    )
  }

  @Test
  @Config(sdk = [33])
  fun legacyDiscoveryAdvancesAfterResolutionFailure() {
    val harness = legacyDiscovery()
    val first = legacyService("First")
    val second = legacyService("Second")
    harness.listener.onServiceFound(first)
    harness.listener.onServiceFound(second)
    assertTrue(harness.resolvers(second).isEmpty())

    harness.resolvers(first).single().onResolveFailed(first, NsdManager.FAILURE_INTERNAL_ERROR)
    harness.resolvers(second).single().onServiceResolved(second)

    assertEquals(
      listOf("Second"),
      harness.discovery.gateways.value
        .map { it.name },
    )
  }

  @Test
  @Config(sdk = [33])
  fun legacyDiscoverySkipsLostQueuedServices() {
    val harness = legacyDiscovery()
    val first = legacyService("First")
    val lost = legacyService("Lost")
    val last = legacyService("Last")
    listOf(first, lost, last).forEach(harness.listener::onServiceFound)
    harness.listener.onServiceLost(lost)
    assertTrue(harness.resolvers(lost).isEmpty())
    assertTrue(harness.resolvers(last).isEmpty())

    harness.resolvers(first).single().onServiceResolved(first)
    harness.resolvers(last).single().onServiceResolved(last)

    assertTrue(harness.resolvers(lost).isEmpty())
    assertEquals(
      listOf("First", "Last"),
      harness.discovery.gateways.value
        .map { it.name },
    )
  }

  @Test
  @Config(sdk = [33])
  fun legacyDiscoveryKeepsLostActiveSlotUntilItsTerminalCallback() {
    val harness = legacyDiscovery()
    val old = legacyService("Gateway", port = 18789)
    val replacement = legacyService("Gateway", port = 18790)
    harness.listener.onServiceFound(old)
    val oldResolver = harness.resolvers(old).single()
    harness.listener.onServiceLost(old)
    harness.listener.onServiceFound(replacement)

    assertEquals(1, harness.resolvers(replacement).size)
    oldResolver.onServiceResolved(old)
    assertTrue(
      harness.discovery.gateways.value
        .isEmpty(),
    )
    // The shadow retains completed listeners under the same name/type: these are cumulative registrations.
    assertEquals(2, harness.resolvers(replacement).size)
    harness.resolvers(replacement)[1].onServiceResolved(replacement)

    assertEquals(
      18790,
      harness.discovery.gateways.value
        .single()
        .port,
    )
  }

  @Test
  @Config(sdk = [33])
  fun legacyDiscoveryDoesNotReleasePlatformSlotWhenCoroutineScopeIsCancelled() {
    val harness = legacyDiscovery()
    val first = legacyService("First")
    val second = legacyService("Second")
    harness.listener.onServiceFound(first)
    harness.listener.onServiceFound(second)

    scope.cancel()
    assertTrue(harness.resolvers(second).isEmpty())
    harness.resolvers(first).single().onResolveFailed(first, NsdManager.FAILURE_INTERNAL_ERROR)
    harness.resolvers(second).single().onServiceResolved(second)

    assertEquals(
      listOf("Second"),
      harness.discovery.gateways.value
        .map { it.name },
    )
  }

  @Test
  @Config(sdk = [33], shadows = [RejectingNsdResolveShadow::class])
  fun legacyDiscoveryDrainsSynchronousRejectionsBeforeResumingCallbacks() {
    val harness = legacyDiscovery()
    val first = legacyService("First")
    val next = legacyService("Next")
    val tail = legacyService("Tail")
    harness.listener.onServiceFound(first)
    repeat(4096) { harness.listener.onServiceFound(legacyService("Rejected $it")) }
    harness.listener.onServiceFound(next)
    harness.listener.onServiceFound(tail)
    val firstResolver = harness.resolvers(first).single()
    assertTrue(harness.resolvers(next).isEmpty())
    assertTrue(harness.resolvers(tail).isEmpty())

    val nsd = harness.nsd as RejectingNsdResolveShadow
    nsd.failuresRemaining = 4096
    firstResolver.onServiceResolved(first)

    assertEquals(0, nsd.failuresRemaining)
    assertEquals(1, harness.resolvers(next).size)
    assertTrue(harness.resolvers(tail).isEmpty())
    harness.resolvers(next).single().onServiceResolved(next)
    harness.resolvers(tail).single().onServiceResolved(tail)
    assertEquals(
      listOf("First", "Next", "Tail"),
      harness.discovery.gateways.value
        .map { it.name },
    )
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

  private fun legacyDiscovery(): LegacyDiscoveryHarness {
    val context = RuntimeEnvironment.getApplication()
    val nsd = shadowOf(context.getSystemService(NsdManager::class.java))
    val discovery = GatewayDiscovery(context, scope)
    return LegacyDiscoveryHarness(discovery, nsd.getDiscoveryListeners("_openclaw-gw._tcp.")!!.single(), nsd)
  }

  private fun legacyService(
    name: String,
    port: Int = 18789,
  ): NsdServiceInfo =
    NsdServiceInfo().apply {
      serviceName = name
      serviceType = "_openclaw-gw._tcp."
      this.port = port
      @Suppress("DEPRECATION")
      host = InetAddress.getByName("127.0.0.1")
    }

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

/** Injects only synchronous SDK rejection; normal NSD bookkeeping stays in the pinned platform shadow. */
@Implements(NsdManager::class)
class RejectingNsdResolveShadow : ShadowNsdManager() {
  var failuresRemaining = 0

  @Implementation
  override fun resolveService(
    serviceInfo: NsdServiceInfo,
    listener: NsdManager.ResolveListener,
  ) {
    if (failuresRemaining > 0) {
      failuresRemaining--
      throw IllegalStateException("NSD service rejected resolution")
    }
    super.resolveService(serviceInfo, listener)
  }
}

private data class LegacyDiscoveryHarness(
  val discovery: GatewayDiscovery,
  val listener: NsdManager.DiscoveryListener,
  val nsd: ShadowNsdManager,
) {
  fun resolvers(service: NsdServiceInfo): List<NsdManager.ResolveListener> = nsd.getResolveListeners(service).orEmpty()
}
