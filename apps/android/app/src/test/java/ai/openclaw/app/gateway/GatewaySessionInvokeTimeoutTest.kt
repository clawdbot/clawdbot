package ai.openclaw.app.gateway

import org.junit.Assert.assertEquals
import org.junit.Test

class GatewaySessionInvokeTimeoutTest {
  @Test
  fun formatGatewayAuthority_bracketsIpv6Hosts() {
    assertEquals("[::1]:18789", formatGatewayAuthority("::1", 18_789))
  }

  @Test
  fun buildGatewayWebSocketUrl_bracketsIpv6Hosts() {
    assertEquals("ws://[::1]:18789", buildGatewayWebSocketUrl("::1", 18_789, useTls = false))
    assertEquals("wss://[::1]:443", buildGatewayWebSocketUrl("::1", 443, useTls = true))
  }

  @Test
  fun buildGatewayWebSocketUrl_normalizesPersistedBracketedIpv6Hosts() {
    assertEquals("ws://[::1]:18789", buildGatewayWebSocketUrl("[::1]", 18_789, useTls = false))
    assertEquals("wss://[::1]:443", buildGatewayWebSocketUrl("[::1]", 443, useTls = true))
  }

  @Test
  fun resolveInvokeResultAckTimeoutMs_usesFloorWhenMissingOrTooSmall() {
    assertEquals(15_000L, resolveInvokeResultAckTimeoutMs(null))
    assertEquals(15_000L, resolveInvokeResultAckTimeoutMs(0L))
    assertEquals(15_000L, resolveInvokeResultAckTimeoutMs(5_000L))
  }

  @Test
  fun resolveInvokeResultAckTimeoutMs_usesInvokeBudgetWithinBounds() {
    assertEquals(30_000L, resolveInvokeResultAckTimeoutMs(30_000L))
    assertEquals(90_000L, resolveInvokeResultAckTimeoutMs(90_000L))
  }

  @Test
  fun resolveInvokeResultAckTimeoutMs_capsAtUpperBound() {
    assertEquals(120_000L, resolveInvokeResultAckTimeoutMs(121_000L))
    assertEquals(120_000L, resolveInvokeResultAckTimeoutMs(Long.MAX_VALUE))
  }
}
