package ai.openclaw.app.ui

import ai.openclaw.app.MainViewModel
import ai.openclaw.app.NodeApp
import ai.openclaw.app.NodeRuntime
import ai.openclaw.app.NodeRuntimeMode
import ai.openclaw.app.SecurePrefs
import ai.openclaw.app.bindNodeRuntimeTestFixture
import ai.openclaw.app.closeNodeRuntimeTestFixture
import ai.openclaw.app.i18n.NativeStringResources
import ai.openclaw.app.ui.design.ClawDesignTheme
import android.Manifest
import android.content.Context
import android.graphics.Bitmap
import android.provider.Settings
import androidx.compose.ui.graphics.asAndroidBitmap
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.captureToImage
import androidx.compose.ui.test.junit4.v2.createComposeRule
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.onRoot
import androidx.lifecycle.SavedStateHandle
import androidx.lifecycle.ViewModelStore
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.rules.ExternalResource
import org.junit.rules.RuleChain
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import org.robolectric.Shadows.shadowOf
import org.robolectric.annotation.Config
import org.robolectric.annotation.GraphicsMode
import java.io.File

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34], qualifiers = "en-rUS-w360dp-h800dp-mdpi")
@GraphicsMode(GraphicsMode.Mode.NATIVE)
class TalkStatusRowTest {
  private val composeRule = createComposeRule()
  private val models = ViewModelStore()
  private lateinit var app: NodeApp
  private lateinit var runtime: NodeRuntime
  private var previousRuntime: NodeRuntime? = null
  private var restoreAnimatorScale: (() -> Unit)? = null

  @get:Rule
  val fixtureRules: RuleChain =
    RuleChain
      .outerRule(
        object : ExternalResource() {
          override fun after() {
            try {
              models.clear()
            } finally {
              try {
                if (::runtime.isInitialized) closeNodeRuntimeTestFixture(runtime)
              } finally {
                try {
                  if (::app.isInitialized) bindNodeRuntimeTestFixture(app, previousRuntime)
                } finally {
                  restoreAnimatorScale?.invoke()
                }
              }
            }
          }
        },
      ).around(composeRule)

  @Test
  fun chatKeepsTheActualTalkStartupFailureVisibleAfterAutomaticShutdown() {
    app = RuntimeEnvironment.getApplication() as NodeApp
    previousRuntime = app.peekRuntime()
    // The real launcher obtains this permission before starting Talk.
    shadowOf(app).grantPermissions(Manifest.permission.RECORD_AUDIO)
    NativeStringResources.install(app)
    val resolver = app.contentResolver
    val originalScale = Settings.Global.getString(resolver, Settings.Global.ANIMATOR_DURATION_SCALE)
    restoreAnimatorScale = {
      Settings.Global.putString(resolver, Settings.Global.ANIMATOR_DURATION_SCALE, originalScale)
    }
    // Match the full-chat fixtures: unrelated perpetual animations must not own test idling.
    Settings.Global.putFloat(resolver, Settings.Global.ANIMATOR_DURATION_SCALE, 0f)
    val prefs = SecurePrefs(app, app.getSharedPreferences("talk-status-proof", Context.MODE_PRIVATE))
    runtime = NodeRuntime(app, prefs, NodeRuntimeMode.ScreenshotFixture)
    runtime.disconnect()
    bindNodeRuntimeTestFixture(app, runtime)
    val model = MainViewModel(app, prefs, SavedStateHandle())
    models.put("talk-status", model)
    composeRule.setContent {
      ClawDesignTheme(dark = false) {
        UnifiedChatShellScreen(
          viewModel = model,
          showSidebarButton = false,
          onOpenSidebar = {},
          onOpenDashboard = {},
          onOpenGatewaySettings = {},
          onOpenProvidersModels = {},
        )
      }
    }
    composeRule.runOnIdle { model.setTalkModeEnabled(true) }
    composeRule.waitUntil(10_000) {
      !runtime.talkModeEnabled.value && runtime.talkModeStatusText.value == "Gateway not connected"
    }
    val output = File("build/outputs/talk-status/startup-failure.png")
    checkNotNull(output.parentFile).mkdirs()
    output.outputStream().use {
      assertTrue(
        composeRule
          .onRoot()
          .captureToImage()
          .asAndroidBitmap()
          .compress(Bitmap.CompressFormat.PNG, 100, it),
      )
    }
    // Capture before the assertion so the same test retains the failing baseline image.
    composeRule.onNodeWithText("Gateway not connected").assertIsDisplayed()
    composeRule.runOnIdle { runtime.disconnect() }
    composeRule.onNodeWithText("Gateway not connected").assertDoesNotExist()
  }
}
