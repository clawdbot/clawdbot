package com.clawdbot.android.ui.chat

import com.clawdbot.android.chat.ChatSessionEntry

private const val RECENT_WINDOW_MS = 24 * 60 * 60 * 1000L

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
    if (aliasKey != null && entry.key == aliasKey) continue
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

  if (current.isNotEmpty() && !included.contains(current)) {
    result.add(ChatSessionEntry(key = current, updatedAtMs = null))
  }

  return result
}
