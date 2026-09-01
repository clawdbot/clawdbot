package ai.openclaw.app.gateway

import android.content.Context
import android.net.ConnectivityManager
import android.net.Network
import android.net.NetworkCapabilities
import android.net.NetworkRequest
import android.util.Log

/**
 * Listens for Android transport restores and signals [onValidatedNetworkAvailable] when the device
 * regains a validated internet connection. Used to trigger an immediate gateway
 * reconnect instead of waiting out the time-based backoff slot in [GatewaySession].
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

  private val callback =
    object : ConnectivityManager.NetworkCallback() {
      override fun onCapabilitiesChanged(
        network: Network,
        capabilities: NetworkCapabilities,
      ) {
        if (validatedNetworks.update(network, isTransportValidated(capabilities))) {
          notifyValidatedNetworkAvailable()
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

  @Synchronized
  fun update(
    network: T,
    isValidated: Boolean,
  ): Boolean {
    val wasOnline = validatedNetworks.isNotEmpty()
    if (isValidated) {
      validatedNetworks.add(network)
    } else {
      validatedNetworks.remove(network)
    }
    return !wasOnline && validatedNetworks.isNotEmpty()
  }
}

/**
 * True when the network reports a validated internet capability. Exposed internal so the
 * predicate can be unit-tested without a Robolectric ConnectivityManager shadow.
 */
internal fun isTransportValidated(capabilities: NetworkCapabilities): Boolean = capabilities.hasCapability(NetworkCapabilities.NET_CAPABILITY_VALIDATED)
