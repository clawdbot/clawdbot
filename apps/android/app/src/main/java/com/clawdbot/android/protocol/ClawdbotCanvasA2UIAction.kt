package com.clawdbot.android.protocol

import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive

object MoltbotCanvasA2UIAction {
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

  fun jsDispatchA2UIActionStatus(actionId: String, ok: Boolean, error: String?): String {
    val err = (error ?: "").replace("\\", "\\\\").replace("\"", "\\\"")
    val okLiteral = if (ok) "true" else "false"
    val idEscaped = actionId.replace("\\", "\\\\").replace("\"", "\\\"")
    return "window.dispatchEvent(new CustomEvent('moltbot:a2ui-action-status', { detail: { id: \"${idEscaped}\", ok: ${okLiteral}, error: \"${err}\" } }));"
  }
}
