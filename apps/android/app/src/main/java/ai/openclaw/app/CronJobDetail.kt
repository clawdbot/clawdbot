package ai.openclaw.app

import ai.openclaw.app.i18n.NativeText
import ai.openclaw.app.i18n.joinedNativeText
import ai.openclaw.app.i18n.nativeText
import ai.openclaw.app.i18n.verbatimText
import ai.openclaw.app.node.asObjectOrNull
import ai.openclaw.app.node.asStringOrNull
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.booleanOrNull
import kotlinx.serialization.json.buildJsonObject

data class GatewayCronJobDetail(
  val id: String,
  val name: String,
  val description: String,
  val enabled: Boolean,
  val deleteAfterRun: Boolean,
  val scheduleKind: String,
  val scheduleLabel: NativeText,
  val scheduleDetail: NativeText,
  val scheduleAt: String?,
  val scheduleEveryMs: Long?,
  val scheduleAnchorMs: Long?,
  val scheduleCronExpr: String?,
  val scheduleTimezone: String?,
  val scheduleStaggerMs: Long?,
  val scheduleCommand: String?,
  val scheduleCwd: String?,
  val sessionTarget: String,
  val wakeMode: String,
  val payloadKind: String,
  val payloadText: String?,
  val payloadLabel: NativeText,
  val payloadModel: String?,
  val payloadThinking: String?,
  val payloadCommandArgv: List<String>?,
  val payloadCommandCwd: String?,
  val deliveryLabel: NativeText,
  val failureAlertLabel: NativeText,
  val createdAtMs: Long,
  val updatedAtMs: Long,
  val configRevision: String?,
  val nextRunAtMs: Long?,
  val runningAtMs: Long?,
  val lastRunAtMs: Long?,
  val lastRunStatus: String?,
  val lastError: String?,
  val lastDiagnosticSummary: String?,
  val lastDurationMs: Long?,
  val consecutiveErrors: Long?,
  val consecutiveSkipped: Long?,
  val lastDeliveryStatus: String?,
  val lastDeliveryError: String?,
)

sealed interface GatewayCronJobDetailState {
  data object Idle : GatewayCronJobDetailState

  data class Loading(
    val id: String,
  ) : GatewayCronJobDetailState

  data class Loaded(
    val job: GatewayCronJobDetail,
  ) : GatewayCronJobDetailState

  data class Error(
    val id: String,
    val message: NativeText,
  ) : GatewayCronJobDetailState
}

internal data class CronJobDetailRequest(
  val id: String,
  val generation: Long,
)

/** Couples the selected job id to its generation so older RPCs cannot publish into a new screen. */
internal class CronJobDetailRequestGuard {
  private val lock = Any()
  private var generation = 0L
  private var selectedId: String? = null

  fun begin(rawId: String): CronJobDetailRequest? {
    val id = rawId.trim().takeIf { it.isNotEmpty() } ?: return null
    return synchronized(lock) {
      generation += 1
      selectedId = id
      CronJobDetailRequest(id = id, generation = generation)
    }
  }

  fun beginIfCurrent(
    rawId: String,
    onBegin: (CronJobDetailRequest) -> Unit,
  ): CronJobDetailRequest? {
    val id = rawId.trim().takeIf { it.isNotEmpty() } ?: return null
    return synchronized(lock) {
      if (selectedId != id) return@synchronized null
      generation += 1
      CronJobDetailRequest(id = id, generation = generation).also(onBegin)
    }
  }

  fun cancel(onCancel: () -> Unit = {}) {
    synchronized(lock) {
      generation += 1
      selectedId = null
      onCancel()
    }
  }

  fun cancelIfCurrent(
    rawId: String,
    onCancel: () -> Unit,
  ): Boolean {
    val id = rawId.trim().takeIf { it.isNotEmpty() } ?: return false
    return synchronized(lock) {
      if (selectedId != id) return@synchronized false
      generation += 1
      selectedId = null
      onCancel()
      true
    }
  }

  fun publishIfCurrent(
    request: CronJobDetailRequest,
    publish: () -> Unit,
  ): Boolean =
    synchronized(lock) {
      if (request.generation != generation || request.id != selectedId) return@synchronized false
      publish()
      true
    }
}

internal fun cronJobGetParams(id: String): String =
  buildJsonObject {
    put("id", JsonPrimitive(id))
  }.toString()

internal fun parseGatewayCronJobDetail(job: JsonObject?): GatewayCronJobDetail? {
  val value = job ?: return null
  val id = value.string("id") ?: return null
  val name = value.string("name") ?: return null
  val createdAtMs = value.long("createdAtMs") ?: return null
  val updatedAtMs = value.long("updatedAtMs") ?: return null
  val schedule = value["schedule"].asObjectOrNull() ?: return null
  val payload = value["payload"].asObjectOrNull() ?: return null
  val sessionTarget = value.string("sessionTarget") ?: return null
  val wakeMode = value.string("wakeMode") ?: return null
  val payloadKind = payload.string("kind") ?: return null
  val scheduleKind = schedule.string("kind") ?: return null
  if (scheduleKind !in setOf("at", "every", "cron", "on-exit")) return null
  if (payloadKind !in setOf("systemEvent", "agentTurn", "command")) return null
  val state = value["state"].asObjectOrNull() ?: return null

  return GatewayCronJobDetail(
    id = id,
    name = name,
    description = value.string("description").orEmpty(),
    enabled = value.boolean("enabled"),
    deleteAfterRun = value.boolean("deleteAfterRun"),
    scheduleKind = scheduleKind,
    scheduleLabel = cronScheduleLabel(schedule),
    scheduleDetail = cronScheduleDetail(schedule),
    scheduleAt = schedule.string("at"),
    scheduleEveryMs = schedule.long("everyMs"),
    scheduleAnchorMs = schedule.long("anchorMs"),
    scheduleCronExpr = schedule.string("expr"),
    scheduleTimezone = schedule.string("tz"),
    scheduleStaggerMs = schedule.long("staggerMs"),
    scheduleCommand = schedule.string("command"),
    scheduleCwd = schedule.string("cwd"),
    sessionTarget = sessionTarget,
    wakeMode = wakeMode,
    payloadKind = payloadKind,
    payloadText = cronPayloadText(payload),
    payloadLabel = cronPayloadLabel(payload),
    payloadModel = payload.string("model"),
    payloadThinking = payload.string("thinking"),
    payloadCommandArgv =
      (payload["argv"] as? JsonArray)
        ?.mapNotNull { it.asStringOrNull() },
    payloadCommandCwd = payload.string("cwd"),
    deliveryLabel = cronDeliveryLabel(value["delivery"].asObjectOrNull()),
    failureAlertLabel = cronFailureAlertLabel(value["failureAlert"]),
    createdAtMs = createdAtMs,
    updatedAtMs = updatedAtMs,
    configRevision = value.string("configRevision"),
    nextRunAtMs = state.long("nextRunAtMs"),
    runningAtMs = state.long("runningAtMs"),
    lastRunAtMs = state.long("lastRunAtMs"),
    lastRunStatus = cronJobLastRunStatus(state),
    lastError = state.string("lastError"),
    lastDiagnosticSummary = state.string("lastDiagnosticSummary"),
    lastDurationMs = state.long("lastDurationMs"),
    consecutiveErrors = state.long("consecutiveErrors"),
    consecutiveSkipped = state.long("consecutiveSkipped"),
    lastDeliveryStatus = state.string("lastDeliveryStatus"),
    lastDeliveryError = state.string("lastDeliveryError"),
  )
}

internal fun formatCronInterval(everyMs: Long): NativeText {
  val minutes = everyMs / 60_000L
  val hours = minutes / 60L
  val days = hours / 24L
  return when {
    days >= 1 && hours % 24L == 0L -> nativeText("Every \${days}d", days)
    hours >= 1 && minutes % 60L == 0L -> nativeText("Every \${hours}h", hours)
    minutes >= 1 -> nativeText("Every \${minutes}m", minutes)
    else -> nativeText("Repeating")
  }
}

private fun cronScheduleLabel(schedule: JsonObject): NativeText =
  when (schedule.string("kind")) {
    "at" -> nativeText("One time")
    "every" -> schedule.long("everyMs")?.let(::formatCronInterval) ?: nativeText("Repeating")
    "cron" -> schedule.string("expr")?.let(::verbatimText) ?: nativeText("Cron")
    else -> nativeText("Scheduled")
  }

private fun cronScheduleDetail(schedule: JsonObject): NativeText =
  when (schedule.string("kind")) {
    "at" -> schedule.string("at")?.let(::verbatimText) ?: nativeText("One time")
    "every" -> {
      val every = schedule.long("everyMs")?.let(::formatCronInterval) ?: nativeText("Repeating")
      val anchor = schedule.long("anchorMs")?.let { nativeText("Anchor \$it", it) }
      joinedNativeText(" · ", listOfNotNull(every, anchor))
    }
    "cron" -> {
      val expression = schedule.string("expr")?.let(::verbatimText) ?: nativeText("Cron")
      val timezone = schedule.string("tz")?.let(::verbatimText)
      val stagger = schedule.long("staggerMs")?.takeIf { it > 0L }?.let { nativeText("Stagger \${formatCronInterval(it)}", formatCronInterval(it)) }
      joinedNativeText(" · ", listOfNotNull(expression, timezone, stagger))
    }
    else -> nativeText("Scheduled")
  }

private fun cronPayloadText(payload: JsonObject): String? =
  when (payload.string("kind")) {
    "systemEvent" -> payload.string("text")
    "agentTurn" -> payload.string("message")
    "command" ->
      (payload["argv"] as? JsonArray)
        ?.mapNotNull { it.asStringOrNull()?.trim()?.takeIf { value -> value.isNotEmpty() } }
        ?.joinToString(" ")
    else -> null
  }

private fun cronPayloadLabel(payload: JsonObject): NativeText =
  when (payload.string("kind")) {
    "systemEvent" -> nativeText("System event")
    "agentTurn" -> {
      val model = payload.string("model")?.let(::verbatimText)
      val thinking = payload.string("thinking")?.let { nativeText("Thinking \$it", it) }
      joinedNativeText(" · ", listOfNotNull(nativeText("Agent turn"), model, thinking))
    }
    "command" -> nativeText("Command")
    else -> nativeText("Payload")
  }

private fun cronDeliveryLabel(delivery: JsonObject?): NativeText {
  val value = delivery ?: return nativeText("Default")
  val mode = value.string("mode") ?: return nativeText("Default")
  return joinedNativeText(
    " · ",
    listOfNotNull(
      verbatimText(mode.replaceFirstChar { it.uppercaseChar() }),
      value.string("channel")?.let(::verbatimText),
      value.string("to")?.let(::verbatimText),
      value.string("accountId")?.let { nativeText("Account \$it", it) },
    ),
  )
}

private fun cronFailureAlertLabel(failureAlert: JsonElement?): NativeText {
  if ((failureAlert as? JsonPrimitive)?.booleanOrNull == false) return nativeText("Off")
  val alert = failureAlert.asObjectOrNull() ?: return nativeText("Default")
  val parts =
    listOfNotNull(
      alert.long("after")?.let { nativeText("After \$it", it) },
      alert.string("mode")?.replaceFirstChar { it.uppercaseChar() }?.let(::verbatimText),
      alert.string("channel")?.let(::verbatimText),
      alert.string("to")?.let(::verbatimText),
      alert.long("cooldownMs")?.takeIf { it > 0L }?.let { nativeText("Cooldown \${formatCronInterval(it)}", formatCronInterval(it)) },
    )
  return if (parts.isEmpty()) nativeText("On") else joinedNativeText(" · ", parts)
}

private fun JsonObject.string(key: String): String? =
  this[key]
    .asStringOrNull()
    ?.trim()
    ?.takeIf { it.isNotEmpty() }

private fun JsonObject.long(key: String): Long? =
  (this[key] as? JsonPrimitive)
    ?.content
    ?.trim()
    ?.toLongOrNull()

private fun JsonObject.boolean(key: String): Boolean = (this[key] as? JsonPrimitive)?.booleanOrNull == true
