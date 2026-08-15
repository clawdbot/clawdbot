package ai.openclaw.app.ui.chat

import ai.openclaw.app.chat.ChatCommandEntry
import org.junit.Assert.assertEquals
import org.junit.Test

class ChatCommandControlsTest {
  @Test
  fun matchingSlashCommandsFiltersByNameAndAliasPrefixes() {
    val commands =
      listOf(
        ChatCommandEntry(
          name = "new",
          description = "Start fresh",
          category = "session",
          textAliases = listOf("/new"),
        ),
        ChatCommandEntry(
          name = "model",
          description = "Switch models",
          category = "model",
          textAliases = listOf("/model"),
          acceptsArgs = true,
        ),
        ChatCommandEntry(
          name = "agent",
          description = "Pick runtime",
          category = "agent",
          textAliases = listOf("/agent", "/delegate"),
          acceptsArgs = true,
        ),
      )

    assertEquals(
      listOf("/new", "/model", "/agent"),
      matchingSlashCommands(input = "/", commands = commands).map(::slashCommandText),
    )
    assertEquals(
      listOf("/new"),
      matchingSlashCommands(input = "/n", commands = commands).map(::slashCommandText),
    )
    assertEquals(
      listOf("/model"),
      matchingSlashCommands(input = "/mo", commands = commands).map(::slashCommandText),
    )
    assertEquals(
      listOf("/delegate"),
      matchingSlashCommands(input = "/de", commands = commands).map(::slashCommandText),
    )
    assertEquals(emptyList<ChatCommandEntry>(), matchingSlashCommands(input = "/runtime", commands = commands))
    assertEquals(emptyList<ChatCommandEntry>(), matchingSlashCommands(input = "/session", commands = commands))
    assertEquals(emptyList<ChatCommandEntry>(), matchingSlashCommands(input = "hello", commands = commands))
  }

  @Test
  fun matchingSlashCommandsKeepsGatewayAdvertisedAliases() {
    val commands =
      listOf(
        ChatCommandEntry(
          name = "new",
          description = "Start fresh",
          category = "session",
          textAliases = listOf("/new", "/reset"),
        ),
        ChatCommandEntry(
          name = "reset",
          description = "Reset session",
          category = "session",
          textAliases = listOf("/reset"),
        ),
      )

    assertEquals(
      listOf("/new", "/reset"),
      matchingSlashCommands(input = "/", commands = commands).map(::slashCommandText),
    )
    assertEquals(listOf("/reset"), matchingSlashCommands(input = "/reset", commands = commands).map(::slashCommandText))
  }

  @Test
  fun selectedNewSlashCommandCompletesGatewayCommandText() {
    assertEquals(
      "/new",
      slashCommandCompletion(
        ChatCommandEntry(
          name = "new",
          description = "Start fresh",
          textAliases = listOf("/new", "/reset"),
        ),
      ),
    )
    assertEquals(
      "/model ",
      slashCommandCompletion(
        ChatCommandEntry(
          name = "model",
          description = "Switch model",
          textAliases = listOf("/model"),
          acceptsArgs = true,
        ),
      ),
    )
  }

  @Test
  fun matchingSlashCommandsKeepsGatewayAdvertisedNewCommandVisible() {
    val commands =
      listOf(
        ChatCommandEntry(
          name = "new",
          description = "Start fresh",
          textAliases = listOf("/new"),
        ),
        ChatCommandEntry(
          name = "model",
          description = "Switch model",
          textAliases = listOf("/model"),
        ),
      )

    assertEquals(
      listOf("/new", "/model"),
      matchingSlashCommands(input = "/", commands = commands).map(::slashCommandText),
    )
  }

  @Test
  fun canStartNewChatRequiresIdleRunAndQueue() {
    assertEquals(true, canStartNewChat(pendingRunCount = 0, hasQueuedMessage = false, gatewayReady = true))
    assertEquals(false, canStartNewChat(pendingRunCount = 1, hasQueuedMessage = false, gatewayReady = true))
    assertEquals(false, canStartNewChat(pendingRunCount = 0, hasQueuedMessage = true, gatewayReady = true))
    assertEquals(false, canStartNewChat(pendingRunCount = 0, hasQueuedMessage = false, gatewayReady = false))
  }

  @Test
  fun slashCommandCompletionKeepsArgumentCommandsOpen() {
    assertEquals(
      "/model ",
      slashCommandCompletion(
        ChatCommandEntry(
          name = "model",
          description = "Switch models",
          textAliases = listOf("/model"),
          acceptsArgs = true,
        ),
      ),
    )
    assertEquals(
      "/new",
      slashCommandCompletion(
        ChatCommandEntry(
          name = "new",
          description = "Start fresh",
          textAliases = listOf("/new"),
        ),
      ),
    )
  }
}
