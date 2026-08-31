package ai.openclaw.app.ui

import ai.openclaw.app.MainViewModel
import ai.openclaw.app.NodeApp
import ai.openclaw.app.NodeRuntime
import ai.openclaw.app.NodeRuntimeMode
import ai.openclaw.app.SecurePrefs
import ai.openclaw.app.node.DeviceNotificationListenerService
import ai.openclaw.app.ui.design.ClawDesignTheme
import android.Manifest
import android.app.Activity
import android.app.NotificationManager
import android.content.ComponentName
import android.content.Context
import android.provider.Settings
import androidx.activity.compose.LocalActivity
import androidx.compose.ui.test.junit4.v2.createComposeRule
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.lifecycle.SavedStateHandle
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import org.robolectric.Shadows.shadowOf
import org.robolectric.annotation.Config
import org.robolectric.shadow.api.Shadow
import org.robolectric.shadows.ShadowNotificationManager
import java.util.UUID

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34])
class NotificationSettingsScreenTest {
  @get:Rule
  val composeRule = createComposeRule()

  private lateinit var app: NodeApp
  private lateinit var prefs: SecurePrefs
  private lateinit var runtime: NodeRuntime
  private lateinit var activity: Activity
  private var originalRuntime: NodeRuntime? = null

  @Before
  fun setUp() {
    app = RuntimeEnvironment.getApplication() as NodeApp
    clearPlainPreferences()
    prefs =
      SecurePrefs(
        app,
        app.getSharedPreferences("notification-settings-${UUID.randomUUID()}", Context.MODE_PRIVATE),
      )
    runtime = NodeRuntime(app, prefs, NodeRuntimeMode.ScreenshotFixture)
    originalRuntime = app.peekRuntime()
    setApplicationRuntime(runtime)
    shadowOf(app).grantPermissions(Manifest.permission.POST_NOTIFICATIONS)
    setListenerAccess(granted = false)
  }

  @After
  fun tearDown() {
    setApplicationRuntime(originalRuntime)
    runtime.disconnect()
    clearPlainPreferences()
  }

  @Test
  fun enablingWithoutListenerAccessKeepsForwardingDisabledAndOpensSystemAccess() {
    showNotificationSettings()

    clickForwarding()

    assertListenerSetupRequired()
  }

  @Test
  fun listenerAccessIsRequestedBeforeNotificationPostingPermission() {
    shadowOf(app).denyPermissions(Manifest.permission.POST_NOTIFICATIONS)
    showNotificationSettings()

    clickForwarding()

    assertListenerSetupRequired()
  }

  @Test
  @Config(sdk = [31])
  fun olderAndroidAlsoRequiresListenerAccessBeforeEnablingForwarding() {
    showNotificationSettings()

    clickForwarding()

    assertListenerSetupRequired()
  }

  @Test
  fun listenerRevokedAfterScreenMountCannotEnableForwarding() {
    setListenerAccess(granted = true)
    showNotificationSettings()
    setListenerAccess(granted = false)

    clickForwarding()

    assertListenerSetupRequired()
  }

  @Test
  fun grantedListenerAccessAllowsForwardingWithoutOpeningSystemAccess() {
    setListenerAccess(granted = true)
    showNotificationSettings()

    clickForwarding()

    assertTrue(prefs.notificationForwardingEnabled.value)
    assertNull(shadowOf(activity).nextStartedActivity)
  }

  @Test
  fun disablingForwardingDoesNotRequireListenerAccess() {
    prefs.setNotificationForwardingEnabled(true)
    showNotificationSettings()

    clickForwarding()

    assertFalse(prefs.notificationForwardingEnabled.value)
    assertNull(shadowOf(activity).nextStartedActivity)
  }

  private fun showNotificationSettings() {
    val viewModel = MainViewModel(app, prefs, SavedStateHandle())
    composeRule.setContent {
      activity = requireNotNull(LocalActivity.current)
      ClawDesignTheme {
        SettingsDetailScreen(
          viewModel = viewModel,
          route = SettingsRoute.Notifications,
          onBack = {},
        )
      }
    }
  }

  private fun clickForwarding() {
    composeRule.onNodeWithText("Forward Notifications").performClick()
    composeRule.waitForIdle()
  }

  private fun assertListenerSetupRequired() {
    assertFalse(prefs.notificationForwardingEnabled.value)
    assertEquals(
      Settings.ACTION_NOTIFICATION_LISTENER_SETTINGS,
      shadowOf(activity).nextStartedActivity?.action,
    )
  }

  private fun setListenerAccess(granted: Boolean) {
    val manager = app.getSystemService(NotificationManager::class.java)
    Shadow.extract<ShadowNotificationManager>(manager).setNotificationListenerAccessGranted(
      ComponentName(app, DeviceNotificationListenerService::class.java),
      granted,
    )
  }

  private fun setApplicationRuntime(value: NodeRuntime?) {
    NodeApp::class.java
      .getDeclaredField("runtimeInstance")
      .apply { isAccessible = true }
      .set(app, value)
  }

  private fun clearPlainPreferences() {
    app
      .getSharedPreferences("openclaw.node", Context.MODE_PRIVATE)
      .edit()
      .clear()
      .commit()
  }
}
