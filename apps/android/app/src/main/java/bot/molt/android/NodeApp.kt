package bot.molt.android

import android.app.Application
import android.os.StrictMode

class NodeApp : Application() {
  val runtime: NodeRuntime by lazy { NodeRuntime(this) }

  override fun onCreate() {
    super.onCreate()
    if (BuildConfig.DEBUG) {
      StrictMode.setThreadPolicy(
        StrictMode.ThreadPolicy.Builder()
          .detectAll()
          .penaltyLog()
          .build(),
      )
      StrictMode.setVmPolicy(
        StrictMode.VmPolicy.Builder()
          .detectAll()
          .penaltyLog()
          .build(),
      )
    }
  }
}
