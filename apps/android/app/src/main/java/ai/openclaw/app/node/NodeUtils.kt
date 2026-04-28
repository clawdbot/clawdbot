package ai.openclaw.app.node

import ai.openclaw.app.gateway.parseInvokeErrorFromThrowable
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.contentOrNull

const val DEFAULT_SEAM_COLOR_ARGB: Long = 0xFF4F7A9A

data class Quad<A, B, C, D>(
  val first: A,
  val second: B,
  val third: C,
  val fourth: D,
)

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

fun parseJsonParamsObject(paramsJson: String?): JsonObject? {
  if (paramsJson.isNullOrBlank()) return null
  return try {
    Json.parseToJsonElement(paramsJson).asObjectOrNull()
  } catch (_: Throwable) {
    null
  }
}

fun readJsonPrimitive(
  params: JsonObject?,
  key: String,
): JsonPrimitive? = params?.get(key) as? JsonPrimitive

fun parseJsonInt(
  params: JsonObject?,
  key: String,
): Int? = readJsonPrimitive(params, key)?.contentOrNull?.toIntOrNull()

fun parseJsonDouble(
  params: JsonObject?,
  key: String,
): Double? = readJsonPrimitive(params, key)?.contentOrNull?.toDoubleOrNull()

fun parseJsonString(
  params: JsonObject?,
  key: String,
): String? = readJsonPrimitive(params, key)?.contentOrNull

fun parseJsonBooleanFlag(
  params: JsonObject?,
  key: String,
): Boolean? {
  val value = readJsonPrimitive(params, key)?.contentOrNull?.trim()?.lowercase() ?: return null
  return when (value) {
    "true" -> true
    "false" -> false
    else -> null
  }
}

fun JsonElement?.asStringOrNull(): String? =
  when (this) {
    is JsonNull -> null
    is JsonPrimitive -> content
    else -> null
  }

fun parseHexColorArgb(raw: String?): Long? {
  val trimmed = raw?.trim().orEmpty()
  if (trimmed.isEmpty()) return null
  val hex = if (trimmed.startsWith("#")) trimmed.drop(1) else trimmed
  if (hex.length != 6) return null
  val rgb = hex.toLongOrNull(16) ?: return null
  return 0xFF000000L or rgb
}

fun invokeErrorFromThrowable(err: Throwable): Pair<String, String> {
  val parsed = parseInvokeErrorFromThrowable(err, fallbackMessage = "UNAVAILABLE: error")
  val message = if (parsed.hadExplicitCode) parsed.prefixedMessage else parsed.message
  return parsed.code to message
}

fun normalizeMainKey(raw: String?): String? {
  val trimmed = raw?.trim().orEmpty()
  return if (trimmed.isEmpty()) null else trimmed
}

fun isCanonicalMainSessionKey(key: String): Boolean = key == "main"
