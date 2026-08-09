package ai.openclaw.wear

import androidx.lifecycle.ViewModelProvider
import androidx.lifecycle.ViewModelStore
import androidx.lifecycle.ViewModelStoreOwner
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Job
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotSame
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(application = WearApplication::class, sdk = [35])
class WearViewModelLifecycleTest {
  @Test
  fun recreatedViewModelGetsALiveTalkClientAfterThePreviousOneClears() {
    val app = RuntimeEnvironment.getApplication() as WearApplication
    val factory = ViewModelProvider.AndroidViewModelFactory.getInstance(app)
    val firstOwner = TestViewModelStoreOwner()
    val firstViewModel = ViewModelProvider(firstOwner, factory)[WearViewModel::class.java]
    val firstClient = firstViewModel.realtimeTalkClientForTest()

    firstOwner.viewModelStore.clear()

    val reopenedOwner = TestViewModelStoreOwner()
    val reopenedViewModel = ViewModelProvider(reopenedOwner, factory)[WearViewModel::class.java]
    val reopenedClient = reopenedViewModel.realtimeTalkClientForTest()
    try {
      assertFalse(firstClient.scopeForTest().coroutineContext[Job]?.isActive == true)
      assertNotSame(firstClient, reopenedClient)
      assertTrue(reopenedClient.scopeForTest().coroutineContext[Job]?.isActive == true)
    } finally {
      reopenedOwner.viewModelStore.clear()
    }
  }

  private class TestViewModelStoreOwner : ViewModelStoreOwner {
    override val viewModelStore = ViewModelStore()
  }

  private fun WearViewModel.realtimeTalkClientForTest(): WearRealtimeTalkClient =
    javaClass.getDeclaredField("realtimeTalkClient").run {
      isAccessible = true
      get(this@realtimeTalkClientForTest) as WearRealtimeTalkClient
    }

  private fun WearRealtimeTalkClient.scopeForTest(): CoroutineScope =
    javaClass.getDeclaredField("scope").run {
      isAccessible = true
      get(this@scopeForTest) as CoroutineScope
    }
}
