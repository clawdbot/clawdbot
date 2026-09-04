package ai.openclaw.app.gateway

import android.content.Context
import android.net.ConnectivityManager
import android.net.Network
import android.net.NetworkCapabilities
import android.net.NetworkRequest
import android.util.Log

/**
 * Listens for Android transport restores and signals [onNetworkAvailable] when the device
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
  private val onNetworkAvailable: () -> Unit,
) {
  private val connectivity = context.getSystemService(ConnectivityManager::class.java)
  private val logTag = "OpenClaw/NetworkMonitor"

  private val restoreState = NetworkRestoreState<Network>()

  private val callback =
    object : ConnectivityManager.NetworkCallback() {
      override fun onAvailable(network: Network) {
        // Fires once per network attach, before validation resolves, so it also covers a
        // restored private LAN/VPN route that never reaches NET_CAPABILITY_VALIDATED.
        // Registration can replay an existing route, but session guards make that wake harmless;
        // dropping it here would also drop an indistinguishable genuine restore.
        val newlyAvailable = restoreState.onAvailable(network)
        if (newlyAvailable) {
          notifyNetworkAvailable()
        }
      }

      override fun onCapabilitiesChanged(
        network: Network,
        capabilities: NetworkCapabilities,
      ) {
        val justValidated =
          restoreState.onCapabilitiesChanged(
            network,
            isTransportValidated(capabilities),
          )
        if (justValidated) {
          notifyNetworkAvailable()
        }
      }

      override fun onLost(network: Network) {
        restoreState.onLost(network)
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
      cm.registerNetworkCallback(appUsableNetworkRequest(), callback)
    } catch (err: Throwable) {
      Log.w(logTag, "registerNetworkCallback failed: ${err.message ?: err::class.java.simpleName}")
    }
  }

  private fun notifyNetworkAvailable() {
    try {
      onNetworkAvailable()
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
        restoreState.seedValidated(active)
      }
    } catch (_: Throwable) {
      // Callback delivery remains the source of truth when the initial snapshot races.
    }
  }
}

// Android requests exclude VPNs by default. Both discovery and reconnect monitoring need every
// app-visible route or a private Gateway can return without either owner observing its VPN.
internal fun appUsableNetworkRequest(): NetworkRequest =
  NetworkRequest
    .Builder()
    .removeCapability(NetworkCapabilities.NET_CAPABILITY_NOT_VPN)
    .build()

// onAvailable and its first capability callback describe one availability episode. Coalesce only
// that pair per network; a different route must always be able to wake the reconnect fleet.
internal class NetworkRestoreState<T>(
  initialValidatedNetworks: Set<T> = emptySet(),
) {
  private val availableNetworks = initialValidatedNetworks.toMutableSet()
  private val validatedNetworks = initialValidatedNetworks.toMutableSet()
  private val awaitingInitialCapabilities = mutableSetOf<T>()

  @Synchronized
  fun onAvailable(network: T): Boolean {
    if (!availableNetworks.add(network)) return false
    awaitingInitialCapabilities.add(network)
    return true
  }

  @Synchronized
  fun onCapabilitiesChanged(
    network: T,
    isValidated: Boolean,
  ): Boolean {
    availableNetworks.add(network)
    val followsAvailability = awaitingInitialCapabilities.remove(network)
    val wasValidated = validatedNetworks.contains(network)
    if (isValidated) {
      validatedNetworks.add(network)
    } else {
      validatedNetworks.remove(network)
    }
    return isValidated && !wasValidated && !followsAvailability
  }

  @Synchronized
  fun onLost(network: T) {
    availableNetworks.remove(network)
    validatedNetworks.remove(network)
    awaitingInitialCapabilities.remove(network)
  }

  @Synchronized
  fun seedValidated(network: T) {
    availableNetworks.add(network)
    validatedNetworks.add(network)
  }
}

/**
 * True when the network reports a validated internet capability. Exposed internal so the
 * predicate can be unit-tested without a Robolectric ConnectivityManager shadow.
 */
internal fun isTransportValidated(capabilities: NetworkCapabilities): Boolean = capabilities.hasCapability(NetworkCapabilities.NET_CAPABILITY_VALIDATED)
