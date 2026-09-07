package ai.openclaw.app.gateway

/** One connection intent's authority to retire its saved bootstrap after durable role writes. */
class GatewayBootstrapHandoff(
  val allowStoredTokenRecovery: Boolean = false,
  private val retireCredential: () -> Boolean,
) {
  private val lock = Any()
  private var active = true

  @Volatile var completed = false
    private set

  fun complete(): Boolean =
    synchronized(lock) {
      if (!active) return@synchronized false
      if (!completed) completed = retireCredential()
      completed
    }

  // Intent admission invalidates this owner before waiting for sockets or other cleanup.
  // This lock never calls back into runtime/session locks, preserving their lock order.
  fun invalidate() {
    synchronized(lock) { active = false }
  }
}
