package ai.openclaw.app.node

import ai.openclaw.app.gateway.GatewaySession
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow

class MobileUiHandler {
  private val connected = MutableStateFlow(false)

  val isConnected: StateFlow<Boolean> = connected.asStateFlow()

  suspend fun handleObserve(
    @Suppress("UNUSED_PARAMETER") paramsJson: String?,
  ): GatewaySession.InvokeResult = unavailable()

  suspend fun handleAct(
    @Suppress("UNUSED_PARAMETER") paramsJson: String?,
  ): GatewaySession.InvokeResult = unavailable()

  private fun unavailable(): GatewaySession.InvokeResult =
    GatewaySession.InvokeResult.error(
      code = "MOBILE_UI_UNAVAILABLE",
      message = "MOBILE_UI_UNAVAILABLE: accessibility control is not available on this build",
    )
}
