package ai.openclaw.app.voice

import ai.openclaw.app.takeUtf16Safe

internal object VoiceWakePreferences {
  val defaultTriggerWords: List<String> = listOf("openclaw", "claude", "computer")
  const val maxWords = 32
  const val maxWordLength = 64

  fun sanitizeTriggerWords(words: List<String>): List<String> {
    val cleaned =
      words
        .asSequence()
        .map(String::trim)
        .filter(String::isNotEmpty)
        .take(maxWords)
        .map { it.takeUtf16Safe(maxWordLength) }
        .toList()
    return cleaned.ifEmpty { defaultTriggerWords }
  }
}

internal data class VoiceWakeMatch(
  val trigger: String,
  val command: String,
)

internal object VoiceWakePhraseMatcher {
  private val wakePrefixFillers =
    setOf(
      "a",
      "ah",
      "eh",
      "er",
      "erm",
      "hey",
      "hmm",
      "huh",
      "mhm",
      "mm",
      "oh",
      "uh",
      "um",
      "yo",
      "呃",
      "嗯",
      "啊",
      "诶",
      "欸",
    )

  fun match(
    transcript: String,
    triggers: List<String>,
  ): VoiceWakeMatch? {
    val normalizedTranscript = normalizeSpokenText(transcript)
    if (normalizedTranscript.value.isEmpty()) return null

    return VoiceWakePreferences
      .sanitizeTriggerWords(triggers)
      .asSequence()
      .mapNotNull { trigger -> matchTrigger(transcript, normalizedTranscript, trigger) }
      .minByOrNull { it.first }
      ?.second
  }

  private fun matchTrigger(
    transcript: String,
    normalizedTranscript: NormalizedSpokenText,
    trigger: String,
  ): Pair<Int, VoiceWakeMatch>? {
    val normalizedTrigger = normalizeSpokenText(trigger).value
    if (normalizedTrigger.isEmpty()) return null
    var start = normalizedTranscript.value.indexOf(normalizedTrigger)
    while (start >= 0) {
      val end = start + normalizedTrigger.length
      if (
        isBoundary(normalizedTranscript.value, start - 1, normalizedTrigger.codePointAt(0)) &&
        isBoundary(normalizedTranscript.value, end, normalizedTrigger.codePointBefore(normalizedTrigger.length)) &&
        hasOnlyWakeFillers(normalizedTranscript.value.substring(0, start))
      ) {
        val originalStart = normalizedTranscript.originalStarts[start]
        val originalEnd = normalizedTranscript.originalEnds[end - 1]
        val command = transcript.substring(originalEnd).trimStart { !it.isLetterOrDigit() }.trim()
        if (command.isNotEmpty()) {
          return originalStart to VoiceWakeMatch(trigger = transcript.substring(originalStart, originalEnd), command = command)
        }
      }
      start = normalizedTranscript.value.indexOf(normalizedTrigger, startIndex = start + 1)
    }
    return null
  }

  private data class NormalizedSpokenText(
    val value: String,
    val originalStarts: IntArray,
    val originalEnds: IntArray,
  )

  private fun normalizeSpokenText(source: String): NormalizedSpokenText {
    val value = StringBuilder()
    val originalStarts = mutableListOf<Int>()
    val originalEnds = mutableListOf<Int>()
    var sourceIndex = 0
    var pendingSeparatorStart: Int? = null
    var previousSpokenCodePoint: Int? = null
    while (sourceIndex < source.length) {
      val codePoint = source.codePointAt(sourceIndex)
      val nextSourceIndex = sourceIndex + Character.charCount(codePoint)
      if (Character.isLetterOrDigit(codePoint)) {
        val separatorStart = pendingSeparatorStart
        val previousCodePoint = previousSpokenCodePoint
        if (
          separatorStart != null &&
          previousCodePoint != null &&
          !doesNotUseWhitespaceWordBoundaries(previousCodePoint) &&
          !doesNotUseWhitespaceWordBoundaries(codePoint)
        ) {
          value.append(' ')
          originalStarts += separatorStart
          originalEnds += sourceIndex
        }
        val folded = String(Character.toChars(codePoint)).lowercase()
        folded.forEach {
          value.append(it)
          originalStarts += sourceIndex
          originalEnds += nextSourceIndex
        }
        previousSpokenCodePoint = codePoint
        pendingSeparatorStart = null
      } else if (value.isNotEmpty() && pendingSeparatorStart == null) {
        pendingSeparatorStart = sourceIndex
      }
      sourceIndex = nextSourceIndex
    }
    return NormalizedSpokenText(
      value = value.toString(),
      originalStarts = originalStarts.toIntArray(),
      originalEnds = originalEnds.toIntArray(),
    )
  }

  private fun isBoundary(
    value: String,
    index: Int,
    triggerEdgeCodePoint: Int,
  ): Boolean =
    index !in value.indices ||
      !value[index].isLetterOrDigit() ||
      doesNotUseWhitespaceWordBoundaries(triggerEdgeCodePoint)

  private fun doesNotUseWhitespaceWordBoundaries(codePoint: Int): Boolean =
    when (Character.UnicodeScript.of(codePoint)) {
      Character.UnicodeScript.BOPOMOFO,
      Character.UnicodeScript.HAN,
      Character.UnicodeScript.HANGUL,
      Character.UnicodeScript.HIRAGANA,
      Character.UnicodeScript.KATAKANA,
      Character.UnicodeScript.KHMER,
      Character.UnicodeScript.LAO,
      Character.UnicodeScript.MYANMAR,
      Character.UnicodeScript.THAI,
      -> true
      else -> false
    }

  private fun hasOnlyWakeFillers(prefix: String): Boolean =
    prefix
      .split(Regex("[^\\p{L}\\p{N}]+"))
      .filter(String::isNotEmpty)
      .all { it.lowercase() in wakePrefixFillers }
}
