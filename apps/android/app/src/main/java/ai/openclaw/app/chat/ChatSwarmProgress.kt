package ai.openclaw.app.chat

import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive

private const val MAX_TRACKED_SWARM_GROUPS = 10_000
private const val MAX_TRACKED_SWARM_CHILDREN = 100_000
private const val MAX_SWARM_PAGE_REQUESTS = 100
private const val MAX_RENDERED_SWARM_DOTS_PER_PHASE = 256

enum class ChatSwarmDotStatus {
  Running,
  Queued,
  Failed,
  Done,
  ;

  val label: String
    get() = name
}

data class ChatSwarmDot(
  val key: String,
  val label: String,
  val status: ChatSwarmDotStatus,
)

data class ChatSwarmPhase(
  val key: String,
  val title: String?,
  val dots: List<ChatSwarmDot>,
  val hidden: Int,
)

data class ChatSwarmGroup(
  val groupId: String,
  val label: String,
  val running: Int,
  val done: Int,
  val failed: Int,
  val narrator: String?,
  val phases: List<ChatSwarmPhase>,
)

internal data class ChatSwarmSnapshot(
  val sessionKey: String?,
  val enabled: Boolean,
  val groups: List<ChatSwarmGroup>,
) {
  fun isAvailableFor(sessionKey: String?): Boolean = enabled && sessionKey != null && this.sessionKey == sessionKey
}

internal data class ChatSwarmSessionPage(
  val sessions: List<ChatSessionEntry>,
  val totalCount: Int?,
  val nextOffset: Int?,
  val hasMore: Boolean?,
)

internal suspend fun collectChatSwarmChildSessions(
  fetchPage: suspend (Int) -> ChatSwarmSessionPage,
): List<ChatSessionEntry> {
  val rowsByKey = linkedMapOf<String, ChatSessionEntry>()
  var remainingPageRequests = MAX_SWARM_PAGE_REQUESTS
  repeat(4) {
    val rowsBeforePass = rowsByKey.size
    var expectedTotal: Int? = null
    val seenOffsets = mutableSetOf<Int>()
    var offset = 0
    while (
      remainingPageRequests > 0 &&
      rowsByKey.size < MAX_TRACKED_SWARM_CHILDREN &&
      seenOffsets.add(offset)
    ) {
      remainingPageRequests -= 1
      val page = fetchPage(offset)
      expectedTotal = page.totalCount
      for (row in page.sessions) {
        rowsByKey[row.key] = row
        if (rowsByKey.size >= MAX_TRACKED_SWARM_CHILDREN) break
      }
      if (rowsByKey.size >= MAX_TRACKED_SWARM_CHILDREN) return rowsByKey.values.toList()
      val hasMore = page.hasMore ?: expectedTotal?.let { offset + page.sessions.size < it } ?: false
      val nextOffset = page.nextOffset ?: (offset + page.sessions.size)
      if (!hasMore || page.sessions.isEmpty() || nextOffset <= offset) break
      offset = nextOffset
    }
    val added = rowsByKey.size - rowsBeforePass
    if (
      remainingPageRequests == 0 ||
      added == 0 ||
      expectedTotal?.let { rowsByKey.size >= it } != false
    ) {
      return rowsByKey.values.toList()
    }
  }
  return rowsByKey.values.toList()
}

internal fun chatSwarmEventBelongsToParent(
  payload: JsonObject,
  matchesParent: (String) -> Boolean,
): Boolean {
  val source = payload["session"].asObjectOrNull() ?: payload
  val explicitParent =
    normalizedSwarmValue(source["parentSessionKey"].asStringOrNull())
      ?: normalizedSwarmValue(source["spawnedBy"].asStringOrNull())
  if (explicitParent != null) return matchesParent(explicitParent)

  val kind = normalizedSwarmValue(payload["kind"].asStringOrNull())
  if (kind == "phase" || kind == "log") {
    val sessionKey = normalizedSwarmValue(payload["sessionKey"].asStringOrNull()) ?: return false
    return matchesParent(sessionKey)
  }

  val groupId =
    normalizedSwarmValue(payload["swarmGroupId"].asStringOrNull())
      ?: normalizedSwarmValue(source["swarmGroupId"].asStringOrNull())
      ?: return false
  if (!groupId.startsWith("swarm:")) return false
  val generatedParent = groupId.removePrefix("swarm:").substringBeforeLast(':', missingDelimiterValue = "")
  return generatedParent.isNotEmpty() && matchesParent(generatedParent)
}

private fun normalizedSwarmValue(value: String?): String? = value?.trim()?.takeIf(String::isNotEmpty)

internal class ChatSwarmActivityTracker {
  private val currentPhaseByGroup = linkedMapOf<String, String>()
  private val phaseRankByGroupPhase = linkedMapOf<String, Int>()
  private var nextPhaseRank = 0
  private val latestLogByGroup = linkedMapOf<String, String>()
  private val phaseByChild = linkedMapOf<String, String>()

  fun clear() {
    currentPhaseByGroup.clear()
    phaseRankByGroupPhase.clear()
    nextPhaseRank = 0
    latestLogByGroup.clear()
    phaseByChild.clear()
  }

  fun observe(payload: JsonObject): Boolean {
    val source = payload["session"].asObjectOrNull() ?: payload
    val groupId = normalized(payload["swarmGroupId"].asStringOrNull()) ?: normalized(source["swarmGroupId"].asStringOrNull()) ?: return false
    val kind = normalized((if ("kind" in payload) payload["kind"] else source["kind"]).asStringOrNull())
    val text = normalized((if ("text" in payload) payload["text"] else source["text"]).asStringOrNull())
    if ((kind == "phase" || kind == "log") && text != null) {
      if (kind == "phase") {
        val rankKey = phaseRankKey(groupId, text)
        if (rankKey !in phaseRankByGroupPhase) {
          setBounded(phaseRankByGroupPhase, rankKey, nextPhaseRank++, MAX_TRACKED_SWARM_CHILDREN)
        }
        setBounded(currentPhaseByGroup, groupId, text, MAX_TRACKED_SWARM_GROUPS)
      } else {
        setBounded(latestLogByGroup, groupId, text, MAX_TRACKED_SWARM_GROUPS)
      }
      return true
    }

    val childKey = normalized(source["key"].asStringOrNull()) ?: normalized(payload["sessionKey"].asStringOrNull()) ?: return true
    val explicitPhase = normalized(source["swarmPhase"].asStringOrNull()) ?: normalized(payload["swarmPhase"].asStringOrNull())
    if (explicitPhase != null) {
      setBounded(phaseByChild, childKey, explicitPhase, MAX_TRACKED_SWARM_CHILDREN)
      return true
    }
    if (payload["reason"].asStringOrNull() == "create" && childKey !in phaseByChild) {
      currentPhaseByGroup[groupId]?.let { phase ->
        setBounded(phaseByChild, childKey, phase, MAX_TRACKED_SWARM_CHILDREN)
      }
    }
    return true
  }

  fun decorate(rows: List<ChatSessionEntry>): List<ChatSessionEntry> =
    rows.map { row ->
      val groupId = normalized(row.swarmGroupId) ?: return@map row
      val phase = phaseByChild[row.key] ?: row.swarmPhase
      row.copy(
        swarmPhase = phase,
        swarmPhaseRank = phase?.let { phaseRankByGroupPhase[phaseRankKey(groupId, it)] } ?: row.swarmPhaseRank,
        swarmLog = latestLogByGroup[groupId] ?: row.swarmLog,
      )
    }

  private fun phaseRankKey(
    groupId: String,
    phase: String,
  ): String = "${groupId.length}:$groupId$phase"

  private fun normalized(value: String?): String? = value?.trim()?.takeIf(String::isNotEmpty)

  private fun <V> setBounded(
    values: LinkedHashMap<String, V>,
    key: String,
    value: V,
    limit: Int,
  ) {
    if (key !in values && values.size >= limit) {
      values.entries
        .firstOrNull()
        ?.key
        ?.let(values::remove)
    }
    values[key] = value
  }
}

internal fun buildChatSwarmGroups(
  sessions: List<ChatSessionEntry>,
  matchesParent: (String) -> Boolean,
): List<ChatSwarmGroup> {
  data class Entry(
    val phase: String?,
    val phaseRank: Int,
    val log: String?,
    val dot: ChatSwarmDot,
  )

  val byGroup = linkedMapOf<String, MutableList<Entry>>()
  sessions.forEach { row ->
    val groupId = row.swarmGroupId?.trim()?.takeIf(String::isNotEmpty) ?: return@forEach
    if (!belongsToParent(row, groupId, matchesParent)) return@forEach
    val status = swarmDotStatus(row) ?: return@forEach
    val label = listOfNotNull(row.label, row.displayName, row.derivedTitle, row.key).firstOrNull { it.isNotBlank() } ?: row.key
    byGroup.getOrPut(groupId, ::mutableListOf) +=
      Entry(
        phase = row.swarmPhase?.trim()?.takeIf(String::isNotEmpty),
        phaseRank = row.swarmPhaseRank ?: Int.MAX_VALUE,
        log = row.swarmLog?.trim()?.takeIf(String::isNotEmpty),
        dot = ChatSwarmDot(key = row.key, label = label, status = status),
      )
  }

  return byGroup
    .map { (groupId, entries) ->
      val phases = linkedMapOf<String, Triple<String?, Int, MutableList<ChatSwarmDot>>>()
      entries.forEach { entry ->
        val phaseKey = entry.phase ?: ""
        val existing = phases[phaseKey]
        if (existing == null) {
          phases[phaseKey] = Triple(entry.phase, entry.phaseRank, mutableListOf(entry.dot))
        } else {
          existing.third += entry.dot
          phases[phaseKey] = Triple(existing.first, minOf(existing.second, entry.phaseRank), existing.third)
        }
      }
      val projectedPhases =
        phases
          .map { (key, bucket) ->
            val dots =
              if (bucket.third.size > MAX_RENDERED_SWARM_DOTS_PER_PHASE) {
                bucket.third.sortedBy(ChatSwarmDot::status)
              } else {
                bucket.third
              }
            ChatSwarmPhase(
              key = key,
              title = bucket.first,
              dots = dots.take(MAX_RENDERED_SWARM_DOTS_PER_PHASE),
              hidden = (dots.size - MAX_RENDERED_SWARM_DOTS_PER_PHASE).coerceAtLeast(0),
            )
          }.sortedWith(compareBy<ChatSwarmPhase> { phases[it.key]?.second ?: Int.MAX_VALUE }.thenBy(ChatSwarmPhase::key))
      val dots = entries.map(Entry::dot)
      ChatSwarmGroup(
        groupId = groupId,
        label = groupId.substringAfterLast(':'),
        running = dots.count { it.status == ChatSwarmDotStatus.Running },
        done = dots.count { it.status == ChatSwarmDotStatus.Done },
        failed = dots.count { it.status == ChatSwarmDotStatus.Failed },
        narrator = entries.firstNotNullOfOrNull(Entry::log),
        phases = projectedPhases,
      )
    }.filter { group ->
      group.phases.any { phase -> phase.dots.any { it.status == ChatSwarmDotStatus.Queued || it.status == ChatSwarmDotStatus.Running } }
    }.sortedBy(ChatSwarmGroup::groupId)
}

private fun swarmDotStatus(row: ChatSessionEntry): ChatSwarmDotStatus? =
  when {
    row.status == "running" || row.hasActiveRun == true -> ChatSwarmDotStatus.Running
    row.status == "done" -> ChatSwarmDotStatus.Done
    row.status == "failed" || row.status == "killed" || row.status == "timeout" -> ChatSwarmDotStatus.Failed
    row.subagentRunState == "active" || row.hasActiveSubagentRun == true -> ChatSwarmDotStatus.Queued
    else -> null
  }

private fun belongsToParent(
  row: ChatSessionEntry,
  groupId: String,
  matchesParent: (String) -> Boolean,
): Boolean {
  if (row.parentSessionKey?.let(matchesParent) == true || row.spawnedBy?.let(matchesParent) == true) return true
  val parts = groupId.split(':')
  return parts.size > 2 && matchesParent(parts.drop(1).dropLast(1).joinToString(":"))
}

private fun JsonElement?.asObjectOrNull(): JsonObject? = this as? JsonObject

private fun JsonElement?.asStringOrNull(): String? =
  (this as? JsonPrimitive)
    ?.takeIf { it.isString }
    ?.content
