package ai.openclaw.app.node

import ai.openclaw.app.gateway.parseInvokeErrorFromThrowable
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.contentOrNull

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

/**
 * Per-profile accent from a users.prefs.get entries payload. Null for missing or
 * malformed values so callers fall back to the gateway accent.
 */
fun resolveProfileAccentArgb(entries: JsonObject?): Long? {
  val value = entries?.get("ui.accent")?.takeIf { it !is JsonNull }
  return parseHexColorArgb((value as? JsonPrimitive)?.takeIf { it.isString }?.contentOrNull)
}

fun resolveGatewayAccentArgb(config: JsonObject?): Long? {
  val ui = config?.get("ui").asObjectOrNull()
  // Control UI precedence (gateway talk.config): a present user accent wins over the
  // operator seam color even when it is not a usable hex string; only an absent or
  // JSON-null accent falls through, matching the gateway's `??` selection.
  val chosen =
    ui
      ?.get("prefs")
      .asObjectOrNull()
      ?.get("accent")
      ?.takeIf { it !is JsonNull }
      ?: ui?.get("seamColor")
  return parseHexColorArgb((chosen as? JsonPrimitive)?.takeIf { it.isString }?.contentOrNull)
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
