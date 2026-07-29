package ai.openclaw.app.protocol

import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive

object OpenClawCanvasA2UIAction {
  /** Reads the agent-facing action name from either the modern name field or legacy action field. */
  fun extractActionName(userAction: JsonObject): String? {
    val name =
      (userAction["name"] as? JsonPrimitive)
        ?.content
        ?.trim()
        .orEmpty()
    if (name.isNotEmpty()) return name
    val action =
      (userAction["action"] as? JsonPrimitive)
        ?.content
        ?.trim()
        .orEmpty()
    return action.ifEmpty { null }
  }

  /** Normalizes prompt tag values so the compact CANVAS_A2UI envelope stays parser-friendly. */
  fun sanitizeTagValue(value: String): String {
    val trimmed = value.trim().ifEmpty { "-" }
    val normalized = trimmed.replace(" ", "_")
    val out = StringBuilder(normalized.length)
    for (c in normalized) {
      val ok =
        c.isLetterOrDigit() ||
          c == '_' ||
          c == '-' ||
          c == '.' ||
          c == ':'
      out.append(if (ok) c else '_')
    }
    return out.toString()
  }

  /** Formats the compact text envelope sent to the agent when a canvas UI action fires. */
  fun formatAgentMessage(
    actionName: String,
    sessionKey: String,
    surfaceId: String,
    sourceComponentId: String,
    host: String,
    instanceId: String,
    contextJson: String?,
  ): String {
    val ctxSuffix = contextJson?.takeIf { it.isNotBlank() }?.let { " ctx=$it" }.orEmpty()
    return listOf(
      "CANVAS_A2UI",
      "action=${sanitizeTagValue(actionName)}",
      "session=${sanitizeTagValue(sessionKey)}",
      "surface=${sanitizeTagValue(surfaceId)}",
      "component=${sanitizeTagValue(sourceComponentId)}",
      "host=${sanitizeTagValue(host)}",
      "instance=${sanitizeTagValue(instanceId)}$ctxSuffix",
      "default=update_canvas",
    ).joinToString(separator = " ")
  }

  /** Builds JS that reports an agent action result back to the canvas runtime. */
  fun jsDispatchA2UIActionStatus(
    actionId: String,
    ok: Boolean,
    error: String?,
  ): String {
    val err = jsonStringLiteral(error ?: "")
    val okLiteral = if (ok) "true" else "false"
    val idLiteral = jsonStringLiteral(actionId)
    return "window.dispatchEvent(new CustomEvent('openclaw:a2ui-action-status', { detail: { id: $idLiteral, ok: $okLiteral, error: $err } }));"
  }

  private fun jsonStringLiteral(raw: String): String = JsonPrimitive(raw).toString().replace("\u2028", "\\u2028").replace("\u2029", "\\u2029")
}
