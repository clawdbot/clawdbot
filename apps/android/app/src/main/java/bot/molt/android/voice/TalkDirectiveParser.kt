package bot.molt.android.voice

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive

private val directiveJson = Json { ignoreUnknownKeys = true }

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

data class TalkDirectiveParseResult(
  val directive: TalkDirective?,
  val stripped: String,
  val unknownKeys: List<String>,
)

object TalkDirectiveParser {
  fun parse(text: String): TalkDirectiveParseResult {
    val normalized = text.replace("\r\n", "\n")
    val lines = normalized.split("\n").toMutableList()
    if (lines.isEmpty()) return TalkDirectiveParseResult(null, text, emptyList())

    val firstNonEmpty = lines.indexOfFirst { it.trim().isNotEmpty() }
    if (firstNonEmpty == -1) return TalkDirectiveParseResult(null, text, emptyList())

    val head = lines[firstNonEmpty].trim()
    if (!head.startsWith("{") || !head.endsWith("}")) {
      return TalkDirectiveParseResult(null, text, emptyList())
    }

    val obj = parseJsonObject(head) ?: return TalkDirectiveParseResult(null, text, emptyList())

    val speakerBoost =
      boolValue(obj, listOf("speaker_boost", "speakerBoost"))
        ?: boolValue(obj, listOf("no_speaker_boost", "noSpeakerBoost"))?.not()

    val directive = TalkDirective(
      voiceId = stringValue(obj, listOf("voice", "voice_id", "voiceId")),
      modelId = stringValue(obj, listOf("model", "model_id", "modelId")),
      speed = doubleValue(obj, listOf("speed")),
      rateWpm = intValue(obj, listOf("rate", "wpm")),
      stability = doubleValue(obj, listOf("stability")),
      similarity = doubleValue(obj, listOf("similarity", "similarity_boost", "similarityBoost")),
      style = doubleValue(obj, listOf("style")),
      speakerBoost = speakerBoost,
      seed = longValue(obj, listOf("seed")),
      normalize = stringValue(obj, listOf("normalize", "apply_text_normalization")),
      language = stringValue(obj, listOf("lang", "language_code", "language")),
      outputFormat = stringValue(obj, listOf("output_format", "format")),
      latencyTier = intValue(obj, listOf("latency", "latency_tier", "latencyTier")),
      once = boolValue(obj, listOf("once")),
    )

    val hasDirective = listOf(
      directive.voiceId,
      directive.modelId,
      directive.speed,
      directive.rateWpm,
      directive.stability,
      directive.similarity,
      directive.style,
      directive.speakerBoost,
      directive.seed,
      directive.normalize,
      directive.language,
      directive.outputFormat,
      directive.latencyTier,
      directive.once,
    ).any { it != null }

    if (!hasDirective) return TalkDirectiveParseResult(null, text, emptyList())

    val knownKeys = setOf(
      "voice", "voice_id", "voiceid",
      "model", "model_id", "modelid",
      "speed", "rate", "wpm",
      "stability", "similarity", "similarity_boost", "similarityboost",
      "style",
      "speaker_boost", "speakerboost",
      "no_speaker_boost", "nospeakerboost",
      "seed",
      "normalize", "apply_text_normalization",
      "lang", "language_code", "language",
      "output_format", "format",
      "latency", "latency_tier", "latencytier",
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

  private fun parseJsonObject(line: String): JsonObject? {
    return try {
      directiveJson.parseToJsonElement(line) as? JsonObject
    } catch (_: Throwable) {
      null
    }
  }

  private fun stringValue(obj: JsonObject, keys: List<String>): String? {
    for (key in keys) {
      val value = obj[key].asStringOrNull()?.trim()
      if (!value.isNullOrEmpty()) return value
    }
    return null
  }

  private fun doubleValue(obj: JsonObject, keys: List<String>): Double? {
    for (key in keys) {
      val value = obj[key].asDoubleOrNull()
      if (value != null) return value
    }
    return null
  }

  private fun intValue(obj: JsonObject, keys: List<String>): Int? {
    for (key in keys) {
      val value = obj[key].asIntOrNull()
      if (value != null) return value
    }
    return null
  }

  private fun longValue(obj: JsonObject, keys: List<String>): Long? {
    for (key in keys) {
      val value = obj[key].asLongOrNull()
      if (value != null) return value
    }
    return null
  }

  private fun boolValue(obj: JsonObject, keys: List<String>): Boolean? {
    for (key in keys) {
      val value = obj[key].asBooleanOrNull()
      if (value != null) return value
    }
    return null
  }
}

private fun JsonElement?.asStringOrNull(): String? =
  (this as? JsonPrimitive)?.takeIf { it.isString }?.content

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
  return when (content) {
    "true", "yes", "1" -> true
    "false", "no", "0" -> false
    else -> null
  }
}
