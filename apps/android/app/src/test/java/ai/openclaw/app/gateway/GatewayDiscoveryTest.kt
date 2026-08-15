package ai.openclaw.app.gateway

import org.junit.Assert.assertEquals
import org.junit.Test
import org.xbill.DNS.Rcode

class GatewayDiscoveryTest {
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
}

private data class StatusCase(
  val localCount: Int,
  val wideAreaRcode: Int?,
  val wideAreaCount: Int,
  val expected: String,
)
