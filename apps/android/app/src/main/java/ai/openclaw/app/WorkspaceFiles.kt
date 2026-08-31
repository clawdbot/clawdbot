package ai.openclaw.app

import ai.openclaw.app.node.asObjectOrNull
import ai.openclaw.app.node.asStringOrNull
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.longOrNull

/** One entry from the read-only `agents.workspace.list` gateway RPC. */
data class GatewayWorkspaceEntry(
  val path: String,
  val name: String,
  val isDirectory: Boolean,
  val size: Long?,
  val updatedAtMs: Long?,
)

/** One directory page of an agent workspace listing. */
data class GatewayWorkspaceListing(
  val path: String,
  val entries: List<GatewayWorkspaceEntry>,
  val totalEntries: Int,
  val offset: Int,
)

/** One previewable workspace file from `agents.workspace.get`. */
data class GatewayWorkspaceFile(
  val path: String,
  val name: String,
  val size: Long,
  val mimeType: String,
  val isBase64: Boolean,
  val content: String,
)

private fun JsonElement?.asLongOrNull(): Long? = (this as? JsonPrimitive)?.longOrNull

internal fun parseWorkspaceListing(root: JsonElement): GatewayWorkspaceListing? {
  val obj = root.asObjectOrNull() ?: return null
  val entries =
    (obj["entries"] as? JsonArray)?.mapNotNull { item ->
      val entry = item.asObjectOrNull() ?: return@mapNotNull null
      // Paths/names are opaque workspace identifiers echoed back to the
      // gateway; never trim them or entries with edge whitespace break.
      val path = entry["path"].asStringOrNull().orEmpty()
      val name = entry["name"].asStringOrNull().orEmpty()
      if (path.isEmpty() || name.isEmpty()) return@mapNotNull null
      GatewayWorkspaceEntry(
        path = path,
        name = name,
        isDirectory = entry["kind"].asStringOrNull() == "directory",
        size = entry["size"].asLongOrNull(),
        updatedAtMs = entry["updatedAtMs"].asLongOrNull(),
      )
    } ?: emptyList()
  return GatewayWorkspaceListing(
    path = obj["path"].asStringOrNull().orEmpty(),
    entries = entries,
    totalEntries = obj["totalEntries"].asLongOrNull()?.toInt() ?: entries.size,
    offset = obj["offset"].asLongOrNull()?.toInt() ?: 0,
  )
}

internal fun parseWorkspaceFile(root: JsonElement): GatewayWorkspaceFile? {
  val file = root.asObjectOrNull()?.get("file").asObjectOrNull() ?: return null
  val path = file["path"].asStringOrNull().orEmpty()
  if (path.isEmpty()) return null
  return GatewayWorkspaceFile(
    path = path,
    name =
      file["name"]
        .asStringOrNull()
        .orEmpty()
        .ifEmpty { path.substringAfterLast('/') },
    size = file["size"].asLongOrNull() ?: 0L,
    mimeType = file["mimeType"].asStringOrNull().orEmpty().ifEmpty { "text/plain" },
    isBase64 = file["encoding"].asStringOrNull() == "base64",
    content = file["content"].asStringOrNull().orEmpty(),
  )
}
