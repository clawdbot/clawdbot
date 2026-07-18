package ai.openclaw.wear

import ai.openclaw.wear.shared.WearEventType
import ai.openclaw.wear.shared.WearProtocol
import com.google.android.gms.wearable.CapabilityInfo
import com.google.android.gms.wearable.MessageEvent
import com.google.android.gms.wearable.WearableListenerService
import kotlinx.coroutines.runBlocking

class WearProxyListenerService : WearableListenerService() {
  override fun onCapabilityChanged(capabilityInfo: CapabilityInfo) {
    if (capabilityInfo.name != WearProtocol.PHONE_CAPABILITY) return
    val preferredNodeId =
      capabilityInfo.nodes
        .sortedWith(compareByDescending<com.google.android.gms.wearable.Node> { it.isNearby }.thenBy { it.id })
        .firstOrNull()
        ?.id
    (application as? WearApplication)?.proxyClient?.updatePreferredPhoneNodeId(preferredNodeId)
  }

  override fun onMessageReceived(messageEvent: MessageEvent) {
    if (messageEvent.path != WearProtocol.RESPONSE_PATH && messageEvent.path != WearProtocol.EVENT_PATH) return
    val app = application as? WearApplication ?: return
    // WearableListenerService callbacks use its background looper. Finish the
    // bounded Data Layer work before returning so Android retains the service.
    runBlocking {
      val event =
        app.proxyClient.handleMessage(
          sourceNodeId = messageEvent.sourceNodeId,
          path = messageEvent.path,
          data = messageEvent.data,
        ) ?: return@runBlocking
      if (event.event == WearEventType.Chat && !app.isActivityVisible()) {
        WearReplyNotifier(applicationContext).show(event)
      }
    }
  }
}
