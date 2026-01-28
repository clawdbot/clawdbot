package bot.molt.android.voice

object VoiceWakeCommandExtractor {
  fun extractCommand(text: String, triggerWords: List<String>): String? {
    val raw = text.trim()
    if (raw.isEmpty()) return null

    val triggers =
      triggerWords
        .map { it.trim().lowercase() }
        .filter { it.isNotEmpty() }
        .distinct()
    if (triggers.isEmpty()) return null

    val alternation = triggers.joinToString("|") { Regex.escape(it) }
    // Match: "<anything> <trigger><punct/space> <command>"
    val regex = Regex("(?i)(?:^|\\s)($alternation)\\b[\\s\\p{Punct}]*([\\s\\S]+)$")
    val match = regex.find(raw) ?: return null
    val extracted = match.groupValues.getOrNull(2)?.trim().orEmpty()
    if (extracted.isEmpty()) return null

    val cleaned = extracted.trimStart { it.isWhitespace() || it.isPunctuation() }.trim()
    if (cleaned.isEmpty()) return null
    return cleaned
  }
}

private fun Char.isPunctuation(): Boolean {
  return when (Character.getType(this)) {
    Character.CONNECTOR_PUNCTUATION.toInt(),
    Character.DASH_PUNCTUATION.toInt(),
    Character.START_PUNCTUATION.toInt(),
    Character.END_PUNCTUATION.toInt(),
    Character.INITIAL_QUOTE_PUNCTUATION.toInt(),
    Character.FINAL_QUOTE_PUNCTUATION.toInt(),
    Character.OTHER_PUNCTUATION.toInt(),
    -> true
    else -> false
  }
}
