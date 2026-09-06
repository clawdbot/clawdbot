package ai.openclaw.app.voice

import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.Deferred

// Match Browser Talk's UTF-16 identity budget; exact IDs must never be truncated.
internal const val TALK_REALTIME_MAX_ID_CHARS = 1024

internal class TalkRealtimeTranscriptOrder(
  private val maxItems: Int = 1024,
  private val maxSpeechItems: Int = 128,
  private val onReserved: (itemId: String, role: String, entryId: CompletableDeferred<String>, text: CompletableDeferred<String?>, afterPrevious: CompletableDeferred<Deferred<Unit>>, written: CompletableDeferred<Unit>) -> Unit,
) {
  private data class Item(
    val previousItemId: String?,
    val role: String?,
    val text: CompletableDeferred<String?> = CompletableDeferred(),
    val entryId: CompletableDeferred<String> = CompletableDeferred(),
    val afterPrevious: CompletableDeferred<Deferred<Unit>> = CompletableDeferred(),
    val written: CompletableDeferred<Unit> = CompletableDeferred(),
    var ordered: Boolean = false,
  )

  private val items = linkedMapOf<String, Item>()
  private var lastItemId: String? = null
  private var sequence = 0
  private var speechItems = 0
  private var lastSpeechWritten: Deferred<Unit> = CompletableDeferred(Unit)

  fun reserve(
    itemId: String,
    previousItemId: String?,
    role: String?,
    predecessorProvided: Boolean = true,
  ): Boolean {
    if (itemId.length > TALK_REALTIME_MAX_ID_CHARS || (previousItemId?.length ?: 0) > TALK_REALTIME_MAX_ID_CHARS) return false
    if (itemId in items) return true
    if (items.size >= maxItems) return false
    if (role != null && speechItems >= maxSpeechItems) return false
    if (role != null) speechItems++
    val item = Item(if (predecessorProvided) previousItemId else lastItemId, role)
    items[itemId] = item
    if (role != null) onReserved(itemId, role, item.entryId, item.text, item.afterPrevious, item.written)
    assignOrders()
    return true
  }

  fun settle(
    itemId: String,
    role: String,
    text: String?,
  ): Boolean {
    val item = items[itemId] ?: return false
    if (item.role != role || item.text.isCompleted) return false
    item.text.complete(text?.takeIf(String::isNotEmpty))
    return true
  }

  fun settle(itemId: String): Boolean {
    val item = items[itemId] ?: return false
    if (item.text.isCompleted) return false
    item.text.complete(null)
    return true
  }

  fun release(itemId: String) {
    val item = items[itemId] ?: return
    if (item.role != null && item.written.isCompleted) {
      items.remove(itemId)
      speechItems--
    }
  }

  fun close() {
    assignOrders(closing = true)
    // Completing a waiter can synchronously release its reservation on Main.immediate.
    items.values.toList().forEach { it.text.complete(null) }
  }

  private fun assignOrders(closing: Boolean = false) {
    while (true) {
      val pending = items.entries.filter { !it.value.ordered }
      val pendingIds = pending.mapTo(mutableSetOf()) { it.key }
      val next =
        pending.firstOrNull { (_, item) ->
          if (item.previousItemId == null) lastItemId == null else item.previousItemId == lastItemId
        }
          ?: if (closing) {
            // Preserve every known pending predecessor edge before falling back
            // for a genuinely absent provider ancestor.
            pending.firstOrNull { it.value.previousItemId !in pendingIds } ?: pending.firstOrNull()
          } else {
            null
          }
          ?: return
      val (itemId, item) = next
      item.ordered = true
      lastItemId = itemId
      if (item.role != null) {
        item.entryId.complete((++sequence).toString())
        item.afterPrevious.complete(lastSpeechWritten)
        lastSpeechWritten = item.written
      } else {
        // Reliable event order means the next announcement can link via lastItemId;
        // the ancestry-only node no longer needs map capacity once ordered.
        items.remove(itemId)
      }
    }
  }
}
