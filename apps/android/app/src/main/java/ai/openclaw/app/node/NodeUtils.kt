package ai.openclaw.app.node

import ai.openclaw.app.gateway.parseInvokeErrorFromThrowable
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.contentOrNull

/** Default canvas seam color used when gateway/user params omit a hex color. */
const val DEFAULT_SEAM_COLOR_ARGB: Long = 0xFF4F7A9A

/** Small tuple used by Android node handlers that need four return values. */
data class Quad<A, B, C, D>(
  val first: A,
  val second: B,
  val third: C,
  val fourth: D,
)

/** Escapes a Kotlin string into a JSON string literal without building a JsonElement. */
fun String.toJsonString(): String {
  val escaped =
    this
      .replace("\\", "\\\\")
      .replace("\"", "\\\"")
      .replace("\n", "\\n")
      .replace("\r", "\\r")
  return "\"$escaped\""
}

fun JsonElement?.asObjectOrNull(): JsonObject? = this as? JsonObject

/** Parses invoke params into a JSON object, returning null for absent/malformed input. */
fun parseJsonParamsObject(paramsJson: String?): JsonObject? {
  if (paramsJson.isNullOrBlank()) return null
  return try {
    Json.parseToJsonElement(paramsJson).asObjectOrNull()
  } catch (_: Throwable) {
    null
  }
}

/** Reads a primitive field from invoke params without accepting arrays/objects. */
fun readJsonPrimitive(
  params: JsonObject?,
  key: String,
): JsonPrimitive? = params?.get(key) as? JsonPrimitive

/** Parses an optional integer invoke param. */
fun parseJsonInt(
  params: JsonObject?,
  key: String,
): Int? = readJsonPrimitive(params, key)?.contentOrNull?.toIntOrNull()

/** Parses an optional decimal invoke param. */
fun parseJsonDouble(
  params: JsonObject?,
  key: String,
): Double? = readJsonPrimitive(params, key)?.contentOrNull?.toDoubleOrNull()

/** Parses an optional string invoke param. */
fun parseJsonString(
  params: JsonObject?,
  key: String,
): String? = readJsonPrimitive(params, key)?.contentOrNull

/** Parses true/false flags from JSON primitives, including common string aliases. */
fun parseJsonBooleanFlag(
  params: JsonObject?,
  key: String,
): Boolean? {
  val value = readJsonPrimitive(params, key)?.contentOrNull?.trim()?.lowercase() ?: return null
  return when (value) {
    "true", "yes", "1" -> true
    "false", "no", "0" -> false
    else -> null
  }
}

/** Converts JSON null to Kotlin null while preserving primitive text content. */
fun JsonElement?.asStringOrNull(): String? =
  when (this) {
    is JsonNull -> null
    is JsonPrimitive -> content
    else -> null
  }

/** Parses #RRGGBB or RRGGBB into opaque ARGB. */
fun parseHexColorArgb(raw: String?): Long? {
  val trimmed = raw?.trim().orEmpty()
  if (trimmed.isEmpty()) return null
  val hex = if (trimmed.startsWith("#")) trimmed.drop(1) else trimmed
  if (hex.length != 6) return null
  val rgb = hex.toLongOrNull(16) ?: return null
  return 0xFF000000L or rgb
}

/** Converts gateway invocation throwables into protocol code/message pairs. */
fun invokeErrorFromThrowable(err: Throwable): Pair<String, String> {
  val parsed = parseInvokeErrorFromThrowable(err, fallbackMessage = "UNAVAILABLE: error")
  val message = if (parsed.hadExplicitCode) parsed.prefixedMessage else parsed.message
  return parsed.code to message
}

/** Normalizes user/session keys while preserving main as the canonical session id. */
fun normalizeMainKey(raw: String?): String? {
  val trimmed = raw?.trim().orEmpty()
  return if (trimmed.isEmpty()) null else trimmed
}
