package ai.openclaw.app.node

import kotlinx.coroutines.delay
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive

class A2UIHandler(
  private val canvas: CanvasController,
  private val json: Json,
  private val getNodeCanvasHostUrl: () -> String?,
  private val getOperatorCanvasHostUrl: () -> String?,
) {
  fun isTrustedCanvasActionUrl(rawUrl: String?): Boolean =
    CanvasActionTrust.isTrustedCanvasActionUrl(
      rawUrl = rawUrl,
      trustedA2uiUrls = listOfNotNull(resolveA2uiHostUrl()),
    )

  fun resolveA2uiHostUrl(): String? {
    val nodeRaw = getNodeCanvasHostUrl()?.trim().orEmpty()
    val operatorRaw = getOperatorCanvasHostUrl()?.trim().orEmpty()
    val raw = if (nodeRaw.isNotBlank()) nodeRaw else operatorRaw
    if (raw.isBlank()) return null
    val base = raw.trimEnd('/')
    return "$base/__openclaw__/a2ui/?platform=android"
  }

  suspend fun ensureA2uiReady(a2uiUrl: String): Boolean {
    try {
      val already = canvas.eval(a2uiReadyCheckJS)
      if (already == "true") return true
    } catch (_: Throwable) {
      // ignore
    }

    canvas.navigate(a2uiUrl)
    repeat(50) {
      try {
        val ready = canvas.eval(a2uiReadyCheckJS)
        if (ready == "true") return true
      } catch (_: Throwable) {
        // ignore
      }
      delay(120)
    }
    return false
  }

  fun decodeA2uiMessages(
    command: String,
    paramsJson: String?,
  ): String {
    val raw = paramsJson?.trim().orEmpty()
    if (raw.isBlank()) throw IllegalArgumentException("INVALID_REQUEST: paramsJSON required")

    val obj =
      json.parseToJsonElement(raw) as? JsonObject
        ?: throw IllegalArgumentException("INVALID_REQUEST: expected object params")

    val jsonlField = (obj["jsonl"] as? JsonPrimitive)?.content?.trim().orEmpty()
    val hasMessagesArray = obj["messages"] is JsonArray

    if (command == "canvas.a2ui.pushJSONL" || (!hasMessagesArray && jsonlField.isNotBlank())) {
      val jsonl = jsonlField
      if (jsonl.isBlank()) throw IllegalArgumentException("INVALID_REQUEST: jsonl required")
      val messages =
        jsonl
          .lineSequence()
          .map { it.trim() }
          .filter { it.isNotBlank() }
          .mapIndexed { idx, line ->
            val el = json.parseToJsonElement(line)
            val msg =
              el as? JsonObject
                ?: throw IllegalArgumentException("A2UI JSONL line ${idx + 1}: expected a JSON object")
            validateA2uiV0_8(msg, idx + 1)
            msg
          }.toList()
      return JsonArray(messages).toString()
    }

    val arr = obj["messages"] as? JsonArray ?: throw IllegalArgumentException("INVALID_REQUEST: messages[] required")
    val out =
      arr.mapIndexed { idx, el ->
        val msg =
          el as? JsonObject
            ?: throw IllegalArgumentException("A2UI messages[$idx]: expected a JSON object")
        validateA2uiV0_8(msg, idx + 1)
        msg
      }
    return JsonArray(out).toString()
  }

  private fun validateA2uiV0_8(
    msg: JsonObject,
    lineNumber: Int,
  ) {
    if (msg.containsKey("createSurface")) {
      throw IllegalArgumentException(
        "A2UI JSONL line $lineNumber: looks like A2UI v0.9 (`createSurface`). Canvas supports v0.8 messages only.",
      )
    }
    val allowed = setOf("beginRendering", "surfaceUpdate", "dataModelUpdate", "deleteSurface")
    val matched = msg.keys.filter { allowed.contains(it) }
    if (matched.size != 1) {
      val found = msg.keys.sorted().joinToString(", ")
      throw IllegalArgumentException(
        "A2UI JSONL line $lineNumber: expected exactly one of ${allowed.sorted().joinToString(", ")}; found: $found",
      )
    }
  }

  companion object {
    const val a2uiReadyCheckJS: String =
      """
      (() => {
        try {
          const host = globalThis.openclawA2UI;
          return !!host && typeof host.applyMessages === 'function';
        } catch (_) {
          return false;
        }
      })()
      """

    const val a2uiResetJS: String =
      """
      (() => {
        try {
          const host = globalThis.openclawA2UI;
          if (!host) return { ok: false, error: "missing openclawA2UI" };
          return host.reset();
        } catch (e) {
          return { ok: false, error: String(e?.message ?? e) };
        }
      })()
      """

    fun a2uiApplyMessagesJS(messagesJson: String): String =
      """
      (() => {
        try {
          const host = globalThis.openclawA2UI;
          if (!host) return { ok: false, error: "missing openclawA2UI" };
          const messages = $messagesJson;
          return host.applyMessages(messages);
        } catch (e) {
          return { ok: false, error: String(e?.message ?? e) };
        }
      })()
      """.trimIndent()
  }
}
