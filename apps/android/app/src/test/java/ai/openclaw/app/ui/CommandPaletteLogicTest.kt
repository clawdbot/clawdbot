package ai.openclaw.app.ui

import ai.openclaw.app.AndroidScreenshotScene
import ai.openclaw.app.HomeDestination
import ai.openclaw.app.MainViewModel
import ai.openclaw.app.NodeApp
import ai.openclaw.app.NodeRuntime
import ai.openclaw.app.NodeRuntimeMode
import ai.openclaw.app.SecurePrefs
import ai.openclaw.app.bindNodeRuntimeTestFixture
import ai.openclaw.app.chat.ChatController
import ai.openclaw.app.closeNodeRuntimeTestFixture
import ai.openclaw.app.i18n.nativeString
import ai.openclaw.app.i18n.resolveNativeText
import ai.openclaw.app.i18n.verbatimText
import ai.openclaw.app.ui.design.assertCompleteText
import android.content.Context
import android.graphics.Bitmap
import androidx.activity.OnBackPressedDispatcher
import androidx.activity.compose.LocalOnBackPressedDispatcherOwner
import androidx.compose.foundation.layout.width
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.ChatBubbleOutline
import androidx.compose.runtime.mutableStateOf
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.asAndroidBitmap
import androidx.compose.ui.semantics.SemanticsActions
import androidx.compose.ui.semantics.SemanticsProperties
import androidx.compose.ui.semantics.getOrNull
import androidx.compose.ui.test.DeviceConfigurationOverride
import androidx.compose.ui.test.FontScale
import androidx.compose.ui.test.SemanticsMatcher
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.assertTextContains
import androidx.compose.ui.test.captureToImage
import androidx.compose.ui.test.hasAnyAncestor
import androidx.compose.ui.test.hasAnyDescendant
import androidx.compose.ui.test.hasClickAction
import androidx.compose.ui.test.hasScrollAction
import androidx.compose.ui.test.hasSetTextAction
import androidx.compose.ui.test.hasTestTag
import androidx.compose.ui.test.hasText
import androidx.compose.ui.test.junit4.v2.createComposeRule
import androidx.compose.ui.test.onNodeWithContentDescription
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.onRoot
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performScrollTo
import androidx.compose.ui.test.performScrollToNode
import androidx.compose.ui.test.performSemanticsAction
import androidx.compose.ui.test.performTextReplacement
import androidx.compose.ui.text.TextLayoutResult
import androidx.compose.ui.unit.dp
import androidx.lifecycle.SavedStateHandle
import androidx.lifecycle.ViewModelStore
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertSame
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import org.robolectric.annotation.Config
import org.robolectric.annotation.GraphicsMode
import org.robolectric.util.ReflectionHelpers
import java.io.File
import java.util.UUID
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicInteger

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34], qualifiers = "w360dp-h800dp-420dpi")
class CommandPaletteLogicTest {
  @get:Rule
  val composeRule = createComposeRule()

  @Test
  fun appearanceSearchFromOverviewReturnsToOverview() = verifyAppearanceSearch(HomeDestination.Connect)

  @Test
  fun appearanceSearchFromSettingsReturnsToSettingsHome() = verifyAppearanceSearch(HomeDestination.Settings)

  @Test
  fun localizedCopyDrivesRenderingAndSearchWithoutChangingActionIdentity() {
    val item =
      CommandItem(
        action = CommandAction.Chat,
        title = verbatimText("Ouvrir le chat"),
        subtitle = verbatimText("Démarrer ou poursuivre une conversation"),
        icon = Icons.Outlined.ChatBubbleOutline,
      )

    assertEquals("Ouvrir le chat", item.title.resolveNativeText())
    assertEquals("Démarrer ou poursuivre une conversation", item.subtitle.resolveNativeText())
    assertTrue(item.matches("ouvrir"))
    assertTrue(item.matches("OUVRIR"))
    assertTrue(item.matches("conversation"))
    assertFalse(item.matches("open chat"))
    assertTrue(item.copy(title = verbatimText("İletişim")).matches("iletişim"))
    assertEquals(CommandAction.Chat, item.action)
  }

  @Test
  fun sessionSearchIgnoresQueryCase() {
    assertTrue(commandSessionMatches(title = "Incident Review", query = "INCIDENT"))
    assertTrue(commandSessionMatches(title = "Incident Review", query = "review"))
    assertFalse(commandSessionMatches(title = "Incident Review", query = "deployment"))
  }

  @Test
  fun accessibilityDescriptionUsesLocalizedActionCopyWithoutDuplicateVerbs() {
    val chatDescription =
      commandActionAccessibilityDescription(CommandAction.Chat, "Ouvrir le chat") { _, _ ->
        error("verb-led commands should use their localized title directly")
      }
    val settingsDescription =
      commandActionAccessibilityDescription(CommandAction.Settings(SettingsRoute.Home), "Paramètres") { source, title ->
        assertEquals("Open \${row.title}", source)
        "Ouvrir $title"
      }

    assertEquals("Ouvrir le chat", chatDescription)
    assertEquals("Ouvrir Paramètres", settingsDescription)
  }

  @Test
  fun settingsCommandsUseTypedDestinationsAndCategoriesWithoutDuplicatingProviders() {
    val providerAction = CommandAction.Settings(SettingsRoute.ProvidersModels)
    val providerSubtitle = "2 providers ready"
    val quickActions = commandItems(query = "", desktopObserveAvailable = false, providerSubtitle = providerSubtitle)
    assertEquals("Empty search must keep the compact quick-action menu", 5, quickActions.size)
    assertEquals(providerSubtitle, quickActions.single { it.action == providerAction }.subtitle.resolveNativeText())

    val categoryMatches = commandItems(query = nativeString("Agents & automation"), desktopObserveAvailable = false, providerSubtitle = providerSubtitle)
    assertTrue(categoryMatches.any { it.action == CommandAction.Settings(SettingsRoute.CronJobs) })
    assertEquals(providerSubtitle, categoryMatches.single { it.action == providerAction }.subtitle.resolveNativeText())

    // These destinations are outside the main Settings row group but still own routes.
    listOf(nativeString("Profile") to SettingsRoute.Profile, nativeString("Licenses") to SettingsRoute.Licenses).forEach { (query, route) ->
      val matches = commandItems(query = query, desktopObserveAvailable = false, providerSubtitle = providerSubtitle)
      assertEquals(query, matches.single { it.action == CommandAction.Settings(route) }.title.resolveNativeText())
    }
  }

  @Test
  fun desktopCommandsRequireAvailabilityAndSearchDoesNotExposeSignOut() {
    val query = nativeString("Desktop")
    assertTrue(commandItems(query = query, desktopObserveAvailable = false, providerSubtitle = "Ready").isEmpty())
    assertEquals(
      listOf(CommandAction.Settings(SettingsRoute.Desktop)),
      commandItems(query = query, desktopObserveAvailable = true, providerSubtitle = "Ready").map { it.action },
    )
    assertTrue(commandItems(query = nativeString("Sign Out"), desktopObserveAvailable = true, providerSubtitle = "Ready").isEmpty())
  }

  @Test
  @GraphicsMode(GraphicsMode.Mode.NATIVE)
  @Config(qualifiers = "fr-w320dp-h800dp-420dpi")
  fun settingsRowsKeepLocalizedTitlesAndStatusesReadable() {
    val fontScale = mutableStateOf(1f)
    val title = nativeString("Providers & Models")
    val value = nativeString("Review readiness")
    assertTrue(title.startsWith("Fournisseurs"))
    withShell(HomeDestination.Settings, Modifier.width(320.dp), { fontScale.value }) { backDispatcher, assertRuntimeUnchanged ->
      for (scale in listOf(1f, 2f)) {
        composeRule.runOnIdle { fontScale.value = scale }
        composeRule.onNode(SemanticsMatcher.keyIsDefined(SemanticsActions.ScrollToIndex)).performScrollToNode(hasText(title))
        for (label in listOf(title, value)) {
          val layouts = mutableListOf<TextLayoutResult>()
          composeRule
            .onNodeWithText(label, useUnmergedTree = true)
            .assertIsDisplayed()
            .performSemanticsAction(SemanticsActions.GetTextLayoutResult) { action -> assertTrue(action(layouts)) }
          val layout = layouts.single()
          // Paragraph width can exceed a tight Text node even when every glyph fits.
          assertFalse("$label must retain every line", layout.multiParagraph.didExceedMaxLines)
          assertTrue("$label must fit vertically", layout.multiParagraph.height <= layout.size.height + 1f)
          assertTrue("$label must fit horizontally", (0 until layout.lineCount).all { layout.getLineLeft(it) >= -1f && layout.getLineRight(it) <= layout.size.width + 1f })
          assertTrue("$scale: $label must not be ellipsized", (0 until layout.lineCount).none(layout::isLineEllipsized))
          assertEquals(label.length, layout.getLineEnd(layout.lineCount - 1, visibleEnd = true))
        }
        assertRuntimeUnchanged()
      }
      composeRule.onNode(SemanticsMatcher.keyIsDefined(SemanticsActions.ScrollToIndex)).performScrollToNode(hasText(nativeString("Appearance")))
      composeRule.onNodeWithContentDescription(settingsRowDisclosureDescription(nativeString("Appearance"), opensRoute = true)).performClick()
      composeRule.onNodeWithText(nativeString("Theme family")).assertIsDisplayed()
      composeRule.runOnIdle { backDispatcher.onBackPressed() }
      composeRule.onNode(SemanticsMatcher.keyIsDefined(SemanticsActions.ScrollToIndex)).performScrollToNode(hasText(nativeString("Licenses")))
      assertEquals(
        listOf(nativeString("Licenses")),
        composeRule
          .onNodeWithText(nativeString("Licenses"))
          .fetchSemanticsNode()
          .config[SemanticsProperties.Text]
          .map { it.text },
      )
      composeRule.onNodeWithText(nativeString("Licenses")).performClick()
      composeRule.onNodeWithText(nativeString("OpenClaw appreciates its partners in the open-source community.")).assertIsDisplayed()
      assertRuntimeUnchanged()
    }
  }

  @Test
  @GraphicsMode(GraphicsMode.Mode.NATIVE)
  @Config(qualifiers = "fr-w320dp-h800dp-420dpi")
  fun quickActionTitlesAndDescriptionsRemainReadableAtLargeFont() {
    val fontScale = mutableStateOf(1f)
    val labels =
      listOf(
        "Open Chat",
        "Start or continue a conversation",
        "Start Voice",
        "Talk or dictate with OpenClaw",
        "Browse Threads",
        "Find previous conversations",
        "Providers & Models",
        "Connect Gateway to view providers",
        "Settings",
        "Gateway, voice, notifications, privacy",
      ).map { nativeString(it) }
    val evidence = File("build/outputs/search-action-readability", UUID.randomUUID().toString())
    assertTrue(evidence.mkdirs())
    withShell(HomeDestination.Settings, Modifier.width(320.dp), { fontScale.value }) { _, assertRuntimeUnchanged ->
      val searchResults = hasScrollAction() and hasAnyDescendant(hasSetTextAction())
      val failures = mutableListOf<String>()
      for (scale in listOf(1f, 2f)) {
        composeRule.runOnIdle { fontScale.value = scale }
        composeRule.onNodeWithContentDescription(nativeString("Search settings")).performClick()
        try {
          composeRule.onNode(hasText("OC") and hasAnyAncestor(searchResults), useUnmergedTree = true).assertCompleteText("OC")
        } catch (error: AssertionError) {
          failures += "$scale: avatar OC: ${error.message}"
        }
        for ((index, label) in labels.withIndex()) {
          val node = composeRule.onNode(hasText(label) and hasAnyAncestor(searchResults), useUnmergedTree = true)
          node.performScrollTo().assertIsDisplayed()
          File(evidence, "$scale-$index.png").outputStream().use {
            assertTrue(
              composeRule
                .onRoot()
                .captureToImage()
                .asAndroidBitmap()
                .compress(Bitmap.CompressFormat.PNG, 100, it),
            )
          }
          try {
            node.assertCompleteText(label)
          } catch (error: AssertionError) {
            failures += "$scale: $label: ${error.message}"
          }
          if (index % 2 == 0) {
            val action = composeRule.onNode(hasText(label) and hasClickAction() and hasAnyAncestor(searchResults)).fetchSemanticsNode()
            val clickLabel = if (index < 6) label else nativeString("Open \${row.title}", label)
            assertEquals(clickLabel, action.config[SemanticsActions.OnClick].label)
          }
          assertRuntimeUnchanged()
        }
        composeRule.onNode(hasText(nativeString("Settings")) and hasClickAction() and hasAnyAncestor(searchResults)).performClick()
        composeRule.onNode(hasSetTextAction()).assertDoesNotExist()
        composeRule.onNodeWithTag("sidebar-open-settings").assertIsDisplayed()
        assertRuntimeUnchanged()
      }
      assertTrue("Quick actions must expose their complete title and description:\n${failures.joinToString("\n")}", failures.isEmpty())
    }
  }

  @Test
  fun threadActivityBelongsToEachSearchResultNotTheSelectedChat() = verifyThreadActivity(queued = false)

  @Test
  fun inactiveQueuedSearchRowsDoNotClaimCurrentWaiting() = verifyThreadActivity(queued = true)

  @Test
  fun inactiveQueuedSidebarRowsDoNotShowQueuedActivity() = verifyThreadActivity(queued = true, sidebar = true)

  private fun verifyThreadActivity(
    queued: Boolean,
    sidebar: Boolean = false,
  ) {
    val selectedKey = "agent:main:selected-elsewhere"
    val activeKey = "agent:main:activity-active"
    val idleKey = "agent:main:activity-idle"
    val finishedKey = "agent:main:activity-finished"
    val queuedKey = "agent:main:activity-queued"
    val runStatus = if (queued) "queued" else "running"
    val expectedKeys = setOf(selectedKey, activeKey, idleKey, finishedKey) + if (queued) setOf(queuedKey) else emptySet()
    val queuedRow = if (queued) """,{"key":"$queuedKey","agentId":"main","label":"Activity queued","hasActiveRun":true,"activeRunIds":["queued-run"],"status":"queued"}""" else ""
    lateinit var model: MainViewModel
    lateinit var controller: ChatController
    val historyReads = AtomicInteger()
    val sessionReads = AtomicInteger()
    var restoreRequest: () -> Unit = {}
    val selectedBusy = AtomicBoolean(true)

    fun selectedState(busy: Boolean) =
      if (busy) {
        """"hasActiveRun":true,"activeRunIds":["selected-run"],"status":"running""""
      } else {
        """"hasActiveRun":false,"activeRunIds":[],"status":"idle""""
      }

    fun history(): String {
      val busy = selectedBusy.get()
      val inFlight = if (busy) ""","inFlightRun":{"runId":"selected-run","text":"Synthetic selected response"}""" else ""
      return """{"sessionId":"selected-elsewhere","messages":[],${selectedState(busy)}$inFlight}"""
    }

    fun sessions() = """{"sessions":[{"key":"$selectedKey","agentId":"main","label":"Selected elsewhere",${selectedState(selectedBusy.get())}},{"key":"$activeKey","agentId":"main","label":"Activity active","status":"$runStatus"},{"key":"$idleKey","agentId":"main","label":"Activity idle","hasActiveRun":false,"activeRunIds":[],"status":"$runStatus"},{"key":"$finishedKey","agentId":"main","label":"Activity finished","hasActiveRun":true,"activeRunIds":["stale-run"],"status":"done"}$queuedRow]}"""
    try {
      withShell(
        HomeDestination.Settings,
        prepare = { viewModel, prefs ->
          model = viewModel
          val app = RuntimeEnvironment.getApplication() as NodeApp
          val runtime = NodeRuntime(app, prefs, NodeRuntimeMode.ScreenshotFixture)
          bindNodeRuntimeTestFixture(app, runtime)
          model.enterScreenshotFixtureMode(AndroidScreenshotScene.Chat)
          controller = ReflectionHelpers.getField<ChatController>(runtime, "chat")
          val field = ChatController::class.java.getDeclaredField("requestGatewayForGateway").apply { isAccessible = true }

          @Suppress("UNCHECKED_CAST")
          val original = field.get(controller) as suspend (String, String, String?) -> String
          val request: suspend (String, String, String?) -> String = { gatewayId, method, params ->
            when (method) {
              "chat.history" -> {
                historyReads.incrementAndGet()
                history()
              }

              else -> {
                original(gatewayId, method, params)
              }
            }
          }
          val listField = ChatController::class.java.getDeclaredField("requestGateway").apply { isAccessible = true }

          @Suppress("UNCHECKED_CAST")
          val originalListRequest = listField.get(controller) as suspend (String, String?) -> String
          val listRequest: suspend (String, String?) -> String = { method, params ->
            if (method == "sessions.list") {
              sessionReads.incrementAndGet()
              sessions()
            } else {
              originalListRequest(method, params)
            }
          }
          field.set(controller, request)
          listField.set(controller, listRequest)
          restoreRequest = {
            field.set(controller, original)
            listField.set(controller, originalListRequest)
          }
          // The ordinary new selection fences the constructor's earlier fixture history.
          controller.load(selectedKey, ownerAgentId = "main")
          controller.refreshSessions(limit = 20)
        },
      ) { _, _ ->
        composeRule.waitUntil(timeoutMillis = 5_000) {
          composeRule.runOnIdle {
            model.chatSessionKey.value == selectedKey && !model.chatHistoryLoading.value &&
              model.chatHealthOk.value && model.pendingRunCount.value == 1 &&
              model.chatSessions.value
                .map { it.key }
                .toSet() == expectedKeys
          }
        }
        assertTrue("The bound history fixture must have been read", historyReads.get() > 0)
        assertTrue("The unbound active-list fixture must have been read", sessionReads.get() > 0)
        val observed = model.chatSessions.value.associateBy { it.key }
        assertTrue(observed.getValue(activeKey).hasActiveRun == null)
        assertEquals(false, observed.getValue(idleKey).hasActiveRun)
        assertEquals(runStatus, observed.getValue(activeKey).status)
        assertEquals(runStatus, observed.getValue(idleKey).status)
        assertEquals(true, observed.getValue(finishedKey).hasActiveRun)
        assertEquals("done", observed.getValue(finishedKey).status)
        if (queued) {
          assertEquals(true, observed.getValue(queuedKey).hasActiveRun)
          assertEquals("queued", observed.getValue(queuedKey).status)
        }
        if (sidebar) {
          composeRule.onNodeWithTag("sidebar-open-settings").performClick()
          composeRule.onNodeWithText(nativeString("Recent")).performScrollTo().performClick()
          for ((title, state) in listOf("Activity active" to "Queued", "Activity queued" to "Queued", "Activity idle" to null, "Activity finished" to null)) {
            val row =
              composeRule
                .onNode(hasText(title) and hasClickAction() and hasAnyAncestor(hasTestTag("sidebar-drawer")))
                .performScrollTo()
                .assertIsDisplayed()
            assertEquals("$title must describe current activity", state?.let { nativeString(it) }, row.fetchSemanticsNode().config.getOrNull(SemanticsProperties.StateDescription))
          }
          composeRule.onNodeWithTag("sidebar-close").performClick()
          return@withShell
        }
        composeRule.onNodeWithContentDescription(nativeString("Search settings")).performClick()
        composeRule.onNode(hasSetTextAction()).performTextReplacement("Activity")
        val searchResults = hasScrollAction() and hasAnyDescendant(hasSetTextAction())

        fun assertResultActivity() {
          val labels =
            listOf("Activity active" to if (queued) "Waiting for a concurrency slot" else "Assistant working", "Activity idle" to "OpenClaw thread", "Activity finished" to "OpenClaw thread") +
              if (queued) listOf("Activity queued" to "Waiting for a concurrency slot") else emptyList()
          for ((title, subtitle) in labels) {
            composeRule
              .onNode(hasText(title) and hasClickAction() and hasAnyAncestor(searchResults))
              .performScrollTo()
              .assertIsDisplayed()
              .assertTextContains(nativeString(subtitle))
          }
          assertEquals("Search does not switch the unrelated selected chat", selectedKey, model.chatSessionKey.value)
        }
        assertResultActivity()
        assertEquals(1, controller.pendingRunCount.value)

        selectedBusy.set(false)
        composeRule.runOnIdle {
          controller.handleGatewayEvent("chat", """{"sessionKey":"$selectedKey","runId":"selected-run","state":"aborted"}""")
          controller.refreshSessions(limit = 20)
        }
        composeRule.waitUntil(timeoutMillis = 5_000) {
          composeRule.runOnIdle {
            val rows = model.chatSessions.value.associateBy { it.key }
            model.chatSessionKey.value == selectedKey && !model.chatHistoryLoading.value &&
              model.chatHealthOk.value && model.pendingRunCount.value == 0 &&
              rows.keys == expectedKeys &&
              rows[selectedKey]?.hasActiveRun == false &&
              rows[activeKey]?.let { it.hasActiveRun == null && it.status == runStatus } == true &&
              rows[idleKey]?.let { it.hasActiveRun == false && it.status == runStatus } == true &&
              rows[finishedKey]?.let { it.hasActiveRun == true && it.status == "done" } == true
          }
        }
        assertResultActivity()
        assertEquals(0, controller.pendingRunCount.value)
      }
    } finally {
      restoreRequest()
    }
  }

  private fun verifyAppearanceSearch(origin: HomeDestination) {
    val fromSettings = origin == HomeDestination.Settings
    val originTag = if (fromSettings) "sidebar-open-settings" else "sidebar-open-overview"
    val searchDescription = if (fromSettings) nativeString("Search settings") else nativeString("Search")
    val appearance = nativeString("Appearance")
    withShell(origin) { backDispatcher, assertRuntimeUnchanged ->
      fun assertOrigin() {
        composeRule.onNode(hasSetTextAction()).assertDoesNotExist()
        composeRule.onNodeWithTag(originTag).assertIsDisplayed()
        composeRule.onNodeWithText(nativeString("Theme family")).assertDoesNotExist()
        assertRuntimeUnchanged()
      }

      fun searchAppearance() {
        composeRule.onNodeWithContentDescription(searchDescription).performClick()
        composeRule.onNode(hasSetTextAction()).performTextReplacement(appearance)
        assertRuntimeUnchanged()
      }
      assertOrigin()
      searchAppearance()
      if (fromSettings) {
        composeRule.onNodeWithContentDescription(nativeString("Close search")).performClick()
      } else {
        composeRule.runOnIdle { backDispatcher.onBackPressed() }
      }
      assertOrigin()
      searchAppearance()
      composeRule.onNodeWithText(nativeString("No actions found")).assertDoesNotExist()
      // Settings Home remains below the palette; scope the result to its query container.
      val searchResults = hasScrollAction() and hasAnyDescendant(hasSetTextAction())
      composeRule
        .onNode(hasText(appearance) and hasClickAction() and hasSetTextAction().not() and hasAnyAncestor(searchResults))
        .performScrollTo()
        .assertIsDisplayed()
        .performClick()
      composeRule.onNode(hasSetTextAction()).assertDoesNotExist()
      composeRule.onNodeWithText(nativeString("Theme family")).assertIsDisplayed()
      assertRuntimeUnchanged()
      if (fromSettings) {
        composeRule.runOnIdle { backDispatcher.onBackPressed() }
      } else {
        composeRule.onNodeWithContentDescription(nativeString("Back")).performClick()
      }
      assertOrigin()
    }
  }

  private fun withShell(
    origin: HomeDestination,
    modifier: Modifier = Modifier,
    fontScale: () -> Float = { 1f },
    prepare: (MainViewModel, SecurePrefs) -> Unit = { _, _ -> },
    verify: (OnBackPressedDispatcher, () -> Unit) -> Unit,
  ) {
    val app = RuntimeEnvironment.getApplication() as NodeApp
    val originalRuntime = app.peekRuntime()
    val prefs = SecurePrefs(app, app.getSharedPreferences("settings-search-${UUID.randomUUID()}", Context.MODE_PRIVATE))
    val viewModel = MainViewModel(app, prefs, SavedStateHandle())
    val models = ViewModelStore().apply { put("settings-search", viewModel) }
    lateinit var backDispatcher: OnBackPressedDispatcher
    try {
      prepare(viewModel, prefs)
      viewModel.requestHomeDestination(origin)
      composeRule.setContent {
        backDispatcher = checkNotNull(LocalOnBackPressedDispatcherOwner.current).onBackPressedDispatcher
        DeviceConfigurationOverride(DeviceConfigurationOverride.FontScale(fontScale())) {
          ShellScreen(viewModel = viewModel, modifier = modifier)
        }
      }
      composeRule.waitForIdle()
      verify(backDispatcher) {
        composeRule.runOnIdle { assertSame("Local Settings must preserve the process runtime owner", originalRuntime, app.peekRuntime()) }
      }
    } finally {
      try {
        models.clear()
      } finally {
        val currentRuntime = app.peekRuntime()
        if (currentRuntime !== originalRuntime) {
          ReflectionHelpers.setField(app, "runtimeInstance", originalRuntime)
          currentRuntime?.let(::closeNodeRuntimeTestFixture)
        }
      }
    }
  }
}
