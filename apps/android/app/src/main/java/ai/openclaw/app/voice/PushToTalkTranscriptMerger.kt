package ai.openclaw.app.voice

import java.util.Locale

internal object PushToTalkTranscriptMerger {
  private val trailingClosers = setOf('"', '\'', '’', '”', ')', ']', '}')

  fun merge(
    finalSegments: List<String>,
    livePartial: String?,
  ): String {
    val segments = finalSegments.map { it.trim() }.filter { it.isNotEmpty() }.toMutableList()
    val partial = livePartial?.trim().orEmpty()
    val lastFinal = segments.lastOrNull()
    if (partial.isNotEmpty() && (lastFinal == null || normalize(partial) != normalize(lastFinal))) {
      segments += partial
    }

    return buildString {
      var previousEndsSentence = false
      segments.forEachIndexed { index, segment ->
        if (index > 0) {
          append(if (previousEndsSentence) " " else ". ")
        }
        append(segment)
        // Recognizers emit locale punctuation (。？؟…); injecting ASCII ". " after those corrupts
        // the transcript. Separate with ". " only when a segment ends in a letter or digit.
        val finalCharacter = segment.trimEnd { it in trailingClosers }.lastOrNull()
        previousEndsSentence = finalCharacter != null && !finalCharacter.isLetterOrDigit()
      }
    }
  }

  private fun normalize(value: String): String =
    value
      .trim()
      .lowercase(Locale.ROOT)
      .replace(Regex("""\s+"""), " ")
}
