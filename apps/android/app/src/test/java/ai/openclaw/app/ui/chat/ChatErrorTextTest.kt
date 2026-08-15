package ai.openclaw.app.ui.chat

import org.junit.Assert.assertEquals
import org.junit.Test

class ChatErrorTextTest {
  @Test
  fun notConnectedErrorPointsToFixActionsOnlyWhenGatewayIsOffline() {
    assertEquals(
      "Gateway is offline. Fix the connection below or copy diagnostics.",
      userFacingChatError(error = "not connected", gatewayConnected = false),
    )
  }

  @Test
  fun notConnectedErrorDoesNotClaimGatewayOfflineDuringConnectedHealthBootstrap() {
    assertEquals(
      "Chat is still checking Gateway health.",
      userFacingChatError(error = "not connected", gatewayConnected = true),
    )
  }
}
