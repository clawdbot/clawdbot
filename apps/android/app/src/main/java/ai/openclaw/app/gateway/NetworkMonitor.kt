package ai.openclaw.app.gateway

import android.content.Context
import android.net.ConnectivityManager
import android.net.Network
import android.net.NetworkCapabilities
import android.net.NetworkRequest
import android.util.Log

/**
 * Listens for Android transport restores and signals [onValidatedNetworkAvailable] when the device
 * regains a validated internet connection, or when any network newly attaches at all. Used to
 * trigger an immediate gateway reconnect instead of waiting out the time-based backoff slot in
 * [GatewaySession].
 *
 * Validation (`NET_CAPABILITY_VALIDATED`) only confirms general internet reachability; a saved
 * Gateway on a private LAN or a split-tunnel VPN route can be reachable without ever validating,
 * so this monitor also wakes on the plain network-attach event. A wake that turns out to be wrong
 * (the attached network cannot actually reach the Gateway) just costs one failed connect attempt.
 *
 * This monitor only reports "transport came back". Each gateway session still owns
 * desired-connection and auth-pause decisions. The application context keeps this
 * process-lifetime callback aligned with the process-lifetime NodeRuntime.
 */
internal class NetworkMonitor(
  context: Context,
  private val onValidatedNetworkAvailable: () -> Unit,
) {
  private val connectivity = context.getSystemService(ConnectivityManager::class.java)
  private val logTag = "OpenClaw/NetworkMonitor"

  // Tracks the last emitted transport state so capability churn (e.g. signal strength
  // changes) does not re-fire the reconnect path. Only a lost->validated transition
  // should signal.
  private val validatedNetworks = ValidatedNetworkState<Network>()

  // registerNetworkCallback() replays every already-matching network's current state right after
  // registration, and that replay is indistinguishable from a later genuine change: there is no
  // non-deprecated synchronous "list every current network" call to seed all of them up front
  // (only the single active one, below), so any other network that was already validated before
  // this monitor existed looks like a fresh restore the moment its replay arrives. The replay
  // delivers cached state ConnectivityService already holds, not a fresh validation check, so it
  // resolves within milliseconds of registration; the window only needs to be short enough to
  // cover that, not long enough to risk absorbing a genuine restore that happens to land in the
  // same instant. A missed genuine restore in this narrow window is not unbounded: the affected
  // session still falls back to its own independent backoff retry, the same bound this PR already
  // asks for acceptance of elsewhere in this body.
  private val registeredAtNanos = System.nanoTime()

  // The fan-out a notification triggers reaches every session regardless of which network
  // changed, so when several transports validate close together (e.g. Wi-Fi and cellular both
  // reactivating from doze at once) each one's own edge would otherwise fire its own full
  // fan-out — repeatedly closing a session's just-started reconnect attempt before its handshake
  // can finish. This debounces to one notification per burst; nothing about which network caused
  // it is lost, because the fan-out is not per-network to begin with.
  @Volatile private var lastNotifiedAtNanos: Long? = null

  private val callback =
    object : ConnectivityManager.NetworkCallback() {
      override fun onAvailable(network: Network) {
        // Fires once per network attach, before validation resolves, so it also covers a
        // restored private LAN/VPN route that never reaches NET_CAPABILITY_VALIDATED. Same
        // registration-replay hazard as onCapabilitiesChanged below: registerNetworkCallback()
        // replays onAvailable for every network already connected at registration time, so the
        // same bootstrap grace absorbs it.
        if (!isWithinNetworkMonitorBootstrapGrace(registeredAtNanos, System.nanoTime())) {
          notifyValidatedNetworkAvailableDebounced()
        }
      }

      override fun onCapabilitiesChanged(
        network: Network,
        capabilities: NetworkCapabilities,
      ) {
        val justValidated = validatedNetworks.update(network, isTransportValidated(capabilities))
        if (justValidated && !isWithinNetworkMonitorBootstrapGrace(registeredAtNanos, System.nanoTime())) {
          notifyValidatedNetworkAvailableDebounced()
        }
      }

      override fun onLost(network: Network) {
        validatedNetworks.update(network, isValidated = false)
      }
    }

  init {
    // Register first so a network lost during initial seeding still has an owning callback.
    // The seed suppresses the initial snapshot when it wins; session guards handle the other race.
    start()
    seedActiveValidatedNetwork()
  }

  private fun start() {
    val cm = connectivity ?: return
    try {
      // Equivalent to the default request used by GatewayDiscovery: match any network.
      cm.registerNetworkCallback(NetworkRequest.Builder().build(), callback)
    } catch (err: Throwable) {
      Log.w(logTag, "registerNetworkCallback failed: ${err.message ?: err::class.java.simpleName}")
    }
  }

  private fun notifyValidatedNetworkAvailableDebounced() {
    val now = System.nanoTime()
    synchronized(this) {
      if (isWithinNetworkMonitorNotifyDebounce(lastNotifiedAtNanos, now)) return
      lastNotifiedAtNanos = now
    }
    notifyValidatedNetworkAvailable()
  }

  private fun notifyValidatedNetworkAvailable() {
    try {
      onValidatedNetworkAvailable()
    } catch (err: Throwable) {
      Log.w(logTag, "network restore callback threw: ${err.message ?: err::class.java.simpleName}")
    }
  }

  private fun seedActiveValidatedNetwork() {
    try {
      val cm = connectivity ?: return
      val active = cm.activeNetwork ?: return
      val caps = cm.getNetworkCapabilities(active) ?: return
      if (isTransportValidated(caps)) {
        validatedNetworks.update(active, isValidated = true)
      }
    } catch (_: Throwable) {
      // Callback delivery remains the source of truth when the initial snapshot races.
    }
  }
}

internal class ValidatedNetworkState<T>(
  initialValidatedNetworks: Set<T> = emptySet(),
) {
  private val validatedNetworks = initialValidatedNetworks.toMutableSet()

  /**
   * Records [network]'s current validated state and reports whether it just became reachable.
   *
   * Signals on this network's own offline->online edge, not on the aggregate "is anything
   * online" state: a saved Gateway can be reachable over one specific route only, so cellular
   * staying validated the whole time must not swallow a returning Wi-Fi/LAN network's own
   * restore. A network already known validated still reports no change, which is what keeps
   * capability churn (e.g. signal-strength updates) from re-firing.
   */
  @Synchronized
  fun update(
    network: T,
    isValidated: Boolean,
  ): Boolean {
    val wasValidated = validatedNetworks.contains(network)
    if (isValidated) {
      validatedNetworks.add(network)
    } else {
      validatedNetworks.remove(network)
    }
    return isValidated && !wasValidated
  }
}

/**
 * True when the network reports a validated internet capability. Exposed internal so the
 * predicate can be unit-tested without a Robolectric ConnectivityManager shadow.
 */
internal fun isTransportValidated(capabilities: NetworkCapabilities): Boolean = capabilities.hasCapability(NetworkCapabilities.NET_CAPABILITY_VALIDATED)

/**
 * How long after registration a just-validated network is treated as registration replay, not a
 * restore. Short by design: the replay carries cached state, not a fresh validation check, so it
 * resolves in milliseconds; this only needs to outlast that, not cover any real elapsed time.
 */
internal const val NETWORK_MONITOR_BOOTSTRAP_GRACE_NANOS = 500_000_000L

/**
 * Whether a just-validated network observed at [nowNanos] is still inside the registration replay
 * window that started at [registeredAtNanos]. Exposed internal so the boundary can be unit-tested
 * without a Robolectric ConnectivityManager shadow.
 */
internal fun isWithinNetworkMonitorBootstrapGrace(
  registeredAtNanos: Long,
  nowNanos: Long,
): Boolean = nowNanos - registeredAtNanos < NETWORK_MONITOR_BOOTSTRAP_GRACE_NANOS

/**
 * How long one notification suppresses another. Long enough to coalesce several transports
 * validating together (radios reactivating from doze tend to land within the same instant, not
 * seconds apart); short enough that a later, genuinely separate restore is not meaningfully
 * delayed.
 */
internal const val NETWORK_MONITOR_NOTIFY_DEBOUNCE_NANOS = 2_000_000_000L

/**
 * Whether a notification at [nowNanos] falls inside the debounce window after [lastNotifiedAtNanos]
 * (`null` meaning no notification has happened yet). Exposed internal so the boundary can be
 * unit-tested without a Robolectric ConnectivityManager shadow.
 */
internal fun isWithinNetworkMonitorNotifyDebounce(
  lastNotifiedAtNanos: Long?,
  nowNanos: Long,
): Boolean = lastNotifiedAtNanos != null && nowNanos - lastNotifiedAtNanos < NETWORK_MONITOR_NOTIFY_DEBOUNCE_NANOS
