package ai.openclaw.app.ui

import android.provider.Settings
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableFloatStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.runtime.snapshotFlow
import androidx.compose.ui.MotionDurationScale
import androidx.compose.ui.platform.LocalContext
import kotlinx.coroutines.flow.collect
import kotlin.coroutines.coroutineContext

/**
 * Reactive read of Compose's canonical Android motion-duration scale.
 *
 * Custom frame loops do not consume the duration scale automatically, so they must stop explicitly
 * at zero. Compose owns the process-shared Android settings observer; reusing it avoids one observer
 * per animated composable and keeps the phone and Wear implementations on the same contract.
 */
@Composable
internal fun rememberSystemAnimationsEnabled(
  motionDurationScale: MotionDurationScale? = null,
): Boolean {
  val resolver = LocalContext.current.contentResolver
  var scale by remember(resolver, motionDurationScale) {
    val initialScale =
      motionDurationScale?.scaleFactor
        ?: Settings.Global.getFloat(resolver, Settings.Global.ANIMATOR_DURATION_SCALE, 1f)
    mutableFloatStateOf(initialScale.coerceAtLeast(0f))
  }
  LaunchedEffect(motionDurationScale) {
    val composeScale = motionDurationScale ?: coroutineContext[MotionDurationScale]
    if (composeScale == null) {
      scale = 1f
      return@LaunchedEffect
    }
    // This getter lazily starts Compose's shared Android settings observer.
    scale = composeScale.scaleFactor.coerceAtLeast(0f)
    snapshotFlow { composeScale.scaleFactor.coerceAtLeast(0f) }
      .collect { updatedScale -> scale = updatedScale }
  }
  return scale > 0f
}
