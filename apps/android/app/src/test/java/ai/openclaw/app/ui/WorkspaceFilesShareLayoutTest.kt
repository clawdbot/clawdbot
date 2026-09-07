package ai.openclaw.app.ui

import ai.openclaw.app.MainViewModel
import ai.openclaw.app.NodeApp
import ai.openclaw.app.NodeRuntime
import ai.openclaw.app.SecurePrefs
import ai.openclaw.app.bindNodeRuntimeTestFixture
import ai.openclaw.app.closeNodeRuntimeTestFixture
import ai.openclaw.app.gateway.GatewayEndpoint
import ai.openclaw.app.ui.design.ClawDesignTheme
import android.app.Activity
import android.content.ActivityNotFoundException
import android.content.Context
import android.content.ContextWrapper
import android.content.Intent
import android.graphics.Bitmap
import android.net.Uri
import android.util.Base64
import androidx.activity.compose.LocalActivity
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.size
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.remember
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clipToBounds
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.assertIsEnabled
import androidx.compose.ui.test.hasClickAction
import androidx.compose.ui.test.hasContentDescription
import androidx.compose.ui.test.hasText
import androidx.compose.ui.test.junit4.v2.createComposeRule
import androidx.compose.ui.test.onAllNodesWithText
import androidx.compose.ui.test.onNodeWithContentDescription
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.compose.ui.unit.dp
import androidx.core.content.FileProvider
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
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Rule
import org.junit.Test
import org.junit.rules.ExternalResource
import org.junit.rules.RuleChain
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import org.robolectric.Shadows.shadowOf
import org.robolectric.annotation.Config
import org.robolectric.shadows.ShadowContentResolver
import org.robolectric.shadows.ShadowToast
import java.io.ByteArrayOutputStream
import java.io.File
import java.net.InetAddress
import java.util.UUID

private const val FILE_NAME = "notes.txt"
private const val FIRST_BODY = "First workspace export.\n"
private const val SECOND_BODY = "Second workspace export.\n"
private const val SHARE_FAILURE = "Could not share file"
private const val READY_TIMEOUT_MS = 10_000L

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34], qualifiers = "en-rUS-w360dp-h800dp-420dpi")
class WorkspaceFilesShareLayoutTest {
  private val composeRule = createComposeRule()

  // Dispose the real screen before joining runtime/socket cleanup, including after the expected red.
  @get:Rule
  val fixtureRules: RuleChain =
    RuleChain
      .outerRule(
        object : ExternalResource() {
          override fun after() = tearDown()
        },
      ).around(composeRule)

  private lateinit var app: NodeApp
  private lateinit var runtime: NodeRuntime
  private lateinit var activity: Activity
  private lateinit var gateway: WorkspaceFilesGateway
  private lateinit var blockedCache: File
  private lateinit var exportRoot: File
  private val models = ViewModelStore()
  private var previousRuntime: NodeRuntime? = null
  private var originalExportChildren = emptySet<File>()
  private var exportRootExisted = false
  private var exportSnapshotReady = false

  @Volatile private var blockCache = false
  private var failLaunch = false

  @Before
  fun setUp() {
    app = RuntimeEnvironment.getApplication() as NodeApp
    previousRuntime = app.peekRuntime()
    blockedCache = File.createTempFile("workspace-share-obstruction-", ".tmp", app.cacheDir)
    exportRoot = File(app.cacheDir, "workspace-files")
    check(!exportRoot.exists() || exportRoot.isDirectory)
    exportRootExisted = exportRoot.exists()
    originalExportChildren = exportRoot.listFiles().orEmpty().toSet()
    exportSnapshotReady = true
    // Load the manifest provider, not a registered byte-stream substitute.
    assertTrue(ShadowContentResolver.getProvider(Uri.parse("content://${app.packageName}.fileprovider")) is FileProvider)
    ShadowToast.reset()
    gateway = WorkspaceFilesGateway()
    val prefs = SecurePrefs(app, app.getSharedPreferences("workspace-share-${UUID.randomUUID()}", Context.MODE_PRIVATE))
    prefs.setManualTls(false)
    prefs.saveGatewayCredentials(gateway.endpoint.stableId, token = "synthetic-workspace-share-proof")
    runtime = NodeRuntime(app, prefs)
    bindNodeRuntimeTestFixture(app, runtime)
    val model = MainViewModel(app, prefs, SavedStateHandle())
    models.put("workspace", model)
    model.setForeground(true)
    composeRule.setContent {
      activity = requireNotNull(LocalActivity.current)
      val context =
        remember(activity) {
          object : ContextWrapper(activity) {
            // Only the selected action's local storage is faulted; fetch/runtime use the normal app.
            override fun getCacheDir(): File = if (blockCache) blockedCache else super.getCacheDir()

            override fun startActivity(intent: Intent) {
              if (failLaunch) throw ActivityNotFoundException("Synthetic chooser failure")
              super.startActivity(intent)
            }
          }
        }
      CompositionLocalProvider(LocalContext provides context) {
        ClawDesignTheme {
          Box(Modifier.size(360.dp, 800.dp).clipToBounds()) {
            WorkspaceFilesScreen(viewModel = model, onBack = {})
          }
        }
      }
    }
    composeRule.runOnIdle { model.connect(gateway.endpoint) }
    openPreview(FIRST_BODY)
    assertNull(shadowOf(activity).nextStartedActivity)
  }

  @Test
  fun cacheFailureReportsOutcomeWithoutLaunchingChooserOrLosingPreview() {
    assertTrue(blockedCache.isFile)
    blockCache = true
    ShadowToast.reset()

    share()

    awaitShareFailure()
    assertTrue(blockedCache.isFile)
    assertNull(shadowOf(activity).nextStartedActivity)
    composeRule.onNodeWithText(FIRST_BODY.trimEnd()).assertIsDisplayed()
    composeRule.onNodeWithContentDescription("Share file").assertIsEnabled()
    composeRule.onNodeWithContentDescription("Back").performClick()
    awaitFileRow()
  }

  @Test
  fun aLaterSameNameExportDoesNotReplaceBytesBehindTheFirstUri() {
    val first = shareUri()
    assertArrayEquals(FIRST_BODY.toByteArray(), readExport(first))

    composeRule.onNodeWithContentDescription("Back").performClick()
    gateway.body = SECOND_BODY
    openPreview(SECOND_BODY)
    val second = shareUri()

    assertArrayEquals(SECOND_BODY.toByteArray(), readExport(second))
    assertArrayEquals(FIRST_BODY.toByteArray(), readExport(first))
  }

  @Test
  fun chooserFailureRemovesOnlyItsUnpublishedAttempt() {
    val first = shareUri()
    val published = exportRoot.listFiles().orEmpty().toSet()
    failLaunch = true

    share()

    awaitShareFailure()
    assertNull(shadowOf(activity).nextStartedActivity)
    assertEquals(published, exportRoot.listFiles().orEmpty().toSet())
    assertArrayEquals(FIRST_BODY.toByteArray(), readExport(first))
    composeRule.onNodeWithText(FIRST_BODY.trimEnd()).assertIsDisplayed()
  }

  @Test
  fun sharesExactImageBytesAndReportsInvalidBase64WithoutLeavingAnAttempt() {
    val bitmap = Bitmap.createBitmap(1, 1, Bitmap.Config.ARGB_8888)
    val bytes =
      ByteArrayOutputStream().use { output ->
        assertTrue(bitmap.compress(Bitmap.CompressFormat.PNG, 100, output))
        output.toByteArray()
      }
    bitmap.recycle()
    gateway.name = "pixel.png"
    gateway.mimeType = "image/png"
    gateway.encoding = "base64"
    gateway.body = Base64.encodeToString(bytes, Base64.NO_WRAP)
    composeRule.onNodeWithContentDescription("Back").performClick()
    openPreview()
    val first = shareUri("image/png")
    assertArrayEquals(bytes, readExport(first))
    val published = exportRoot.listFiles().orEmpty().toSet()

    composeRule.onNodeWithContentDescription("Back").performClick()
    gateway.body = "A"
    openPreview()
    share()

    awaitShareFailure()
    assertNull(shadowOf(activity).nextStartedActivity)
    assertEquals(published, exportRoot.listFiles().orEmpty().toSet())
    assertArrayEquals(bytes, readExport(first))
  }

  private fun openPreview(body: String? = null) {
    awaitFileRow()
    composeRule.onNode(hasText(gateway.name) and hasClickAction()).performClick()
    composeRule.waitUntil(READY_TIMEOUT_MS) {
      composeRule.onAllNodes(hasContentDescription("Share file")).fetchSemanticsNodes().isNotEmpty()
    }
    if (body != null) composeRule.onNodeWithText(body.trimEnd()).assertIsDisplayed()
    composeRule.onNodeWithContentDescription("Share file").assertIsDisplayed().assertIsEnabled()
  }

  private fun awaitFileRow() {
    composeRule.waitUntil(READY_TIMEOUT_MS) {
      composeRule.onAllNodes(hasText(gateway.name) and hasClickAction()).fetchSemanticsNodes().isNotEmpty()
    }
  }

  private fun share() {
    composeRule
      .onNodeWithContentDescription("Share file")
      .assertIsDisplayed()
      .assertIsEnabled()
      .performClick()
  }

  private fun awaitShareFailure() {
    // The outcome may be a shown Toast or visible screen text; the test does not require a layout.
    composeRule.waitUntil(READY_TIMEOUT_MS) {
      ShadowToast.getTextOfLatestToast() == SHARE_FAILURE ||
        composeRule.onAllNodesWithText(SHARE_FAILURE).fetchSemanticsNodes().isNotEmpty()
    }
    if (ShadowToast.getTextOfLatestToast() != SHARE_FAILURE) {
      composeRule.onNodeWithText(SHARE_FAILURE).assertIsDisplayed()
    }
  }

  private fun shareUri(mimeType: String = "text/plain"): Uri {
    share()
    var chooser: Intent? = null
    composeRule.waitUntil(READY_TIMEOUT_MS) {
      chooser = shadowOf(activity).nextStartedActivity
      chooser != null
    }
    val selected = requireNotNull(chooser)
    assertEquals(Intent.ACTION_CHOOSER, selected.action)
    val send = requireNotNull(selected.getParcelableExtra(Intent.EXTRA_INTENT, Intent::class.java))
    assertEquals(Intent.ACTION_SEND, send.action)
    assertEquals(mimeType, send.type)
    assertTrue(send.flags and Intent.FLAG_GRANT_READ_URI_PERMISSION != 0)
    return requireNotNull(send.getParcelableExtra(Intent.EXTRA_STREAM, Uri::class.java)).also {
      assertEquals("content", it.scheme)
    }
  }

  private fun readExport(uri: Uri): ByteArray = requireNotNull(app.contentResolver.openInputStream(uri)).use { it.readBytes() }

  private fun tearDown() {
    try {
      models.clear()
    } finally {
      try {
        if (::runtime.isInitialized) closeNodeRuntimeTestFixture(runtime)
      } finally {
        try {
          if (::app.isInitialized) bindNodeRuntimeTestFixture(app, previousRuntime)
        } finally {
          try {
            if (::gateway.isInitialized) gateway.close()
          } finally {
            if (::blockedCache.isInitialized) assertTrue(blockedCache.delete())
            if (exportSnapshotReady) {
              exportRoot.listFiles().orEmpty().filterNot(originalExportChildren::contains).forEach {
                assertTrue(it.deleteRecursively())
              }
              if (!exportRootExisted && exportRoot.exists()) assertTrue(exportRoot.delete())
            }
          }
        }
      }
    }
  }
}

private class WorkspaceFilesGateway : AutoCloseable {
  private val json = Json { ignoreUnknownKeys = true }
  private val server = MockWebServer()

  @Volatile var body = FIRST_BODY

  @Volatile var name = FILE_NAME

  @Volatile var mimeType = "text/plain"

  @Volatile var encoding = "utf8"
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
        webSocket.send("""{"type":"event","event":"connect.challenge","payload":{"nonce":"workspace-share-proof","ts":1700000000123}}""")
      }

      override fun onMessage(
        webSocket: WebSocket,
        text: String,
      ) {
        val frame = json.parseToJsonElement(text).jsonObject
        if (frame["type"]?.jsonPrimitive?.content != "req") return
        val id = frame.getValue("id")
        val method = frame["method"]?.jsonPrimitive?.content
        val params = frame["params"] as? JsonObject ?: JsonObject(emptyMap())
        val content = body
        val payload: JsonElement? =
          when (method) {
            "connect" -> {
              val role = params.getValue("role").jsonPrimitive.content
              json.parseToJsonElement(
                """{"type":"hello-ok","protocol":3,"server":{"host":"workspace-share-proof","version":"proof"},"features":{"methods":["agents.workspace.list","agents.workspace.get","chat.history","chat.metadata","health","sessions.list"],"events":[]},"auth":{"role":"$role","scopes":${if (role == "operator") "[\"operator.read\",\"operator.write\"]" else "[]"}},"snapshot":{"sessionDefaults":{"mainSessionKey":"agent:main:main"}}}""",
              )
            }

            "agents.workspace.list" -> {
              if (params["agentId"]?.jsonPrimitive?.content == "main" &&
                params["path"]
                  ?.jsonPrimitive
                  ?.content
                  .orEmpty()
                  .isEmpty()
              ) {
                json.parseToJsonElement("""{"agentId":"main","workspace":"/synthetic-workspace","path":"","parentPath":null,"entries":[{"path":"$name","name":"$name","kind":"file","size":${content.toByteArray().size},"updatedAtMs":1}],"totalEntries":1,"offset":0}""")
              } else {
                null
              }
            }

            "agents.workspace.get" -> {
              if (params["agentId"]?.jsonPrimitive?.content == "main" && params["path"]?.jsonPrimitive?.content == name) {
                buildJsonObject {
                  put("agentId", JsonPrimitive("main"))
                  put("workspace", JsonPrimitive("/synthetic-workspace"))
                  put(
                    "file",
                    buildJsonObject {
                      put("path", JsonPrimitive(name))
                      put("name", JsonPrimitive(name))
                      put("size", JsonPrimitive(content.toByteArray().size))
                      put("updatedAtMs", JsonPrimitive(1))
                      put("mimeType", JsonPrimitive(mimeType))
                      put("encoding", JsonPrimitive(encoding))
                      put("content", JsonPrimitive(content))
                    },
                  )
                }
              } else {
                null
              }
            }

            "chat.history" -> {
              json.parseToJsonElement("""{"sessionId":"workspace-share-chat","messages":[]}""")
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
                  put("message", JsonPrimitive("Workspace share fixture does not implement this request: $method"))
                },
              )
            }
          }.toString(),
        )
      }
    }

  override fun close() = server.shutdown()
}
