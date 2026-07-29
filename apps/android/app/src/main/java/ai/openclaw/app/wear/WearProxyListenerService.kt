package ai.openclaw.app.wear

import ai.openclaw.app.NodeApp
import ai.openclaw.wear.shared.WearProtocol
import com.google.android.gms.wearable.ChannelClient
import com.google.android.gms.wearable.MessageEvent
import com.google.android.gms.wearable.WearableListenerService
import kotlinx.coroutines.runBlocking

class WearProxyListenerService : WearableListenerService() {
  override fun onMessageReceived(messageEvent: MessageEvent) {
    if (messageEvent.path != WearProtocol.REQUEST_PATH) return
    val app = application as? NodeApp ?: return
    // Google's Data Layer contract dispatches this callback on a background handler thread
    // and explicitly recommends runBlocking there. Returning early can end the bound service
    // lifetime before the correlated response is sent.
    runBlocking { app.wearProxyBridge.handleMessage(messageEvent.sourceNodeId, messageEvent.data) }
  }

  override fun onChannelOpened(channel: ChannelClient.Channel) {
    val app = application as? NodeApp ?: return
    app.wearRealtimeChannels.accept(channel, app::ensureBackgroundRuntime)
  }
}
