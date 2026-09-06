package ai.openclaw.app.voice

/** Keeps one provider response from resuming before all its admitted tools finish. */
internal class TalkRealtimeToolBatch {
  private val seen = mutableSetOf<String>()
  private val pending = mutableSetOf<String>()
  val hasPending: Boolean get() = pending.isNotEmpty()

  fun admit(callIds: Collection<String>): Set<String> {
    check(callIds.all { it.length <= TALK_REALTIME_MAX_ID_CHARS }) { "Realtime tool-call identity limit exceeded" }
    val fresh = callIds.filterNot { it in seen }.toSet()
    check(seen.size + fresh.size <= 1024) { "Realtime tool-call limit exceeded" }
    seen.addAll(fresh)
    pending.addAll(fresh)
    return fresh
  }

  /** Null rejects duplicate results; true releases exactly one response after the last result. */
  fun complete(callId: String): Boolean? {
    if (!pending.remove(callId)) return null
    return pending.isEmpty()
  }
}
