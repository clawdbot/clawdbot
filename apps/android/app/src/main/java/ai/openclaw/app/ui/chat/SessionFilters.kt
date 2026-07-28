package ai.openclaw.app.ui.chat

import ai.openclaw.app.chat.ChatSessionEntry

private const val RECENT_WINDOW_MS = 24 * 60 * 60 * 1000L

fun friendlySessionName(key: String): String {
  val stripped = key.substringAfterLast(":")
  val cleaned = if (stripped.startsWith("g-")) stripped.removePrefix("g-") else stripped
  val words =
    cleaned
      .split('-', '_')
      .filter { it.isNotBlank() }
      .map { word ->
        word.replaceFirstChar { it.uppercaseChar() }
      }.distinct()

  val result = words.joinToString(" ")
  return result.ifBlank { key }
}

/** Keeps transport/device sessions out of chat pickers while preserving channel conversations. */
internal fun isSelectableChatSession(
  key: String,
  mainSessionKey: String,
): Boolean {
  val sessionKey = key.trim()
  if (sessionKey.isEmpty()) return false
  val mainKey = mainSessionKey.trim().ifEmpty { "main" }
  if (sessionKey == mainKey || sessionKey == "onboarding" || sessionKey.endsWith(":onboarding")) {
    return false
  }

  val parts = sessionKey.lowercase().split(':')
  val directBase =
    when {
      parts.size == 1 -> parts.single()
      parts.size >= 3 && parts[0] == "agent" && (parts.size == 3 || parts[3] == "thread") -> parts[2].trim()
      else -> return true
    }
  return !isDirectSessionBase(directBase, sessionBaseKey(mainKey))
}

private fun isDirectSessionBase(
  base: String,
  defaultBase: String,
): Boolean = base == defaultBase || base == "main" || base == "global" || base.startsWith("node-")

private fun sessionBaseKey(key: String): String {
  val normalized = key.trim().lowercase()
  val parts = normalized.split(':')
  return if (parts.size >= 3 && parts[0] == "agent") parts[2].trim() else normalized
}

/** Builds the selectable recent-session list while preserving the active session. */
fun resolveSessionChoices(
  currentSessionKey: String,
  sessions: List<ChatSessionEntry>,
  mainSessionKey: String,
  nowMs: Long = System.currentTimeMillis(),
): List<ChatSessionEntry> {
  val mainKey = mainSessionKey.trim().ifEmpty { "main" }
  val current = currentSessionKey.trim().let { if (it == "main" && mainKey != "main") mainKey else it }
  val aliasKey = if (mainKey == "main") null else "main"
  val cutoff = nowMs - RECENT_WINDOW_MS
  val sorted = sessions.sortedByDescending { it.updatedAtMs ?: 0L }
  val recent = mutableListOf<ChatSessionEntry>()
  val seen = mutableSetOf<String>()
  for (entry in sorted) {
    // Hide the legacy main alias when the gateway has supplied a canonical main session key.
    if (aliasKey != null && entry.key == aliasKey) continue
    if (!isSelectableChatSession(entry.key, mainKey)) continue
    if (!seen.add(entry.key)) continue
    if ((entry.updatedAtMs ?: 0L) < cutoff) continue
    recent.add(entry)
  }

  val result = mutableListOf<ChatSessionEntry>()
  val included = mutableSetOf<String>()
  val mainEntry = sorted.firstOrNull { it.key == mainKey }
  if (mainEntry != null) {
    result.add(mainEntry)
    included.add(mainKey)
  } else if (current == mainKey) {
    result.add(ChatSessionEntry(key = mainKey, updatedAtMs = null))
    included.add(mainKey)
  }

  for (entry in recent) {
    if (included.add(entry.key)) {
      result.add(entry)
    }
  }

  if (current.isNotEmpty() && !included.contains(current) && isSelectableChatSession(current, mainKey)) {
    // Keep the active session selectable even if it is old or missing from the recent list.
    result.add(ChatSessionEntry(key = current, updatedAtMs = null))
  }

  return result
}

fun resolveCompactSessionChoices(
  currentSessionKey: String,
  sessions: List<ChatSessionEntry>,
  mainSessionKey: String,
  nowMs: Long = System.currentTimeMillis(),
  maxOptions: Int = 5,
): List<ChatSessionEntry> {
  val allChoices =
    resolveSessionChoices(
      currentSessionKey = currentSessionKey,
      sessions = sessions,
      mainSessionKey = mainSessionKey,
      nowMs = nowMs,
    )
  return compactSessionChoices(
    choices = allChoices,
    currentSessionKey = currentSessionKey,
    mainSessionKey = mainSessionKey,
    maxOptions = maxOptions,
  )
}

internal fun compactSessionChoices(
  choices: List<ChatSessionEntry>,
  currentSessionKey: String,
  mainSessionKey: String,
  maxOptions: Int = 5,
): List<ChatSessionEntry> {
  val mainKey = mainSessionKey.trim().ifEmpty { "main" }
  val current = currentSessionKey.trim().let { if (it == "main" && mainKey != "main") mainKey else it }
  val pinnedRank =
    listOf(mainKey, current)
      .filter { it.isNotBlank() }
      .distinct()
      .withIndex()
      .associate { it.value to it.index }
  val unpinnedRank = pinnedRank.size

  return choices
    .withIndex()
    .sortedWith(compareBy({ pinnedRank[it.value.key] ?: unpinnedRank }, { it.index }))
    .take(maxOptions)
    .map { it.value }
}

internal fun hasAdditionalSessionChoices(
  sessions: List<ChatSessionEntry>,
  displayedChoices: List<ChatSessionEntry>,
  mainSessionKey: String,
): Boolean {
  val mainKey = mainSessionKey.trim().ifEmpty { "main" }
  val aliasKey = if (mainKey == "main") null else "main"
  val displayedKeys = displayedChoices.mapTo(mutableSetOf()) { it.key }
  return sessions.any { entry ->
    entry.key != aliasKey &&
      entry.key !in displayedKeys &&
      (entry.key == mainKey || isSelectableChatSession(entry.key, mainKey))
  }
}
