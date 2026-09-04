package ai.openclaw.app.wear

import ai.openclaw.app.chat.BackgroundTask
import ai.openclaw.app.chat.ChatSwarmDotStatus
import ai.openclaw.app.chat.ChatSwarmGroup
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.buildJsonArray
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put

internal fun projectWearAgentPulse(
  gatewayConnected: Boolean,
  tasks: List<BackgroundTask>?,
  swarmAvailable: Boolean,
  swarmGroups: List<ChatSwarmGroup>,
  pendingApprovalCount: Int,
  approvalsAvailable: Boolean,
  approvalsRefreshing: Boolean,
): JsonObject =
  buildJsonObject {
    put(
      "tasks",
      buildJsonObject {
        if (!gatewayConnected || tasks == null) {
          put("state", "unavailable")
        } else {
          val queued = tasks.count { task -> task.status == "queued" }
          val running = tasks.count { task -> task.status == "running" }
          val completed = tasks.count { task -> task.status == "completed" }
          val failed =
            tasks.count { task ->
              task.status == "failed" || task.status == "cancelled" || task.status == "timed_out"
            }
          put("state", "ready")
          put("scope", "bounded")
          put("queued", queued)
          put("running", running)
          put("completed", completed)
          put("failed", failed)
          put("activeAtLimit", queued + running >= ACTIVE_TASK_LIMIT)
          put("recentAtLimit", completed + failed >= RECENT_TASK_LIMIT)
        }
      },
    )
    put(
      "swarm",
      buildJsonObject {
        when {
          !gatewayConnected || !swarmAvailable -> {
            put("state", "unavailable")
          }

          swarmGroups.isEmpty() -> {
            put("state", "idle")
            put("scope", "selected-session")
          }

          else -> {
            val phaseBuckets = MutableList(MAX_PHASE_BUCKETS) { MutablePhaseCounts() }
            var morePhases = false
            swarmGroups.forEach { group ->
              if (group.phases.size > MAX_PHASE_BUCKETS) morePhases = true
              group.phases.take(MAX_PHASE_BUCKETS).forEachIndexed { index, phase ->
                val bucket = phaseBuckets[index]
                phase.dots.forEach { dot ->
                  when (dot.status) {
                    ChatSwarmDotStatus.Queued -> bucket.queued += 1
                    ChatSwarmDotStatus.Running -> bucket.running += 1
                    ChatSwarmDotStatus.Done -> bucket.done += 1
                    ChatSwarmDotStatus.Failed -> bucket.failed += 1
                  }
                }
                bucket.hidden += phase.hidden
              }
            }
            put("state", "active")
            put("scope", "selected-session")
            put("groups", swarmGroups.size)
            put("running", swarmGroups.sumOf(ChatSwarmGroup::running))
            put("done", swarmGroups.sumOf(ChatSwarmGroup::done))
            put("failed", swarmGroups.sumOf(ChatSwarmGroup::failed))
            put(
              "phases",
              buildJsonArray {
                phaseBuckets
                  .dropLastWhile { phase -> !phase.hasData() }
                  .forEach { phase ->
                    add(
                      buildJsonObject {
                        put("queued", phase.queued)
                        put("running", phase.running)
                        put("done", phase.done)
                        put("failed", phase.failed)
                        put("hidden", phase.hidden)
                      },
                    )
                  }
              },
            )
            put("morePhases", morePhases)
          }
        }
      },
    )
    put(
      "approvals",
      buildJsonObject {
        when {
          !gatewayConnected -> {
            put("state", "unavailable")
          }

          approvalsRefreshing -> {
            put("state", "refreshing")
          }

          !approvalsAvailable -> {
            put("state", "unavailable")
          }

          else -> {
            put("state", "ready")
            put("pending", pendingApprovalCount.coerceAtLeast(0))
          }
        }
      },
    )
  }

private data class MutablePhaseCounts(
  var queued: Int = 0,
  var running: Int = 0,
  var done: Int = 0,
  var failed: Int = 0,
  var hidden: Int = 0,
) {
  fun hasData(): Boolean = queued != 0 || running != 0 || done != 0 || failed != 0 || hidden != 0
}

private const val ACTIVE_TASK_LIMIT = 100
private const val RECENT_TASK_LIMIT = 50
private const val MAX_PHASE_BUCKETS = 8
