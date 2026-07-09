package ai.openclaw.app

import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonArray
import kotlinx.serialization.json.buildJsonObject

internal object AndroidScreenshotFixture {
  const val mainSessionKey = "agent:main:node-screenshot"
  const val primarySessionTitle = "Android release planning"

  val agents =
    listOf(
      GatewayAgentSummary(
        id = "main",
        name = "Molty",
        emoji = "M",
      ),
    )

  val models =
    listOf(
      GatewayModelSummary(
        id = "gpt-5.2",
        name = "GPT-5.2",
        provider = "openai",
        available = true,
        supportsVision = true,
        supportsAudio = true,
        supportsDocuments = true,
        supportsReasoning = true,
        contextTokens = 200_000,
      ),
    )

  val providers =
    listOf(
      GatewayModelProviderSummary(
        id = "openai",
        displayName = "OpenAI",
        status = "ready",
        profileCount = 1,
      ),
    )

  val nodes =
    GatewayNodesDevicesSummary(
      nodes =
        listOf(
          GatewayNodeSummary(
            id = "android-screenshot",
            displayName = "Pixel",
            remoteIp = "100.64.0.24",
            version = BuildConfig.VERSION_NAME,
            deviceFamily = "Android",
            paired = true,
            connected = true,
            approvalState = GatewayNodeApprovalState.Approved,
            pendingRequestId = null,
            capabilities = listOf("camera", "location", "notifications"),
            commands = emptyList(),
          ),
        ),
      pendingDevices = emptyList(),
      pairedDevices = emptyList(),
    )

  val channels =
    GatewayChannelsSummary(
      updatedAtMs = 1_783_555_200_000,
      channels =
        listOf(
          GatewayChannelSummary(
            id = "discord",
            label = "Discord",
            accountCount = 1,
            enabled = true,
            configured = true,
            linked = true,
            running = true,
            connected = true,
            error = null,
          ),
        ),
    )

  fun request(
    method: String,
    paramsJson: String?,
  ): String =
    when (method) {
      "health" -> buildJsonObject { put("ok", JsonPrimitive(true)) }.toString()
      "chat.history" -> chatHistory()
      "sessions.list" -> sessionList()
      "chat.metadata" -> chatMetadata()
      else -> error("Screenshot fixture does not implement gateway method $method with params $paramsJson")
    }

  private fun chatHistory(): String =
    buildJsonObject {
      put("sessionId", JsonPrimitive("screenshot-session"))
      put("thinkingLevel", JsonPrimitive("low"))
      put("messages", buildJsonArray {})
      put(
        "sessionInfo",
        buildJsonObject {
          put("key", JsonPrimitive(mainSessionKey))
          put("displayName", JsonPrimitive("New chat"))
          put("updatedAt", JsonPrimitive(1_783_555_200_000))
          put("unread", JsonPrimitive(false))
          put("modelProvider", JsonPrimitive("openai"))
          put("model", JsonPrimitive("gpt-5.2"))
          put("contextTokens", JsonPrimitive(200_000))
        },
      )
    }.toString()

  private fun sessionList(): String =
    buildJsonObject {
      put(
        "sessions",
        buildJsonArray {
          add(session("discord:release-planning", primarySessionTitle, 1_783_555_200_000))
          add(session("main", "Product notes", 1_783_468_800_000))
          add(session("discord:android", "Android QA", 1_783_382_400_000))
        },
      )
      put("totalCount", JsonPrimitive(3))
    }.toString()

  private fun session(
    key: String,
    displayName: String,
    updatedAt: Long,
  ) = buildJsonObject {
    put("key", JsonPrimitive(key))
    put("displayName", JsonPrimitive(displayName))
    put("updatedAt", JsonPrimitive(updatedAt))
    put("lastActivityAt", JsonPrimitive(updatedAt))
    put("unread", JsonPrimitive(false))
    put("archived", JsonPrimitive(false))
    put("category", JsonNull)
    put("modelProvider", JsonPrimitive("openai"))
    put("model", JsonPrimitive("gpt-5.2"))
    put("totalTokens", JsonPrimitive(18_420))
    put("contextTokens", JsonPrimitive(200_000))
  }

  private fun chatMetadata(): String =
    buildJsonObject {
      put(
        "commands",
        buildJsonArray {
          add(
            buildJsonObject {
              put("name", JsonPrimitive("status"))
              put("description", JsonPrimitive("Show current OpenClaw status"))
              put("acceptsArgs", JsonPrimitive(false))
            },
          )
        },
      )
      put(
        "models",
        buildJsonArray {
          add(
            buildJsonObject {
              put("id", JsonPrimitive("gpt-5.2"))
              put("name", JsonPrimitive("GPT-5.2"))
              put("provider", JsonPrimitive("openai"))
              put("available", JsonPrimitive(true))
              put("reasoning", JsonPrimitive(true))
              put("contextWindow", JsonPrimitive(200_000))
              put(
                "input",
                buildJsonArray {
                  add(JsonPrimitive("text"))
                  add(JsonPrimitive("image"))
                  add(JsonPrimitive("audio"))
                  add(JsonPrimitive("document"))
                },
              )
            },
          )
        },
      )
    }.toString()
}
