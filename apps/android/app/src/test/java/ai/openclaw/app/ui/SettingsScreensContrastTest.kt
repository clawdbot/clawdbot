package ai.openclaw.app.ui

import ai.openclaw.app.MainViewModel
import ai.openclaw.app.NodeApp
import ai.openclaw.app.NodeRuntime
import ai.openclaw.app.SecurePrefs
import ai.openclaw.app.bindNodeRuntimeTestFixture
import ai.openclaw.app.closeNodeRuntimeTestFixture
import ai.openclaw.app.gateway.GatewayEndpoint
import ai.openclaw.app.ui.design.ClawDesignTheme
import ai.openclaw.app.ui.design.contrastThemeCases
import ai.openclaw.app.ui.design.renderedLabelContrast
import android.content.Context
import android.graphics.Bitmap
import androidx.compose.runtime.mutableStateOf
import androidx.compose.ui.graphics.asAndroidBitmap
import androidx.compose.ui.graphics.toArgb
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.assertIsEnabled
import androidx.compose.ui.test.captureToImage
import androidx.compose.ui.test.junit4.v2.createComposeRule
import androidx.compose.ui.test.onAllNodesWithText
import androidx.compose.ui.test.onNodeWithContentDescription
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.onRoot
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performScrollTo
import androidx.lifecycle.SavedStateHandle
import androidx.lifecycle.ViewModelStore
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

  // Dispose Compose before joining the actual runtime and socket, including on the contrast red.
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
                  if (::gateway.isInitialized) gateway.close()
                }
              }
            }
          }
        },
      ).around(composeRule)

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
        !model.execApprovalsRefreshing.value && model.execApprovals.value
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
      composeRule.onAllNodesWithText("Approval approval-1").fetchSemanticsNodes().isNotEmpty()
    }
    assertTrue(model.execApprovals.value.isEmpty() && model.execApprovalsNotice.value?.approvalId == "approval-1")
    assertTrue(gateway.methods.count { it == "approval.get" } > readsBeforeRefresh)
    composeRule.onNodeWithText("A prior response already denied this approval.").performScrollTo().assertIsDisplayed()
    themes.forEach { theme ->
      composeRule.runOnIdle { currentTheme.value = theme }
      observe("approval-notice-id", "Approval approval-1")
    }
    composeRule.onNodeWithContentDescription("Dismiss approval notice").performClick()
    composeRule.waitUntil(10_000) { composeRule.onAllNodesWithText("Approval approval-1").fetchSemanticsNodes().isEmpty() }
    assertEquals(null, model.execApprovalsNotice.value)
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
