package ai.openclaw.app

import android.content.Intent
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34])
class MainActivityLifecycleTest {
  @Test
  fun pendingIntentRouterUsesLatestIntentBeforeActivation() {
    val router = MainActivityPendingIntentRouter()
    val initial = Intent("initial")
    val replacement = Intent("replacement")
    val routed = mutableListOf<Intent>()

    router.setInitialIntent(initial)
    router.onNewIntent(replacement, routed::add)

    assertTrue(router.activate(routed::add))
    assertEquals(listOf(replacement), routed)
    assertFalse(router.activate(routed::add))
    assertEquals(listOf(replacement), routed)
  }

  @Test
  fun pendingIntentRouterRoutesImmediatelyAfterActivation() {
    val router = MainActivityPendingIntentRouter()
    val routed = mutableListOf<Intent>()
    val next = Intent("next")

    assertTrue(router.activate(routed::add))
    router.onNewIntent(next, routed::add)
    router.setInitialIntent(Intent("ignored"))

    assertEquals(listOf(next), routed)
  }

  @Test
  fun pendingIntentRouterQueuesRapidColdStartShares() {
    val router = MainActivityPendingIntentRouter()
    val first = Intent(Intent.ACTION_SEND).setType("text/plain").putExtra(Intent.EXTRA_TEXT, "first")
    val second = Intent(Intent.ACTION_SEND).setType("text/plain").putExtra(Intent.EXTRA_TEXT, "second")
    val routed = mutableListOf<Intent>()

    router.setInitialIntent(first)
    assertTrue(router.onNewIntent(second, routed::add))

    assertTrue(router.activate(routed::add))
    assertEquals(listOf(first, second), routed)
  }

  @Test
  fun pendingIntentRouterDiscardsOnlyRecreatedInitialIntent() {
    val router = MainActivityPendingIntentRouter()
    val routed = mutableListOf<Intent>()

    router.setInitialIntent(Intent("recreated"))
    router.discardInitialIntent()

    assertTrue(router.activate(routed::add))
    assertTrue(routed.isEmpty())
  }

  @Test
  fun pendingIntentRouterKeepsNewIntentAcrossRecreationGate() {
    val router = MainActivityPendingIntentRouter()
    val routed = mutableListOf<Intent>()
    val replacement = Intent("replacement")

    router.setInitialIntent(Intent("recreated"))
    router.onNewIntent(replacement, routed::add)
    router.discardInitialIntent()

    assertTrue(router.activate(routed::add))
    assertEquals(listOf(replacement), routed)
  }

  @Test
  fun initialIntentGateDistinguishesRecreationFromProcessRestoration() {
    val retainedGate = MainActivityInitialIntentGate()

    assertTrue(retainedGate.claim())
    assertFalse(retainedGate.claim())
    assertTrue(MainActivityInitialIntentGate().claim())
  }

  @Test
  fun runtimeStaysForegroundAcrossConfigurationRecreation() {
    assertFalse(shouldNotifyRuntimeBackgrounded(isChangingConfigurations = true))
    assertTrue(shouldNotifyRuntimeBackgrounded(isChangingConfigurations = false))
  }

  @Test
  fun runtimeUiStarterWaitsForReadinessAndStartsOnce() {
    val starter = MainActivityRuntimeUiStarter()
    var attachCount = 0
    var serviceCount = 0

    starter.onRuntimeInitialized(
      ready = false,
      startRuntimeUi = true,
      attachRuntimeUi = { attachCount += 1 },
      startNodeService = { serviceCount += 1 },
    )
    starter.onRuntimeInitialized(
      ready = true,
      startRuntimeUi = true,
      attachRuntimeUi = { attachCount += 1 },
      startNodeService = { serviceCount += 1 },
    )
    starter.onRuntimeInitialized(
      ready = true,
      startRuntimeUi = true,
      attachRuntimeUi = { attachCount += 1 },
      startNodeService = { serviceCount += 1 },
    )

    assertEquals(1, attachCount)
    assertEquals(1, serviceCount)
  }

  @Test
  fun runtimeUiStarterCompletesWithoutSideEffectsForScreenshotFixture() {
    val starter = MainActivityRuntimeUiStarter()
    var attachCount = 0
    var serviceCount = 0

    starter.onRuntimeInitialized(
      ready = true,
      startRuntimeUi = false,
      attachRuntimeUi = { attachCount += 1 },
      startNodeService = { serviceCount += 1 },
    )
    starter.onRuntimeInitialized(
      ready = true,
      startRuntimeUi = true,
      attachRuntimeUi = { attachCount += 1 },
      startNodeService = { serviceCount += 1 },
    )

    assertEquals(0, attachCount)
    assertEquals(0, serviceCount)
  }
}
