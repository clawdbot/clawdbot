package ai.openclaw.app.ui

import ai.openclaw.app.i18n.resolveNativeText
import ai.openclaw.app.i18n.verbatimText
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.ChatBubbleOutline
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class CommandPaletteLogicTest {
  @Test
  fun localizedCopyDrivesRenderingAndSearchWithoutChangingActionIdentity() {
    val item =
      CommandItem(
        action = CommandAction.Chat,
        title = verbatimText("Ouvrir le chat"),
        subtitle = verbatimText("Démarrer ou poursuivre une conversation"),
        icon = Icons.Outlined.ChatBubbleOutline,
        onClick = {},
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
      commandActionAccessibilityDescription(CommandAction.Settings, "Paramètres") { source, title ->
        assertEquals("Open \${row.title}", source)
        "Ouvrir $title"
      }

    assertEquals("Ouvrir le chat", chatDescription)
    assertEquals("Ouvrir Paramètres", settingsDescription)
  }

  @Test
  fun stableActionDispatchDoesNotDependOnLocalizedCopy() {
    val calls = mutableListOf<CommandAction>()
    val item =
      CommandItem(
        action = CommandAction.Voice,
        title = verbatimText("Démarrer la voix"),
        subtitle = verbatimText("Parler avec OpenClaw"),
        icon = Icons.Outlined.ChatBubbleOutline,
        onClick = { calls += CommandAction.Voice },
      )

    item.onClick()

    assertEquals(CommandAction.Voice, item.action)
    assertEquals(listOf(CommandAction.Voice), calls)
  }

  @Test
  fun relativeTimeUsesCatalogBackedCompactLabels() {
    val now = 10_000_000L

    assertEquals("now", commandRelativeTime(updatedAtMs = now, nowMs = now))
    assertEquals("5m", commandRelativeTime(updatedAtMs = now - 5 * 60_000L, nowMs = now))
    assertEquals("3h", commandRelativeTime(updatedAtMs = now - 3 * 60 * 60_000L, nowMs = now))
    assertEquals("2d", commandRelativeTime(updatedAtMs = now - 2 * 24 * 60 * 60_000L, nowMs = now))
  }
}
