package ai.openclaw.app.gateway

import android.content.Context
import android.net.ConnectivityManager
import android.net.LinkProperties
import android.net.Network
import android.net.NetworkCapabilities
import android.net.NetworkRequest
import android.os.Parcel
import android.util.Log

/**
 * Listens for Android transport restores and signals [onNetworkAvailable] when the device
 * regains validation, any network attaches, or an existing network changes link properties. Used to
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

      override fun onLinkPropertiesChanged(
        network: Network,
        linkProperties: LinkProperties,
      ) {
        if (restoreState.onLinkPropertiesChanged(network, linkProperties)) {
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

// Initial capability/link snapshots describe one availability episode. Later link changes
// can restore private routes or DNS without another availability or validation transition.
internal class NetworkRestoreState<T>(
  initialValidatedNetworks: Set<T> = emptySet(),
) {
  private class State(
    var validated: Boolean = false,
    var awaitingInitialCapabilities: Boolean = false,
    var linkProperties: LinkProperties? = null,
  )

  private val networks = initialValidatedNetworks.associateWith { State(validated = true) }.toMutableMap()

  @Synchronized
  fun onAvailable(network: T): Boolean {
    if (networks.containsKey(network)) return false
    networks[network] = State(awaitingInitialCapabilities = true)
    return true
  }

  @Synchronized
  fun onCapabilitiesChanged(
    network: T,
    isValidated: Boolean,
  ): Boolean {
    val state = networks.getOrPut(network) { State() }
    val restored = isValidated && !state.validated && !state.awaitingInitialCapabilities
    state.validated = isValidated
    state.awaitingInitialCapabilities = false
    return restored
  }

  @Synchronized
  fun onLinkPropertiesChanged(
    network: T,
    properties: LinkProperties,
  ): Boolean {
    val state = networks[network] ?: return false
    // LinkProperties is mutable and has no public copy constructor in the SDK. Keep an owned
    // Parcelable snapshot so later callback mutations cannot erase a route/DNS change.
    val parcel = Parcel.obtain()
    val snapshot =
      try {
        properties.writeToParcel(parcel, 0)
        parcel.setDataPosition(0)
        LinkProperties.CREATOR.createFromParcel(parcel)
      } finally {
        parcel.recycle()
      }
    val previous = state.linkProperties
    state.linkProperties = snapshot
    return previous != null && previous != snapshot
  }

  @Synchronized
  fun onLost(network: T) {
    networks.remove(network)
  }

  @Synchronized
  fun seedValidated(network: T) {
    networks.getOrPut(network) { State() }.validated = true
  }
}

/**
 * True when the network reports a validated internet capability. Exposed internal so the
 * predicate can be unit-tested without a Robolectric ConnectivityManager shadow.
 */
internal fun isTransportValidated(capabilities: NetworkCapabilities): Boolean = capabilities.hasCapability(NetworkCapabilities.NET_CAPABILITY_VALIDATED)
