package ai.openclaw.app.node

import ai.openclaw.app.SecurePrefs
import ai.openclaw.app.gateway.GatewaySession
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray

/**
 * Handles gateway-originated events that need to update local Android preferences.
 */
class GatewayEventHandler(
  private val scope: CoroutineScope,
  private val prefs: SecurePrefs,
  private val json: Json,
  private val operatorSession: GatewaySession,
  private val isConnected: () -> Boolean,
) {
  private var suppressWakeWordsSync = false
  private var wakeWordsSyncJob: Job? = null

  /** Applies gateway wake words locally without echoing the same change back to the gateway. */
  fun applyWakeWordsFromGateway(words: List<String>) {
    suppressWakeWordsSync = true
    prefs.setWakeWords(words)
    suppressWakeWordsSync = false
  }

  /** Debounces local wake-word edits before sending voicewake.set to the operator session. */
  fun scheduleWakeWordsSyncIfNeeded() {
    if (suppressWakeWordsSync) return
    if (!isConnected()) return

    val snapshot = prefs.wakeWords.value
    wakeWordsSyncJob?.cancel()
    wakeWordsSyncJob =
      scope.launch {
        delay(650)
        val jsonList = snapshot.joinToString(separator = ",") { it.toJsonString() }
        val params = """{"triggers":[$jsonList]}"""
        try {
          operatorSession.request("voicewake.set", params)
        } catch (_: Throwable) {
          // ignore
        }
      }
  }

  /** Loads gateway wake words on connect so Android settings show server truth. */
  suspend fun refreshWakeWordsFromGateway() {
    if (!isConnected()) return
    try {
      val res = operatorSession.request("voicewake.get", "{}")
      val payload = json.parseToJsonElement(res).asObjectOrNull() ?: return
      val array = payload["triggers"] as? JsonArray ?: return
      val triggers = array.mapNotNull { it.asStringOrNull() }
      applyWakeWordsFromGateway(triggers)
    } catch (_: Throwable) {
      // ignore
    }
  }

  /** Applies voicewake.changed event payloads emitted by the gateway. */
  fun handleVoiceWakeChangedEvent(payloadJson: String?) {
    if (payloadJson.isNullOrBlank()) return
    try {
      val payload = json.parseToJsonElement(payloadJson).asObjectOrNull() ?: return
      val array = payload["triggers"] as? JsonArray ?: return
      val triggers = array.mapNotNull { it.asStringOrNull() }
      applyWakeWordsFromGateway(triggers)
    } catch (_: Throwable) {
      // ignore
    }
  }
}
