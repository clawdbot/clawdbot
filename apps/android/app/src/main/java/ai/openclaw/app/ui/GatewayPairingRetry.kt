package ai.openclaw.app.ui

import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.LifecycleEventObserver
import androidx.lifecycle.compose.LocalLifecycleOwner
import kotlinx.coroutines.delay

internal const val PAIRING_INITIAL_AUTO_RETRY_MS = 1_500L
internal const val PAIRING_AUTO_RETRY_MS = 4_000L

/** Retries pairing-only gateway refreshes while the screen is visible and started. */
@Composable
internal fun PairingAutoRetryEffect(
  enabled: Boolean,
  onRetry: () -> Unit,
) {
  val lifecycleOwner = LocalLifecycleOwner.current
  var lifecycleStarted by
    remember(lifecycleOwner) {
      mutableStateOf(lifecycleOwner.lifecycle.currentState.isAtLeast(Lifecycle.State.STARTED))
    }

  DisposableEffect(lifecycleOwner) {
    val observer =
      LifecycleEventObserver { _, _ ->
        lifecycleStarted = lifecycleOwner.lifecycle.currentState.isAtLeast(Lifecycle.State.STARTED)
      }
    lifecycleOwner.lifecycle.addObserver(observer)
    onDispose {
      lifecycleOwner.lifecycle.removeObserver(observer)
    }
  }

  LaunchedEffect(enabled, lifecycleStarted) {
    if (!enabled || !lifecycleStarted) {
      return@LaunchedEffect
    }
    // Give the gateway a short settling window before the first retry so an
    // approval response is not immediately chased by a redundant reconnect.
    delay(PAIRING_INITIAL_AUTO_RETRY_MS)
    while (true) {
      onRetry()
      delay(PAIRING_AUTO_RETRY_MS)
    }
  }
}
