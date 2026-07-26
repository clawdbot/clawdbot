package ai.openclaw.wear

import android.app.Application
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import java.util.concurrent.atomic.AtomicInteger

internal class VisibleActivityTracker {
  private val count = AtomicInteger()

  fun onStarted() {
    count.incrementAndGet()
  }

  fun onStopped() {
    count.updateAndGet { current -> (current - 1).coerceAtLeast(0) }
  }

  fun isVisible(): Boolean = count.get() > 0
}

class WearApplication : Application() {
  internal val processScope = CoroutineScope(SupervisorJob() + Dispatchers.Default)

  internal val proxyClient: WearProxyClient by lazy {
    WearProxyClient.create(context = this)
  }

  internal val gatewayRepository: WearGatewayRepository by lazy {
    WearGatewayRepository(proxyClient)
  }

  internal val realtimeTalkClient: WearRealtimeTalkClient by lazy {
    WearRealtimeTalkClient(this, gatewayRepository)
  }

  private val visibleActivities = VisibleActivityTracker()

  internal fun onActivityStarted() = visibleActivities.onStarted()

  internal fun onActivityStopped() = visibleActivities.onStopped()

  internal fun isActivityVisible(): Boolean = visibleActivities.isVisible()
}
