package bot.molt.android

import android.app.Application
import android.os.StrictMode
import java.security.Security
import org.bouncycastle.jce.provider.BouncyCastleProvider

class NodeApp : Application() {
  val runtime: NodeRuntime by lazy { NodeRuntime(this) }

  override fun onCreate() {
    super.onCreate()

    // Ensure a working provider for Ed25519/EdDSA. Some Android builds ship broken or missing support.
    try {
      Security.removeProvider("BC")
      Security.insertProviderAt(BouncyCastleProvider(), 1)
    } catch (_: Throwable) {
      // best-effort
    }

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
