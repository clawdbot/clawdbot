package ai.openclaw.app.ui.chat

import ai.openclaw.app.MainViewModel
import ai.openclaw.app.NodeApp
import ai.openclaw.app.NodeRuntime
import ai.openclaw.app.SecurePrefs
import ai.openclaw.app.chat.ChatComposerOwner
import ai.openclaw.app.chat.ChatFullMessageState
import ai.openclaw.app.chat.ChatFullMessageUnavailable
import ai.openclaw.app.closeNodeRuntimeTestFixture
import ai.openclaw.app.gateway.GatewayEndpoint
import ai.openclaw.app.gateway.GatewaySession
import ai.openclaw.app.ui.design.ClawDesignTheme
import android.content.ClipboardManager
import android.content.Context
import android.graphics.Point
import android.graphics.Rect
import android.graphics.RectF
import android.os.Looper
import android.provider.Settings
import android.view.View
import android.view.ViewGroup
import android.view.inspector.WindowInspector
import android.widget.TextView
import androidx.activity.findViewTreeOnBackPressedDispatcherOwner
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.size
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clipToBounds
import androidx.compose.ui.semantics.SemanticsActions
import androidx.compose.ui.semantics.SemanticsProperties
import androidx.compose.ui.test.assertCountEquals
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.assertIsEnabled
import androidx.compose.ui.test.hasAnyAncestor
import androidx.compose.ui.test.hasClickAction
import androidx.compose.ui.test.hasContentDescription
import androidx.compose.ui.test.hasScrollToNodeAction
import androidx.compose.ui.test.hasSetTextAction
import androidx.compose.ui.test.hasText
import androidx.compose.ui.test.isDialog
import androidx.compose.ui.test.junit4.v2.createComposeRule
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performScrollTo
import androidx.compose.ui.test.performScrollToNode
import androidx.compose.ui.test.performSemanticsAction
import androidx.compose.ui.test.performTextClearance
import androidx.compose.ui.test.performTouchInput
import androidx.compose.ui.test.swipeUp
import androidx.compose.ui.text.TextLayoutResult
import androidx.compose.ui.unit.dp
import androidx.lifecycle.SavedStateHandle
import androidx.lifecycle.ViewModelStore
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.async
import kotlinx.coroutines.cancelAndJoin
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.combine
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.withTimeout
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
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
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
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
import org.robolectric.annotation.GraphicsMode
import org.robolectric.config.ConfigurationRegistry
import java.net.InetAddress
import java.util.UUID
import java.util.concurrent.CopyOnWriteArrayList
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicInteger
import java.util.concurrent.atomic.AtomicReference

internal const val FULL_MESSAGE_FIRST_CHAT = "agent:main:disclosure-a"
internal const val FULL_MESSAGE_SECOND_CHAT = "agent:main:disclosure-b"
internal const val FULL_MESSAGE_ENTRY = "shared-transcript-entry"
internal const val FULL_MESSAGE_TAIL = "The complete answer ends here."
internal const val FULL_MESSAGE_READY_TIMEOUT_MS = 15_000L
private const val FULL_MESSAGE_IMAGE = "inline-image.png"
private const val FULL_MESSAGE_FILE = "inline-file.txt"
private const val FULL_MESSAGE_AUDIO = "inline-history-tts.mp3"
private const val FULL_MESSAGE_MEDIA_TEXT = "The second paragraph stays after the file."

/** Real ChatScreen callbacks, live NodeRuntime, and physical WebSockets; no injected chat state. */
@RunWith(RobolectricTestRunner::class)
@Config(qualifiers = "w360dp-h800dp-420dpi")
class ChatFullMessageOwnershipLayoutTest {
  val composeRule = createComposeRule()

  // Finish Compose test scheduling and dispose UI consumers before joining runtime cleanup.
  @get:Rule
  val fixtureRules: RuleChain =
    RuleChain
      .outerRule(
        object : ExternalResource() {
          override fun after() {
            tearDown()
          }
        },
      ).around(composeRule)

  private lateinit var app: NodeApp
  private lateinit var runtime: NodeRuntime
  private lateinit var model: MainViewModel
  private lateinit var gateway: FullMessageGateway
  private var previousRuntime: NodeRuntime? = null
  private var restoreAnimatorScale: (() -> Unit)? = null
  private val models = ViewModelStore()

  @Before
  fun setUp() {
    app = RuntimeEnvironment.getApplication() as NodeApp
    previousRuntime = app.peekRuntime()
    val resolver = app.contentResolver
    val originalScale = Settings.Global.getString(resolver, Settings.Global.ANIMATOR_DURATION_SCALE)
    restoreAnimatorScale = {
      Settings.Global.putString(resolver, Settings.Global.ANIMATOR_DURATION_SCALE, originalScale)
      assertEquals(originalScale, Settings.Global.getString(resolver, Settings.Global.ANIMATOR_DURATION_SCALE))
    }
    Settings.Global.putFloat(resolver, Settings.Global.ANIMATOR_DURATION_SCALE, 0f)
    gateway = FullMessageGateway()
    val prefs = SecurePrefs(app, app.getSharedPreferences("full-message-${UUID.randomUUID()}", Context.MODE_PRIVATE))
    prefs.setManualTls(false)
    prefs.saveGatewayCredentials(gateway.endpoint.stableId, token = "synthetic-full-message-proof")
    runtime = NodeRuntime(app, prefs)
    bindRuntime(runtime)
    model = MainViewModel(app, prefs, SavedStateHandle())
    models.put("chat", model)
    model.setForeground(true)
    composeRule.setContent {
      ClawDesignTheme {
        Box(Modifier.size(width = 360.dp, height = 800.dp).clipToBounds()) {
          ChatScreen(
            viewModel = model,
            talkActive = false,
            showSidebarButton = true,
            onOpenSidebar = {},
            onToggleTalk = {},
            onOpenDashboard = {},
            onOpenGatewaySettings = {},
          )
        }
      }
    }
    composeRule.runOnIdle { runtime.connect(gateway.endpoint) }
    composeRule.waitUntil(FULL_MESSAGE_READY_TIMEOUT_MS) {
      runtime.gatewayConnectionDisplay.value.isConnected &&
        runtime.serverName.value == "full-message-${gateway.operatorConnection.get()}"
    }
    selectChat(FULL_MESSAGE_FIRST_CHAT)
  }

  fun tearDown() {
    try {
      models.clear()
    } finally {
      try {
        if (::runtime.isInitialized) closeNodeRuntimeTestFixture(runtime)
      } finally {
        try {
          if (::app.isInitialized) bindRuntime(previousRuntime)
        } finally {
          try {
            if (::gateway.isInitialized) gateway.close()
          } finally {
            restoreAnimatorScale?.invoke()
          }
        }
      }
    }
  }

  @Test
  fun viewAllLoadsTheCompleteAnswerAndCloseRestoresThePreview() {
    assertTrue(
      "Gateway-capped assistant answers must expose View all",
      composeRule.onAllNodes(hasText("View all") and hasClickAction()).fetchSemanticsNodes().isNotEmpty(),
    )
    viewAll().assertIsDisplayed().assertIsEnabled().performClick()
    composeRule.waitUntil(FULL_MESSAGE_READY_TIMEOUT_MS) { gateway.fullReads.isNotEmpty() }
    assertEquals(listOf(expectedRequest()), gateway.fullReads.toList())
    awaitInlineExpanded()
    composeRule
      .onNodeWithText("Show less")
      .performScrollTo()
      .assertIsDisplayed()
      .performClick()
    assertInlineCollapsed()
    viewAll().assertIsDisplayed().performClick()
    awaitInlineExpanded()
    assertEquals("Re-expansion reuses the loaded entry", 1, gateway.fullReads.size)
  }

  @Test
  fun stableMarkerlessPreviewCanRecoverTheCanonicalAnswer() {
    gateway.emitTruncationMarker = false
    listOf(false, true).forEachIndexed { index, blocks ->
      gateway.contentAsBlocks = blocks
      if (index == 0) refreshSelectedChat() else selectChat(FULL_MESSAGE_SECOND_CHAT)
      viewAll().assertIsDisplayed().assertIsEnabled().performClick()
      awaitExpanded()
      assertEquals(expectedRequest(), gateway.fullReads.last())
      assertEquals(index + 1, gateway.fullReads.size)
      composeRule.onNodeWithText("Show less").performScrollTo().performClick()
      assertExpandedTextAbsent()
    }
  }

  @Test
  fun markerLikeCompleteRepliesDoNotOfferCanonicalRecovery() {
    gateway.emitTruncationMarker = false
    val suffix = "\n...(truncated)..."
    val cases = listOf("short$suffix", "x".repeat(7_999) + suffix, "x".repeat(8_001) + suffix, "x".repeat(8_000) + suffix + " continued")
    cases.forEach { text ->
      gateway.historyTextOverride = text
      refreshSelectedChat()
      viewAll().assertDoesNotExist()
      assertFalse(
        runtime.chatMessages.value
          .single()
          .truncated,
      )
    }
    assertTrue(gateway.fullReads.isEmpty())
  }

  @Test
  fun producerTruncationFactsRecoverRepliesAtASurrogateBoundary() {
    val prefix = "x".repeat(7_999)
    val suffix = "\n...(truncated)..."
    val complete = prefix + "😀 The actual ending."
    val response = gateway.fullResponse(FULL_MESSAGE_FIRST_CHAT)
    val message = response.getValue("message").jsonObject
    gateway.fullResponseOverride = JsonObject(response + ("message" to JsonObject(message + ("content" to JsonPrimitive(complete)))))
    listOf(false, true).forEachIndexed { index, structural ->
      gateway.emitTruncationMarker = structural
      // Released raw slicing retains one high surrogate; current safe slicing drops it
      // but records truncated=true. A markerless 8,017-unit literal stays a negative above.
      gateway.historyTextOverride = prefix + (if (structural) "" else "\uD83D") + suffix
      refreshSelectedChat()
      viewAll().assertIsDisplayed().assertIsEnabled().performClick()
      awaitExpanded(complete)
      assertEquals(index + 1, gateway.fullReads.size)
      composeRule.onNodeWithText("Show less").performScrollTo().performClick()
      assertExpandedTextAbsent(complete.takeLast(128))
    }
  }

  @Test
  fun messageToolMirrorKeepsItsPreviewWithoutCanonicalRecovery() {
    for (marker in listOf("openclawMessageToolMirror", "openclawStreamFallback")) {
      gateway.historySyntheticMarker = marker
      gateway.historyMessageToolMirror = true
      refreshSelectedChat()
      assertEquals(
        FULL_MESSAGE_ENTRY,
        runtime.chatMessages.value
          .single()
          .entryId,
      )
      viewAll().assertDoesNotExist()
      assertNull(runtime.prepareFullMessageRead(currentOwner(), runtime.chatSelectionGeneration.value, runtime.gatewayCatalogRevision.value, runtime.chatMessages.value.single()))
      assertTrue(gateway.fullReads.isEmpty())
    }
  }

  @Test
  fun preparedReadCannotDispatchAfterItsPreviewBecomesAMessageToolMirror() {
    val prepared = prepareCurrentRead()
    gateway.historyMessageToolMirror = true
    refreshSelectedChat()
    runBlocking { prepared.execute() }
    assertEquals("A borrowed transcript ID must not authorize a canonical read", emptyList<FullMessageRead>(), gateway.fullReads.toList())
    assertEquals(ChatFullMessageState.Loading, prepared.state.value)
    viewAll().assertDoesNotExist()
  }

  @Test
  fun loadedReaderRetiresWhenItsPreviewBecomesAMessageToolMirror() {
    for (marker in listOf("openclawMessageToolMirror", "openclawStreamFallback")) {
      if (marker == "openclawStreamFallback") selectChat(FULL_MESSAGE_SECOND_CHAT)
      val before = gateway.fullReads.size
      gateway.historySyntheticMarker = marker
      viewAll().performClick()
      awaitExpanded()
      gateway.historyMessageToolMirror = true
      refreshSelectedChat()
      assertExpandedTextAbsent()
      composeRule.onNodeWithText("Show less").assertDoesNotExist()
      viewAll().assertDoesNotExist()
      assertEquals(before + 1, gateway.fullReads.size)
      gateway.historyMessageToolMirror = false
      refreshSelectedChat()
      viewAll().assertIsDisplayed().performClick()
      awaitExpanded()
      assertEquals("Restoring a canonical row must not revive its retired cache", before + 2, gateway.fullReads.size)
      composeRule
        .onNodeWithText("Show less")
        .performScrollTo()
        .assertIsDisplayed()
        .performClick()
    }
  }

  @Test
  fun inFlightResponseCannotPublishAfterItsPreviewBecomesAMessageToolMirror() =
    runBlocking {
      val selection = runtime.chatSelectionGeneration.value
      val catalog = runtime.gatewayCatalogRevision.value
      val connection = gateway.operatorConnection.get()
      gateway.holdFullResponses = true
      val oldRead = prepareCurrentRead()
      val pending = async(Dispatchers.IO) { oldRead.execute() }
      try {
        withTimeout(FULL_MESSAGE_READY_TIMEOUT_MS) { gateway.heldResponses.first { it.isNotEmpty() } }
        gateway.historyMessageToolMirror = true
        refreshSelectedChat()
        assertEquals(selection, runtime.chatSelectionGeneration.value)
        assertEquals(catalog, runtime.gatewayCatalogRevision.value)
        assertEquals(connection, gateway.operatorConnection.get())
        assertEquals(
          FULL_MESSAGE_ENTRY,
          runtime.chatMessages.value
            .single()
            .entryId,
        )
        gateway.releaseFullResponses()
        withTimeout(FULL_MESSAGE_READY_TIMEOUT_MS) { pending.await() }
        val retiredResult = oldRead.state.value

        gateway.historyMessageToolMirror = false
        refreshSelectedChat()
        val current = prepareCurrentRead()
        current.execute()
        assertEquals(gateway.fullText(FULL_MESSAGE_FIRST_CHAT), loadedText(current.state.value))
        assertEquals(listOf(expectedRequest(), expectedRequest()), gateway.fullReads.toList())
        assertEquals("Mirror provenance must retire publication even when the selection and socket remain current", ChatFullMessageState.Loading, retiredResult)
      } finally {
        gateway.releaseFullResponses()
        pending.cancelAndJoin()
      }
    }

  @Test
  fun retainedLoadedDisclosureCannotReopenAfterMirrorRefreshBeforeRecomposition() {
    viewAll().assertIsDisplayed().assertIsEnabled().performClick()
    awaitExpanded()
    composeRule
      .onNodeWithText("Show less")
      .performScrollTo()
      .assertIsDisplayed()
      .performClick()
    assertExpandedTextAbsent()
    val oldAction =
      checkNotNull(
        viewAll()
          .assertIsDisplayed()
          .assertIsEnabled()
          .fetchSemanticsNode()
          .config[SemanticsActions.OnClick]
          .action,
      )
    val selection = runtime.chatSelectionGeneration.value
    val catalog = runtime.gatewayCatalogRevision.value
    val connection = gateway.operatorConnection.get()
    val previousHistoryCount = gateway.historyReads.value.size
    gateway.historyMessageToolMirror = true
    composeRule.runOnIdle {
      // Refresh commits on runtime IO while Main remains occupied, as in the existing
      // retained-action tests. Do not pump Compose before replaying the old callback.
      model.refreshChat()
      awaitRuntimeReady(FULL_MESSAGE_FIRST_CHAT)
      assertTrue(
        gateway.historyReads.value
          .drop(previousHistoryCount)
          .contains(connection to FULL_MESSAGE_FIRST_CHAT),
      )
      assertEquals(selection, runtime.chatSelectionGeneration.value)
      assertEquals(catalog, runtime.gatewayCatalogRevision.value)
      assertEquals(connection, gateway.operatorConnection.get())
      assertEquals(
        FULL_MESSAGE_ENTRY,
        runtime.chatMessages.value
          .single()
          .entryId,
      )
      assertTrue(oldAction())
    }
    composeRule.waitForIdle()
    assertExpandedTextAbsent()
    composeRule.onNodeWithText("Show less").assertDoesNotExist()
    viewAll().assertDoesNotExist()
    // A subsequent same-socket history response orders the absence check.
    refreshSelectedChat()
    assertEquals(listOf(expectedRequest()), gateway.fullReads.toList())

    gateway.historyMessageToolMirror = false
    refreshSelectedChat()
    viewAll().assertIsDisplayed().assertIsEnabled().performClick()
    awaitExpanded()
    assertEquals("A fresh canonical row must request again rather than revive the retired cache", listOf(expectedRequest(), expectedRequest()), gateway.fullReads.toList())
    composeRule
      .onNodeWithText("Show less")
      .performScrollTo()
      .assertIsDisplayed()
      .performClick()
    assertExpandedTextAbsent()
  }

  @Test
  fun stableFullResponseUsesItsOwnCapInsteadOfTheHistoryCap() =
    runBlocking {
      gateway.emitTruncationMarker = false
      val response = gateway.fullResponse(FULL_MESSAGE_FIRST_CHAT)
      val message = response.getValue("message").jsonObject
      val suffix = "\n...(truncated)..."
      for (blocks in listOf(false, true)) {
        for (cap in listOf(8_000, 1_000_000)) {
          val text = "x".repeat(cap) + suffix
          val content =
            if (blocks) {
              JsonArray(
                listOf(
                  buildJsonObject {
                    put("type", JsonPrimitive("text"))
                    put("text", JsonPrimitive(text))
                  },
                ),
              )
            } else {
              JsonPrimitive(text)
            }
          gateway.fullResponseOverride = JsonObject(response + ("message" to JsonObject(message + ("content" to content))))
          val read = prepareCurrentRead()
          read.execute()
          if (cap == 8_000) {
            assertEquals("A complete reply can literally end in the old history sentinel", text, loadedText(read.state.value))
          } else {
            assertTrue("A markerless retrieval capped at its requested limit must remain unavailable", read.state.value == ChatFullMessageState.Unavailable(ChatFullMessageUnavailable.TooLarge))
          }
        }
      }
    }

  @Test
  @Config(sdk = [36])
  @GraphicsMode(GraphicsMode.Mode.NATIVE)
  fun viewAllKeepsTheTailReachableForALargeSingleTextField() {
    val graphicsMode = ConfigurationRegistry.get(GraphicsMode.Mode::class.java)
    println("FULL_MESSAGE_BOUNDARY engine=$graphicsMode api=${RuntimeEnvironment.getApiLevel()}")
    assertEquals(GraphicsMode.Mode.NATIVE, graphicsMode)
    assertEquals(36, RuntimeEnvironment.getApiLevel())
    val normalRequest = expectedRequest()
    val clipboard = app.getSystemService(Context.CLIPBOARD_SERVICE) as ClipboardManager
    var phase = "normal-size-control"
    try {
      val normalText = gateway.fullText(FULL_MESSAGE_FIRST_CHAT)
      assertEquals(9_656, normalText.length)
      viewAll().assertIsDisplayed().assertIsEnabled().performClick()
      awaitInlineExpanded()
      openMessageActions()
      composeRule.onNodeWithText("Copy").performClick()
      assertEquals(
        normalText,
        clipboard.primaryClip
          ?.getItemAt(0)
          ?.text
          ?.toString(),
      )
      assertEquals(listOf(normalRequest), gateway.fullReads.toList())
      composeRule
        .onNodeWithText("Show less")
        .performScrollTo()
        .assertIsEnabled()
        .performClick()
      assertInlineCollapsed()
      viewAll().assertIsDisplayed()
      println("FULL_MESSAGE_BOUNDARY normalSizeControl=passed utf16=9656")
      selectChat(FULL_MESSAGE_SECOND_CHAT)

      val tail = "UPPER_BOUND_TAIL"
      val code = "x\n".repeat(400_000) + tail
      val fullText =
        gateway.fullText(FULL_MESSAGE_SECOND_CHAT).removeSuffix("\n\n$FULL_MESSAGE_TAIL") +
          "\n\n```\n" + code + "\n```"
      assertEquals(800_016, code.length)
      assertEquals(400_001, code.lineSequence().count())
      assertEquals(809_650, fullText.length)
      assertEquals(400_006, fullText.lineSequence().count())
      assertTrue("The single text field is below the existing producer limit", fullText.length < 1_000_000)
      assertEquals(gateway.preview(FULL_MESSAGE_SECOND_CHAT), fullText.take(8_000) + "\n...(truncated)...")
      val response = gateway.fullResponse(FULL_MESSAGE_SECOND_CHAT)
      val message = response.getValue("message").jsonObject
      gateway.fullResponseOverride =
        JsonObject(response + ("message" to JsonObject(message + ("content" to JsonPrimitive(fullText)))))
      phase = "open-large-inline"
      viewAll().assertIsDisplayed().assertIsEnabled().performClick()
      showEndOfCode()
      awaitInlineExpanded(tail, fullText)
      assertInlineTailDisplayed(tail)
      assertEquals(listOf(normalRequest, expectedRequest()), gateway.fullReads.toList())
      phase = "complete-buffer-copy"
      openMessageActions()
      composeRule.onNodeWithText("Copy").performClick()
      assertEquals(
        "Inline actions must retain the entire answer, including its markdown fences",
        fullText,
        clipboard.primaryClip
          ?.getItemAt(0)
          ?.text
          ?.toString(),
      )
      phase = "collapse-large"
      composeRule.onNodeWithText("Show less", useUnmergedTree = true).performScrollTo().assertIsDisplayed()
      composeRule
        .onNodeWithText("Show less")
        .assertIsDisplayed()
        .assertIsEnabled()
        .performClick()
      assertInlineCollapsed(tail)
      viewAll().assertIsDisplayed()
      assertEquals(
        gateway.preview(FULL_MESSAGE_SECOND_CHAT),
        runtime.chatMessages.value
          .single()
          .content
          .single()
          .text,
      )
      assertEquals(2, gateway.fullReads.size)
      viewAll().assertIsDisplayed().assertIsEnabled().performClick()
      showEndOfCode()
      awaitInlineExpanded(tail, fullText)
      assertInlineTailDisplayed(tail)
      assertEquals("Reopening preserves the complete loaded answer without refetching", 2, gateway.fullReads.size)
      composeRule.onNodeWithText("Show less", useUnmergedTree = true).performScrollTo().assertIsDisplayed()
      composeRule
        .onNodeWithText("Show less")
        .assertIsDisplayed()
        .assertIsEnabled()
        .performClick()
      assertInlineCollapsed(tail)
      phase = "complete"
    } finally {
      clipboard.clearPrimaryClip()
      println("FULL_MESSAGE_BOUNDARY targetUtf16=809650 codeLines=400001 phase=$phase fullReads=${gateway.fullReads.size}")
    }
  }

  @Test
  fun readerPagesPreserveEveryCharacterWithinTheNativeAllocationBound() {
    val cap = 16_384
    val oversizedCombining = "a" + "\u0301".repeat(cap)
    val oversizedEmoji = "😀" + "\u200D😀".repeat(6_000)
    val cases =
      listOf(
        "empty" to listOf(""),
        "below cap" to listOf("a".repeat(cap - 1)),
        "at cap" to listOf("a".repeat(cap)),
        "above cap" to listOf("a".repeat(cap), "b"),
        "multiple pages" to listOf("a".repeat(cap), "b".repeat(cap), "c"),
        "surrogate pair at cap" to listOf("a".repeat(cap - 1), "😀z"),
        "combining character at cap" to listOf("a".repeat(cap - 1), "e\u0301z"),
        "emoji joiner at cap" to listOf("a".repeat(cap - 1), "👩\u200D💻z"),
        "RTL text" to listOf("אב".repeat(cap / 2), "مرحبا"),
        "CRLF at cap" to listOf("a".repeat(cap - 1), "\r\nend\n"),
        "oversized combining cluster" to listOf(oversizedCombining.substring(0, cap), oversizedCombining.substring(cap)),
        "oversized emoji cluster" to listOf(oversizedEmoji.substring(0, cap - 1), oversizedEmoji.substring(cap - 1)),
      )
    cases.forEach { (label, expectedPages) ->
      val text = expectedPages.joinToString("")
      val ranges = chatTextLayoutRanges(text)
      assertEquals(label, expectedPages, ranges.map { text.substring(it) })
      var nextOffset = 0
      val stitched = StringBuilder()
      ranges.forEach { range ->
        assertEquals("$label: pages must neither overlap nor skip characters", nextOffset, range.first)
        val end = range.last + 1
        assertTrue("$label: the native allocation cap applies even to an oversized grapheme", end - range.first <= cap)
        assertTrue("$label: only empty input has an empty page", text.isEmpty() || end > range.first)
        if (end in 1 until text.length) {
          assertFalse("$label: never split a UTF-16 surrogate pair", text[end - 1].isHighSurrogate() && text[end].isLowSurrogate())
        }
        stitched.append(text.substring(range))
        nextOffset = end
      }
      assertEquals(label, text.length, nextOffset)
      assertEquals(label, text, stitched.toString())
    }
  }

  @Test
  fun backDismissesTheNativeReaderAndReopeningUsesTheLoadedEntry() {
    viewAll().assertIsDisplayed().assertIsEnabled().performClick()
    awaitExpanded()
    composeRule.runOnIdle {
      val owner = WindowInspector.getGlobalWindowViews().firstNotNullOfOrNull { it.findViewTreeOnBackPressedDispatcherOwner() }
      checkNotNull(owner).onBackPressedDispatcher.onBackPressed()
    }
    assertInlineCollapsed()
    viewAll().assertIsDisplayed().assertIsEnabled().performClick()
    awaitExpanded()
    assertEquals("Back must not discard the completed read", listOf(expectedRequest()), gateway.fullReads.toList())
  }

  @Test
  fun backgroundHistoryUpdatesDoNotDismissOpenReader() {
    val fullText = gateway.fullText(FULL_MESSAGE_FIRST_CHAT)
    val request = expectedRequest()
    viewAll().assertIsDisplayed().assertIsEnabled().performClick()
    awaitExpanded(fullText)
    appendBackgroundHistoryAndShowLatest()
    scrollToOriginalMessage()
    awaitExpanded(fullText)
    assertEquals("Background history must not replace or reload the open reader", listOf(request), gateway.fullReads.toList())
    composeRule
      .onNodeWithText("Show less")
      .performScrollTo()
      .assertIsDisplayed()
      .performClick()
    assertExpandedTextAbsent()
  }

  @Test
  fun pendingFullReadSurvivesItsPreviewRowLeavingTheViewport() {
    val request = expectedRequest()
    val owner = currentOwner()
    val selection = runtime.chatSelectionGeneration.value
    val catalog = runtime.gatewayCatalogRevision.value
    val preview = runtime.chatMessages.value.single()
    gateway.holdFullResponses = true
    try {
      viewAll().assertIsDisplayed().assertIsEnabled().performClick()
      composeRule.onNodeWithText("Loading full message…").assertIsDisplayed()
      runBlocking { withTimeout(FULL_MESSAGE_READY_TIMEOUT_MS) { gateway.heldResponses.first { it.isNotEmpty() } } }
      appendBackgroundHistoryAndShowLatest()
      assertEquals(owner, currentOwner())
      assertEquals(selection, runtime.chatSelectionGeneration.value)
      assertEquals(catalog, runtime.gatewayCatalogRevision.value)
      assertEquals(preview, runtime.chatMessages.value.first())
      composeRule.onNode(hasText("...(truncated)...", substring = true)).assertDoesNotExist()
      assertExpandedTextAbsent()

      gateway.releaseFullResponses()
      scrollToOriginalMessage()
      awaitExpanded()
      assertEquals("The original pending read must complete without another click or request", listOf(request), gateway.fullReads.toList())
      composeRule
        .onNodeWithText("Show less")
        .performScrollTo()
        .assertIsDisplayed()
        .assertIsEnabled()
        .performClick()
      assertExpandedTextAbsent()
    } finally {
      gateway.releaseFullResponses()
    }
  }

  @Test
  fun readingInsideExpandedCodePausesFollowingUntilJumpToLatest() {
    val code = (0 until 700).joinToString("\n") { "Code line $it: keep this reading position." }
    val full = "```\n$code\n```"
    val response = gateway.fullResponse(FULL_MESSAGE_FIRST_CHAT)
    val message = response.getValue("message").jsonObject
    gateway.fullResponseOverride = JsonObject(response + ("message" to JsonObject(message + ("content" to JsonPrimitive(full)))))
    gateway.historyTextOverride = full.take(8_000) + "\n...(truncated)..."
    gateway.historyAppendRole = "assistant"
    refreshSelectedChat()
    val preview = runtime.chatMessages.value.single()
    val selection = runtime.chatSelectionGeneration.value
    val catalog = runtime.gatewayCatalogRevision.value
    viewAll().assertIsDisplayed().assertIsEnabled().performClick()
    composeRule.waitUntil(FULL_MESSAGE_READY_TIMEOUT_MS) {
      gateway.fullReads.size == 1 && composeRule.onAllNodes(hasText("Loading full message…")).fetchSemanticsNodes().isEmpty()
    }
    composeRule.onNodeWithText("Show less").assertIsDisplayed()
    composeRule.onNode(isDialog()).assertDoesNotExist()
    composeRule.onNode(hasContentDescription("OpenClaw")).performSemanticsAction(SemanticsActions.OnLongClick) { it() }
    composeRule.onNodeWithText("Copy").performClick()
    val clipboard = app.getSystemService(Context.CLIPBOARD_SERVICE) as ClipboardManager
    assertEquals(
      "The gesture must read the full answer, not its capped history",
      full,
      clipboard.primaryClip
        ?.getItemAt(0)
        ?.text
        ?.toString(),
    )
    val insideMessage = hasAnyAncestor(hasContentDescription("OpenClaw"))
    val codeViewport = composeRule.onNode(hasScrollToNodeAction() and insideMessage, useUnmergedTree = true)
    val transcript = composeRule.onNode(hasScrollToNodeAction() and insideMessage.not(), useUnmergedTree = true)
    val jump = composeRule.onNode(hasContentDescription("Jump to latest") and hasClickAction())

    fun appendAssistant(count: Int) {
      val before = gateway.historyReads.value.size
      gateway.historyAppendCount = count
      composeRule.runOnIdle { model.refreshChat() }
      composeRule.waitUntil(FULL_MESSAGE_READY_TIMEOUT_MS) {
        shadowOf(Looper.getMainLooper()).idle()
        gateway.historyReads.value.size > before && !model.chatHistoryLoading.value && model.chatHealthOk.value && model.chatMessages.value.size == count + 1
      }
      composeRule.waitForIdle()
      assertEquals(preview, runtime.chatMessages.value.first())
      assertEquals(selection, runtime.chatSelectionGeneration.value)
      assertEquals(catalog, runtime.gatewayCatalogRevision.value)
      assertNull(model.chatError.value)
    }

    // Prove live-follow through consecutive updates, not an assumed Jump affordance after layout settles.
    appendAssistant(1)
    composeRule.onNodeWithText(gateway.backgroundText(0)).assertIsDisplayed()
    assertEquals("The first assistant update must settle at latest", 0f, transcript.fetchSemanticsNode().config[SemanticsProperties.VerticalScrollAxisRange].value(), 0f)
    appendAssistant(2)
    composeRule.onNodeWithText(gateway.backgroundText(1)).assertIsDisplayed()
    assertEquals("Following must bring the next update to latest without interaction", 0f, transcript.fetchSemanticsNode().config[SemanticsProperties.VerticalScrollAxisRange].value(), 0f)
    codeViewport.assertIsDisplayed()
    val initialCode = codeViewport.fetchSemanticsNode()
    assertEquals("The touch must stay inside the fully visible code viewport", initialCode.size.height.toFloat(), initialCode.boundsInRoot.height, 0.01f)
    val outerBefore = transcript.fetchSemanticsNode().config[SemanticsProperties.VerticalScrollAxisRange].value()
    assertEquals("Start in live-follow at the latest message", 0f, outerBefore, 0f)
    jump.assertDoesNotExist()
    val innerBefore = initialCode.config[SemanticsProperties.VerticalScrollAxisRange].value()
    codeViewport.performTouchInput { swipeUp(durationMillis = 500) }
    composeRule.waitForIdle()
    val reading = codeViewport.fetchSemanticsNode()
    val readingOffset = reading.config[SemanticsProperties.VerticalScrollAxisRange].value()
    assertTrue("The real touch must move within the code, not its outer transcript", readingOffset > innerBefore)
    assertEquals("The child must consume this gesture without moving the transcript", outerBefore, transcript.fetchSemanticsNode().config[SemanticsProperties.VerticalScrollAxisRange].value(), 0f)

    appendAssistant(3)
    codeViewport.assertIsDisplayed()
    val afterAppend = codeViewport.fetchSemanticsNode()
    assertEquals("New assistant output must preserve the code reading offset", readingOffset, afterAppend.config[SemanticsProperties.VerticalScrollAxisRange].value(), 0f)
    assertEquals("New assistant output must not pull the code out of its reading position", reading.positionInRoot.y, afterAppend.positionInRoot.y, 0.01f)
    jump.assertIsDisplayed().assertIsEnabled().performClick()
    composeRule.onNodeWithText(gateway.backgroundText(2)).assertIsDisplayed()
    jump.assertDoesNotExist()
    appendAssistant(4)
    composeRule.onNodeWithText(gateway.backgroundText(3)).assertIsDisplayed()
    jump.assertDoesNotExist()
    assertEquals("Reading and resuming live-follow must reuse the loaded canonical entry", listOf(expectedRequest()), gateway.fullReads.toList())
  }

  @Test
  fun retainedDisclosureCannotReadTheSameEntryIdInAnotherSession() {
    assertRetiredDisclosureCannotLoad("another session") {
      selectBeforeRecomposition(FULL_MESSAGE_SECOND_CHAT)
    }
  }

  @Test
  fun retainedDisclosureCannotReviveAfterSelectingAwayAndBack() {
    assertRetiredDisclosureCannotLoad("selection ABA") {
      selectBeforeRecomposition(FULL_MESSAGE_SECOND_CHAT)
      selectBeforeRecomposition(FULL_MESSAGE_FIRST_CHAT)
    }
  }

  @Test
  fun retainedDisclosureCannotReadThroughAReplacementConnection() {
    assertRetiredDisclosureCannotLoad("replacement connection", retire = ::replaceConnectionBeforeRecomposition)
  }

  @Test
  fun retainedLoadedDisclosureStaysCollapsedAfterSelectingAwayAndBack() {
    assertRetiredDisclosureCannotLoad("loaded selection ABA", preload = true) {
      selectBeforeRecomposition(FULL_MESSAGE_SECOND_CHAT)
      selectBeforeRecomposition(FULL_MESSAGE_FIRST_CHAT)
    }
  }

  @Test
  fun retainedLoadedDisclosureStaysCollapsedAfterConnectionReplacement() {
    assertRetiredDisclosureCannotLoad("loaded replacement connection", preload = true, retire = ::replaceConnectionBeforeRecomposition)
  }

  @Test
  fun preparedReadCannotDispatchAfterSelectionChanges() {
    assertPreparedReadRetired { selectChat(FULL_MESSAGE_SECOND_CHAT) }
  }

  @Test
  fun preparedReadCannotDispatchAfterSelectionReturnsToTheSameKey() {
    assertPreparedReadRetired {
      selectChat(FULL_MESSAGE_SECOND_CHAT)
      selectChat(FULL_MESSAGE_FIRST_CHAT)
    }
  }

  @Test
  fun preparedReadCannotDispatchThroughAReplacementSocket() {
    assertPreparedReadRetired {
      composeRule.runOnIdle { replaceConnectionBeforeRecomposition() }
    }
  }

  @Test
  fun replacementOperatorLeaseSurvivesTheRestOfGatewayRefresh() =
    runBlocking {
      val nodeSession =
        NodeRuntime::class.java
          .getDeclaredField("nodeSession")
          .apply { isAccessible = true }
          .get(runtime) as GatewaySession
      val nodeLifecycleLock =
        checkNotNull(
          GatewaySession::class.java
            .getDeclaredField("lifecycleLock")
            .apply { isAccessible = true }
            .get(nodeSession),
        )
      val acquired = CountDownLatch(1)
      val release = CountDownLatch(1)
      val previousConnection = gateway.operatorConnection.get()
      val heldNode =
        async(Dispatchers.IO) {
          synchronized(nodeLifecycleLock) {
            acquired.countDown()
            check(release.await(FULL_MESSAGE_READY_TIMEOUT_MS, TimeUnit.MILLISECONDS))
          }
        }
      val refresh =
        async(Dispatchers.IO) {
          check(acquired.await(FULL_MESSAGE_READY_TIMEOUT_MS, TimeUnit.MILLISECONDS))
          runtime.refreshGatewayConnection()
        }
      try {
        // Hold the second role's connect while the replacement operator finishes its
        // real hello. Finishing one refresh must not close that new connection again.
        val replacement =
          withTimeout(FULL_MESSAGE_READY_TIMEOUT_MS) {
            combine(gateway.historyReads, runtime.serverName) { reads, _ ->
              val lease = operatorSession().captureRequestLease(gateway.endpoint.stableId)
              val connection = gateway.operatorConnection.get()
              lease?.takeIf {
                connection > previousConnection &&
                  runtime.serverName.value == "full-message-$connection" &&
                  reads.any { it.first == connection && it.second == FULL_MESSAGE_FIRST_CHAT } &&
                  it.isCurrent()
              }
            }.first { it != null }
          }
        val current = prepareCurrentRead()
        release.countDown()
        heldNode.await()
        refresh.await()
        assertTrue("The refreshed operator must survive the later node-role connect", checkNotNull(replacement).isCurrent())
        current.execute()
        assertEquals(gateway.fullText(FULL_MESSAGE_FIRST_CHAT), loadedText(current.state.value))
      } finally {
        release.countDown()
        refresh.cancelAndJoin()
        heldNode.cancelAndJoin()
      }
    }

  @Test
  fun preparedReadSurvivesAnUnchangedRefreshButNotAChangedPreview() {
    val unchanged = prepareCurrentRead()
    refreshSelectedChat()
    runBlocking { unchanged.execute() }
    assertEquals(gateway.fullText(FULL_MESSAGE_FIRST_CHAT), loadedText(unchanged.state.value))

    val oldPreview = runtime.chatMessages.value.single()
    val changed = prepareCurrentRead()
    gateway.previewPrefix = "An edited answer. "
    refreshSelectedChat()
    assertNull(runtime.prepareFullMessageRead(currentOwner(), runtime.chatSelectionGeneration.value, runtime.gatewayCatalogRevision.value, oldPreview))
    runBlocking { changed.execute() }
    val current = prepareCurrentRead()
    runBlocking { current.execute() }
    assertEquals(gateway.fullText(FULL_MESSAGE_FIRST_CHAT), loadedText(current.state.value))
    assertEquals("Only the unchanged refresh and current edited entry may read", 2, gateway.fullReads.size)
    assertEquals(ChatFullMessageState.Loading, changed.state.value)
  }

  @Test
  fun anInFlightResponseCannotPublishIntoARetiredSelection() =
    runBlocking {
      gateway.holdFullResponses = true
      val oldRead = prepareCurrentRead()
      val pending = async(Dispatchers.IO) { oldRead.execute() }
      try {
        withTimeout(FULL_MESSAGE_READY_TIMEOUT_MS) { gateway.heldResponses.first { it.isNotEmpty() } }
        selectChat(FULL_MESSAGE_SECOND_CHAT)
        gateway.releaseFullResponses()
        withTimeout(FULL_MESSAGE_READY_TIMEOUT_MS) { pending.await() }
        assertEquals("Retired response must not publish even when its socket is still current", ChatFullMessageState.Loading, oldRead.state.value)
        val current = prepareCurrentRead()
        current.execute()
        assertEquals(gateway.fullText(FULL_MESSAGE_SECOND_CHAT), loadedText(current.state.value))
        assertEquals(listOf(FULL_MESSAGE_FIRST_CHAT, FULL_MESSAGE_SECOND_CHAT), gateway.fullReads.map { it.sessionKey })
      } finally {
        gateway.releaseFullResponses()
        pending.cancelAndJoin()
      }
    }

  @Test
  fun closingWhileLoadingCancelsPublicationAndAllowsARequestedRetry() {
    gateway.holdFullResponses = true
    viewAll().performClick()
    composeRule.onNodeWithText("Loading full message…").assertIsDisplayed()
    runBlocking { withTimeout(FULL_MESSAGE_READY_TIMEOUT_MS) { gateway.heldResponses.first { it.isNotEmpty() } } }
    composeRule.onNodeWithText("Show less").performScrollTo().performClick()
    assertExpandedTextAbsent()
    gateway.releaseFullResponses()
    viewAll().performClick()
    awaitExpanded()
    assertEquals("Closing does not cache the canceled response", 2, gateway.fullReads.size)
    composeRule
      .onNodeWithText("Show less")
      .performScrollTo()
      .assertIsDisplayed()
      .assertIsEnabled()
      .performClick()
    selectChat(FULL_MESSAGE_SECOND_CHAT)
    val writeLock =
      GatewaySession::class.java
        .getDeclaredField("writeLock")
        .apply { isAccessible = true }
        .get(operatorSession()) as Mutex
    val lockOwner = Any()
    val autoAdvance = composeRule.mainClock.autoAdvance
    try {
      runBlocking { withTimeout(FULL_MESSAGE_READY_TIMEOUT_MS) { writeLock.lock(lockOwner) } }
      val beforeClose = gateway.fullReads.toList()
      viewAll().assertIsDisplayed().assertIsEnabled().performClick()
      composeRule.onNodeWithText("Loading full message…").assertIsDisplayed()
      composeRule.mainClock.advanceTimeBy(0, ignoreFrameDuration = true)
      assertEquals("The held transport must prevent the pending read from enqueueing", beforeClose, gateway.fullReads.toList())
      val close =
        checkNotNull(
          composeRule
            .onNodeWithText("Show less")
            .assertIsDisplayed()
            .assertIsEnabled()
            .fetchSemanticsNode()
            .config[SemanticsActions.OnClick]
            .action,
        )
      composeRule.mainClock.autoAdvance = false
      val beforeFrame = composeRule.mainClock.currentTime
      composeRule.runOnUiThread {
        assertTrue(close())
        writeLock.unlock(lockOwner)
      }
      // Drain the unblocked coroutine before a recomposition can dispose its effect.
      composeRule.mainClock.advanceTimeBy(0, ignoreFrameDuration = true)
      assertEquals(beforeFrame, composeRule.mainClock.currentTime)
      val beforeHistory = gateway.historyReads.value.size
      val connection = gateway.operatorConnection.get()
      composeRule.runOnUiThread { model.refreshChat() }
      runBlocking {
        withTimeout(FULL_MESSAGE_READY_TIMEOUT_MS) {
          gateway.historyReads.first { it.drop(beforeHistory).contains(connection to FULL_MESSAGE_SECOND_CHAT) }
        }
      }
      val packetsBeforeFrame = gateway.fullReads.toList()
      assertEquals(beforeFrame, composeRule.mainClock.currentTime)
      composeRule.mainClock.autoAdvance = autoAdvance
      awaitRuntimeReady(FULL_MESSAGE_SECOND_CHAT)
      composeRule.waitForIdle()
      assertExpandedTextAbsent()
      viewAll().assertIsDisplayed().assertIsEnabled().performClick()
      awaitExpanded()
      assertEquals("Close must cancel the pending read before the next composition frame", beforeClose, packetsBeforeFrame)
      assertEquals("Only the fresh reopening may enqueue a read", beforeClose + expectedRequest(), gateway.fullReads.toList())
      composeRule
        .onNodeWithText("Show less")
        .performScrollTo()
        .assertIsDisplayed()
        .assertIsEnabled()
        .performClick()
      assertExpandedTextAbsent()
    } finally {
      if (writeLock.holdsLock(lockOwner)) writeLock.unlock(lockOwner)
      composeRule.mainClock.autoAdvance = autoAdvance
      gateway.releaseFullResponses()
    }
  }

  @Test
  fun unavailableAndStillCappedResponsesRemainVisibleWithoutPretendingToBeComplete() {
    val variants =
      listOf(
        "not_found" to "The full message is no longer available.",
        "not_visible" to "The full message is no longer available.",
        "oversized" to "The full message is too large to display.",
        "still-capped" to "The full message is too large to display.",
      )
    variants.forEachIndexed { index, (reason, expectedText) ->
      if (index > 0) selectChat(if (index % 2 == 0) FULL_MESSAGE_FIRST_CHAT else FULL_MESSAGE_SECOND_CHAT)
      gateway.fullResponseOverride =
        if (reason == "still-capped") {
          gateway.fullResponse(runtime.chatSessionKey.value, truncated = true)
        } else {
          buildJsonObject {
            put("ok", JsonPrimitive(false))
            put("unavailableReason", JsonPrimitive(reason))
          }
        }
      viewAll().performClick()
      composeRule.waitUntil(FULL_MESSAGE_READY_TIMEOUT_MS) { composeRule.onAllNodes(hasText(expectedText)).fetchSemanticsNodes().isNotEmpty() }
      composeRule.onNodeWithText(expectedText).assertIsDisplayed()
      assertExpandedTextAbsent()
      composeRule.onNodeWithText("Retry").assertDoesNotExist()
      composeRule.onNodeWithText("Show less").performScrollTo().performClick()
      assertEquals(index + 1, gateway.fullReads.size)
    }
  }

  @Test
  fun requestFailureKeepsThePreviewAndRetriesOnlyWhenRequested() {
    gateway.fullReadRpcError = true
    viewAll().performClick()
    composeRule.waitUntil(FULL_MESSAGE_READY_TIMEOUT_MS) {
      composeRule.onAllNodes(hasText("Retry") and hasClickAction()).fetchSemanticsNodes().isNotEmpty()
    }
    composeRule.onNodeWithText("The full message could not be loaded.").assertIsDisplayed()
    composeRule.onNode(hasText("...(truncated)...", substring = true)).assertExists()
    assertExpandedTextAbsent()
    assertEquals(listOf(expectedRequest()), gateway.fullReads.toList())
    gateway.fullReadRpcError = false
    composeRule.onNodeWithText("Retry").performClick()
    awaitExpanded()
    assertEquals(listOf(expectedRequest(), expectedRequest()), gateway.fullReads.toList())
    composeRule.onNodeWithText("Show less").performScrollTo().performClick()
    selectChat(FULL_MESSAGE_SECOND_CHAT)
    gateway.fullReadRpcError = true
    viewAll().performClick()
    composeRule.waitUntil(FULL_MESSAGE_READY_TIMEOUT_MS) {
      composeRule.onAllNodes(hasText("Retry") and hasClickAction()).fetchSemanticsNodes().isNotEmpty()
    }
    composeRule.onNodeWithText("The full message could not be loaded.").assertIsDisplayed()
    val retry =
      checkNotNull(
        composeRule
          .onNodeWithText("Retry")
          .assertIsDisplayed()
          .assertIsEnabled()
          .fetchSemanticsNode()
          .config[SemanticsActions.OnClick]
          .action,
      )
    val close =
      checkNotNull(
        composeRule
          .onNodeWithText("Show less")
          .assertIsDisplayed()
          .assertIsEnabled()
          .fetchSemanticsNode()
          .config[SemanticsActions.OnClick]
          .action,
      )
    gateway.fullReadRpcError = false
    gateway.holdFullResponses = true
    try {
      composeRule.runOnIdle {
        // Both visible actions can run before a new composition observes the retry's Loading state.
        assertTrue(retry())
        assertTrue(close())
      }
      composeRule.waitForIdle()
      assertExpandedTextAbsent()
      composeRule.onNodeWithText("Show less").assertDoesNotExist()
      viewAll().assertIsDisplayed().assertIsEnabled()
      refreshSelectedChat()
      val beforeReopen = gateway.fullReads.toList()
      viewAll().performClick()
      // Same-socket history orders this packet check without assuming whether cancellation
      // happened before the retry dispatched, or adding a sleep-based absence window.
      refreshSelectedChat()
      assertEquals("Close must discard the pending retry, so reopening requests a fresh read", beforeReopen + expectedRequest(), gateway.fullReads.toList())
      gateway.releaseFullResponses()
      awaitExpanded()
      composeRule
        .onNodeWithText("Show less")
        .performScrollTo()
        .assertIsDisplayed()
        .performClick()
      assertExpandedTextAbsent()
    } finally {
      gateway.releaseFullResponses()
    }
  }

  @Test
  fun fullResponsesRequireTheCanonicalAssistantEntryAndReadableText() {
    val valid = gateway.fullResponse(FULL_MESSAGE_FIRST_CHAT)
    val validMessage = valid.getValue("message").jsonObject
    val variants =
      listOf(
        JsonObject(emptyMap()),
        buildJsonObject {
          put("ok", JsonPrimitive(false))
          put("unavailableReason", JsonPrimitive("unknown-reason"))
        },
        JsonObject(valid + ("ok" to JsonPrimitive("true"))),
        JsonObject(valid + ("message" to JsonObject(validMessage + ("role" to JsonPrimitive("user"))))),
        JsonObject(valid + ("message" to JsonObject(validMessage + ("__openclaw" to buildJsonObject { put("id", JsonPrimitive("another-entry")) })))),
        JsonObject(valid + ("message" to JsonObject(validMessage + ("__openclaw" to buildJsonObject { put("id", JsonPrimitive(12)) })))),
        JsonObject(valid + ("message" to JsonObject(validMessage + ("content" to JsonPrimitive(""))))),
        JsonObject(valid + ("message" to JsonObject(validMessage + ("openclawMessageToolMirror" to buildJsonObject { put("toolName", JsonPrimitive("message")) })))),
        JsonObject(
          valid + (
            "message" to
              JsonObject(
                validMessage + (
                  "openclawStreamFallback" to
                    buildJsonObject {
                      put("source", JsonPrimitive("segment"))
                      put("itemId", JsonPrimitive("segment-qa"))
                    }
                ),
              )
          ),
        ),
      )
    variants.forEachIndexed { index, payload ->
      if (index > 0) selectChat(if (index % 2 == 0) FULL_MESSAGE_FIRST_CHAT else FULL_MESSAGE_SECOND_CHAT)
      gateway.fullResponseOverride = payload
      viewAll().assertIsDisplayed().performClick()
      composeRule.waitUntil(FULL_MESSAGE_READY_TIMEOUT_MS) {
        composeRule.onAllNodes(hasText("The full message could not be loaded.")).fetchSemanticsNodes().isNotEmpty()
      }
      assertExpandedTextAbsent()
      composeRule.onNode(hasText("...(truncated)...", substring = true)).assertExists()
      composeRule.onNodeWithText("Show less").performScrollTo().performClick()
      gateway.fullResponseOverride = null
      viewAll().assertIsDisplayed().performClick()
      composeRule.onNodeWithText("The full message could not be loaded.").assertIsDisplayed()
      assertEquals("Reopening a failure must not silently retry", index * 2 + 1, gateway.fullReads.size)
      composeRule
        .onNodeWithText("Retry")
        .assertIsDisplayed()
        .assertIsEnabled()
        .performClick()
      awaitExpanded()
      assertEquals("Only the explicit Retry may recover the canonical answer", index * 2 + 2, gateway.fullReads.size)
      composeRule.onNodeWithText("Show less").performScrollTo().performClick()
    }
  }

  @Test
  @Config(sdk = [36])
  @GraphicsMode(GraphicsMode.Mode.NATIVE)
  fun closingFullReaderPreservesPreviewActionsAndCachedReopening() {
    gateway.includeMedia = true
    refreshSelectedChat()
    val history = runtime.chatMessages.value.single()
    assertEquals(listOf("image", "text", "file", "text", "audio"), history.content.map { it.type })
    val full = gateway.fullText(FULL_MESSAGE_FIRST_CHAT) + "\n\n" + FULL_MESSAGE_MEDIA_TEXT
    val preview = gateway.preview(FULL_MESSAGE_FIRST_CHAT) + "\n\n" + FULL_MESSAGE_MEDIA_TEXT
    val clipboard = app.getSystemService(Context.CLIPBOARD_SERVICE) as ClipboardManager

    fun assertMediaOrder() {
      val labels = listOf(FULL_MESSAGE_IMAGE, FULL_MESSAGE_FIRST_CHAT, FULL_MESSAGE_FILE, FULL_MESSAGE_MEDIA_TEXT, FULL_MESSAGE_AUDIO)
      val tops =
        labels.map { label ->
          val matcher = hasText(label, substring = true) and hasAnyAncestor(hasContentDescription("OpenClaw"))
          composeRule.onAllNodes(matcher, useUnmergedTree = true).assertCountEquals(1)
          composeRule
            .onNode(matcher, useUnmergedTree = true)
            .fetchSemanticsNode()
            .positionInRoot.y
        }
      assertTrue("Expansion must preserve image/text/file/text/history-audio order without duplicates", tops.all { it.isFinite() } && tops.zipWithNext().all { (before, after) -> before < after })
      composeRule.onAllNodes(hasContentDescription("Play audio") and hasClickAction()).assertCountEquals(1)
      labels.forEach { label ->
        composeRule.onNode(hasText(label, substring = true) and hasAnyAncestor(hasContentDescription("OpenClaw")), useUnmergedTree = true).performScrollTo().assertIsDisplayed()
      }
    }

    fun assertActions(text: String) {
      // Reply prepends to an existing draft; exercise each content state independently.
      composeRule.onNode(hasSetTextAction()).performTextClearance()
      openMessageActions()
      composeRule.onNodeWithText("Copy").performClick()
      assertEquals(
        text,
        clipboard.primaryClip
          ?.getItemAt(0)
          ?.text
          ?.toString(),
      )
      val beforeSpeech = gateway.speechReads.value.size
      openMessageActions()
      composeRule.onNodeWithText("Listen").performClick()
      runBlocking { withTimeout(FULL_MESSAGE_READY_TIMEOUT_MS) { gateway.speechReads.first { it.size > beforeSpeech } } }
      assertEquals(text, gateway.speechReads.value.last())
      composeRule.runOnIdle { model.stopChatMessageSpeech() }
      openMessageActions()
      composeRule.onNodeWithText("Reply").performClick()
      val expectedReply = quoteChatMessage(text)
      composeRule.waitUntil(FULL_MESSAGE_READY_TIMEOUT_MS) {
        composeRule.onAllNodes(hasSetTextAction() and hasText(expectedReply)).fetchSemanticsNodes().isNotEmpty()
      }
      composeRule.onNode(hasSetTextAction() and hasText(expectedReply)).assertExists()
    }

    assertMediaOrder()
    viewAll().performScrollTo().assertIsDisplayed().performClick()
    awaitExpanded(full)
    assertMediaOrder()
    assertActions(full)
    openMessageActions()
    composeRule.onNodeWithText("Select text").performClick()
    awaitSelectionText(full)
    assertNativeTailAndSelection(full, FULL_MESSAGE_MEDIA_TEXT)
    composeRule.onNodeWithText("Done").performClick()
    composeRule.onNode(isDialog()).assertDoesNotExist()
    composeRule.runOnIdle { assertTrue(nativeReaders().isEmpty()) }
    awaitExpanded(full)
    composeRule.onNodeWithText("Show less").performScrollTo().performClick()
    assertInlineCollapsed()
    assertMediaOrder()
    assertActions(preview)
    assertExpandedTextAbsent()
    viewAll()
      .performScrollTo()
      .assertIsDisplayed()
      .assertIsEnabled()
      .performClick()
    awaitExpanded(full)
    assertMediaOrder()
    assertEquals("Full and preview actions plus cached reopening must not fetch again", 1, gateway.fullReads.size)
    composeRule.onNodeWithText("Show less").performScrollTo().performClick()
    assertInlineCollapsed()
    assertEquals(history, runtime.chatMessages.value.single())
  }

  @Test
  fun expandedOrdinaryUserMessageSurvivesAnUnchangedGatewayReconnect() {
    gateway.historyRole = "user"
    gateway.historyTruncated = false
    refreshSelectedChat()
    composeRule.onNode(hasText(FULL_MESSAGE_TAIL, substring = true)).assertDoesNotExist()
    viewAll().performClick()
    composeRule.waitUntil(FULL_MESSAGE_READY_TIMEOUT_MS) {
      composeRule.onAllNodes(hasText(FULL_MESSAGE_TAIL, substring = true)).fetchSemanticsNodes().isNotEmpty()
    }
    composeRule.onNodeWithText("Close").assertIsDisplayed()
    assertExpandedTextAbsent()
    composeRule.runOnIdle { replaceConnectionBeforeRecomposition() }
    composeRule.waitForIdle()
    composeRule.onNode(hasText(FULL_MESSAGE_TAIL, substring = true)).assertExists()
    composeRule.onNodeWithText("Close").assertExists()
    assertTrue("Local user expansion must not use full-message RPC", gateway.fullReads.isEmpty())
  }

  @Test
  fun disconnectedLivePreviewAsksToReconnectRatherThanUpdateTheGateway() {
    assertDisconnectedReaderSurvivesFailedReconnect()
  }

  @Test
  fun missingMethodCatalogStillRetiresOnReconnectAndDisconnect() {
    gateway.omitMethodCatalog = true
    composeRule.runOnIdle { replaceConnectionBeforeRecomposition() }
    composeRule.waitForIdle()
    viewAll().performClick()
    composeRule.onNodeWithText("Update the Gateway to load the full message.").assertIsDisplayed()
    val catalog = runtime.gatewayCatalogRevision.value
    composeRule.runOnIdle { replaceConnectionBeforeRecomposition() }
    composeRule.waitForIdle()
    assertTrue(runtime.gatewayCatalogRevision.value > catalog)
    composeRule.onNodeWithText("Show less").assertDoesNotExist()
    assertDisconnectedReaderSurvivesFailedReconnect()
  }

  private fun assertDisconnectedReaderSurvivesFailedReconnect() {
    val preview = runtime.chatMessages.value.single()
    val catalog = runtime.gatewayCatalogRevision.value
    gateway.disconnectOperatorAndRejectReconnects()
    composeRule.waitUntil(FULL_MESSAGE_READY_TIMEOUT_MS) {
      shadowOf(Looper.getMainLooper()).idle()
      gateway.rejectedConnections.isNotEmpty() &&
        !model.gatewayConnectionDisplay.value.isConnected &&
        runtime.gatewayCatalogRevision.value > catalog &&
        model.gatewayCatalogRevision.value == runtime.gatewayCatalogRevision.value &&
        model.chatSelectionGeneration.value == runtime.chatSelectionGeneration.value
    }
    assertEquals(preview, runtime.chatMessages.value.single())
    viewAll().assertIsDisplayed().assertIsEnabled()
    viewAll().performClick()
    composeRule.onNodeWithText("Reconnect to load the full message.").assertIsDisplayed()
    val attempts = gateway.rejectedConnections.size
    gateway.releaseRejectedConnection()
    composeRule.waitUntil(FULL_MESSAGE_READY_TIMEOUT_MS) {
      shadowOf(Looper.getMainLooper()).idle()
      gateway.rejectedConnections.size > attempts &&
        model.gatewayCatalogRevision.value == runtime.gatewayCatalogRevision.value
    }
    composeRule.onNodeWithText("Reconnect to load the full message.").assertIsDisplayed()
    composeRule.onNodeWithText("Update the Gateway to load the full message.").assertDoesNotExist()
    assertTrue(gateway.fullReads.isEmpty())
  }

  @Test
  fun connectedGatewayWithoutFullReadMethodHasAVisibleUpdateOutcome() {
    gateway.advertiseFullRead = false
    composeRule.runOnIdle { replaceConnectionBeforeRecomposition() }
    composeRule.waitForIdle()
    viewAll().performClick()
    composeRule.onNodeWithText("Update the Gateway to load the full message.").assertIsDisplayed()
    assertTrue(runtime.gatewayConnectionDisplay.value.isConnected)
    assertTrue(gateway.fullReads.isEmpty())
  }

  private fun openMessageActions() {
    composeRule
      .onNode(hasContentDescription("OpenClaw") and hasText("An ordinary paragraph", substring = true))
      .performSemanticsAction(SemanticsActions.OnLongClick) { it() }
  }

  private fun currentOwner() = ChatComposerOwner(gateway.endpoint.stableId, "main", runtime.chatSessionKey.value)

  private fun operatorSession(): GatewaySession =
    NodeRuntime::class.java
      .getDeclaredField("operatorSession")
      .apply { isAccessible = true }
      .get(runtime) as GatewaySession

  private fun prepareCurrentRead() =
    checkNotNull(
      runtime.prepareFullMessageRead(currentOwner(), runtime.chatSelectionGeneration.value, runtime.gatewayCatalogRevision.value, runtime.chatMessages.value.single()),
    )

  private fun loadedText(value: ChatFullMessageState) = chatMessagePlainText((value as ChatFullMessageState.Loaded).content)

  private fun assertPreparedReadRetired(retire: () -> Unit) {
    val old = prepareCurrentRead()
    retire()
    runBlocking { old.execute() }
    val current = prepareCurrentRead()
    runBlocking { current.execute() }
    assertEquals(gateway.fullText(runtime.chatSessionKey.value), loadedText(current.state.value))
    assertEquals("Only the fresh operation may dispatch after retirement", listOf(expectedRequest()), gateway.fullReads.toList())
    assertEquals(ChatFullMessageState.Loading, old.state.value)
  }

  private fun refreshSelectedChat() {
    val before = gateway.historyReads.value.size
    val key = runtime.chatSessionKey.value
    val connection = gateway.operatorConnection.get()
    composeRule.runOnIdle { model.refreshChat() }
    runBlocking {
      withTimeout(FULL_MESSAGE_READY_TIMEOUT_MS) {
        gateway.historyReads.first { it.drop(before).any { entry -> entry == (connection to key) } }
      }
    }
    awaitRuntimeReady(key)
    composeRule.waitForIdle()
  }

  private fun appendBackgroundHistoryAndShowLatest() {
    val before = gateway.historyReads.value.size
    val connection = gateway.operatorConnection.get()
    gateway.historyAppendCount = 40
    composeRule.runOnIdle { model.refreshChat() }
    composeRule.waitUntil(FULL_MESSAGE_READY_TIMEOUT_MS) {
      shadowOf(Looper.getMainLooper()).idle()
      gateway.historyReads.value
        .drop(before)
        .contains(connection to FULL_MESSAGE_FIRST_CHAT) &&
        !model.chatHistoryLoading.value &&
        model.chatHealthOk.value &&
        model.chatMessages.value.size == 41
    }
    composeRule.waitForIdle()
    assertNull(model.chatError.value)
    assertEquals(
      gateway.preview(FULL_MESSAGE_FIRST_CHAT),
      model.chatMessages.value
        .first()
        .content
        .single()
        .text,
    )
    composeRule.onNodeWithText(gateway.backgroundText(39)).assertIsDisplayed()
  }

  private fun replaceConnectionBeforeRecomposition() {
    val oldConnection = gateway.operatorConnection.get()
    val key = runtime.chatSessionKey.value
    val session = operatorSession()
    runtime.refreshGatewayConnection()
    runBlocking {
      withTimeout(FULL_MESSAGE_READY_TIMEOUT_MS) {
        // A server-side read is not proof that the replacement is still current.
        // Capturing its lease waits for hello publication without advancing Compose.
        combine(gateway.historyReads, runtime.serverName) { reads, _ ->
          val lease = session.captureRequestLease(gateway.endpoint.stableId)
          val connection = gateway.operatorConnection.get()
          connection > oldConnection &&
            runtime.serverName.value == "full-message-$connection" &&
            reads.any { it.first == connection && it.second == key } &&
            lease?.isCurrent() == true
        }.first { it }
      }
    }
    assertTrue(gateway.operatorConnection.get() > oldConnection)
    awaitRuntimeReady(key)
    assertEquals("full-message-${gateway.operatorConnection.get()}", runtime.serverName.value)
  }

  private fun assertRetiredDisclosureCannotLoad(
    retirement: String,
    preload: Boolean = false,
    retire: () -> Unit,
  ) {
    if (preload) {
      viewAll().performClick()
      awaitExpanded()
      composeRule.onNodeWithText("Show less").performScrollTo().performClick()
    }
    val priorReads = gateway.fullReads.toList()
    val oldAction =
      checkNotNull(
        viewAll()
          .assertIsDisplayed()
          .fetchSemanticsNode()
          .config[SemanticsActions.OnClick]
          .action,
      )
    composeRule.runOnIdle {
      // Runtime IO consumes the real replacement history while Main is occupied. Replay the
      // retained rendered callback before Compose can apply the changed owner (including ABA).
      retire()
      assertFalse(runtime.chatHistoryLoading.value)
      assertTrue(runtime.chatHealthOk.value)
      assertNull(runtime.chatError.value)
      oldAction()
    }
    composeRule.waitForIdle()
    assertExpandedTextAbsent()
    val previousHistoryCount = gateway.historyReads.value.size
    val currentConnection = gateway.operatorConnection.get()
    val currentSession = runtime.chatSessionKey.value
    composeRule.runOnIdle { model.refreshChat() }
    runBlocking {
      withTimeout(FULL_MESSAGE_READY_TIMEOUT_MS) {
        gateway.historyReads.first { reads ->
          reads.drop(previousHistoryCount).any { it.first == currentConnection && it.second == currentSession }
        }
      }
    }
    awaitRuntimeReady(currentSession)
    // The click has reached its first suspension before Main goes idle. A subsequent history
    // request on the same socket orders the packet check without a sleep-based absence window.
    assertEquals("Retained disclosure must enqueue zero reads after $retirement", priorReads, gateway.fullReads.toList())
    viewAll().assertIsDisplayed().assertIsEnabled().performClick()
    awaitExpanded()
    assertEquals("Only the current rendered action may enqueue a full-message read", priorReads + expectedRequest(), gateway.fullReads.toList())
  }

  private fun selectChat(key: String) {
    composeRule.runOnIdle { model.switchChatSession(key, ownerAgentId = "main") }
    try {
      composeRule.waitUntil(FULL_MESSAGE_READY_TIMEOUT_MS) {
        shadowOf(Looper.getMainLooper()).idle()
        model.chatSessionKey.value == key &&
          !model.chatHistoryLoading.value &&
          model.chatHealthOk.value &&
          model.chatMessages.value
            .singleOrNull()
            ?.content
            ?.firstOrNull { it.type == "text" }
            ?.text == gateway.historyText(key)
      }
    } catch (failure: Exception) {
      throw AssertionError(
        "Chat readiness for $key: runtime=${runtime.chatSessionKey.value}/${runtime.chatHistoryLoading.value}/${runtime.chatHealthOk.value}; " +
          "model=${model.chatSessionKey.value}/${model.chatHistoryLoading.value}/${model.chatHealthOk.value}; " +
          "rows=${runtime.chatMessages.value.size}/${model.chatMessages.value.size}; " +
          "textMatches=${runtime.chatMessages.value
            .singleOrNull()
            ?.content
            ?.firstOrNull { it.type == "text" }
            ?.text == gateway.historyText(key)}/" +
          "${model.chatMessages.value
            .singleOrNull()
            ?.content
            ?.firstOrNull { it.type == "text" }
            ?.text == gateway.historyText(key)}; " +
          "error=${runtime.chatError.value}/${model.chatError.value}; " +
          "connected=${runtime.gatewayConnectionDisplay.value.isConnected}; " +
          "history=${gateway.historyReads.value.takeLast(8)}",
        failure,
      )
    }
    composeRule.waitForIdle()
    assertTrue(model.chatHealthOk.value)
    assertNull(model.chatError.value)
  }

  private fun selectBeforeRecomposition(key: String) {
    model.switchChatSession(key, ownerAgentId = "main")
    awaitRuntimeReady(key)
    assertEquals(key, runtime.chatSessionKey.value)
  }

  private fun awaitRuntimeReady(key: String) {
    runBlocking {
      withTimeout(FULL_MESSAGE_READY_TIMEOUT_MS) {
        combine(runtime.chatMessages, runtime.chatHistoryLoading, runtime.chatHealthOk) { messages, loading, healthy ->
          !loading &&
            healthy &&
            messages
              .singleOrNull()
              ?.content
              ?.firstOrNull { it.type == "text" }
              ?.text == gateway.historyText(key)
        }.first { it }
      }
    }
    assertNull(runtime.chatError.value)
  }

  private fun awaitInlineExpanded(
    tail: String = FULL_MESSAGE_TAIL,
    expected: String = gateway.fullText(runtime.chatSessionKey.value),
  ) {
    assertTrue("View all must expand the transcript bubble without opening a dialog", composeRule.onAllNodes(isDialog()).fetchSemanticsNodes().isEmpty())
    val assistant = hasAnyAncestor(hasContentDescription("OpenClaw"))
    val firstParagraph = expected.substringBefore("\n\n").trimEnd()
    val inlineTail = hasText(tail, substring = true) and assistant
    composeRule.waitUntil(FULL_MESSAGE_READY_TIMEOUT_MS) {
      composeRule.onAllNodes(inlineTail, useUnmergedTree = true).fetchSemanticsNodes().isNotEmpty() &&
        composeRule.onAllNodes(hasText(firstParagraph, substring = true) and assistant, useUnmergedTree = true).fetchSemanticsNodes().isNotEmpty()
    }
    composeRule.onNode(hasText(firstParagraph, substring = true) and assistant, useUnmergedTree = true).assertExists()
    composeRule.onNode(inlineTail, useUnmergedTree = true).performScrollTo().assertIsDisplayed()
    composeRule.onNode(hasText("...(truncated)...", substring = true) and assistant, useUnmergedTree = true).assertDoesNotExist()
    composeRule.onNode(isDialog()).assertDoesNotExist()
  }

  private fun assertInlineCollapsed(tail: String = FULL_MESSAGE_TAIL) {
    composeRule.onNode(hasText(tail, substring = true) and hasAnyAncestor(hasContentDescription("OpenClaw")), useUnmergedTree = true).assertDoesNotExist()
    composeRule.onNode(hasText("...(truncated)...", substring = true) and hasAnyAncestor(hasContentDescription("OpenClaw")), useUnmergedTree = true).assertExists()
    composeRule.onNodeWithText("Show less").assertDoesNotExist()
    composeRule.onNode(isDialog()).assertDoesNotExist()
  }

  private fun awaitExpanded(expected: String = gateway.fullText(runtime.chatSessionKey.value)) {
    awaitInlineExpanded(tail = expected.lineSequence().last { it.isNotBlank() }.takeLast(128), expected = expected)
  }

  private fun assertInlineTailDisplayed(tail: String) {
    val target = composeRule.onNode(hasText(tail, substring = true) and hasAnyAncestor(hasContentDescription("OpenClaw")), useUnmergedTree = true)
    target.performScrollTo().assertIsDisplayed()
    val layouts = mutableListOf<TextLayoutResult>()
    target.performSemanticsAction(SemanticsActions.GetTextLayoutResult) { action -> assertTrue(action(layouts)) }
    val layout = layouts.single()
    val start =
      layout.layoutInput.text.text
        .lastIndexOf(tail)
    assertTrue("The rendered text layout must contain the requested ending", start >= 0)
    val node = target.fetchSemanticsNode()
    for (index in tail.indices) {
      if (tail[index].isWhitespace()) continue
      val glyph = layout.getBoundingBox(start + index).translate(node.positionInRoot)
      assertTrue("Ending glyph $index must have finite positive geometry", glyph.left.isFinite() && glyph.top.isFinite() && glyph.width > 0 && glyph.height > 0)
      assertTrue(
        "Ending glyph $index must be visible inside the transcript: $glyph vs ${node.boundsInRoot}",
        node.boundsInRoot.contains(glyph.topLeft) &&
          node.boundsInRoot.contains(
            glyph.bottomRight -
              androidx.compose.ui.geometry
                .Offset(0.01f, 0.01f),
          ),
      )
    }
  }

  private fun showEndOfCode() {
    val end = hasText("End of code") and hasClickAction()
    composeRule.waitUntil(FULL_MESSAGE_READY_TIMEOUT_MS) { composeRule.onAllNodes(end).fetchSemanticsNodes().isNotEmpty() }
    // A merged message can inherit the inner code scroller, which does not own this toolbar.
    composeRule.onNodeWithText("End of code", useUnmergedTree = true).performScrollTo().assertIsDisplayed()
    composeRule
      .onNode(end)
      .assertIsDisplayed()
      .assertIsEnabled()
      .performClick()
    // Bring the bounded code viewport into the transcript viewport using public scrolling.
    composeRule.onNode(hasScrollToNodeAction() and hasAnyAncestor(hasContentDescription("OpenClaw")), useUnmergedTree = true).performScrollTo().assertIsDisplayed()
  }

  private fun scrollToOriginalMessage() {
    composeRule.onNode(hasScrollToNodeAction()).performScrollToNode(hasContentDescription("OpenClaw") and hasText("An ordinary paragraph", substring = true))
  }

  private fun awaitSelectionText(expected: String) {
    composeRule.waitUntil(FULL_MESSAGE_READY_TIMEOUT_MS) {
      composeRule.runOnIdle {
        nativeReaders().singleOrNull()?.let { it.text.toString() == expected && it.isShown && it.width > 0 && it.height > 0 && !it.isLayoutRequested && it.layout != null } == true
      }
    }
    composeRule.onNode(isDialog()).assertExists()
    composeRule.onNodeWithText("Done").assertIsDisplayed()
    composeRule.runOnIdle {
      val reader = nativeReaders().single()
      assertEquals(expected, reader.text.toString())
      assertEquals(expected.length, reader.layout.getLineEnd(reader.layout.lineCount - 1))
    }
  }

  private fun nativeReaders(): List<TextView> {
    // Select text remains a native dialog; inspect its real buffer and every attached window.
    fun descendants(view: View): Sequence<View> =
      sequence {
        yield(view)
        if (view is ViewGroup) {
          for (index in 0 until view.childCount) yieldAll(descendants(view.getChildAt(index)))
        }
      }
    return WindowInspector
      .getGlobalWindowViews()
      .asSequence()
      .flatMap(::descendants)
      .filterIsInstance<TextView>()
      .filter { it.isTextSelectable && !it.onCheckIsTextEditor() }
      .toList()
  }

  private fun assertExpandedTextAbsent(tail: String = FULL_MESSAGE_TAIL) {
    composeRule.onNode(hasText(tail, substring = true) and hasAnyAncestor(hasContentDescription("OpenClaw")), useUnmergedTree = true).assertDoesNotExist()
    composeRule.onNode(isDialog()).assertDoesNotExist()
    composeRule.runOnIdle {
      assertTrue("No retired selection buffer may remain in an attached window", nativeReaders().isEmpty())
    }
  }

  private fun assertNativeTailAndSelection(
    expected: String,
    tail: String,
  ) {
    assertEquals(GraphicsMode.Mode.NATIVE, ConfigurationRegistry.get(GraphicsMode.Mode::class.java))
    composeRule.runOnIdle {
      val reader = nativeReaders().single()
      assertEquals(expected, reader.text.toString())
      assertTrue("Full text must have a bounded viewport", reader.height > 0 && reader.height < reader.resources.displayMetrics.heightPixels)
      val layout = checkNotNull(reader.layout)
      assertTrue("Full text must extend beyond its viewport", layout.height > reader.height)
      // Public native navigation, not a claim about a touch gesture or semantic-string visibility.
      reader.bringPointIntoView(expected.length)
    }
    composeRule.runOnIdle {
      val reader = nativeReaders().single()
      assertTrue("Native navigation must actually scroll", reader.scrollY > 0)
      val layout = checkNotNull(reader.layout)
      val start = expected.lastIndexOf(tail)
      assertTrue(start >= 0)
      val bounds = FloatArray(tail.length * 4)
      layout.fillCharacterBounds(start, start + tail.length, bounds, 0)
      val clip = Rect()
      val offset = Point()
      assertTrue(reader.isShown && reader.getGlobalVisibleRect(clip, offset))
      val viewportLeft = offset.x + reader.scrollX
      val viewportTop = offset.y + reader.scrollY
      assertTrue("The finite reader must be wholly on screen", clip.contains(viewportLeft, viewportTop, viewportLeft + reader.width, viewportTop + reader.height))
      val paddedClip =
        RectF(
          (viewportLeft + reader.totalPaddingLeft).toFloat(),
          (viewportTop + reader.totalPaddingTop).toFloat(),
          (viewportLeft + reader.width - reader.totalPaddingRight).toFloat(),
          (viewportTop + reader.height - reader.totalPaddingBottom).toFloat(),
        )
      assertTrue(paddedClip.intersect(RectF(clip)))
      for (index in tail.indices) {
        if (tail[index].isWhitespace()) continue
        val line = layout.getLineForOffset(start + index)
        assertTrue(layout.getLineStart(line) <= start + index && start + index < layout.getLineVisibleEnd(line))
        assertEquals(0, layout.getEllipsisCount(line))
        val base = index * 4
        val glyph =
          RectF(
            bounds[base] + reader.totalPaddingLeft + offset.x,
            bounds[base + 1] + reader.totalPaddingTop + offset.y,
            bounds[base + 2] + reader.totalPaddingLeft + offset.x,
            bounds[base + 3] + reader.totalPaddingTop + offset.y,
          )
        assertTrue((base until base + 4).all { bounds[it].isFinite() })
        assertTrue(glyph.width() > 0 && glyph.height() > 0)
        assertTrue("Tail glyph $index must be wholly inside $paddedClip, was $glyph", paddedClip.contains(glyph))
      }
      val clipboard = app.getSystemService(Context.CLIPBOARD_SERVICE) as ClipboardManager
      try {
        assertTrue(reader.onTextContextMenuItem(android.R.id.selectAll))
        assertEquals(0, minOf(reader.selectionStart, reader.selectionEnd))
        assertEquals(expected.length, maxOf(reader.selectionStart, reader.selectionEnd))
        assertTrue(reader.onTextContextMenuItem(android.R.id.copy))
        assertEquals(
          expected,
          clipboard.primaryClip
            ?.getItemAt(0)
            ?.text
            ?.toString(),
        )
        assertEquals(expected, reader.text.toString())
      } finally {
        clipboard.clearPrimaryClip()
      }
      println("FULL_MESSAGE_NATIVE utf16=${expected.length} viewport=${reader.width}x${reader.height} layoutHeight=${layout.height} scrollY=${reader.scrollY} tail=visible fullRangeCopy=Robolectric-shadow")
    }
  }

  private fun viewAll() = composeRule.onNode(hasText("View all") and hasClickAction())

  private fun expectedRequest() = FullMessageRead(gateway.operatorConnection.get(), model.chatSessionKey.value, "main", FULL_MESSAGE_ENTRY)

  private fun bindRuntime(value: NodeRuntime?) {
    // Existing app-fixture binding only: the object itself is the normal live runtime.
    NodeApp::class.java
      .getDeclaredField("runtimeInstance")
      .apply { isAccessible = true }
      .set(app, value)
  }
}

internal data class FullMessageRead(
  val connection: Int,
  val sessionKey: String,
  val agentId: String,
  val messageId: String,
  val maxChars: Int? = 1_000_000,
)

internal class FullMessageGateway : AutoCloseable {
  private val json = Json { ignoreUnknownKeys = true }
  private val server = MockWebServer()
  private val sequence = AtomicInteger()
  private val operatorSocket = AtomicReference<WebSocket?>()

  @Volatile private var rejectConnections = false
  val rejectedConnections = CopyOnWriteArrayList<CountDownLatch>()
  val operatorConnection = AtomicInteger()
  val fullReads = CopyOnWriteArrayList<FullMessageRead>()
  val historyReads = MutableStateFlow<List<Pair<Int, String>>>(emptyList())
  val speechReads = MutableStateFlow<List<String>>(emptyList())
  val heldResponses = MutableStateFlow<List<() -> Unit>>(emptyList())

  @Volatile var holdFullResponses = false

  @Volatile var fullResponseOverride: JsonObject? = null

  @Volatile var previewPrefix = ""

  @Volatile var historyRole = "assistant"

  @Volatile var historyTruncated = true

  @Volatile var historyMessageToolMirror = false

  @Volatile var historySyntheticMarker = "openclawMessageToolMirror"

  @Volatile var emitTruncationMarker = true

  @Volatile var contentAsBlocks = false

  @Volatile var includeMedia = false

  @Volatile var historyTextOverride: String? = null

  @Volatile var historyAppendCount = 0

  @Volatile var historyAppendRole: String? = null

  @Volatile var advertiseFullRead = true

  @Volatile var omitMethodCatalog = false

  @Volatile var fullReadRpcError = false
  val endpoint: GatewayEndpoint

  init {
    server.dispatcher =
      object : Dispatcher() {
        override fun dispatch(request: RecordedRequest): MockResponse =
          if (rejectConnections) {
            val release = CountDownLatch(1)
            rejectedConnections += release
            check(release.await(FULL_MESSAGE_READY_TIMEOUT_MS, TimeUnit.MILLISECONDS))
            MockResponse().setResponseCode(503)
          } else if (request.getHeader("Upgrade").equals("websocket", ignoreCase = true)) {
            MockResponse().withWebSocketUpgrade(listener(sequence.incrementAndGet()))
          } else {
            MockResponse().setResponseCode(404)
          }
      }
    server.start(InetAddress.getByName("127.0.0.1"), 0)
    endpoint = GatewayEndpoint.manual("127.0.0.1", server.port)
  }

  fun preview(session: String) = fullText(session).take(8_000) + "\n...(truncated)..."

  fun historyText(session: String) = historyTextOverride ?: if (historyTruncated) preview(session) else fullText(session)

  fun backgroundText(index: Int) = "Background message $index from another client."

  fun disconnectOperatorAndRejectReconnects() {
    rejectConnections = true
    check(checkNotNull(operatorSocket.get()).close(1001, "Proof operator disconnected"))
  }

  fun releaseRejectedConnection() {
    rejectedConnections.last().countDown()
  }

  fun fullText(session: String) = "$previewPrefix$session\n" + "An ordinary paragraph in a long answer. ".repeat(240) + "\n\n$FULL_MESSAGE_TAIL"

  fun fullResponse(
    session: String,
    truncated: Boolean = false,
  ) = buildJsonObject {
    put("ok", JsonPrimitive(true))
    put("message", message(session, truncated))
  }

  fun releaseFullResponses() {
    holdFullResponses = false
    val responses = heldResponses.value
    heldResponses.value = emptyList()
    responses.forEach { it() }
  }

  private fun listener(connection: Int) =
    object : WebSocketListener() {
      override fun onOpen(
        webSocket: WebSocket,
        response: Response,
      ) {
        webSocket.send("""{"type":"event","event":"connect.challenge","payload":{"nonce":"full-message-proof","ts":1700000000123}}""")
      }

      override fun onMessage(
        webSocket: WebSocket,
        text: String,
      ) {
        val frame = json.parseToJsonElement(text).jsonObject
        if (frame["type"]?.jsonPrimitive?.content != "req") return
        val id = checkNotNull(frame["id"])
        val method = frame["method"]?.jsonPrimitive?.content
        val params = frame["params"] as? JsonObject ?: JsonObject(emptyMap())
        val session = params["sessionKey"]?.jsonPrimitive?.content.orEmpty()

        fun reject(
          code: String,
          message: String,
        ) {
          webSocket.send(
            buildJsonObject {
              put("type", JsonPrimitive("res"))
              put("id", id)
              put("ok", JsonPrimitive(false))
              put(
                "error",
                buildJsonObject {
                  put("code", JsonPrimitive(code))
                  put("message", JsonPrimitive(message))
                },
              )
            }.toString(),
          )
        }
        val payload =
          when (method) {
            "connect" -> {
              val role = checkNotNull(params["role"]?.jsonPrimitive?.content)
              if (role == "operator") {
                operatorConnection.set(connection)
                operatorSocket.set(webSocket)
              }
              val methods =
                if (omitMethodCatalog) {
                  ""
                } else {
                  "\"methods\":[\"chat.history\",${if (advertiseFullRead) "\"chat.message.get\"," else ""}\"chat.metadata\",\"health\",\"sessions.list\"],"
                }
              json.parseToJsonElement(
                """{"type":"hello-ok","protocol":3,"server":{"host":"full-message-$connection","version":"proof"},"features":{$methods"events":[]},"auth":{"role":"$role","scopes":${if (role == "operator") "[\"operator.read\",\"operator.write\"]" else "[]"}},"snapshot":{"sessionDefaults":{"mainSessionKey":"agent:main:main"}}}""",
              )
            }

            "chat.history" -> {
              historyReads.update { it + (connection to session) }
              buildJsonObject {
                put("sessionId", JsonPrimitive("transcript-$session"))
                put(
                  "messages",
                  JsonArray(
                    buildList {
                      add(message(session, truncated = historyTruncated, role = historyRole, text = historyText(session), mirror = historyMessageToolMirror, history = true))
                      repeat(historyAppendCount) { index ->
                        add(
                          buildJsonObject {
                            put("role", JsonPrimitive(historyAppendRole ?: if (index % 2 == 0) "user" else "assistant"))
                            put("content", JsonPrimitive(backgroundText(index)))
                            put("__openclaw", buildJsonObject { put("id", JsonPrimitive("background-$index")) })
                          },
                        )
                      }
                    },
                  ),
                )
              }
            }

            "chat.message.get" -> {
              fullReads += FullMessageRead(connection, session, params["agentId"]?.jsonPrimitive?.content.orEmpty(), params["messageId"]?.jsonPrimitive?.content.orEmpty(), params["maxChars"]?.jsonPrimitive?.content?.toIntOrNull())
              if (fullReadRpcError) {
                reject("UNAVAILABLE", "Synthetic full-message request failure")
                return
              }
              fullResponseOverride ?: fullResponse(session)
            }

            "tts.speak" -> {
              // Observe the production Listen request without starting unrelated platform audio.
              speechReads.update { it + params.getValue("text").jsonPrimitive.content }
              return
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
              reject("INVALID_REQUEST", "Proof Gateway does not implement $method")
              return
            }
          }
        val response =
          buildJsonObject {
            put("type", JsonPrimitive("res"))
            put("id", id)
            put("ok", JsonPrimitive(true))
            put("payload", payload)
          }.toString().let { serialized ->
            // Match JSON.stringify's escaped lone surrogates; UTF-8 encoding otherwise replaces them.
            buildString {
              serialized.forEach { char ->
                if (char.isSurrogate()) append("\\u" + char.code.toString(16).padStart(4, '0')) else append(char)
              }
            }
          }
        if (method == "chat.message.get" && holdFullResponses) {
          heldResponses.update {
            it + {
              webSocket.send(response)
            }
          }
        } else {
          webSocket.send(response)
        }
      }
    }

  private fun message(
    session: String,
    truncated: Boolean,
    role: String = "assistant",
    text: String = if (truncated) preview(session) else fullText(session),
    mirror: Boolean = false,
    history: Boolean = false,
  ) = buildJsonObject {
    put("role", JsonPrimitive(role))
    if (mirror) {
      put(
        historySyntheticMarker,
        buildJsonObject {
          if (historySyntheticMarker == "openclawStreamFallback") {
            put("source", JsonPrimitive("segment"))
            put("itemId", JsonPrimitive("segment-qa"))
            put("replacementText", JsonPrimitive(text))
          } else {
            put("toolName", JsonPrimitive("message"))
          }
        },
      )
    }
    put(
      "content",
      if (includeMedia) {
        JsonArray(
          buildList {
            add(
              buildJsonObject {
                put("type", JsonPrimitive("image"))
                put("mimeType", JsonPrimitive("image/png"))
                put("fileName", JsonPrimitive(FULL_MESSAGE_IMAGE))
                put("omitted", JsonPrimitive(true))
              },
            )
            add(
              buildJsonObject {
                put("type", JsonPrimitive("text"))
                put("text", JsonPrimitive(text))
              },
            )
            add(
              buildJsonObject {
                put("type", JsonPrimitive("file"))
                put("fileName", JsonPrimitive(FULL_MESSAGE_FILE))
              },
            )
            add(
              buildJsonObject {
                put("type", JsonPrimitive("text"))
                put("text", JsonPrimitive(FULL_MESSAGE_MEDIA_TEXT))
              },
            )
            if (history) {
              // The history owner appends generated TTS audio; canonical full-get does not.
              add(
                buildJsonObject {
                  put("type", JsonPrimitive("audio"))
                  put("mimeType", JsonPrimitive("audio/mpeg"))
                  put("fileName", JsonPrimitive(FULL_MESSAGE_AUDIO))
                  put("artifactId", JsonPrimitive("history-tts-audio"))
                },
              )
            }
          },
        )
      } else if (contentAsBlocks) {
        JsonArray(
          listOf(
            buildJsonObject {
              put("type", JsonPrimitive("text"))
              put("text", JsonPrimitive(text))
            },
          ),
        )
      } else {
        JsonPrimitive(text)
      },
    )
    put(
      "__openclaw",
      buildJsonObject {
        put("id", JsonPrimitive(FULL_MESSAGE_ENTRY))
        if (truncated && emitTruncationMarker) {
          put("truncated", JsonPrimitive(true))
          put("reason", JsonPrimitive("display-cap"))
        }
      },
    )
  }

  override fun close() {
    rejectedConnections.forEach { it.countDown() }
    server.shutdown()
  }
}
