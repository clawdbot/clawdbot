package ai.openclaw.app

import ai.openclaw.app.gateway.GatewayRegistryEntry
import ai.openclaw.app.gateway.GatewayRegistryEntryKind
import android.content.Context
import android.content.Intent
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import org.robolectric.Shadows.shadowOf
import org.robolectric.annotation.Config
import java.util.UUID

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34])
class MainViewModelTest {
  @After
  fun resetNodeServiceStartSuppression() {
    val app = RuntimeEnvironment.getApplication()
    NodeForegroundService.resume(app, startNow = false)
    val appShadow = shadowOf(app)
    while (appShadow.nextStartedService != null) {
      // Drain queued service intents so each test owns its lifecycle assertions.
    }
  }

  @Test
  fun foregroundStartupRequiresForegroundAndCompletedOnboarding() {
    assertFalse(
      shouldStartRuntimeOnForeground(
        foreground = false,
        onboardingCompleted = true,
      ),
    )
    assertFalse(
      shouldStartRuntimeOnForeground(
        foreground = true,
        onboardingCompleted = false,
      ),
    )
    assertFalse(
      shouldStartRuntimeOnForeground(
        foreground = false,
        onboardingCompleted = false,
      ),
    )
    assertTrue(
      shouldStartRuntimeOnForeground(
        foreground = true,
        onboardingCompleted = true,
      ),
    )
  }

  @Test
  fun cronEditorDraftMemoryIsBoundedAndClearsOnlyItsOwningJob() {
    val memory = CronEditorDraftMemory()
    val first = draft("First")
    val second = draft("Second")

    memory.set("job-a", first)
    assertEquals(first, memory.get("job-a"))
    assertNull(memory.get("job-b"))

    memory.set("job-b", second)
    assertNull(memory.get("job-a"))
    memory.clear("job-a")
    assertEquals(second, memory.get("job-b"))

    memory.set("job-b", null)
    assertNull(memory.get("job-b"))
  }

  @Test
  fun disconnectStopsStickyNodeServiceWithoutClearingSavedGateways() {
    val (viewModel, prefs) = createViewModel()
    val gateway =
      GatewayRegistryEntry(
        stableId = "manual|gateway.test|18789",
        kind = GatewayRegistryEntryKind.MANUAL,
        name = "gateway.test",
        host = "gateway.test",
        port = 18789,
      )
    prefs.gatewayRegistry.upsert(gateway)
    prefs.setOnboardingCompleted(true)

    viewModel.disconnect()

    assertNodeServiceStopRequested()
    assertEquals(listOf(gateway), prefs.gatewayRegistry.entries.value)

    viewModel.resumeNodeServiceForConnection()

    assertNodeServiceResumeRequested()
  }

  @Test
  fun pairNewGatewayStopsStickyNodeServiceWithoutClearingSavedGateways() {
    val (viewModel, prefs) = createViewModel()
    val gateway =
      GatewayRegistryEntry(
        stableId = "manual|gateway.test|18789",
        kind = GatewayRegistryEntryKind.MANUAL,
        name = "gateway.test",
        host = "gateway.test",
        port = 18789,
      )
    prefs.gatewayRegistry.upsert(gateway)

    viewModel.pairNewGateway()

    assertNodeServiceStopRequested()
    assertEquals(listOf(gateway), prefs.gatewayRegistry.entries.value)
  }

  private fun assertNodeServiceStopRequested() {
    val app = RuntimeEnvironment.getApplication()
    val intent: Intent? = shadowOf(app).nextStartedService
    assertNotNull(intent)
    assertEquals(NodeForegroundService::class.java.name, intent?.component?.className)
    assertEquals("ai.openclaw.app.action.STOP", intent?.action)
  }

  private fun assertNodeServiceResumeRequested() {
    val app = RuntimeEnvironment.getApplication()
    val intent: Intent? = shadowOf(app).nextStartedService
    assertNotNull(intent)
    assertEquals(NodeForegroundService::class.java.name, intent?.component?.className)
    assertEquals("ai.openclaw.app.action.RESUME", intent?.action)
  }

  private fun createViewModel(): Pair<MainViewModel, SecurePrefs> {
    val app = RuntimeEnvironment.getApplication() as NodeApp
    val prefs =
      SecurePrefs(
        app,
        securePrefsOverride =
          app.getSharedPreferences(
            "main-view-model-test-${UUID.randomUUID()}",
            Context.MODE_PRIVATE,
          ),
      )
    return MainViewModel(app, prefs) to prefs
  }

  private fun draft(name: String): CronEditorDraftState {
    val edit =
      GatewayCronJobEdit(
        name = name,
        description = "",
        enabled = true,
        deleteAfterRun = false,
        schedule = GatewayCronScheduleEdit.At("2026-07-10T09:00:00Z"),
        sessionTarget = "isolated",
        wakeMode = "now",
        payload = GatewayCronPayloadEdit.SystemEvent("Wake up"),
      )
    return CronEditorDraftState(
      baseline = edit,
      edit = edit.copy(name = "$name draft"),
    )
  }
}
