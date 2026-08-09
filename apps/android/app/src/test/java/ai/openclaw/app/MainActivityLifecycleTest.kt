package ai.openclaw.app

import android.content.ContentProvider
import android.content.ContentValues
import android.content.Context
import android.content.Intent
import android.database.Cursor
import android.net.Uri
import android.os.Looper
import androidx.lifecycle.SavedStateHandle
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.Robolectric
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import org.robolectric.Shadows.shadowOf
import org.robolectric.annotation.Config
import org.robolectric.shadows.ShadowContentResolver
import java.util.UUID
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit

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
  fun pendingIntentRouterRetainsShareOverflowUntilViewModelActivation() {
    val router = MainActivityPendingIntentRouter()
    val routed = mutableListOf<Intent>()
    repeat(MAX_PENDING_CHAT_SHARES) { index ->
      val share = Intent(Intent.ACTION_SEND).setType("text/plain").putExtra(Intent.EXTRA_TEXT, "share-$index")
      if (index == 0) {
        router.setInitialIntent(share)
      } else {
        assertTrue(router.onNewIntent(share, routed::add))
      }
    }

    assertFalse(
      router.onNewIntent(
        Intent(Intent.ACTION_SEND).setType("text/plain").putExtra(Intent.EXTRA_TEXT, "overflow"),
        routed::add,
      ),
    )

    assertTrue(router.activate(routed::add))
    assertEquals(MAX_PENDING_CHAT_SHARES, routed.size)
    assertEquals(1, router.takeShareOverflowCount())
    assertEquals(0, router.takeShareOverflowCount())
  }

  @Test
  fun initialIntentGateDistinguishesRecreationFromProcessRestoration() {
    val retainedGate = MainActivityInitialIntentGate()

    assertTrue(retainedGate.claim())
    assertFalse(retainedGate.claim())
    assertTrue(MainActivityInitialIntentGate().claim())
  }

  @Test
  fun blockedShareMimeResolutionSurvivesActivityRecreation() {
    val app = RuntimeEnvironment.getApplication() as NodeApp
    app.chatShareDraftQueue.clear()
    val resolverEntered = CountDownLatch(1)
    val releaseResolver = CountDownLatch(1)
    ShadowContentResolver.registerProviderInternal(
      "blocked-share",
      BlockingMimeProvider(resolverEntered, releaseResolver),
    )
    val sharedUri = Uri.parse("content://blocked-share/document")
    val shareIntent =
      Intent(Intent.ACTION_SEND)
        .setType("*/*")
        .putExtra(Intent.EXTRA_STREAM, sharedUri)
    val controller =
      Robolectric
        .buildActivity(MainActivity::class.java)
        .create()
        .start()
        .resume()
    val activity = controller.get()
    val prefs =
      SecurePrefs(
        app,
        securePrefsOverride =
          app.getSharedPreferences(
            "share-recreation-test-${UUID.randomUUID()}",
            Context.MODE_PRIVATE,
          ),
      )
    val viewModel = MainViewModel(app, prefs, SavedStateHandle())
    val expectedOwner = viewModel.captureChatShareOwner()
    assertTrue(viewModel.claimInitialIntentRouting())
    val handleLaunchIntent =
      MainActivity::class.java
        .getDeclaredMethod("handleLaunchIntent", MainViewModel::class.java, Intent::class.java)
        .apply { isAccessible = true }

    handleLaunchIntent.invoke(activity, viewModel, shareIntent)
    assertTrue(resolverEntered.await(5, TimeUnit.SECONDS))

    controller.pause().stop().destroy()
    assertFalse(viewModel.claimInitialIntentRouting())
    releaseResolver.countDown()

    assertTrue(waitUntil { app.chatShareDraftQueue.size() == 1 })
    val draft = requireNotNull(app.chatShareDraftQueue.head.value)
    assertEquals(listOf(sharedUri), draft.attachments.map(SharedAttachment::uri))
    assertEquals(expectedOwner, app.chatShareDraftQueue.ownerOf(draft.id))
  }

  @Test
  fun runtimeStaysForegroundAcrossConfigurationRecreation() {
    assertFalse(shouldNotifyRuntimeBackgrounded(isChangingConfigurations = true))
    assertTrue(shouldNotifyRuntimeBackgrounded(isChangingConfigurations = false))
  }

  @Test
  fun topResumedPermissionHostRefreshesAuthorityAfterActivation() {
    val events = mutableListOf<String>()

    updateTopResumedPermissionHost(
      isTopResumedActivity = true,
      activate = { events += "activate" },
      deactivate = { events += "deactivate" },
      refreshPermissionSurface = { events += "refresh" },
    )
    updateTopResumedPermissionHost(
      isTopResumedActivity = false,
      activate = { events += "activate" },
      deactivate = { events += "deactivate" },
      refreshPermissionSurface = { events += "refresh" },
    )

    assertEquals(listOf("activate", "refresh", "deactivate"), events)
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

  @Test
  fun recreatedRuntimeUiStarterCannotRestartSuppressedServiceUntilExplicitResume() {
    val app = RuntimeEnvironment.getApplication()
    val appShadow = shadowOf(app)
    NodeForegroundService.resume(app, startNow = false)

    try {
      NodeForegroundService.stop(app)
      assertEquals("ai.openclaw.app.action.STOP", appShadow.nextStartedService.action)

      repeat(2) {
        MainActivityRuntimeUiStarter().onRuntimeInitialized(
          ready = true,
          startRuntimeUi = true,
          attachRuntimeUi = {},
          startNodeService = { NodeForegroundService.start(app) },
        )
      }

      assertNull(appShadow.nextStartedService)

      NodeForegroundService.resume(app, startNow = true)
      assertEquals("ai.openclaw.app.action.RESUME", appShadow.nextStartedService.action)
    } finally {
      NodeForegroundService.resume(app, startNow = false)
    }
  }

  private fun waitUntil(
    timeoutMillis: Long = 2_000,
    predicate: () -> Boolean,
  ): Boolean {
    val deadline = System.nanoTime() + TimeUnit.MILLISECONDS.toNanos(timeoutMillis)
    while (System.nanoTime() < deadline) {
      shadowOf(Looper.getMainLooper()).idle()
      if (predicate()) return true
      Thread.sleep(10)
    }
    shadowOf(Looper.getMainLooper()).idle()
    return predicate()
  }

  private class BlockingMimeProvider(
    private val entered: CountDownLatch,
    private val release: CountDownLatch,
  ) : ContentProvider() {
    override fun onCreate(): Boolean = true

    override fun getType(uri: Uri): String {
      entered.countDown()
      check(release.await(5, TimeUnit.SECONDS))
      return "application/pdf"
    }

    override fun query(
      uri: Uri,
      projection: Array<out String>?,
      selection: String?,
      selectionArgs: Array<out String>?,
      sortOrder: String?,
    ): Cursor? = null

    override fun insert(
      uri: Uri,
      values: ContentValues?,
    ): Uri? = null

    override fun delete(
      uri: Uri,
      selection: String?,
      selectionArgs: Array<out String>?,
    ): Int = 0

    override fun update(
      uri: Uri,
      values: ContentValues?,
      selection: String?,
      selectionArgs: Array<out String>?,
    ): Int = 0
  }
}
