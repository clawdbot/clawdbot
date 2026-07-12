package ai.openclaw.app

import ai.openclaw.app.node.asObjectOrNull
import ai.openclaw.app.node.asStringOrNull
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive

data class GatewayAgentSummary(
  val id: String,
  val name: String?,
  val emoji: String?,
  val avatar: String? = null,
  val avatarUrl: String? = null,
  val workspaceGit: Boolean = false,
)

/** Parses validated agents.list rows into the smaller Android display model. */
internal fun parseGatewayAgentSummaries(root: JsonObject): List<GatewayAgentSummary> = (root["agents"] as? JsonArray)?.mapNotNull(::parseGatewayAgentSummary) ?: emptyList()

private fun parseGatewayAgentSummary(item: JsonElement): GatewayAgentSummary? {
  val agent = item.asObjectOrNull() ?: return null
  val id = agent["id"].asStringOrNull()?.trim().orEmpty()
  if (id.isEmpty()) return null
  val identity = agent["identity"].asObjectOrNull()
  return GatewayAgentSummary(
    id = id,
    name = agent["name"].asStringOrNull().normalizedAgentValue(),
    emoji = identity?.get("emoji").asStringOrNull().normalizedAgentValue(),
    avatar = identity?.get("avatar").asStringOrNull().normalizedAgentValue(),
    avatarUrl = identity?.get("avatarUrl").asStringOrNull().normalizedAgentValue(),
    workspaceGit = (agent["workspaceGit"] as? JsonPrimitive)?.content?.toBooleanStrictOrNull() == true,
  )
}

private fun String?.normalizedAgentValue(): String? = this?.trim()?.takeIf { it.isNotEmpty() }
