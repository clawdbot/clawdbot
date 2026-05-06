package ai.openclaw.app.voice

import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive

internal object ChatEventText {
  fun assistantTextFromPayload(payload: JsonObject): String? = assistantTextFromMessage(payload["message"])

  fun assistantTextFromMessage(messageEl: JsonElement?): String? {
    val message = messageEl.asObjectOrNull() ?: return null
    val role = message["role"].asStringOrNull()
    if (role != null && role != "assistant") return null
    return textFromContent(message["content"])
  }

  private fun textFromContent(content: JsonElement?): String? =
    when (content) {
      is JsonPrimitive -> content.asStringOrNull()?.trim()?.takeIf { it.isNotEmpty() }
      is JsonArray ->
        content
          .mapNotNull(::textFromContentPart)
          .filter { it.isNotEmpty() }
          .joinToString("\n")
          .takeIf { it.isNotBlank() }
      else -> null
    }

  private fun textFromContentPart(part: JsonElement): String? {
    part
      .asStringOrNull()
      ?.trim()
      ?.takeIf { it.isNotEmpty() }
      ?.let { return it }
    val obj = part.asObjectOrNull() ?: return null
    val type = obj["type"].asStringOrNull()
    if (type != null && type != "text") return null
    return obj["text"].asStringOrNull()?.trim()?.takeIf { it.isNotEmpty() }
  }
}

private fun JsonElement?.asObjectOrNull(): JsonObject? = this as? JsonObject

private fun JsonElement?.asStringOrNull(): String? = (this as? JsonPrimitive)?.takeIf { it.isString }?.content
