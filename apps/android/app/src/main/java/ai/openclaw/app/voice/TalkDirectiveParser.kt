package ai.openclaw.app.voice

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive

private val directiveJson = Json { ignoreUnknownKeys = true }

/**
 * Optional first-line JSON overrides for one Talk request.
 */
data class TalkDirective(
  val voiceId: String? = null,
  val modelId: String? = null,
  val speed: Double? = null,
  val rateWpm: Int? = null,
  val stability: Double? = null,
  val similarity: Double? = null,
  val style: Double? = null,
  val speakerBoost: Boolean? = null,
  val seed: Long? = null,
  val normalize: String? = null,
  val language: String? = null,
  val outputFormat: String? = null,
  val latencyTier: Int? = null,
  val once: Boolean? = null,
)

/**
 * Parsed directive plus the utterance text after removing the directive line.
 */
data class TalkDirectiveParseResult(
  val directive: TalkDirective?,
  val stripped: String,
  val unknownKeys: List<String>,
)

object TalkDirectiveParser {
  /** Parses optional first-line JSON directives while preserving normal speech text. */
  fun parse(text: String): TalkDirectiveParseResult {
    val normalized = text.replace("\r\n", "\n")
    val lines = normalized.split("\n").toMutableList()
    if (lines.isEmpty()) return TalkDirectiveParseResult(null, text, emptyList())

    val firstNonEmpty = lines.indexOfFirst { it.trim().isNotEmpty() }
    if (firstNonEmpty == -1) return TalkDirectiveParseResult(null, text, emptyList())

    val head = lines[firstNonEmpty].trim()
    // Directives are accepted only as a complete first-line JSON object; spoken text remains plain text.
    if (!head.startsWith("{") || !head.endsWith("}")) {
      return TalkDirectiveParseResult(null, text, emptyList())
    }

    val obj = parseJsonObject(head) ?: return TalkDirectiveParseResult(null, text, emptyList())

    val speakerBoost =
      obj.readAlias(listOf("speaker_boost", "speakerBoost")) { it.asBooleanOrNull() }
        ?: obj.readAlias(listOf("no_speaker_boost", "noSpeakerBoost")) { it.asBooleanOrNull() }?.not()

    val directive =
      TalkDirective(
        voiceId = obj.readAlias(listOf("voice", "voice_id", "voiceId")) { it.asStringOrNull() },
        modelId = obj.readAlias(listOf("model", "model_id", "modelId")) { it.asStringOrNull() },
        speed = obj.readAlias(listOf("speed")) { it.asDoubleOrNull() },
        rateWpm = obj.readAlias(listOf("rate", "wpm")) { it.asIntOrNull() },
        stability = obj.readAlias(listOf("stability")) { it.asDoubleOrNull() },
        similarity = obj.readAlias(listOf("similarity", "similarity_boost", "similarityBoost")) { it.asDoubleOrNull() },
        style = obj.readAlias(listOf("style")) { it.asDoubleOrNull() },
        speakerBoost = speakerBoost,
        seed = obj.readAlias(listOf("seed")) { it.asLongOrNull() },
        normalize = obj.readAlias(listOf("normalize", "apply_text_normalization")) { it.asStringOrNull() },
        language = obj.readAlias(listOf("lang", "language_code", "language")) { it.asStringOrNull() },
        outputFormat = obj.readAlias(listOf("output_format", "format")) { it.asStringOrNull() },
        latencyTier = obj.readAlias(listOf("latency", "latency_tier", "latencyTier")) { it.asIntOrNull() },
        once = obj.readAlias(listOf("once")) { it.asBooleanOrNull() },
      )

    if (directive == TalkDirective()) return TalkDirectiveParseResult(null, text, emptyList())

    // Keep alias matching case-insensitive so dictated JSON can use snake/camel variants.
    val knownKeys =
      setOf(
        "voice",
        "voice_id",
        "voiceid",
        "model",
        "model_id",
        "modelid",
        "speed",
        "rate",
        "wpm",
        "stability",
        "similarity",
        "similarity_boost",
        "similarityboost",
        "style",
        "speaker_boost",
        "speakerboost",
        "no_speaker_boost",
        "nospeakerboost",
        "seed",
        "normalize",
        "apply_text_normalization",
        "lang",
        "language_code",
        "language",
        "output_format",
        "format",
        "latency",
        "latency_tier",
        "latencytier",
        "once",
      )
    val unknownKeys = obj.keys.filter { !knownKeys.contains(it.lowercase()) }.sorted()

    lines.removeAt(firstNonEmpty)
    if (firstNonEmpty < lines.size) {
      if (lines[firstNonEmpty].trim().isEmpty()) {
        lines.removeAt(firstNonEmpty)
      }
    }

    return TalkDirectiveParseResult(directive, lines.joinToString("\n"), unknownKeys)
  }

  private fun parseJsonObject(line: String): JsonObject? =
    try {
      directiveJson.parseToJsonElement(line) as? JsonObject
    } catch (_: Throwable) {
      null
    }

  private inline fun <T : Any> JsonObject.readAlias(
    keys: List<String>,
    convert: (JsonElement?) -> T?,
  ): T? = keys.firstNotNullOfOrNull { convert(valueForKey(it)) }

  private fun JsonObject.valueForKey(key: String): JsonElement? = this[key] ?: entries.firstOrNull { it.key.equals(key, ignoreCase = true) }?.value
}

private fun JsonElement?.asStringOrNull(): String? =
  (this as? JsonPrimitive)
    ?.takeIf { it.isString }
    ?.content
    ?.trim()
    ?.takeIf { it.isNotEmpty() }

private fun JsonElement?.asDoubleOrNull(): Double? {
  val primitive = this as? JsonPrimitive ?: return null
  return primitive.content.toDoubleOrNull()
}

private fun JsonElement?.asIntOrNull(): Int? {
  val primitive = this as? JsonPrimitive ?: return null
  return primitive.content.toIntOrNull()
}

private fun JsonElement?.asLongOrNull(): Long? {
  val primitive = this as? JsonPrimitive ?: return null
  return primitive.content.toLongOrNull()
}

private fun JsonElement?.asBooleanOrNull(): Boolean? {
  val primitive = this as? JsonPrimitive ?: return null
  val content = primitive.content.trim().lowercase()
  // Accept dictated/config-style booleans in addition to strict JSON literals.
  return when (content) {
    "true", "yes", "1" -> true
    "false", "no", "0" -> false
    else -> null
  }
}
