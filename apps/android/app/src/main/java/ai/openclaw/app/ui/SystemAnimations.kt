package ai.openclaw.app.ui

import android.content.ContentResolver
import android.database.ContentObserver
import android.os.Handler
import android.os.Looper
import android.provider.Settings
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableFloatStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.platform.LocalContext

/**
 * Reactive read of the OS "remove animations" accessibility setting.
 *
 * Custom frame loops must stop explicitly at zero. Compose's process-shared MotionDurationScale can
 * retain its last value across a gap with no recomposer, so read the authoritative setting here and
 * register before rereading to close the mount-time notification race.
 */
@Composable
internal fun rememberSystemAnimationsEnabled(): Boolean {
  val context = LocalContext.current
  val resolver = context.contentResolver
  var scale by remember(resolver) { mutableFloatStateOf(readAnimatorDurationScale(resolver)) }
  DisposableEffect(resolver) {
    val observer =
      object : ContentObserver(Handler(Looper.getMainLooper())) {
        override fun onChange(selfChange: Boolean) {
          scale = readAnimatorDurationScale(resolver)
        }
      }
    resolver.registerContentObserver(Settings.Global.getUriFor(Settings.Global.ANIMATOR_DURATION_SCALE), false, observer)
    scale = readAnimatorDurationScale(resolver)
    onDispose { resolver.unregisterContentObserver(observer) }
  }
  return scale > 0f
}

private fun readAnimatorDurationScale(resolver: ContentResolver): Float = Settings.Global.getFloat(resolver, Settings.Global.ANIMATOR_DURATION_SCALE, 1f)
