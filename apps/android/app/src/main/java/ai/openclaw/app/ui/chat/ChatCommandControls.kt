package ai.openclaw.app.ui.chat

import ai.openclaw.app.chat.ChatCommandEntry
import java.util.Locale

internal fun slashCommandQuery(input: String): String? {
  val trimmed = input.trimStart()
  if (!trimmed.startsWith("/")) return null
  val token = trimmed.drop(1).takeWhile { !it.isWhitespace() }
  return token.lowercase(Locale.US)
}

internal fun shouldShowSlashCommandMenu(input: String): Boolean = slashCommandQuery(input) != null

internal fun matchingSlashCommands(
  input: String,
  commands: List<ChatCommandEntry>,
  limit: Int = 6,
): List<ChatCommandEntry> {
  val query = slashCommandQuery(input) ?: return emptyList()
  val uniqueCommands = commands.map { command -> command.withMatchedSlashAliasFirst(query) }.distinctBy { slashCommandText(it) }
  val matches =
    if (query.isEmpty()) {
      uniqueCommands
    } else {
      uniqueCommands.filter { command ->
        slashCommandPrefixes(command).any { prefix -> prefix.startsWith(query) }
      }
    }
  return matches.take(limit)
}

internal fun slashCommandText(command: ChatCommandEntry): String {
  command.textAliases
    .firstOrNull { alias -> alias.startsWith("/") && alias.length > 1 }
    ?.let { return it }
  val name =
    command.name
      .trim()
      .removePrefix("/")
      .takeIf { it.isNotEmpty() } ?: "help"
  return "/$name"
}

internal fun slashCommandCompletion(command: ChatCommandEntry): String {
  val text = slashCommandText(command)
  return if (command.acceptsArgs) "$text " else text
}

private fun slashCommandPrefixes(command: ChatCommandEntry): List<String> =
  buildList {
    add(normalizedSlashCommandName(command.name))
    command.textAliases.forEach { alias ->
      add(normalizedSlashCommandName(alias))
    }
  }.filter { it.isNotEmpty() }

private fun ChatCommandEntry.withMatchedSlashAliasFirst(query: String): ChatCommandEntry {
  if (query.isEmpty()) return this
  val match = textAliases.firstOrNull { alias -> normalizedSlashCommandName(alias).startsWith(query) } ?: return this
  if (textAliases.firstOrNull() == match) return this
  return copy(textAliases = listOf(match) + textAliases.filterNot { it == match })
}

private fun normalizedSlashCommandName(value: String): String = value.trim().removePrefix("/").lowercase(Locale.US)
