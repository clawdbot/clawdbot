package ai.openclaw.wear

import ai.openclaw.wear.shared.WearProxyCapability
import androidx.lifecycle.ViewModelProvider
import androidx.lifecycle.ViewModelStore
import androidx.lifecycle.ViewModelStoreOwner
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Job
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotSame
import org.junit.Assert.assertNull
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

  @Test
  fun agentPulsePollingRequiresVisibleConnectedCapablePreferredRoute() {
    val connected =
      WearUiState(
        loading = false,
        connected = true,
        phoneNodeId = "phone-a",
        proxyCapabilities = setOf(WearProxyCapability.AgentPulse),
      )

    assertTrue(shouldPollAgentPulse(connected, pulseVisible = true))
    assertFalse(shouldPollAgentPulse(connected, pulseVisible = false))
    assertFalse(shouldPollAgentPulse(connected.copy(connected = false), pulseVisible = true))
    assertFalse(shouldPollAgentPulse(connected.copy(phoneNodeId = null), pulseVisible = true))
    assertFalse(
      shouldPollAgentPulse(
        connected.copy(proxyCapabilities = emptySet()),
        pulseVisible = true,
      ),
    )
  }

  @Test
  fun agentPulseRouteRejectsPhoneAgentSessionAndGenerationChanges() {
    val session =
      WearSession(
        key = "agent:main:one",
        title = "One",
        updatedAt = null,
        hasActiveRun = false,
        phoneNodeId = "phone-a",
        agentId = "main",
      )
    val current =
      WearUiState(
        loading = false,
        connected = true,
        phoneNodeId = "phone-a",
        activeAgentId = "main",
        proxyCapabilities = setOf(WearProxyCapability.AgentPulse),
        selectedSession = session,
      )

    fun accepts(
      state: WearUiState = current,
      routeGeneration: Long = 7L,
      requestGeneration: Long = 11L,
    ): Boolean =
      wearAgentPulseRouteIsCurrent(
        requestedPhoneNodeId = "phone-a",
        requestedAgentId = "main",
        requestedSessionKey = session.key,
        requestedRouteGeneration = 7L,
        currentRouteGeneration = routeGeneration,
        requestedGeneration = 11L,
        currentGeneration = requestGeneration,
        pulseVisible = true,
        state = state,
      )

    assertTrue(accepts())
    assertFalse(accepts(current.copy(phoneNodeId = "phone-b")))
    assertFalse(accepts(current.copy(activeAgentId = "secondary")))
    assertFalse(accepts(current.copy(selectedSession = session.copy(key = "agent:main:two"))))
    assertFalse(accepts(routeGeneration = 8L))
    assertFalse(accepts(requestGeneration = 12L))
  }

  @Test
  fun hidingAgentPulseCancelsTheSinglePoller() {
    val app = RuntimeEnvironment.getApplication() as WearApplication
    val factory = ViewModelProvider.AndroidViewModelFactory.getInstance(app)
    val owner = TestViewModelStoreOwner()
    val viewModel = ViewModelProvider(owner, factory)[WearViewModel::class.java]
    val pollJob = Job()
    try {
      viewModel.setAgentPulseVisibleForTest(true)
      viewModel.setAgentPulsePollJobForTest(pollJob)

      viewModel.setAgentPulseVisible(false)

      assertFalse(pollJob.isActive)
      assertNull(viewModel.agentPulsePollJobForTest())
      assertFalse(viewModel.state.value.agentPulseLoading)
    } finally {
      owner.viewModelStore.clear()
    }
  }

  @Test
  fun clearingViewModelCancelsTheAgentPulsePoller() {
    val app = RuntimeEnvironment.getApplication() as WearApplication
    val factory = ViewModelProvider.AndroidViewModelFactory.getInstance(app)
    val owner = TestViewModelStoreOwner()
    val viewModel = ViewModelProvider(owner, factory)[WearViewModel::class.java]
    val pollJob = Job()
    viewModel.setAgentPulsePollJobForTest(pollJob)

    owner.viewModelStore.clear()

    assertFalse(pollJob.isActive)
    assertNull(viewModel.agentPulsePollJobForTest())
  }

  private class TestViewModelStoreOwner : ViewModelStoreOwner {
    override val viewModelStore = ViewModelStore()
  }

  private fun WearViewModel.realtimeTalkClientForTest(): WearRealtimeTalkClient =
    javaClass.getDeclaredField("realtimeTalkClient").run {
      isAccessible = true
      get(this@realtimeTalkClientForTest) as WearRealtimeTalkClient
    }

  private fun WearViewModel.setAgentPulseVisibleForTest(visible: Boolean) {
    javaClass.getDeclaredField("agentPulseVisible").run {
      isAccessible = true
      setBoolean(this@setAgentPulseVisibleForTest, visible)
    }
  }

  private fun WearViewModel.setAgentPulsePollJobForTest(job: Job?) {
    javaClass.getDeclaredField("agentPulsePollJob").run {
      isAccessible = true
      set(this@setAgentPulsePollJobForTest, job)
    }
  }

  private fun WearViewModel.agentPulsePollJobForTest(): Job? =
    javaClass.getDeclaredField("agentPulsePollJob").run {
      isAccessible = true
      get(this@agentPulsePollJobForTest) as? Job
    }

  private fun WearRealtimeTalkClient.scopeForTest(): CoroutineScope =
    javaClass.getDeclaredField("scope").run {
      isAccessible = true
      get(this@scopeForTest) as CoroutineScope
    }
}
