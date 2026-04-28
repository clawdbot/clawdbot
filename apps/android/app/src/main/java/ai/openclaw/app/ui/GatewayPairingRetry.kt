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

internal const val PAIRING_AUTO_RETRY_MS = 6_000L

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
    while (true) {
      delay(PAIRING_AUTO_RETRY_MS)
      onRetry()
    }
  }
}
