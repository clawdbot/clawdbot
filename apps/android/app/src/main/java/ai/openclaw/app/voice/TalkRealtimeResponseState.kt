package ai.openclaw.app.voice

/** Owns the unacknowledged response-create window as well as the active response. */
internal class TalkRealtimeResponseState {
  var responseId: String? = null
    private set
  var createInFlight = false
    private set
  var responsePending = false
    private set
  private var createEventId: String? = null
  private var cancelOnCreation = false
  private var cancelledId: String? = null

  fun requesting(eventId: String? = null) {
    createInFlight = true
    createEventId = eventId
  }

  /** Coalesce tool continuations and consume the deferred request only when it can start. */
  fun requestResponse(
    hasPendingTools: Boolean,
    eventId: String,
  ): Boolean {
    responsePending = true
    if (responseId != null || createInFlight || hasPendingTools) return false
    responsePending = false
    requesting(eventId)
    return true
  }

  /** Returns the exact newly created response when an earlier Cancel must be applied. */
  fun created(id: String): String? {
    responseId = id
    createInFlight = false
    createEventId = null
    val cancel = cancelOnCreation
    cancelOnCreation = false
    return if (cancel) claimCancellation(id) else null
  }

  fun creationRejected(eventId: String?): Boolean {
    if (!createInFlight || eventId == null || createEventId != eventId) return false
    createInFlight = false
    createEventId = null
    cancelOnCreation = false
    return true
  }

  fun cancel(): String? {
    responsePending = false
    if (createInFlight) cancelOnCreation = true
    return responseId?.let(::claimCancellation)
  }

  private fun claimCancellation(id: String): String? {
    if (cancelledId == id) return null
    cancelledId = id
    return id
  }

  fun completed(id: String) {
    if (responseId == id) responseId = null
  }
}
