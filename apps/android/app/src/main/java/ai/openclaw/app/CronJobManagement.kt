package ai.openclaw.app

import ai.openclaw.app.gateway.GatewaySession
import ai.openclaw.app.i18n.NativeText
import ai.openclaw.app.i18n.nativeText
import ai.openclaw.app.i18n.resolveNativeText
import ai.openclaw.app.node.asObjectOrNull
import ai.openclaw.app.node.asStringOrNull
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.booleanOrNull
import kotlinx.serialization.json.buildJsonObject

data class GatewayCronRunSummary(
  val ts: Long,
  val runId: String?,
  val status: String?,
  val summary: String?,
  val error: String?,
  val durationMs: Long?,
  val deliveryStatus: String?,
  val sessionKey: String?,
  val model: String?,
)

sealed interface GatewayCronRunHistoryState {
  data object Idle : GatewayCronRunHistoryState

  data class Loading(
    val id: String,
  ) : GatewayCronRunHistoryState

  data class Loaded(
    val id: String,
    val runs: List<GatewayCronRunSummary>,
  ) : GatewayCronRunHistoryState

  data class Error(
    val id: String,
    val message: String,
  ) : GatewayCronRunHistoryState
}

enum class GatewayCronAction {
  Run,
  Enable,
  Disable,
  Save,
  Delete,
}

enum class GatewayCronNoticeKind {
  Success,
  Warning,
  Error,
}

sealed interface GatewayCronActionState {
  data object Idle : GatewayCronActionState

  data class Running(
    val id: String,
    val action: GatewayCronAction,
  ) : GatewayCronActionState

  data class Notice(
    val id: String,
    val message: NativeText,
    val kind: GatewayCronNoticeKind,
    val deleted: Boolean = false,
  ) : GatewayCronActionState {
    constructor(
      id: String,
      message: String,
      kind: GatewayCronNoticeKind,
      deleted: Boolean = false,
    ) : this(id = id, message = nativeText(message), kind = kind, deleted = deleted)
  }
}

/** Owns one queued manual run id per job so a stale tracker cannot clear a newer run. */
internal class PendingCronRunRegistry {
  private val lock = Any()
  private val runIdsByJob = linkedMapOf<String, String>()

  fun contains(rawJobId: String): Boolean {
    val jobId = rawJobId.trim().takeIf { it.isNotEmpty() } ?: return false
    return synchronized(lock) { runIdsByJob.containsKey(jobId) }
  }

  fun begin(
    rawJobId: String,
    rawRunId: String,
    publish: (Set<String>) -> Unit,
  ): Boolean {
    val jobId = rawJobId.trim().takeIf { it.isNotEmpty() } ?: return false
    val runId = rawRunId.trim().takeIf { it.isNotEmpty() } ?: return false
    return synchronized(lock) {
      if (runIdsByJob.containsKey(jobId)) return@synchronized false
      runIdsByJob[jobId] = runId
      publish(runIdsByJob.keys.toSet())
      true
    }
  }

  fun finish(
    rawJobId: String,
    rawRunId: String,
    publish: (Set<String>) -> Unit,
  ): Boolean {
    val jobId = rawJobId.trim().takeIf { it.isNotEmpty() } ?: return false
    val runId = rawRunId.trim().takeIf { it.isNotEmpty() } ?: return false
    return synchronized(lock) {
      if (runIdsByJob[jobId] != runId) return@synchronized false
      runIdsByJob.remove(jobId)
      publish(runIdsByJob.keys.toSet())
      true
    }
  }

  fun clear(publish: (Set<String>) -> Unit) {
    synchronized(lock) {
      runIdsByJob.clear()
      publish(emptySet())
    }
  }
}

internal fun nextCronJobsPageOffset(
  page: JsonObject?,
  requestedOffset: Int,
  pageCount: Int,
): Int? {
  val responseOffset =
    page
      ?.long("offset")
      ?.takeIf { it in 0L..Int.MAX_VALUE.toLong() }
      ?.toInt()
      ?: requestedOffset
  val total = page?.long("total")?.takeIf { it >= 0 }
  val hasMore =
    (page?.get("hasMore") as? JsonPrimitive)?.booleanOrNull
      ?: (total != null && responseOffset.toLong() + pageCount < total)
  if (!hasMore) return null

  val nextOffset =
    page
      ?.long("nextOffset")
      ?.takeIf { it in 0L..Int.MAX_VALUE.toLong() }
      ?.toInt()
      ?: Math.addExact(responseOffset, pageCount)
  require(nextOffset > requestedOffset) { "Gateway returned a non-advancing cron jobs page." }
  return nextOffset
}

sealed interface GatewayCronScheduleEdit {
  data class At(
    val at: String,
  ) : GatewayCronScheduleEdit

  data class Every(
    val everyMs: String,
    val anchorMs: String,
  ) : GatewayCronScheduleEdit

  data class Cron(
    val expression: String,
    val timezone: String,
    val staggerMs: String,
  ) : GatewayCronScheduleEdit

  data class OnExit(
    val command: String,
    val cwd: String,
  ) : GatewayCronScheduleEdit
}

sealed interface GatewayCronPayloadEdit {
  data class SystemEvent(
    val text: String,
  ) : GatewayCronPayloadEdit

  data class AgentTurn(
    val message: String,
    val model: String,
    val thinking: String,
  ) : GatewayCronPayloadEdit

  data class Command(
    val argvJson: String,
    val cwd: String,
  ) : GatewayCronPayloadEdit
}

data class GatewayCronJobEdit(
  val name: String,
  val description: String,
  val enabled: Boolean,
  val deleteAfterRun: Boolean,
  val schedule: GatewayCronScheduleEdit,
  val sessionTarget: String,
  val wakeMode: String,
  val payload: GatewayCronPayloadEdit,
) {
  fun withSchedule(value: GatewayCronScheduleEdit): GatewayCronJobEdit =
    copy(
      schedule = value,
      deleteAfterRun = deleteAfterRun && value is GatewayCronScheduleEdit.At,
    )
}

internal data class CronEditorDraftState(
  val baseline: GatewayCronJobEdit,
  val edit: GatewayCronJobEdit,
  val savePending: Boolean = false,
  val saveSucceeded: Boolean = false,
  val hasIncomingConflict: Boolean = false,
) {
  val isDirty: Boolean
    get() = edit != baseline

  val requiresResolution: Boolean
    get() = isDirty || hasIncomingConflict

  fun withEdit(value: GatewayCronJobEdit): CronEditorDraftState = copy(edit = value)

  fun saveStarted(): CronEditorDraftState = copy(savePending = true, saveSucceeded = false)

  fun saveAborted(): CronEditorDraftState = copy(savePending = false, saveSucceeded = false)

  fun observeSaveNotice(kind: GatewayCronNoticeKind): CronEditorDraftState {
    if (!savePending) return this
    return if (kind == GatewayCronNoticeKind.Success) {
      copy(saveSucceeded = true)
    } else {
      copy(savePending = false, saveSucceeded = false)
    }
  }

  fun observeJob(job: GatewayCronJobDetail): CronEditorDraftState {
    val incoming = job.toCronJobEdit()
    if (incoming == edit) {
      return CronEditorDraftState(
        baseline = incoming,
        edit = incoming,
      )
    }
    if (incoming == baseline) {
      return copy(hasIncomingConflict = false)
    }
    val canAdopt = !isDirty || saveSucceeded
    if (!canAdopt) {
      return copy(hasIncomingConflict = true)
    }
    return CronEditorDraftState(
      baseline = incoming,
      edit = incoming,
    )
  }

  companion object {
    fun from(job: GatewayCronJobDetail): CronEditorDraftState {
      val edit = job.toCronJobEdit()
      return CronEditorDraftState(
        baseline = edit,
        edit = edit,
      )
    }
  }
}

internal fun CronEditorDraftState.reconcileRestoredAction(
  isConnected: Boolean,
  jobId: String,
  actionState: GatewayCronActionState,
): CronEditorDraftState {
  if (!savePending) return this
  // Activity recreation retains the runtime action; process death does not.
  // Preserve pending only when the restored runtime still owns this Save.
  val retainedSaveState =
    when (actionState) {
      is GatewayCronActionState.Running ->
        actionState.id == jobId && actionState.action == GatewayCronAction.Save
      is GatewayCronActionState.Notice -> actionState.id == jobId
      GatewayCronActionState.Idle -> false
    }
  return if (isConnected && retainedSaveState) this else saveAborted()
}

internal enum class GatewayCronRunSkipReason {
  NotDue,
  AlreadyRunning,
  RestartRecoveryPending,
  InvalidSpec,
  Stopped,
  ;

  val message: String
    get() = messageText.resolveNativeText()

  val messageText: NativeText
    get() =
      when (this) {
        NotDue -> nativeText("Automation is not due yet.")
        AlreadyRunning -> nativeText("Automation is already running.")
        RestartRecoveryPending -> nativeText("Gateway restart recovery is still in progress.")
        InvalidSpec -> nativeText("Automation has an invalid configuration.")
        Stopped -> nativeText("Cron scheduler is stopped.")
      }
}

internal sealed interface GatewayCronRunOutcome {
  data class Started(
    val runId: String?,
  ) : GatewayCronRunOutcome

  data class Skipped(
    val reason: GatewayCronRunSkipReason,
  ) : GatewayCronRunOutcome

  data object Rejected : GatewayCronRunOutcome
}

internal fun cronRunShouldRefresh(outcome: GatewayCronRunOutcome): Boolean =
  when (outcome) {
    is GatewayCronRunOutcome.Started -> true
    is GatewayCronRunOutcome.Skipped -> outcome.reason == GatewayCronRunSkipReason.InvalidSpec
    GatewayCronRunOutcome.Rejected -> false
  }

internal fun cronRunCompletionNotice(
  jobId: String,
  status: String?,
): GatewayCronActionState.Notice {
  val (message, kind) =
    when (status) {
      "ok" -> nativeText("Automation run finished.") to GatewayCronNoticeKind.Success
      "skipped" -> nativeText("Automation run skipped.") to GatewayCronNoticeKind.Warning
      "error" -> nativeText("Automation run failed.") to GatewayCronNoticeKind.Error
      else -> nativeText("Automation run finished with an unknown status.") to GatewayCronNoticeKind.Warning
    }
  return GatewayCronActionState.Notice(id = jobId, message = message, kind = kind)
}

internal fun isCronJobRevisionConflict(error: GatewaySession.ErrorShape): Boolean = error.details?.code == "CRON_JOB_CHANGED"

internal fun GatewayCronJobDetail.toCronJobEdit(): GatewayCronJobEdit =
  GatewayCronJobEdit(
    name = name,
    description = description,
    enabled = enabled,
    // Gateway deletion only runs after a successful one-shot schedule.
    deleteAfterRun = deleteAfterRun && scheduleKind == "at",
    schedule =
      when (scheduleKind) {
        "at" -> GatewayCronScheduleEdit.At(at = scheduleAt.orEmpty())
        "every" ->
          GatewayCronScheduleEdit.Every(
            everyMs = scheduleEveryMs?.toString().orEmpty(),
            anchorMs = scheduleAnchorMs?.toString().orEmpty(),
          )
        "cron" ->
          GatewayCronScheduleEdit.Cron(
            expression = scheduleCronExpr.orEmpty(),
            timezone = scheduleTimezone.orEmpty(),
            staggerMs = scheduleStaggerMs?.toString().orEmpty(),
          )
        "on-exit" ->
          GatewayCronScheduleEdit.OnExit(
            command = scheduleCommand.orEmpty(),
            cwd = scheduleCwd.orEmpty(),
          )
        else -> error("Unsupported cron schedule kind: $scheduleKind")
      },
    sessionTarget = sessionTarget,
    wakeMode = wakeMode,
    payload =
      when (payloadKind) {
        "systemEvent" -> GatewayCronPayloadEdit.SystemEvent(text = payloadText.orEmpty())
        "agentTurn" ->
          GatewayCronPayloadEdit.AgentTurn(
            message = payloadText.orEmpty(),
            model = payloadModel.orEmpty(),
            thinking = payloadThinking.orEmpty(),
          )
        "command" ->
          GatewayCronPayloadEdit.Command(
            argvJson = JsonArray(payloadCommandArgv.orEmpty().map(::JsonPrimitive)).toString(),
            cwd = payloadCommandCwd.orEmpty(),
          )
        else -> error("Unsupported cron payload kind: $payloadKind")
      },
  )

internal fun buildCronUpdateParams(
  original: GatewayCronJobDetail,
  edit: GatewayCronJobEdit,
): String {
  val name = edit.name.trim()
  require(name.isNotEmpty()) { "Automation name is required." }
  val description = edit.description.trim()
  val sessionTarget = edit.sessionTarget.trim()
  require(
    sessionTarget == "main" ||
      sessionTarget == "isolated" ||
      sessionTarget == "current" ||
      (sessionTarget.startsWith("session:") && sessionTarget.removePrefix("session:").isNotBlank()),
  ) { "Session target must be main, isolated, current, or session:<id>." }
  val wakeMode = edit.wakeMode.trim()
  require(wakeMode == "now" || wakeMode == "next-heartbeat") {
    "Wake mode must be now or next-heartbeat."
  }

  val schedulePatch = buildCronSchedulePatch(original = original, edit = edit.schedule)
  val payloadPatch = buildCronPayloadPatch(original = original, edit = edit.payload)
  val patch =
    buildJsonObject {
      if (name != original.name) put("name", JsonPrimitive(name))
      if (description != original.description) put("description", JsonPrimitive(description))
      if (edit.enabled != original.enabled) put("enabled", JsonPrimitive(edit.enabled))
      if (edit.deleteAfterRun != original.deleteAfterRun) {
        put("deleteAfterRun", JsonPrimitive(edit.deleteAfterRun))
      }
      schedulePatch?.let { put("schedule", it) }
      if (sessionTarget != original.sessionTarget) {
        put("sessionTarget", JsonPrimitive(sessionTarget))
      }
      if (wakeMode != original.wakeMode) put("wakeMode", JsonPrimitive(wakeMode))
      payloadPatch?.let { put("payload", it) }
    }
  require(patch.isNotEmpty()) { "No cron changes to save." }
  val configRevision =
    requireNotNull(original.configRevision) {
      "Update the gateway before saving cron changes from Android."
    }
  return buildJsonObject {
    put("id", JsonPrimitive(original.id))
    put("expectedConfigRevision", JsonPrimitive(configRevision))
    put("patch", patch)
  }.toString()
}

internal fun parseGatewayCronRunOutcome(root: JsonObject?): GatewayCronRunOutcome? {
  val value = root ?: return null
  val ok = value.optionalBoolean("ok") ?: return null
  if (!ok) return GatewayCronRunOutcome.Rejected
  if (value.optionalBoolean("ran") == true) {
    return GatewayCronRunOutcome.Started(runId = value.string("runId"))
  }
  if (value.optionalBoolean("enqueued") == true) {
    val runId = value.string("runId") ?: return null
    return GatewayCronRunOutcome.Started(runId = runId)
  }
  if (value.optionalBoolean("ran") != false) return null
  val reason =
    when (value.string("reason")) {
      "not-due" -> GatewayCronRunSkipReason.NotDue
      "already-running" -> GatewayCronRunSkipReason.AlreadyRunning
      "restart-recovery-pending" -> GatewayCronRunSkipReason.RestartRecoveryPending
      "invalid-spec" -> GatewayCronRunSkipReason.InvalidSpec
      "stopped" -> GatewayCronRunSkipReason.Stopped
      else -> return null
    }
  return GatewayCronRunOutcome.Skipped(reason)
}

internal fun parseGatewayCronRunHistory(entries: JsonArray?): List<GatewayCronRunSummary> =
  entries
    ?.mapNotNull { item ->
      val value = item.asObjectOrNull() ?: return@mapNotNull null
      val ts = value.long("ts") ?: return@mapNotNull null
      GatewayCronRunSummary(
        ts = ts,
        runId = value.string("runId"),
        status = value.string("status"),
        summary = value.string("summary"),
        error = value.string("error"),
        durationMs = value.long("durationMs"),
        deliveryStatus = value.string("deliveryStatus"),
        sessionKey = value.string("sessionKey"),
        model = value.string("model"),
      )
    }.orEmpty()

private fun buildCronSchedulePatch(
  original: GatewayCronJobDetail,
  edit: GatewayCronScheduleEdit,
): JsonObject? =
  when (edit) {
    is GatewayCronScheduleEdit.At -> {
      require(original.scheduleKind == "at") { "Changing schedule type is not supported here." }
      val at = edit.at.trim()
      require(at.isNotEmpty()) { "One-time automations need an ISO time." }
      if (at == original.scheduleAt) {
        null
      } else {
        buildJsonObject {
          put("kind", JsonPrimitive("at"))
          put("at", JsonPrimitive(at))
        }
      }
    }
    is GatewayCronScheduleEdit.Every -> {
      require(original.scheduleKind == "every") { "Changing schedule type is not supported here." }
      val everyMs = edit.everyMs.trim().toLongOrNull()
      require(everyMs != null && everyMs > 0L) { "Interval must be a positive number of milliseconds." }
      val anchorMs = parseOptionalNonNegativeLong(edit.anchorMs, "Anchor")
      if (everyMs == original.scheduleEveryMs && anchorMs == original.scheduleAnchorMs) {
        null
      } else {
        buildJsonObject {
          put("kind", JsonPrimitive("every"))
          put("everyMs", JsonPrimitive(everyMs))
          anchorMs?.let { put("anchorMs", JsonPrimitive(it)) }
        }
      }
    }
    is GatewayCronScheduleEdit.Cron -> {
      require(original.scheduleKind == "cron") { "Changing schedule type is not supported here." }
      val expression = edit.expression.trim()
      require(expression.isNotEmpty()) { "Cron expression is required." }
      val timezone = edit.timezone.trim().ifEmpty { null }
      val requestedStaggerMs = parseOptionalNonNegativeLong(edit.staggerMs, "Stagger")
      val staggerMs =
        requestedStaggerMs ?: if (original.scheduleStaggerMs != null) 0L else null
      if (
        expression == original.scheduleCronExpr &&
        timezone == original.scheduleTimezone &&
        staggerMs == original.scheduleStaggerMs
      ) {
        null
      } else {
        buildJsonObject {
          put("kind", JsonPrimitive("cron"))
          put("expr", JsonPrimitive(expression))
          timezone?.let { put("tz", JsonPrimitive(it)) }
          staggerMs?.let { put("staggerMs", JsonPrimitive(it)) }
        }
      }
    }
    is GatewayCronScheduleEdit.OnExit -> {
      require(original.scheduleKind == "on-exit") { "Changing schedule type is not supported here." }
      val command = edit.command.trim()
      require(command.isNotEmpty()) { "On-exit automations need a command." }
      val cwd = edit.cwd.trim().ifEmpty { null }
      if (command == original.scheduleCommand && cwd == original.scheduleCwd) {
        null
      } else {
        buildJsonObject {
          put("kind", JsonPrimitive("on-exit"))
          put("command", JsonPrimitive(command))
          cwd?.let { put("cwd", JsonPrimitive(it)) }
        }
      }
    }
  }

private fun buildCronPayloadPatch(
  original: GatewayCronJobDetail,
  edit: GatewayCronPayloadEdit,
): JsonObject? =
  when (edit) {
    is GatewayCronPayloadEdit.SystemEvent -> {
      require(original.payloadKind == "systemEvent") { "Changing payload type is not supported here." }
      val text = edit.text.trim()
      require(text.isNotEmpty()) { "System event text is required." }
      if (text == original.payloadText) {
        null
      } else {
        buildJsonObject {
          put("kind", JsonPrimitive("systemEvent"))
          put("text", JsonPrimitive(text))
        }
      }
    }
    is GatewayCronPayloadEdit.AgentTurn -> {
      require(original.payloadKind == "agentTurn") { "Changing payload type is not supported here." }
      val message = edit.message.trim()
      require(message.isNotEmpty()) { "Agent message is required." }
      val model = edit.model.trim().ifEmpty { null }
      val thinking = edit.thinking.trim().ifEmpty { null }
      if (
        message == original.payloadText &&
        model == original.payloadModel &&
        thinking == original.payloadThinking
      ) {
        null
      } else {
        buildJsonObject {
          put("kind", JsonPrimitive("agentTurn"))
          if (message != original.payloadText) put("message", JsonPrimitive(message))
          if (model != original.payloadModel) put("model", model?.let(::JsonPrimitive) ?: JsonNull)
          if (thinking != original.payloadThinking) {
            put("thinking", thinking?.let(::JsonPrimitive) ?: JsonNull)
          }
        }
      }
    }
    is GatewayCronPayloadEdit.Command -> {
      require(original.payloadKind == "command") { "Changing payload type is not supported here." }
      val argv = parseCommandArgv(edit.argvJson)
      val cwd = edit.cwd.trim().ifEmpty { null }
      if (cwd == null && original.payloadCommandCwd != null) {
        error("The gateway does not support clearing a command working directory.")
      }
      if (argv == original.payloadCommandArgv && cwd == original.payloadCommandCwd) {
        null
      } else {
        buildJsonObject {
          put("kind", JsonPrimitive("command"))
          if (argv != original.payloadCommandArgv) {
            put("argv", JsonArray(argv.map(::JsonPrimitive)))
          }
          if (cwd != original.payloadCommandCwd) put("cwd", JsonPrimitive(requireNotNull(cwd)))
        }
      }
    }
  }

private fun parseCommandArgv(raw: String): List<String> {
  val value =
    runCatching { Json.parseToJsonElement(raw) }.getOrNull() as? JsonArray
      ?: error("Command argv must be a JSON array.")
  val argv =
    value.map { item ->
      val primitive = item as? JsonPrimitive
      primitive?.takeIf { it.isString }?.content?.takeIf { it.isNotEmpty() }
        ?: error("Command argv entries must be non-empty strings.")
    }
  require(argv.isNotEmpty()) { "Command argv must contain at least one entry." }
  return argv
}

private fun parseOptionalNonNegativeLong(
  raw: String,
  label: String,
): Long? {
  val value = raw.trim()
  if (value.isEmpty()) return null
  val parsed = value.toLongOrNull()
  require(parsed != null && parsed >= 0L) { "$label must be a non-negative number of milliseconds." }
  return parsed
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

private fun JsonObject.optionalBoolean(key: String): Boolean? = (this[key] as? JsonPrimitive)?.booleanOrNull
