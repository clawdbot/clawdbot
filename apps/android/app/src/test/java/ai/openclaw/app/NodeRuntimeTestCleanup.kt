package ai.openclaw.app

import ai.openclaw.app.chat.AndroidClientDatabases
import android.os.Handler
import android.os.Looper
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.async
import kotlinx.coroutines.cancelAndJoin
import kotlinx.coroutines.job
import kotlinx.coroutines.runBlocking
import org.robolectric.Shadows.shadowOf
import org.robolectric.android.controller.ServiceController
import org.robolectric.shadows.ShadowPausedLooper
import org.robolectric.util.ReflectionHelpers

internal fun closeNodeRuntimeTestFixture(runtime: NodeRuntime) = drainWithMainLooper { closeRuntime(runtime) }

internal fun closeNodeServiceTestFixture(
  controller: ServiceController<NodeForegroundService>,
  app: NodeApp,
) {
  try {
    controller.destroy()
  } finally {
    drainWithMainLooper {
      // A canceled service can still be constructing the process runtime. Join its producer
      // before taking the app's final runtime snapshot, including the asynchronous STOP task.
      ReflectionHelpers
        .getField<CoroutineScope>(controller.get(), "scope")
        .coroutineContext.job
        .join()
      ReflectionHelpers
        .getField<CoroutineScope>(app, "runtimeScope")
        .coroutineContext.job
        .cancelAndJoin()
      app.peekRuntime()?.let { closeRuntime(it) }
    }
  }
}

private suspend fun closeRuntime(runtime: NodeRuntime) {
  val databases = ReflectionHelpers.getField<AndroidClientDatabases>(runtime, "clientDatabases")
  try {
    try {
      runtime.disconnect()
    } finally {
      ReflectionHelpers
        .getField<CoroutineScope>(runtime, "scope")
        .coroutineContext.job
        .cancelAndJoin()
    }
  } finally {
    try {
      // Database initialization has its own IO scope. Await its real result before closing so
      // native loading cannot escape this sandbox and initialization failures remain test failures.
      databases.clientStateDatabase()
    } finally {
      databases.close()
    }
  }
}

internal fun drainWithMainLooper(block: suspend () -> Unit) {
  val mainLooper = Looper.getMainLooper()
  val shadowLooper = shadowOf(mainLooper) as ShadowPausedLooper
  val handler = Handler(mainLooper)
  var completed = false
  val wakeMain = Runnable { completed = true }
  try {
    runBlocking {
      val cleanup = async(Dispatchers.Default) { block() }
      cleanup.invokeOnCompletion { handler.post(wakeMain) }
      // Robolectric's paused Main looper needs pumping while worker finalizers dispatch to it.
      // Completion posts a wakeup so poll cannot strand Main after the last worker finishes.
      while (!completed) {
        shadowLooper.poll(0)
        shadowLooper.idle()
      }
      cleanup.await()
    }
  } finally {
    handler.removeCallbacks(wakeMain)
  }
}
