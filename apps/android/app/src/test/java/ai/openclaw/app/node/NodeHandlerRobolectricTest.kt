package ai.openclaw.app.node

import android.content.Context
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment

@RunWith(RobolectricTestRunner::class)
abstract class NodeHandlerRobolectricTest {
  protected fun appContext(): Context = RuntimeEnvironment.getApplication()
}
