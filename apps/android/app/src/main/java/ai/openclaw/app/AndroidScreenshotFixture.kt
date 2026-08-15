package ai.openclaw.app

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonArray
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive

internal object AndroidScreenshotFixture {
  @Volatile private var scene: AndroidScreenshotScene = AndroidScreenshotScene.Home

  fun configure(scene: AndroidScreenshotScene) {
    this.scene = scene
  }

  const val gatewayId = "android-screenshot-gateway"
  const val controlUiBaseUrl = "http://127.0.0.1:18789"
  const val mainSessionKey = "agent:main:node-screenshot"
  const val primarySessionTitle = "Android release planning"
  const val cronJobId = "android-release-digest"
  const val cronJobName = "Android release digest"

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
        supportsVideo = true,
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
      "sessions.list" -> sessionList(paramsJson)
      "chat.metadata" -> chatMetadata()
      "cron.list" -> cronList()
      "cron.get" -> cronJob().toString()
      "cron.runs" -> cronRuns()
      "openclaw.chat" -> systemAgentChat(paramsJson)
      else -> error("Screenshot fixture does not implement gateway method $method with params $paramsJson")
    }

  private fun systemAgentChat(paramsJson: String?): String {
    val message =
      paramsJson
        ?.let { Json.parseToJsonElement(it).jsonObject["message"] }
        ?.jsonPrimitive
        ?.contentOrNull
    return buildJsonObject {
      put("sessionId", JsonPrimitive("android-screenshot-openclaw"))
      put(
        "reply",
        JsonPrimitive(
          if (message == null) {
            "I can check Gateway status, repair configuration, change models, or connect channels."
          } else {
            "I’ll keep this conversation separate from ordinary agent chat."
          },
        ),
      )
      put("action", JsonPrimitive("none"))
      if (message == null) {
        put(
          "question",
          buildJsonObject {
            put("id", JsonPrimitive("help"))
            put("header", JsonPrimitive("OpenClaw"))
            put("question", JsonPrimitive("What should we look at first?"))
            put(
              "options",
              buildJsonArray {
                add(
                  buildJsonObject {
                    put("label", JsonPrimitive("Check status"))
                    put("description", JsonPrimitive("Review the Gateway and active services."))
                    put("recommended", JsonPrimitive(true))
                    put("reply", JsonPrimitive("Check Gateway status"))
                  },
                )
                add(
                  buildJsonObject {
                    put("label", JsonPrimitive("Review setup"))
                    put("description", JsonPrimitive("Inspect models, channels, and configuration."))
                    put("reply", JsonPrimitive("Review setup"))
                  },
                )
              },
            )
          },
        )
      }
    }.toString()
  }

  private fun cronList(): String =
    buildJsonObject {
      put(
        "jobs",
        buildJsonArray {
          add(cronJob())
        },
      )
    }.toString()

  private fun cronJob() =
    buildJsonObject {
      put("id", JsonPrimitive(cronJobId))
      put("name", JsonPrimitive(cronJobName))
      put("enabled", JsonPrimitive(true))
      put("createdAtMs", JsonPrimitive(1_783_468_800_000))
      put("updatedAtMs", JsonPrimitive(1_783_555_200_000))
      put("configRevision", JsonPrimitive("sha256:screenshot-fixture"))
      put(
        "schedule",
        buildJsonObject {
          put("kind", JsonPrimitive("every"))
          put("everyMs", JsonPrimitive(86_400_000))
          put("anchorMs", JsonPrimitive(1_783_468_800_000))
        },
      )
      put("sessionTarget", JsonPrimitive("isolated"))
      put("wakeMode", JsonPrimitive("now"))
      put(
        "payload",
        buildJsonObject {
          put("kind", JsonPrimitive("agentTurn"))
          put("message", JsonPrimitive("Summarize Android release readiness."))
          put("model", JsonPrimitive("openai/gpt-5.2"))
        },
      )
      put(
        "state",
        buildJsonObject {
          put("nextRunAtMs", JsonPrimitive(1_783_641_600_000))
          put("lastRunAtMs", JsonPrimitive(1_783_555_200_000))
          put("lastStatus", JsonPrimitive("ok"))
          put("lastDurationMs", JsonPrimitive(1_842))
          put("consecutiveErrors", JsonPrimitive(0))
          put("consecutiveSkipped", JsonPrimitive(0))
          put("lastDeliveryStatus", JsonPrimitive("delivered"))
        },
      )
    }

  private fun cronRuns(): String =
    buildJsonObject {
      put(
        "entries",
        buildJsonArray {
          add(
            buildJsonObject {
              put("ts", JsonPrimitive(1_783_555_200_000))
              put("jobId", JsonPrimitive(cronJobId))
              put("runId", JsonPrimitive("android-release-digest-run-2"))
              put("action", JsonPrimitive("finished"))
              put("status", JsonPrimitive("ok"))
              put("summary", JsonPrimitive("Release checklist ready"))
              put("durationMs", JsonPrimitive(1_842))
              put("deliveryStatus", JsonPrimitive("delivered"))
              put("model", JsonPrimitive("openai/gpt-5.2"))
            },
          )
          add(
            buildJsonObject {
              put("ts", JsonPrimitive(1_783_468_800_000))
              put("jobId", JsonPrimitive(cronJobId))
              put("runId", JsonPrimitive("android-release-digest-run-1"))
              put("action", JsonPrimitive("finished"))
              put("status", JsonPrimitive("error"))
              put("error", JsonPrimitive("Play publish blocked"))
              put("durationMs", JsonPrimitive(927))
              put("deliveryStatus", JsonPrimitive("not-requested"))
              put("model", JsonPrimitive("openai/gpt-5.2"))
            },
          )
        },
      )
    }.toString()

  private fun chatHistory(): String =
    buildJsonObject {
      put("sessionId", JsonPrimitive("screenshot-session"))
      put("thinkingLevel", JsonPrimitive("low"))
      put(
        "messages",
        buildJsonArray {
          add(chatMessage("user", "What is blocking the Android release?", 1_783_555_020_000))
          add(
            chatMessage(
              "assistant",
              "Two review threads are still open on the release branch, and the localization sync needs one more pass. " +
                "Once those land, the changelog draft is ready for review and the tag can go out.",
              1_783_555_080_000,
            ),
          )
          add(
            chatMessage(
              role = "user",
              content = "[System] Continue the interrupted turn.",
              timestamp = 1_783_555_100_000,
              provenanceSourceTool = "main_session_restart_recovery",
            ),
          )
          add(
            chatMessage(
              role = "user",
              content = "[System] Gateway restarted during the Android release update.",
              timestamp = 1_783_555_120_000,
              provenanceSourceTool = "restart-sentinel",
            ),
          )
          add(chatMessage("user", "Summarize the open review feedback for me.", 1_783_555_140_000))
          add(
            chatMessage(
              "assistant",
              "The main thread asks for a regression test around session restore, and the second one wants the new " +
                "config key documented before merge. Both are small; I can draft patches for each if you want.",
              1_783_555_200_000,
            ),
          )
          add(
            chatMessage(
              role = "system",
              content = "Compaction",
              timestamp = 1_783_555_220_000,
              marker =
                buildJsonObject {
                  put("kind", JsonPrimitive("compaction"))
                  put("id", JsonPrimitive("android-screenshot-compaction"))
                  put("tokensBefore", JsonPrimitive(900_000))
                  put("tokensAfter", JsonPrimitive(24_700))
                },
            ),
          )
          add(
            chatMessage(
              role = "system",
              content = "Reset",
              timestamp = 1_783_555_240_000,
              marker =
                buildJsonObject {
                  put("kind", JsonPrimitive("reset"))
                  put("id", JsonPrimitive("android-screenshot-reset"))
                },
            ),
          )
          add(chatMessage("user", "Draft a short status update for the team.", 1_783_555_260_000))
          add(
            chatMessage(
              "assistant",
              "The Android release is close. Two review follow-ups and one localization pass remain; once those land, " +
                "the changelog can be reviewed and the tag can go out.",
              1_783_555_320_000,
            ),
          )
        },
      )
      put(
        "sessionInfo",
        buildJsonObject {
          put("key", JsonPrimitive(mainSessionKey))
          put("displayName", JsonPrimitive("New chat"))
          put("updatedAt", JsonPrimitive(1_783_555_320_000))
          put("unread", JsonPrimitive(false))
          put("modelProvider", JsonPrimitive("openai"))
          put("model", JsonPrimitive("gpt-5.2"))
          put("contextTokens", JsonPrimitive(200_000))
        },
      )
    }.toString()

  private fun chatMessage(
    role: String,
    content: String,
    timestamp: Long,
    provenanceSourceTool: String? = null,
    marker: JsonObject? = null,
  ) = buildJsonObject {
    put("role", JsonPrimitive(role))
    put("content", JsonPrimitive(content))
    put("timestamp", JsonPrimitive(timestamp))
    provenanceSourceTool?.let { sourceTool ->
      put(
        "provenance",
        buildJsonObject {
          put("kind", JsonPrimitive("internal_system"))
          put("sourceTool", JsonPrimitive(sourceTool))
        },
      )
    }
    marker?.let { put("__openclaw", it) }
  }

  private fun sessionList(paramsJson: String?): String {
    val spawnedBy =
      paramsJson
        ?.let {
          runCatching {
            Json
              .parseToJsonElement(it)
              .jsonObject["spawnedBy"]
              ?.jsonPrimitive
              ?.contentOrNull
          }.getOrNull()
        }
    if (scene == AndroidScreenshotScene.Swarm && spawnedBy != null) {
      val children = swarmChildren(spawnedBy)
      return buildJsonObject {
        put("sessions", buildJsonArray { children.forEach(::add) })
        put("count", JsonPrimitive(children.size))
        put("totalCount", JsonPrimitive(children.size))
        put("hasMore", JsonPrimitive(false))
      }.toString()
    }
    return buildJsonObject {
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
  }

  private fun swarmChildren(parentKey: String) =
    listOf(
      swarmChild("research-polling", "National polling", "done", parentKey),
      swarmChild("research-work", "Work and labor", "running", parentKey),
      swarmChild("research-health", "Health", "running", parentKey),
      swarmChild("research-trust", "Governance and trust", null, parentKey, queued = true),
      swarmChild("research-media", "Media signals", "failed", parentKey),
    )

  private fun swarmChild(
    key: String,
    label: String,
    status: String?,
    parentKey: String,
    queued: Boolean = false,
  ) = session("agent:main:subagent:$key", label, 1_783_555_320_000).toMutableMap().let { values ->
    buildJsonObject {
      values.forEach { (field, value) -> put(field, value) }
      put("parentSessionKey", JsonPrimitive(parentKey))
      put("spawnedBy", JsonPrimitive(parentKey))
      put("swarmGroupId", JsonPrimitive("swarm:$parentKey:research"))
      put("swarmPhase", JsonPrimitive("Research"))
      put("swarmPhaseRank", JsonPrimitive(0))
      put("swarmLog", JsonPrimitive("Comparing labor, education, health, trust, and media signals."))
      status?.let { put("status", JsonPrimitive(it)) }
      if (queued) put("subagentRunState", JsonPrimitive("active"))
      if (status == "running") put("hasActiveRun", JsonPrimitive(true))
    }
  }

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
      put("swarmEnabled", JsonPrimitive(scene == AndroidScreenshotScene.Swarm))
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
