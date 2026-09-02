package ai.openclaw.app.ui

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34])
class SessionDashboardScreenTest {
  @Test
  fun dashboardUrlUsesDirectControlUiSessionRoute() {
    val url =
      sessionDashboardUrl(
        baseUrl = "https://gateway.example.com:8443/",
        sessionKey = "agent:ops:telegram:12345",
      )

    assertEquals(
      "https://gateway.example.com:8443/dashboard/ops/telegram/12345",
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
  fun dashboardUrlKeepsConfiguredControlUiBasePathAndDropsOldQuery() {
    val url =
      sessionDashboardUrl(
        baseUrl = "https://gateway.example.com:8443/openclaw?stale=true#old",
        sessionKey = "agent:main:qa",
      )

    assertEquals(
      "https://gateway.example.com:8443/openclaw/dashboard/main/qa",
      url,
    )
  }

  @Test
  fun dashboardUrlCollapsesMainKeysToAgentDashboard() {
    assertEquals(
      "https://gateway.example.com/dashboard/research",
      sessionDashboardUrl(
        baseUrl = "https://gateway.example.com",
        sessionKey = "agent:research:workspace",
        mainSessionKey = "agent:research:workspace",
      ),
    )
    assertEquals(
      "https://gateway.example.com/dashboard/research",
      sessionDashboardUrl(
        baseUrl = "https://gateway.example.com",
        sessionKey = "main",
        fallbackAgentId = "research",
      ),
    )
  }

  @Test
  fun dashboardUrlEscapesDotTildeAndShortLiteralSegments() {
    assertEquals(
      "https://gateway.example.com/dashboard/main/cron/~dot/~dotdot/~~dot",
      sessionDashboardUrl(
        baseUrl = "https://gateway.example.com",
        sessionKey = "agent:main:cron:.:..:~dot",
      ),
    )
    assertEquals(
      "https://gateway.example.com/dashboard/main/~key/release-deadbeef",
      sessionDashboardUrl(
        baseUrl = "https://gateway.example.com",
        sessionKey = "agent:main:release-deadbeef",
      ),
    )
    assertEquals(
      "https://gateway.example.com/dashboard/main/channel/release%2Ejs",
      sessionDashboardUrl(
        baseUrl = "https://gateway.example.com",
        sessionKey = "agent:main:channel:release.js",
      ),
    )
  }

  @Test
  fun dashboardUrlPreservesExactSessionIdentity() {
    val uuid = "12345678-90ab-cdef-1234-567890abcdef"
    listOf(
      "agent:main:dashboard:$uuid" to "dashboard/$uuid",
      "agent:main:$uuid" to "~key/$uuid",
      "agent:main:sessions" to "~key/sessions",
      "agent:main:main" to "~key/main",
    ).forEach { (sessionKey, rest) ->
      assertEquals(
        sessionKey,
        "https://gateway.example.com/dashboard/main/$rest",
        sessionDashboardUrl(
          baseUrl = "https://gateway.example.com",
          sessionKey = sessionKey,
          mainSessionKey = "workspace",
        ),
      )
    }
  }

  @Test
  fun dashboardUrlRejectsIncompleteSessionIdentity() {
    listOf(
      "" to "main",
      "agent:main" to "main",
      "agent::control-link" to "main",
      "agent:main:" to "main",
      "agent:main:telegram::12345" to "main",
      "telegram::12345" to "main",
      "telegram:12345" to null,
    ).forEach { (sessionKey, fallbackAgentId) ->
      assertNull(
        "sessionKey=$sessionKey, fallbackAgentId=$fallbackAgentId",
        sessionDashboardUrl(
          baseUrl = "https://gateway.example.com",
          sessionKey = sessionKey,
          fallbackAgentId = fallbackAgentId,
        ),
      )
    }
  }
}
