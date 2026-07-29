package ai.openclaw.app.node

import ai.openclaw.app.takeUtf16Safe
import android.os.Build
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject

internal object NodePresenceAliveBeacon {
  /** Gateway event emitted by Android when background execution confirms liveness. */
  const val EVENT_NAME: String = "node.presence.alive"

  /** Avoids spamming presence when multiple background triggers fire together. */
  const val MIN_SUCCESS_INTERVAL_MS: Long = 10 * 60 * 1000
  private const val MAX_RESPONSE_JSON_CHARS: Int = 16 * 1024

  /**
   * Source of the liveness event, serialized as gateway-stable wire values.
   */
  enum class Trigger(
    val rawValue: String,
  ) {
    Background("background"),
    SilentPush("silent_push"),
    BackgroundAppRefresh("bg_app_refresh"),
    SignificantLocation("significant_location"),
    Manual("manual"),
    Connect("connect"),
  }

  /**
   * Minimal gateway response fields used to decide whether a liveness event was accepted.
   */
  data class ResponsePayload(
    val ok: Boolean?,
    val event: String?,
    val handled: Boolean?,
    val reason: String?,
  )

  private val json = Json { ignoreUnknownKeys = true }

  /** Skips sends after a recent successful presence update. */
  fun shouldSkipRecentSuccess(
    nowMs: Long,
    lastSuccessAtMs: Long?,
    minIntervalMs: Long = MIN_SUCCESS_INTERVAL_MS,
  ): Boolean {
    val last = lastSuccessAtMs ?: return false
    if (last <= 0) return false
    val elapsed = nowMs - last
    return elapsed >= 0 && elapsed < minIntervalMs
  }

  /** Human-readable Android version label included in presence payloads. */
  fun androidPlatformMetadata(): String {
    val release =
      Build.VERSION.RELEASE
        ?.trim()
        .orEmpty()
        .ifEmpty { "unknown" }
    return "Android $release (SDK ${Build.VERSION.SDK_INT})"
  }

  /** Builds the compact JSON payload consumed by gateway node-presence handlers. */
  fun makePayloadJson(
    trigger: Trigger,
    sentAtMs: Long,
    displayName: String,
    version: String,
    platform: String,
    deviceFamily: String?,
    modelIdentifier: String?,
    pushTransport: String? = null,
  ): String =
    buildJsonObject {
      put("trigger", JsonPrimitive(trigger.rawValue))
      put("sentAtMs", JsonPrimitive(sentAtMs))
      put("displayName", JsonPrimitive(displayName))
      put("version", JsonPrimitive(version))
      put("platform", JsonPrimitive(platform))
      deviceFamily?.trim()?.takeIf { it.isNotEmpty() }?.let { put("deviceFamily", JsonPrimitive(it)) }
      modelIdentifier?.trim()?.takeIf { it.isNotEmpty() }?.let { put("modelIdentifier", JsonPrimitive(it)) }
      pushTransport?.trim()?.takeIf { it.isNotEmpty() }?.let { put("pushTransport", JsonPrimitive(it)) }
    }.toString()

  /** Parses the gateway response while rejecting empty, oversized, or malformed payloads. */
  fun decodeResponse(payloadJson: String?): ResponsePayload? {
    val raw = payloadJson?.trim()?.takeIf { it.isNotEmpty() } ?: return null
    // Bound log/IPC responses before JSON parsing to avoid memory spikes from
    // malformed gateway replies.
    if (raw.length > MAX_RESPONSE_JSON_CHARS) return null
    val obj =
      try {
        json.parseToJsonElement(raw).asObjectOrNull()
      } catch (_: Throwable) {
        null
      } ?: return null
    return ResponsePayload(
      ok = parseJsonBooleanFlag(obj, "ok"),
      event = parseJsonString(obj, "event"),
      handled = parseJsonBooleanFlag(obj, "handled"),
      reason = parseJsonString(obj, "reason"),
    )
  }

  /** Sanitizes gateway response reasons before writing them into Android logs. */
  fun sanitizeReasonForLog(raw: String?): String {
    val value = raw?.trim()?.takeIf { it.isNotEmpty() } ?: "unsupported"
    return value
      .map { ch -> if (ch.isISOControl()) ' ' else ch }
      .joinToString("")
      .takeUtf16Safe(200)
  }
}
