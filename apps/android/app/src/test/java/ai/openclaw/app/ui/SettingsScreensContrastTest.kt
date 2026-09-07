package ai.openclaw.app.ui

import ai.openclaw.app.GatewayTalkSetupReadiness
import ai.openclaw.app.MainViewModel
import ai.openclaw.app.NodeApp
import ai.openclaw.app.NodeRuntime
import ai.openclaw.app.NodeRuntimeMode
import ai.openclaw.app.SecurePrefs
import ai.openclaw.app.bindNodeRuntimeTestFixture
import ai.openclaw.app.closeNodeRuntimeTestFixture
import ai.openclaw.app.gateway.GatewayEndpoint
import ai.openclaw.app.i18n.NativeStringResources
import ai.openclaw.app.i18n.nativeString
import ai.openclaw.app.ui.design.ClawDesignTheme
import ai.openclaw.app.ui.design.assertCompleteText
import ai.openclaw.app.ui.design.contrastThemeCases
import ai.openclaw.app.ui.design.renderedLabelContrast
import android.content.ClipData
import android.content.ClipboardManager
import android.content.Context
import android.graphics.Bitmap
import androidx.compose.runtime.mutableStateOf
import androidx.compose.ui.graphics.asAndroidBitmap
import androidx.compose.ui.graphics.toArgb
import androidx.compose.ui.semantics.SemanticsActions
import androidx.compose.ui.semantics.SemanticsProperties
import androidx.compose.ui.test.DeviceConfigurationOverride
import androidx.compose.ui.test.FontScale
import androidx.compose.ui.test.assertHasClickAction
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.assertIsEnabled
import androidx.compose.ui.test.assertIsNotEnabled
import androidx.compose.ui.test.assertIsSelected
import androidx.compose.ui.test.captureToImage
import androidx.compose.ui.test.click
import androidx.compose.ui.test.junit4.v2.createComposeRule
import androidx.compose.ui.test.onAllNodesWithText
import androidx.compose.ui.test.onNodeWithContentDescription
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.onRoot
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performScrollTo
import androidx.compose.ui.test.performSemanticsAction
import androidx.compose.ui.test.performTouchInput
import androidx.compose.ui.text.TextLayoutResult
import androidx.core.os.LocaleListCompat
import androidx.lifecycle.SavedStateHandle
import androidx.lifecycle.ViewModelStore
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.CoroutineStart
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancelAndJoin
import kotlinx.coroutines.flow.collect
import kotlinx.coroutines.launch
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import okhttp3.mockwebserver.Dispatcher
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import okhttp3.mockwebserver.RecordedRequest
import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.rules.ExternalResource
import org.junit.rules.RuleChain
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import org.robolectric.annotation.Config
import org.robolectric.annotation.GraphicsMode
import java.io.File
import java.net.InetAddress
import java.util.UUID
import java.util.concurrent.CopyOnWriteArrayList
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [36], qualifiers = "en-rUS-w360dp-h800dp-mdpi")
@GraphicsMode(GraphicsMode.Mode.NATIVE)
class SettingsScreensContrastTest {
  private val composeRule = createComposeRule()
  private val models = ViewModelStore()
  private lateinit var app: NodeApp
  private lateinit var runtime: NodeRuntime
  private var previousRuntime: NodeRuntime? = null
  private lateinit var gateway: OperationalCaptionsGateway
  private val noticeReached = CountDownLatch(1)
  private val releaseNotice = CountDownLatch(1)
  private val observationScope = CoroutineScope(SupervisorJob() + Dispatchers.Unconfined)

  @Volatile private var noticeReleasedWithinBound = false

  // Dispose Compose before joining the actual runtime and socket, including on the contrast red.
  @get:Rule
  val fixtureRules: RuleChain =
    RuleChain
      .outerRule(
        object : ExternalResource() {
          override fun after() {
            try {
              releaseNotice.countDown()
              runBlocking { observationScope.coroutineContext[Job]!!.cancelAndJoin() }
              models.clear()
            } finally {
              try {
                if (::runtime.isInitialized) closeNodeRuntimeTestFixture(runtime)
              } finally {
                try {
                  if (::app.isInitialized) bindNodeRuntimeTestFixture(app, previousRuntime)
                } finally {
                  if (::gateway.isInitialized) gateway.close()
                }
              }
            }
          }
        },
      ).around(composeRule)

  @Test
  @Config(qualifiers = "fr-rFR-w320dp-h800dp-mdpi")
  fun gatewayInstanceIdCopiesTheWholeValueAtLargeFont() {
    val application = RuntimeEnvironment.getApplication()
    val clipboard = requireNotNull(application.getSystemService(ClipboardManager::class.java))
    val previousClip = clipboard.primaryClip
    try {
      val model = offlineTypographyModel()
      composeRule.setContent {
        DeviceConfigurationOverride(DeviceConfigurationOverride.FontScale(2f)) {
          ClawDesignTheme(dark = false) {
            SettingsDetailScreen(model, SettingsRoute.Gateway, onBack = {})
          }
        }
      }
      val expected = model.instanceId.value
      assertTrue(expected.isNotBlank())
      val value = composeRule.onNodeWithText(expected, useUnmergedTree = true).performScrollTo()
      value.assertIsDisplayed()
      composeRule.runOnIdle { clipboard.setPrimaryClip(ClipData.newPlainText("Previous clipboard", "synthetic clipboard sentinel")) }
      captureTypography("gateway-instance-id-before-copy")
      value.performTouchInput { click() }
      composeRule.runOnIdle {
        assertEquals(
          "The copyable Gateway instance ID must copy its full value",
          expected,
          clipboard.primaryClip
            ?.getItemAt(0)
            ?.text
            ?.toString(),
        )
      }
    } finally {
      try {
        if (previousClip == null) clipboard.clearPrimaryClip() else clipboard.setPrimaryClip(previousClip)
      } finally {
        NativeStringResources.setApplicationLocales(LocaleListCompat.getEmptyLocaleList())
      }
    }
  }

  @Test
  @Config(qualifiers = "fr-rFR-w320dp-h800dp-mdpi")
  fun gatewayMetricsKeepVisibleLabelsAndFullValuesAtLargeFont() {
    try {
      val model = offlineTypographyModel()
      composeRule.setContent {
        DeviceConfigurationOverride(DeviceConfigurationOverride.FontScale(2f)) {
          ClawDesignTheme(dark = false) {
            SettingsDetailScreen(model, SettingsRoute.Gateway, onBack = {})
          }
        }
      }
      val failures = mutableListOf<String>()
      for (text in listOf(nativeString("Connection"), nativeString("Instance ID"), model.instanceId.value)) {
        // Exact semantic lookup alone must not certify the visible, possibly ellipsized value.
        val node = composeRule.onNodeWithText(text, useUnmergedTree = true).performScrollTo()
        captureTypography("gateway-metric-${if (text == model.instanceId.value) "instance-value" else text}")
        try {
          node.assertCompleteText(text)
        } catch (error: AssertionError) {
          failures += "$text: ${error.message}"
        }
      }
      assertTrue("Gateway metric labels and values must remain readable:\n${failures.joinToString("\n")}", failures.isEmpty())
    } finally {
      NativeStringResources.setApplicationLocales(LocaleListCompat.getEmptyLocaleList())
    }
  }

  @Test
  @Config(qualifiers = "fr-rFR-w320dp-h800dp-mdpi")
  fun voiceInformationKeepsCompleteTextAndSpeakerActionAtLargeFont() {
    try {
      val model = offlineTypographyModel()
      composeRule.setContent {
        DeviceConfigurationOverride(DeviceConfigurationOverride.FontScale(2f)) {
          ClawDesignTheme(dark = false) {
            SettingsDetailScreen(model, SettingsRoute.Voice, onBack = {})
          }
        }
      }
      assertEquals(GatewayTalkSetupReadiness.unverified(), model.talkSetupReadiness.value)
      for (key in listOf("Realtime Talk", "Dictation", "Gateway talk catalog not loaded", "Unverified", "Wake listener", "Pauses during other voice activity.", "Add wake phrase", "Save wake words")) {
        val label = nativeString(key)
        val nodes = composeRule.onAllNodesWithText(label, useUnmergedTree = true)
        assertTrue("$key must have a rendered caller", nodes.fetchSemanticsNodes().isNotEmpty())
        for (index in nodes.fetchSemanticsNodes().indices) {
          nodes[index].performScrollTo()
          captureTypography("voice-$key-$index")
          nodes[index].assertCompleteText(label)
        }
      }
      val wakeStatus = composeRule.runOnIdle { model.voiceWakeStatusText.value }
      composeRule.onNodeWithText(wakeStatus, useUnmergedTree = true).assertCompleteText(wakeStatus)
      for (key in listOf("Realtime Talk", "Dictation", "Wake listener", "Save wake words")) {
        composeRule.onNodeWithText(nativeString(key)).assertIsNotEnabled()
      }
      for ((action, description) in listOf("Mute speaker" to "Replies play aloud", "Enable speaker" to "Assistant speech muted")) {
        composeRule.onNodeWithText(nativeString(description), useUnmergedTree = true).assertCompleteText(nativeString(description))
        composeRule.onNodeWithText(nativeString(action), useUnmergedTree = true).assertCompleteText(nativeString(action))
        val before = model.speakerEnabled.value
        val status = nativeString(if (before) "On" else "Muted")
        composeRule.onNodeWithText(status, useUnmergedTree = true).assertCompleteText(status)
        captureTypography("voice-$action")
        // The merged Surface can center over status; exercise the visible title's actual hit.
        composeRule.onNodeWithText(nativeString(action), useUnmergedTree = true).performScrollTo().performClick()
        composeRule.runOnIdle { assertEquals(!before, model.speakerEnabled.value) }
      }
      assertTrue(model.speakerEnabled.value)
    } finally {
      NativeStringResources.setApplicationLocales(LocaleListCompat.getEmptyLocaleList())
    }
  }

  @Test
  @Config(qualifiers = "fr-rFR-w320dp-h800dp-mdpi")
  fun gatewayExplanationAndSecurityKeepCompleteTextAndTlsRestriction() {
    try {
      val model = offlineTypographyModel()
      val fontScale = mutableStateOf(2f)
      composeRule.setContent {
        DeviceConfigurationOverride(DeviceConfigurationOverride.FontScale(fontScale.value)) {
          ClawDesignTheme(dark = false) {
            SettingsDetailScreen(model, SettingsRoute.Gateway, onBack = {})
          }
        }
      }
      for (key in listOf("Reconnect", "Disconnect")) {
        val label = nativeString(key)
        val node = composeRule.onNodeWithText(label, useUnmergedTree = true)
        node.assertCompleteText(label)
        captureTypography("gateway-$key")
        val layouts = mutableListOf<TextLayoutResult>()
        node.performSemanticsAction(SemanticsActions.GetTextLayoutResult) { assertTrue(it(layouts)) }
        val layout = layouts.single()
        assertTrue(
          "$label must move below its peer rather than break inside its action word",
          (0 until layout.lineCount - 1).none { line ->
            val end = layout.getLineEnd(line, visibleEnd = true)
            end > 0 && end < label.length && label[end - 1].isLetter() && label[end].isLetter()
          },
        )
      }
      for (key in listOf("Scan or paste a setup code to add another gateway.", "Unencrypted", "Secure (TLS)")) {
        val label = nativeString(key)
        composeRule.onNodeWithText(label, useUnmergedTree = true).performScrollTo()
        captureTypography("gateway-$key")
        composeRule.onNodeWithText(label, useUnmergedTree = true).assertCompleteText(label)
      }
      composeRule.onNodeWithText(nativeString("Unencrypted")).assertIsNotEnabled().performClick()
      composeRule.onNodeWithText(nativeString("Secure (TLS)")).assertIsSelected()
      assertFalse("Presenting required TLS does not rewrite saved preferences", model.manualTls.value)

      composeRule.runOnIdle { fontScale.value = 1f }
      val reconnect = composeRule.onNodeWithText(nativeString("Reconnect")).performScrollTo()
      val disconnect = composeRule.onNodeWithText(nativeString("Disconnect"))
      disconnect.assertIsDisplayed()
      val first = reconnect.fetchSemanticsNode().boundsInRoot
      val second = disconnect.fetchSemanticsNode().boundsInRoot
      assertTrue("Fitting normal-font actions stay beside one another", first.right <= second.left && first.top == second.top)
      captureTypography("gateway-actions-normal-font")
    } finally {
      NativeStringResources.setApplicationLocales(LocaleListCompat.getEmptyLocaleList())
    }
  }

  private fun offlineTypographyModel(): MainViewModel {
    app = RuntimeEnvironment.getApplication() as NodeApp
    previousRuntime = app.peekRuntime()
    NativeStringResources.install(app)
    NativeStringResources.setApplicationLocales(LocaleListCompat.forLanguageTags("fr"))
    val prefs = SecurePrefs(app, app.getSharedPreferences("typography-${UUID.randomUUID()}", Context.MODE_PRIVATE))
    prefs.setManualHost("wss://gateway.example.test")
    prefs.setManualPort(443)
    prefs.setManualTls(false)
    runtime = NodeRuntime(app, prefs, NodeRuntimeMode.ScreenshotFixture)
    runtime.disconnect()
    bindNodeRuntimeTestFixture(app, runtime)
    return MainViewModel(app, prefs, SavedStateHandle()).also { models.put("typography", it) }
  }

  private fun captureTypography(name: String) {
    val evidence = File("build/outputs/settings-typography", UUID.randomUUID().toString())
    check(evidence.mkdirs())
    File(evidence, "${name.replace(Regex("[^a-zA-Z0-9-]"), "-")}.png").outputStream().use {
      assertTrue(
        composeRule
          .onRoot()
          .captureToImage()
          .asAndroidBitmap()
          .compress(Bitmap.CompressFormat.PNG, 100, it),
      )
    }
  }

  @Test
  fun operationalCaptionsRemainReadableThroughTheirSettingsCallers() {
    app = RuntimeEnvironment.getApplication() as NodeApp
    previousRuntime = app.peekRuntime()
    gateway = OperationalCaptionsGateway()
    val prefs = SecurePrefs(app, app.getSharedPreferences("captions-${UUID.randomUUID()}", Context.MODE_PRIVATE))
    prefs.setManualTls(false)
    prefs.saveGatewayCredentials(gateway.endpoint.stableId, token = "synthetic-caption-proof")
    runtime = NodeRuntime(app, prefs)
    bindNodeRuntimeTestFixture(app, runtime)
    val model = MainViewModel(app, prefs, SavedStateHandle())
    models.put("operational-captions", model)
    model.setForeground(true)
    val route = mutableStateOf(SettingsRoute.CronJobs)
    val themes = contrastThemeCases()
    val currentTheme = mutableStateOf(themes.first())
    val evidence = File("build/outputs/operational-caption-contrast", UUID.randomUUID().toString())
    check(!evidence.exists() && evidence.mkdirs())
    val observations = JSONArray()
    val failures = mutableListOf<String>()
    composeRule.setContent {
      val theme = currentTheme.value
      ClawDesignTheme(dark = theme.dark, family = theme.family, accentArgb = theme.accentArgb) {
        SettingsDetailScreen(viewModel = model, route = route.value, onBack = {})
      }
    }
    composeRule.runOnIdle { model.connect(gateway.endpoint) }
    // Both screens retain visible data during refresh; wait for completion before measuring.
    try {
      composeRule.waitUntil(10_000) {
        composeRule.onAllNodesWithText("Enabled").fetchSemanticsNodes().isNotEmpty() &&
          model.isConnected.value && !model.cronRefreshing.value && model.cronStatus.value.enabled
      }
    } finally {
      File(evidence, "cron-readiness.json").writeText(
        JSONObject()
          .put("connected", model.isConnected.value)
          .put("status", model.statusText.value)
          .put("cronEnabled", model.cronStatus.value.enabled)
          .put("cronRefreshing", model.cronRefreshing.value)
          .put("runtimeConnected", runtime.isConnected.value)
          .put("runtimeStatus", runtime.statusText.value)
          .put("cronError", model.cronErrorText.value)
          .put("methods", JSONArray(gateway.methods))
          .toString(2),
      )
    }
    assertTrue(gateway.methods.containsAll(listOf("cron.status", "cron.list")))

    fun observe(
      name: String,
      label: String,
      substring: Boolean = false,
    ) {
      val theme = currentTheme.value
      val capture = "${theme.family.rawValue}-${if (theme.dark) "dark" else "light"}-${theme.accentArgb?.toString(16) ?: "default"}-$name"
      val node = composeRule.onNodeWithText(label, substring = substring, useUnmergedTree = true)
      val observation = renderedLabelContrast(node)
      val contrast = observation.ratio
      val bounds = node.fetchSemanticsNode().boundsInRoot
      val crop = node.captureToImage().asAndroidBitmap()
      File(evidence, "$capture-crop.png").outputStream().use { stream ->
        assertTrue(crop.compress(Bitmap.CompressFormat.PNG, 100, stream))
      }
      val bitmap = composeRule.onRoot().captureToImage().asAndroidBitmap()
      File(evidence, "$capture.png").outputStream().use { stream ->
        assertTrue(bitmap.compress(Bitmap.CompressFormat.PNG, 100, stream))
      }
      observations.put(
        JSONObject()
          .put("caption", name)
          .put("family", theme.family.rawValue)
          .put("dark", theme.dark)
          .put("accentArgb", theme.accentArgb)
          .put("contrast", contrast.toDouble())
          .put("image", "$capture.png")
          .put("crop", "$capture-crop.png")
          .put("foregroundArgb", "%08X".format(observation.foreground.toArgb()))
          .put("backgroundArgb", "%08X".format(observation.background.toArgb()))
          .put("sampleX", observation.sampleX)
          .put("sampleY", observation.sampleY)
          .put("boundsInRoot", JSONArray(listOf(bounds.left, bounds.top, bounds.right, bounds.bottom))),
      )
      if (contrast < 4.5f) failures += "$capture: $contrast:1"
    }

    themes.forEach { theme ->
      composeRule.runOnIdle { currentTheme.value = theme }
      observe("cron-status", "Status")
      observe("cron-next-wake", "Next Wake")
      observe("cron-help", "Open an automation to inspect its configuration and run history.", substring = true)
    }
    composeRule.runOnIdle { route.value = SettingsRoute.Approvals }
    composeRule.waitUntil(10_000) {
      composeRule.onAllNodesWithText("echo ok").fetchSemanticsNodes().isNotEmpty() &&
        !model.execApprovalInbox.value.refreshing && model.execApprovalInbox.value.approvals
          .singleOrNull()
          ?.commandPreview == "echo"
    }
    composeRule
      .onNodeWithText("Deny")
      .performScrollTo()
      .assertIsDisplayed()
      .assertIsEnabled()
    themes.forEach { theme ->
      composeRule.runOnIdle { currentTheme.value = theme }
      observe("approval-metadata", "Gateway · Agent main · Waiting", substring = true)
    }

    // Readback of a previously visible approval publishes the terminal notice; no resolution is sent.
    val readsBeforeRefresh = gateway.methods.count { it == "approval.get" }
    gateway.terminal = true
    composeRule.onNodeWithText("Refresh").performScrollTo().performClick()
    composeRule.waitUntil(10_000) {
      val inbox = model.execApprovalInbox.value
      composeRule.onAllNodesWithText("Approval approval-1").fetchSemanticsNodes().isNotEmpty() &&
        inbox.approvals.isEmpty() && inbox.notice?.approvalId == "approval-1"
    }
    assertTrue(
      model.execApprovalInbox.value.approvals
        .isEmpty() && model.execApprovalInbox.value.notice
        ?.approvalId == "approval-1",
    )
    assertTrue(gateway.methods.count { it == "approval.get" } > readsBeforeRefresh)
    composeRule.onNodeWithText("A prior response already denied this approval.").performScrollTo().assertIsDisplayed()
    themes.forEach { theme ->
      composeRule.runOnIdle { currentTheme.value = theme }
      observe("approval-notice-id", "Approval approval-1")
    }
    composeRule.onNodeWithContentDescription("Dismiss approval notice").performClick()
    composeRule.waitUntil(10_000) { composeRule.onAllNodesWithText("Approval approval-1").fetchSemanticsNodes().isEmpty() }
    assertEquals(null, model.execApprovalInbox.value.notice)
    assertTrue(composeRule.onAllNodesWithText("Approval approval-1").fetchSemanticsNodes().isEmpty())
    assertFalse(gateway.methods.any { it in setOf("approval.resolve", "exec.approval.resolve", "chat.send", "cron.run") })
    File(evidence, "observations.json").writeText(
      JSONObject()
        .put("observations", observations)
        .put("methods", JSONArray(gateway.methods))
        .put("themeCount", themes.size)
        .put("createdAtMs", gateway.createdAtMs)
        .put("expiresAtMs", gateway.expiresAtMs)
        .put("terminalReadbackObserved", true)
        .put("noticeDismissed", true)
        .put("approvalResolutionRequests", 0)
        .toString(2),
    )
    assertTrue("Operational captions must retain 4.5:1 contrast:\n${failures.joinToString("\n")}", failures.isEmpty())
  }

  @Test
  fun terminalNoticeDoesNotCoexistWithItsActionableCard() {
    app = RuntimeEnvironment.getApplication() as NodeApp
    previousRuntime = app.peekRuntime()
    gateway = OperationalCaptionsGateway()
    val prefs = SecurePrefs(app, app.getSharedPreferences("approval-coherence-${UUID.randomUUID()}", Context.MODE_PRIVATE))
    prefs.setManualTls(false)
    prefs.saveGatewayCredentials(gateway.endpoint.stableId, token = "synthetic-coherence-proof")
    runtime = NodeRuntime(app, prefs)
    bindNodeRuntimeTestFixture(app, runtime)
    val model = MainViewModel(app, prefs, SavedStateHandle())
    models.put("approval-coherence", model)
    model.setForeground(true)
    val evidence = File("build/outputs/approval-inbox-coherence", UUID.randomUUID().toString())
    check(!evidence.exists() && evidence.mkdirs())
    composeRule.setContent {
      ClawDesignTheme(dark = false) {
        SettingsDetailScreen(viewModel = model, route = SettingsRoute.Approvals, onBack = {})
      }
    }
    composeRule.runOnIdle { model.connect(gateway.endpoint) }
    composeRule.waitUntil(10_000) {
      composeRule.onAllNodesWithText("Refresh").fetchSemanticsNodes().any {
        SemanticsActions.OnClick in it.config && SemanticsProperties.Disabled !in it.config
      } && composeRule.onAllNodesWithText("echo ok").fetchSemanticsNodes().isNotEmpty() &&
        !model.execApprovalInbox.value.refreshing && model.execApprovalInbox.value.approvals
          .singleOrNull()
          ?.id == "approval-1"
    }
    composeRule
      .onNodeWithText("Deny")
      .performScrollTo()
      .assertIsDisplayed()
      .assertIsEnabled()
    // Public subscription pauses the publisher, not the UI or an injected state setter.
    observationScope.launch(start = CoroutineStart.UNDISPATCHED) {
      runtime.execApprovalInbox.collect { inbox ->
        if (inbox.notice?.approvalId == "approval-1" && noticeReached.count != 0L) {
          noticeReached.countDown()
          noticeReleasedWithinBound = releaseNotice.await(10, TimeUnit.SECONDS)
        }
      }
    }
    val renderedTogether =
      try {
        gateway.terminal = true
        composeRule.onNodeWithText("Refresh").performScrollTo().performClick()
        composeRule.waitUntil(10_000) {
          composeRule.onAllNodesWithText("Approval approval-1").fetchSemanticsNodes().isNotEmpty() && noticeReached.count == 0L
        }
        composeRule.onNodeWithText("A prior response already denied this approval.").assertIsDisplayed()
        composeRule.onNodeWithText("Approval approval-1").assertIsDisplayed()
        val commands = composeRule.onAllNodesWithText("echo ok").fetchSemanticsNodes()
        val deny = composeRule.onAllNodesWithText("Deny").fetchSemanticsNodes()
        val mixed =
          commands.isNotEmpty() &&
            deny.any {
              SemanticsActions.OnClick in it.config && SemanticsProperties.Disabled !in it.config
            }
        if (mixed) {
          composeRule.onNodeWithText("echo ok").assertIsDisplayed()
          composeRule
            .onNodeWithText("Deny")
            .assertIsDisplayed()
            .assertIsEnabled()
            .assertHasClickAction()
          assertEquals(
            "approval-1",
            model.execApprovalInbox.value.approvals
              .single()
              .id,
          )
        }
        assertEquals(
          "approval-1",
          model.execApprovalInbox.value.notice
            ?.approvalId,
        )
        val bitmap = composeRule.onRoot().captureToImage().asAndroidBitmap()
        File(evidence, "terminal-inbox.png").outputStream().use {
          assertTrue(bitmap.compress(Bitmap.CompressFormat.PNG, 100, it))
        }
        mixed
      } finally {
        releaseNotice.countDown()
        runBlocking { observationScope.coroutineContext[Job]!!.cancelAndJoin() }
      }
    assertTrue(noticeReleasedWithinBound)
    composeRule.waitUntil(10_000) {
      composeRule.onAllNodesWithText("echo ok").fetchSemanticsNodes().isEmpty() &&
        model.execApprovalInbox.value.approvals
          .isEmpty() && model.execApprovalInbox.value.notice
          ?.approvalId == "approval-1"
    }
    composeRule.onNodeWithText("Approval approval-1").assertIsDisplayed()
    composeRule.onNodeWithText("Deny").assertDoesNotExist()
    composeRule.onNodeWithContentDescription("Dismiss approval notice").performClick()
    composeRule.waitUntil(10_000) {
      composeRule.onAllNodesWithText("Approval approval-1").fetchSemanticsNodes().isEmpty() && model.execApprovalInbox.value.notice == null
    }
    assertFalse(gateway.methods.any { it in setOf("approval.resolve", "exec.approval.resolve", "chat.send", "cron.run") })
    assertFalse("A rendered terminal notice must not coexist with its same-ID actionable card", renderedTogether)
  }
}

private class OperationalCaptionsGateway : AutoCloseable {
  private val json = Json { ignoreUnknownKeys = true }
  private val server = MockWebServer()
  private val startedAtMs = System.currentTimeMillis()
  val createdAtMs = startedAtMs - 60_000
  val expiresAtMs = startedAtMs + 600_000
  val methods = CopyOnWriteArrayList<String>()

  @Volatile var terminal = false
  val endpoint: GatewayEndpoint

  init {
    server.dispatcher =
      object : Dispatcher() {
        override fun dispatch(request: RecordedRequest): MockResponse =
          if (request.getHeader("Upgrade").equals("websocket", ignoreCase = true)) {
            MockResponse().withWebSocketUpgrade(listener())
          } else {
            MockResponse().setResponseCode(404)
          }
      }
    server.start(InetAddress.getByName("127.0.0.1"), 0)
    endpoint = GatewayEndpoint.manual("127.0.0.1", server.port)
  }

  private fun listener() =
    object : WebSocketListener() {
      override fun onOpen(
        webSocket: WebSocket,
        response: Response,
      ) {
        webSocket.send("""{"type":"event","event":"connect.challenge","payload":{"nonce":"caption-proof","ts":1700000000123}}""")
      }

      override fun onMessage(
        webSocket: WebSocket,
        text: String,
      ) {
        val frame = json.parseToJsonElement(text).jsonObject
        if (frame["type"]?.jsonPrimitive?.content != "req") return
        val id = frame.getValue("id")
        val method = frame["method"]?.jsonPrimitive?.content.orEmpty()
        methods += method
        val params = frame["params"] as? JsonObject ?: JsonObject(emptyMap())
        val payload: JsonElement? =
          when (method) {
            "connect" -> {
              val role = params.getValue("role").jsonPrimitive.content
              json.parseToJsonElement(
                """{"type":"hello-ok","protocol":3,"server":{"host":"caption-proof","version":"proof"},"features":{"methods":["cron.status","cron.list","exec.approval.list","approval.get","approval.resolve","chat.history","chat.metadata","health","sessions.list"],"events":[]},"auth":{"role":"$role","scopes":${if (role == "operator") "[\"operator.read\",\"operator.write\",\"operator.approvals\"]" else "[]"}},"snapshot":{"sessionDefaults":{"mainSessionKey":"agent:main:main"}}}""",
              )
            }

            "cron.status" -> {
              json.parseToJsonElement("""{"enabled":true,"jobs":0,"nextWakeAtMs":null}""")
            }

            "cron.list" -> {
              json.parseToJsonElement("""{"jobs":[],"total":0,"hasMore":false,"nextOffset":null}""")
            }

            "exec.approval.list" -> {
              json.parseToJsonElement("""[{"id":"approval-1","createdAtMs":$createdAtMs,"expiresAtMs":$expiresAtMs}]""")
            }

            "approval.get" -> {
              if (params["id"]?.jsonPrimitive?.content == "approval-1") approval() else null
            }

            "chat.history" -> {
              json.parseToJsonElement("""{"sessionId":"caption-chat","messages":[]}""")
            }

            "chat.metadata" -> {
              json.parseToJsonElement("""{"commands":[],"models":[]}""")
            }

            "sessions.list" -> {
              json.parseToJsonElement("""{"sessions":[]}""")
            }

            "health", "sessions.subscribe", "sessions.messages.subscribe" -> {
              JsonObject(emptyMap())
            }

            else -> {
              null
            }
          }
        webSocket.send(
          buildJsonObject {
            put("type", JsonPrimitive("res"))
            put("id", id)
            put("ok", JsonPrimitive(payload != null))
            if (payload != null) {
              put("payload", payload)
            } else {
              put(
                "error",
                buildJsonObject {
                  put("code", JsonPrimitive("INVALID_REQUEST"))
                  put("message", JsonPrimitive("Read-only caption fixture does not implement $method"))
                },
              )
            }
          }.toString(),
        )
      }
    }

  private fun approval(): JsonElement {
    val terminalFields = if (terminal) ",\"resolvedAtMs\":${System.currentTimeMillis()},\"reason\":\"user\",\"decision\":\"deny\"" else ""
    return json.parseToJsonElement(
      """{"approval":{"id":"approval-1","urlPath":"/approve/approval-1","status":"${if (terminal) "denied" else "pending"}","createdAtMs":$createdAtMs,"expiresAtMs":$expiresAtMs,"presentation":{"kind":"exec","commandText":"echo ok","commandPreview":"echo","warningText":null,"host":"gateway","nodeId":null,"agentId":"main","allowedDecisions":["allow-once","allow-always","deny"]}$terminalFields}}""",
    )
  }

  override fun close() = server.shutdown()
}
