package ai.openclaw.app.ui

import ai.openclaw.app.HomeDestination
import ai.openclaw.app.MainViewModel
import ai.openclaw.app.NodeApp
import ai.openclaw.app.SecurePrefs
import ai.openclaw.app.closeNodeRuntimeTestFixture
import ai.openclaw.app.i18n.nativeString
import ai.openclaw.app.i18n.resolveNativeText
import ai.openclaw.app.i18n.verbatimText
import android.content.Context
import androidx.activity.OnBackPressedDispatcher
import androidx.activity.compose.LocalOnBackPressedDispatcherOwner
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.ChatBubbleOutline
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.hasAnyAncestor
import androidx.compose.ui.test.hasAnyDescendant
import androidx.compose.ui.test.hasClickAction
import androidx.compose.ui.test.hasScrollAction
import androidx.compose.ui.test.hasSetTextAction
import androidx.compose.ui.test.hasText
import androidx.compose.ui.test.junit4.v2.createComposeRule
import androidx.compose.ui.test.onNodeWithContentDescription
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performScrollTo
import androidx.compose.ui.test.performTextReplacement
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
import org.robolectric.util.ReflectionHelpers
import java.util.UUID

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

  private fun verifyAppearanceSearch(origin: HomeDestination) {
    val app = RuntimeEnvironment.getApplication() as NodeApp
    val originalRuntime = app.peekRuntime()
    val prefs = SecurePrefs(app, app.getSharedPreferences("settings-search-${UUID.randomUUID()}", Context.MODE_PRIVATE))
    val viewModel = MainViewModel(app, prefs, SavedStateHandle())
    val models = ViewModelStore().apply { put("settings-search", viewModel) }
    val fromSettings = origin == HomeDestination.Settings
    val originTag = if (fromSettings) "sidebar-open-settings" else "sidebar-open-overview"
    val searchDescription = if (fromSettings) nativeString("Search settings") else nativeString("Search")
    val appearance = nativeString("Appearance")
    lateinit var backDispatcher: OnBackPressedDispatcher

    fun assertOrigin() {
      composeRule.onNode(hasSetTextAction()).assertDoesNotExist()
      composeRule.onNodeWithTag(originTag).assertIsDisplayed()
      composeRule.onNodeWithText(nativeString("Theme family")).assertDoesNotExist()
      composeRule.runOnIdle { assertSame("Settings discovery must preserve the process runtime owner", originalRuntime, app.peekRuntime()) }
    }

    fun searchAppearance() {
      composeRule.onNodeWithContentDescription(searchDescription).performClick()
      composeRule.onNode(hasSetTextAction()).performTextReplacement(appearance)
      composeRule.runOnIdle { assertSame("Opening and filtering search must not create a runtime", originalRuntime, app.peekRuntime()) }
    }

    try {
      viewModel.requestHomeDestination(origin)
      composeRule.setContent {
        backDispatcher = checkNotNull(LocalOnBackPressedDispatcherOwner.current).onBackPressedDispatcher
        ShellScreen(viewModel = viewModel)
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
      // Settings Home remains composed below the palette. Match a non-editable
      // result in the query's scroll container, not the query editor itself.
      val searchResults = hasScrollAction() and hasAnyDescendant(hasSetTextAction())
      composeRule
        .onNode(hasText(appearance) and hasClickAction() and hasSetTextAction().not() and hasAnyAncestor(searchResults))
        .performScrollTo()
        .assertIsDisplayed()
        .performClick()
      composeRule.onNode(hasSetTextAction()).assertDoesNotExist()
      composeRule.onNodeWithText(nativeString("Theme family")).assertIsDisplayed()
      composeRule.runOnIdle { assertSame("Opening local Appearance must not create a runtime", originalRuntime, app.peekRuntime()) }

      if (fromSettings) {
        composeRule.runOnIdle { backDispatcher.onBackPressed() }
      } else {
        composeRule.onNodeWithContentDescription(nativeString("Back")).performClick()
      }
      assertOrigin()
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
