package ai.openclaw.app.ui.chat

import ai.openclaw.app.chat.ChatComposerOwner
import ai.openclaw.app.ui.FoldAwareSheetState
import ai.openclaw.app.ui.WindowDisplayFeatureSnapshot
import android.app.Activity
import android.os.Handler
import android.os.Looper
import android.view.View
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.lifecycle.Lifecycle

internal class ChatModelPickerSession(
  val composerOwner: ChatComposerOwner,
  val sessionKey: String,
  val geometry: FoldAwareSheetState,
)

/** Main-thread admission is separate from deferred Compose removal. */
internal class ChatModelPickerSessionOwner(
  private val activity: Activity?,
  private val activityView: View,
  private val lifecycle: Lifecycle,
  private val targetIsCurrent: (ChatComposerOwner) -> Boolean,
) {
  var visible by mutableStateOf<ChatModelPickerSession?>(null)
    private set
  private var active: ChatModelPickerSession? = null
  private var features = WindowDisplayFeatureSnapshot()
  private val handler = Handler(Looper.getMainLooper())

  fun publishFeatures(next: WindowDisplayFeatureSnapshot) {
    features = next
    active?.geometry?.publishFeatures(next)
  }

  fun open(
    composerOwner: ChatComposerOwner,
    sessionKey: String,
  ) {
    if (active != null || !targetIsCurrent(composerOwner)) return
    var captured: ChatModelPickerSession? = null
    val geometry =
      FoldAwareSheetState(activity, activityView, lifecycle) {
        captured?.let(::retire)
      }
    // Preflight must not treat a missing first publication as a flat window.
    geometry.publishFeatures(features)
    if (!geometry.canOpen()) return
    val session = ChatModelPickerSession(composerOwner, sessionKey, geometry)
    captured = session
    active = session
    visible = session
  }

  fun retire(session: ChatModelPickerSession) {
    session.geometry.revoke()
    if (active === session) active = null
    handler.post {
      if (visible === session) visible = null
    }
  }

  fun refreshTarget() {
    active?.let { if (!targetIsCurrent(it.composerOwner)) retire(it) }
  }

  fun dispose() {
    active?.let(::retire)
  }

  fun admit(session: ChatModelPickerSession): Boolean {
    if (active !== session || session.geometry.revoked) return false
    // A declined late dismiss may already have hidden its native sheet. Never leave it active.
    if (!targetIsCurrent(session.composerOwner) || !session.geometry.refresh()) {
      retire(session)
      return false
    }
    return true
  }
}
