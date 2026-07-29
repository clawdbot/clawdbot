package ai.openclaw.app.ui

import org.junit.Assert.assertEquals
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34])
class SessionDashboardScreenTest {
  @Test
  fun dashboardUrlAppendsChatRouteAndEncodesSessionKey() {
    val url =
      sessionDashboardUrl(
        baseUrl = "https://gateway.example.com:8443/",
        sessionKey = "agent:main/phone & qa?x=1",
      )

    assertEquals(
      "https://gateway.example.com:8443/chat?session=agent%3Amain%2Fphone%20%26%20qa%3Fx%3D1&face=dashboard",
      url,
    )
  }

  @Test
  fun originRuleDropsBasePathAndKeepsPort() {
    assertEquals(
      "https://gateway.example.com:8443",
      controlUiOriginRule("https://gateway.example.com:8443/openclaw"),
    )
    assertEquals("http://[::1]:18789", controlUiOriginRule("http://[::1]:18789"))
  }

  @Test
  fun dashboardUrlKeepsConfiguredControlUiBasePath() {
    val url =
      sessionDashboardUrl(
        baseUrl = "https://gateway.example.com:8443/openclaw",
        sessionKey = "agent:main:qa",
      )

    assertEquals(
      "https://gateway.example.com:8443/openclaw/chat?session=agent%3Amain%3Aqa&face=dashboard",
      url,
    )
  }
}
