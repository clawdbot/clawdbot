package ai.openclaw.app

/**
 * Wake-word parsing limits and sanitizers shared by settings and voice runtime paths.
 */
object WakeWords {
  const val maxWords: Int = 32
  const val maxWordLength: Int = 64

  /** Splits comma-separated user input into non-empty wake-word entries. */
  fun parseCommaSeparated(input: String): List<String> = input.split(",").map { it.trim() }.filter { it.isNotEmpty() }

  /** Returns null when edited text normalizes to the current wake-word list. */
  fun parseIfChanged(
    input: String,
    current: List<String>,
  ): List<String>? {
    val parsed = parseCommaSeparated(input)
    return if (parsed == current) null else parsed
  }

  /** Applies persisted-list bounds and falls back to defaults when all entries are empty. */
  fun sanitize(
    words: List<String>,
    defaults: List<String>,
  ): List<String> {
    val cleaned =
      words
        .map { it.trim() }
        .filter { it.isNotEmpty() }
        .take(maxWords)
        .map { it.take(maxWordLength) }
    return cleaned.ifEmpty { defaults }
  }
}
