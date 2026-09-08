package ai.openclaw.app

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.booleanOrNull
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.doubleOrNull

data class SessionCatalogState(
  val loading: Boolean = false,
  val catalogs: List<SessionCatalog> = emptyList(),
  val errorText: String? = null,
  val agentId: String? = null,
  val loadingMoreCatalogIds: Set<String> = emptySet(),
  val continuingEntryId: String? = null,
  val loadedPageDepthsByHost: Map<String, Int> = emptyMap(),
)

data class SessionCatalog(
  val id: String,
  val label: String,
  val hosts: List<SessionCatalogHost>,
  val canCreateSession: Boolean = false,
  val errorText: String? = null,
)

data class SessionCatalogHost(
  val catalogId: String,
  val hostId: String,
  val label: String,
  val kind: String,
  val connected: Boolean,
  val sessions: List<SessionCatalogEntry>,
  val nextCursor: String? = null,
  val errorText: String? = null,
)

data class SessionCatalogEntry(
  val catalogId: String,
  val hostId: String,
  val threadId: String,
  val sourceHomeId: String? = null,
  val agentId: String? = null,
  val name: String? = null,
  val cwd: String? = null,
  val status: String,
  val recencyAt: Double? = null,
  val source: String? = null,
  val modelProvider: String? = null,
  val gitBranch: String? = null,
  val customGroup: String? = null,
  val archived: Boolean,
  val sessionKey: String? = null,
  val canContinue: Boolean,
) {
  val locatorId: String
    get() = listOf(catalogId, hostId, threadId, sourceHomeId.orEmpty()).joinToString("\u0000")
}

internal fun sessionCatalogListParams(
  agentId: String?,
  progressId: String,
): String =
  buildJsonObject {
    normalizedCatalogValue(agentId)?.let { put("agentId", JsonPrimitive(it)) }
    put("progressId", JsonPrimitive(progressId))
    put("limitPerHost", JsonPrimitive(40))
  }.toString()

internal fun sessionCatalogPageParams(
  agentId: String?,
  catalogId: String,
  cursors: Map<String, String>,
): String =
  buildJsonObject {
    normalizedCatalogValue(agentId)?.let { put("agentId", JsonPrimitive(it)) }
    put("catalogId", JsonPrimitive(catalogId))
    put(
      "cursors",
      buildJsonObject {
        cursors.forEach { (hostId, cursor) ->
          put(hostId, JsonPrimitive(cursor))
        }
      },
    )
  }.toString()

internal fun sessionCatalogContinueParams(entry: SessionCatalogEntry): String =
  buildJsonObject {
    put("catalogId", JsonPrimitive(entry.catalogId))
    put("hostId", JsonPrimitive(entry.hostId))
    put("threadId", JsonPrimitive(entry.threadId))
    normalizedCatalogValue(entry.agentId)?.let { put("agentId", JsonPrimitive(it)) }
    normalizedCatalogValue(entry.sourceHomeId)?.let { put("sourceHomeId", JsonPrimitive(it)) }
  }.toString()

internal fun parseSessionCatalogContinueResult(
  raw: String,
  json: Json = Json { ignoreUnknownKeys = true },
): String {
  val root = json.parseToJsonElement(raw) as? JsonObject
  return root
    ?.string("sessionKey")
    ?.takeIf(String::isNotEmpty)
    ?: throw IllegalArgumentException("sessions.catalog.continue returned no sessionKey")
}

internal fun parseSessionCatalogs(
  raw: String,
  requestedAgentId: String?,
  json: Json = Json { ignoreUnknownKeys = true },
): List<SessionCatalog> {
  val root = json.parseToJsonElement(raw) as? JsonObject ?: return emptyList()
  val agentId = normalizedCatalogValue(requestedAgentId)
  return root.array("catalogs").mapNotNull { catalogElement ->
    val catalog = catalogElement as? JsonObject ?: return@mapNotNull null
    parseSessionCatalog(catalog, agentId)
  }
}

internal data class SessionCatalogHostProgress(
  val progressId: String,
  val agentId: String,
  val catalog: SessionCatalog,
)

internal fun parseSessionCatalogHostProgress(
  raw: String,
  json: Json = Json { ignoreUnknownKeys = true },
): SessionCatalogHostProgress? {
  val root = json.parseToJsonElement(raw) as? JsonObject ?: return null
  val progressId = root.string("progressId")?.takeIf(String::isNotEmpty) ?: return null
  val agentId = root.string("agentId")?.takeIf(String::isNotEmpty) ?: return null
  val catalogObject = root["catalog"] as? JsonObject ?: return null
  val catalog = parseSessionCatalog(catalogObject, agentId) ?: return null
  if (catalog.hosts.size != 1) return null
  return SessionCatalogHostProgress(progressId = progressId, agentId = agentId, catalog = catalog)
}

internal fun mergeSessionCatalogHostProgress(
  current: List<SessionCatalog>,
  progress: SessionCatalogHostProgress,
  preserveExpandedHostIds: Set<String> = emptySet(),
): List<SessionCatalog> {
  val incomingCatalog = progress.catalog
  val incomingHost = incomingCatalog.hosts.singleOrNull() ?: return current
  val currentCatalog = current.firstOrNull { it.id == incomingCatalog.id }
  if (currentCatalog == null) return (current + incomingCatalog).sortedBy(SessionCatalog::id)
  val currentHost = currentCatalog.hosts.firstOrNull { it.hostId == incomingHost.hostId }
  val hostKey = sessionCatalogHostKey(incomingCatalog.id, incomingHost.hostId)
  val mergedHost =
    if (currentHost != null && hostKey in preserveExpandedHostIds) {
      preserveExpandedSessionCatalogHost(fresh = incomingHost, previous = currentHost)
    } else {
      incomingHost
    }
  val hosts =
    if (currentHost == null) {
      currentCatalog.hosts + mergedHost
    } else {
      currentCatalog.hosts.map { host -> if (host.hostId == mergedHost.hostId) mergedHost else host }
    }
  val mergedCatalog = incomingCatalog.copy(hosts = hosts.sortedBy(SessionCatalogHost::label))
  return current.map { catalog -> if (catalog.id == mergedCatalog.id) mergedCatalog else catalog }
}

internal suspend fun refetchLoadedSessionCatalogPages(
  firstPages: List<SessionCatalog>,
  previous: List<SessionCatalog>,
  loadedPageDepthsByHost: Map<String, Int>,
  isCurrent: () -> Boolean,
  fetchPage: suspend (catalogId: String, hostId: String, cursor: String) -> SessionCatalogHost?,
): List<SessionCatalog> {
  if (loadedPageDepthsByHost.isEmpty()) return firstPages
  val previousCatalogs = previous.associateBy(SessionCatalog::id)
  return firstPages.map { catalog ->
    val previousHosts = previousCatalogs[catalog.id]?.hosts?.associateBy(SessionCatalogHost::hostId).orEmpty()
    catalog.copy(
      hosts =
        catalog.hosts.map hostMap@{ firstHost ->
          val hostKey = sessionCatalogHostKey(catalog.id, firstHost.hostId)
          val pageDepth = loadedPageDepthsByHost[hostKey] ?: 0
          if (pageDepth <= 0) return@hostMap firstHost
          val previousHost = previousHosts[firstHost.hostId]
          if (firstHost.errorText != null) {
            return@hostMap previousHost?.let { preserveExpandedSessionCatalogHost(firstHost, it) } ?: firstHost
          }
          var refreshed = firstHost
          var loadedPages = 0
          while (loadedPages < pageDepth) {
            val cursor = refreshed.nextCursor ?: break
            val pageHost =
              fetchPage(catalog.id, firstHost.hostId, cursor)
                ?: return@hostMap previousHost ?: firstHost
            if (!isCurrent()) return@hostMap previousHost ?: firstHost
            if (pageHost.errorText != null) {
              return@hostMap preserveExpandedSessionCatalogHost(
                fresh = refreshed.copy(errorText = pageHost.errorText),
                previous = previousHost ?: refreshed,
              )
            }
            refreshed = mergeSessionCatalogHost(refreshed, pageHost)
            loadedPages += 1
          }
          refreshed
        },
    )
  }
}

internal fun incrementSessionCatalogPageDepths(
  current: Map<String, Int>,
  catalogId: String,
  advancedHostIds: Set<String>,
): Map<String, Int> {
  if (advancedHostIds.isEmpty()) return current
  return current.toMutableMap().apply {
    advancedHostIds.forEach { hostId ->
      val key = sessionCatalogHostKey(catalogId, hostId)
      this[key] = (this[key] ?: 0) + 1
    }
  }
}

internal fun retainSessionCatalogPageDepths(
  current: Map<String, Int>,
  catalogs: List<SessionCatalog>,
): Map<String, Int> {
  if (current.isEmpty()) return current
  val validKeys =
    catalogs
      .flatMap { catalog ->
        catalog.hosts.map { host -> sessionCatalogHostKey(catalog.id, host.hostId) }
      }.toSet()
  return current.filterKeys(validKeys::contains)
}

internal fun sessionCatalogHostKey(
  catalogId: String,
  hostId: String,
): String = "$catalogId\u0000$hostId"

internal data class SessionCatalogPageMergeResult(
  val catalog: SessionCatalog,
  val advancedHostIds: Set<String>,
)

internal fun mergeSessionCatalogPage(
  current: SessionCatalog,
  page: SessionCatalog,
  cursors: Map<String, String>,
): SessionCatalogPageMergeResult {
  val pageByHost = page.hosts.associateBy(SessionCatalogHost::hostId)
  val advancedHostIds = mutableSetOf<String>()
  val mergedHosts =
    current.hosts.map { host ->
      val requestedCursor = cursors[host.hostId]
      val pageHost = pageByHost[host.hostId]
      if (requestedCursor == null || host.nextCursor != requestedCursor || pageHost == null) {
        host
      } else {
        if (pageHost.errorText == null) advancedHostIds += host.hostId
        mergeSessionCatalogHost(host, pageHost)
      }
    }
  return SessionCatalogPageMergeResult(
    catalog =
      current.copy(
        label = page.label,
        hosts = mergedHosts,
        errorText = page.errorText,
      ),
    advancedHostIds = advancedHostIds,
  )
}

internal fun mergeSessionCatalogHost(
  current: SessionCatalogHost,
  page: SessionCatalogHost,
): SessionCatalogHost {
  val known = current.sessions.mapTo(mutableSetOf(), SessionCatalogEntry::locatorId)
  if (page.errorText != null) return current.copy(errorText = page.errorText)
  val appended = page.sessions.filter { known.add(it.locatorId) }
  return page.copy(sessions = current.sessions + appended)
}

internal fun preserveExpandedSessionCatalogHost(
  fresh: SessionCatalogHost,
  previous: SessionCatalogHost,
): SessionCatalogHost {
  if (fresh.errorText != null) return previous.copy(errorText = fresh.errorText)
  val freshIds = fresh.sessions.mapTo(mutableSetOf(), SessionCatalogEntry::locatorId)
  return fresh.copy(
    sessions = fresh.sessions + previous.sessions.filter { it.locatorId !in freshIds },
    nextCursor = previous.nextCursor,
  )
}

private fun parseSessionCatalog(
  catalog: JsonObject,
  requestedAgentId: String?,
): SessionCatalog? {
  val catalogId = catalog.string("id")?.takeIf(String::isNotEmpty) ?: return null
  return SessionCatalog(
    id = catalogId,
    label = catalog.string("label")?.takeIf(String::isNotEmpty) ?: catalogId,
    hosts =
      catalog.array("hosts").mapNotNull { hostElement ->
        parseSessionCatalogHost(
          catalogId = catalogId,
          element = hostElement,
          requestedAgentId = requestedAgentId,
        )
      },
    canCreateSession = (catalog["capabilities"] as? JsonObject)?.get("createSession") is JsonObject,
    errorText = catalog.errorMessage(),
  )
}

private fun parseSessionCatalogHost(
  catalogId: String,
  element: JsonElement,
  requestedAgentId: String?,
): SessionCatalogHost? {
  val host = element as? JsonObject ?: return null
  val hostId = host.string("hostId")?.takeIf(String::isNotEmpty) ?: return null
  return SessionCatalogHost(
    catalogId = catalogId,
    hostId = hostId,
    label = host.string("label")?.takeIf(String::isNotEmpty) ?: hostId,
    kind = host.string("kind") ?: "gateway",
    connected = host.boolean("connected") ?: false,
    sessions =
      host.array("sessions").mapNotNull { sessionElement ->
        parseSessionCatalogEntry(
          catalogId = catalogId,
          hostId = hostId,
          element = sessionElement,
          requestedAgentId = requestedAgentId,
        )
      },
    nextCursor = host.string("nextCursor"),
    errorText = host.errorMessage(),
  )
}

private fun parseSessionCatalogEntry(
  catalogId: String,
  hostId: String,
  element: JsonElement,
  requestedAgentId: String?,
): SessionCatalogEntry? {
  val session = element as? JsonObject ?: return null
  val threadId = session.string("threadId")?.takeIf(String::isNotEmpty) ?: return null
  return SessionCatalogEntry(
    catalogId = catalogId,
    hostId = hostId,
    threadId = threadId,
    sourceHomeId = session.string("sourceHomeId"),
    agentId = requestedAgentId,
    name = session.string("name"),
    cwd = session.string("cwd"),
    status = session.string("status")?.takeIf(String::isNotEmpty) ?: "unknown",
    recencyAt = session.number("recencyAt") ?: session.number("updatedAt") ?: session.number("createdAt"),
    source = session.string("source"),
    modelProvider = session.string("modelProvider"),
    gitBranch = session.string("gitBranch"),
    customGroup = session.string("customGroup"),
    archived = session.boolean("archived") ?: false,
    sessionKey = session.string("sessionKey")?.takeIf(String::isNotEmpty),
    canContinue = session.boolean("canContinue") ?: false,
  )
}

private fun normalizedCatalogValue(value: String?): String? = value?.trim()?.takeIf(String::isNotEmpty)

private fun JsonObject.errorMessage(): String? =
  (this["error"] as? JsonObject)
    ?.string("message")
    ?.takeIf(String::isNotEmpty)

private fun JsonObject.string(key: String): String? = (this[key] as? JsonPrimitive)?.contentOrNull?.trim()

private fun JsonObject.boolean(key: String): Boolean? = (this[key] as? JsonPrimitive)?.booleanOrNull

private fun JsonObject.number(key: String): Double? = (this[key] as? JsonPrimitive)?.doubleOrNull

private fun JsonObject.array(key: String): JsonArray = this[key] as? JsonArray ?: JsonArray(emptyList())
