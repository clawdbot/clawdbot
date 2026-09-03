package ai.openclaw.app.gateway

import android.net.ConnectivityManager
import org.junit.Assert.assertEquals
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import org.robolectric.Shadows.shadowOf
import org.robolectric.annotation.Config
import org.robolectric.shadows.ShadowNetwork

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34])
class NetworkMonitorTest {
  @Test
  fun emitsOnceOnOfflineToOnline() {
    val state = ValidatedNetworkState<String>()

    assertEquals(true, state.update("wifi", isValidated = true))
    assertEquals(false, state.update("wifi", isValidated = true))
  }

  @Test
  fun emitsAgainAfterAllValidatedNetworksAreLost() {
    val state = ValidatedNetworkState<String>()

    assertEquals(true, state.update("wifi", isValidated = true))
    assertEquals(false, state.update("wifi", isValidated = false))
    assertEquals(true, state.update("wifi", isValidated = true))
  }

  @Test
  fun aSecondNetworkValidatingWhileAnotherIsAlreadyOnlineStillWakes() {
    // A saved Gateway can be reachable over one specific route only (a returning Wi-Fi/LAN
    // network), not merely "the internet is up somewhere" — so cellular staying validated the
    // whole time must not swallow Wi-Fi's own restore. Regression for the P1 finding on #127873.
    val state = ValidatedNetworkState<String>()

    assertEquals(true, state.update("cellular", isValidated = true))
    assertEquals(true, state.update("wifi", isValidated = true))
  }

  @Test
  fun losingOneOfMultipleValidatedNetworksDoesNotWake() {
    val state = ValidatedNetworkState<String>()

    assertEquals(true, state.update("wifi", isValidated = true))
    assertEquals(true, state.update("cellular", isValidated = true))
    assertEquals(false, state.update("wifi", isValidated = false))
    // Capability churn on the still-validated network must not re-fire either.
    assertEquals(false, state.update("cellular", isValidated = true))
    // The last validated network being lost is an offline transition, not a restore.
    assertEquals(false, state.update("cellular", isValidated = false))
    assertEquals(true, state.update("wifi", isValidated = true))
  }

  @Test
  fun initialValidatedNetworkSuppressesRegistrationSnapshot() {
    val state = ValidatedNetworkState(setOf("wifi"))

    assertEquals(false, state.update("wifi", isValidated = true))
  }

  @Test
  fun bootstrapGraceCoversTheRegistrationReplayWindow() {
    // registerNetworkCallback() replays every already-validated network's state right after
    // registration, and there is no non-deprecated synchronous way to seed all of them up front
    // (only the single active network). Without this grace window, a second already-validated
    // network's replay would misread as a fresh restore at every cold start. Regression for the
    // P2 finding on #127873.
    val registeredAt = 1_000_000_000L

    assertEquals(true, isWithinNetworkMonitorBootstrapGrace(registeredAt, registeredAt))
    assertEquals(
      true,
      isWithinNetworkMonitorBootstrapGrace(registeredAt, registeredAt + NETWORK_MONITOR_BOOTSTRAP_GRACE_NANOS - 1),
    )
  }

  @Test
  fun bootstrapGraceExpiresSoALaterRestoreStillWakes() {
    val registeredAt = 1_000_000_000L

    assertEquals(
      false,
      isWithinNetworkMonitorBootstrapGrace(registeredAt, registeredAt + NETWORK_MONITOR_BOOTSTRAP_GRACE_NANOS),
    )
    assertEquals(
      false,
      isWithinNetworkMonitorBootstrapGrace(registeredAt, registeredAt + NETWORK_MONITOR_BOOTSTRAP_GRACE_NANOS * 100),
    )
  }

  @Test
  fun notifyDebounceCoalescesASimultaneousMultiNetworkRestore() {
    // Wi-Fi and cellular reactivating together (e.g. leaving doze) each produce their own
    // ValidatedNetworkState edge; without coalescing, the second one's fan-out would close the
    // reconnect attempt the first one just started. Regression for the P2 finding on #127873.
    val firstNotifyAt = 1_000_000_000L

    assertEquals(false, isWithinNetworkMonitorNotifyDebounce(lastNotifiedAtNanos = null, nowNanos = firstNotifyAt))
    assertEquals(
      true,
      isWithinNetworkMonitorNotifyDebounce(
        lastNotifiedAtNanos = firstNotifyAt,
        nowNanos = firstNotifyAt + NETWORK_MONITOR_NOTIFY_DEBOUNCE_NANOS - 1,
      ),
    )
  }

  @Test
  fun notifyDebounceExpiresSoALaterRestoreStillWakes() {
    val firstNotifyAt = 1_000_000_000L

    assertEquals(
      false,
      isWithinNetworkMonitorNotifyDebounce(
        lastNotifiedAtNanos = firstNotifyAt,
        nowNanos = firstNotifyAt + NETWORK_MONITOR_NOTIFY_DEBOUNCE_NANOS,
      ),
    )
  }

  @Test
  fun aPlainNetworkAttachWakesEvenWithoutValidation() {
    // A saved Gateway on a private LAN or a split-tunnel VPN route can be reachable without the
    // network ever reporting NET_CAPABILITY_VALIDATED (that capability only confirms general
    // internet reachability), so the wake must not depend on validation. Regression for the P1
    // finding on #127873.
    val context = RuntimeEnvironment.getApplication()
    var wakeCount = 0
    NetworkMonitor(context) { wakeCount += 1 }
    // Outlast NETWORK_MONITOR_BOOTSTRAP_GRACE_NANOS so this attach reads as a genuine restore,
    // not registerNetworkCallback()'s own registration replay.
    Thread.sleep(600)

    val connectivity = context.getSystemService(ConnectivityManager::class.java)
    val callback = shadowOf(connectivity).networkCallbacks.single()
    callback.onAvailable(ShadowNetwork.newInstance(101))

    assertEquals(1, wakeCount)
  }

  @Test
  fun networkAttachDuringBootstrapGraceDoesNotWake() {
    val context = RuntimeEnvironment.getApplication()
    var wakeCount = 0
    NetworkMonitor(context) { wakeCount += 1 }

    val connectivity = context.getSystemService(ConnectivityManager::class.java)
    val callback = shadowOf(connectivity).networkCallbacks.single()
    callback.onAvailable(ShadowNetwork.newInstance(101))

    assertEquals(0, wakeCount)
  }
}
