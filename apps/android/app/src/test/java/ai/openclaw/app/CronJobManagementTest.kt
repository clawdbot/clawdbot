package ai.openclaw.app

import ai.openclaw.app.gateway.GatewayErrorDetails
import ai.openclaw.app.gateway.GatewaySession
import ai.openclaw.app.ui.cronWakeModeLabel
import ai.openclaw.app.ui.cronWakeModeOptions
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class CronJobManagementTest {
  @Test
  fun wakeModeLabelsPreserveGatewayCodes() {
    assertEquals(
      listOf("next-heartbeat", "now"),
      cronWakeModeOptions().map { it.code },
    )
    assertEquals("Next heartbeat", cronWakeModeLabel("next-heartbeat"))
    assertEquals("Now", cronWakeModeLabel("now"))
    assertEquals("future-mode", cronWakeModeLabel("future-mode"))
  }

  @Test
  fun parsesEveryClosedCronRunOutcome() {
    val started = parseGatewayCronRunOutcome(objectJson("""{"ok":true,"ran":true}"""))
    val queued =
      parseGatewayCronRunOutcome(
        objectJson("""{"ok":true,"enqueued":true,"runId":"run-1"}"""),
      )

    assertEquals(GatewayCronRunOutcome.Started(runId = null), started)
    assertEquals(GatewayCronRunOutcome.Started(runId = "run-1"), queued)
    mapOf(
      "not-due" to GatewayCronRunSkipReason.NotDue,
      "already-running" to GatewayCronRunSkipReason.AlreadyRunning,
      "restart-recovery-pending" to GatewayCronRunSkipReason.RestartRecoveryPending,
      "invalid-spec" to GatewayCronRunSkipReason.InvalidSpec,
      "stopped" to GatewayCronRunSkipReason.Stopped,
    ).forEach { (raw, reason) ->
      assertEquals(
        GatewayCronRunOutcome.Skipped(reason),
        parseGatewayCronRunOutcome(
          objectJson("""{"ok":true,"ran":false,"reason":"$raw"}"""),
        ),
      )
    }
    assertEquals(
      GatewayCronRunOutcome.Rejected,
      parseGatewayCronRunOutcome(objectJson("""{"ok":false}""")),
    )
    assertEquals(null, parseGatewayCronRunOutcome(objectJson("""{"ok":true,"ran":false,"reason":"future"}""")))
    assertEquals(null, parseGatewayCronRunOutcome(objectJson("""{"ok":true,"enqueued":true}""")))
  }

  @Test
  fun updatePatchIsMinimalAndClearsAgentOverridesWithNull() {
    val original = requireNotNull(parseGatewayCronJobDetail(jobJson()))
    val initial = original.toCronJobEdit()
    val payload = initial.payload as GatewayCronPayloadEdit.AgentTurn
    val edit = initial.copy(payload = payload.copy(model = "", thinking = ""))

    val root = objectJson(buildCronUpdateParams(original = original, edit = edit))
    val patch = root.getValue("patch").jsonObject
    val payloadPatch = patch.getValue("payload").jsonObject

    assertEquals("sha256:fixture", root.getValue("expectedConfigRevision").jsonPrimitive.content)
    assertEquals(setOf("payload"), patch.keys)
    assertEquals("agentTurn", payloadPatch.getValue("kind").jsonPrimitive.content)
    assertEquals(JsonNull, payloadPatch["model"])
    assertEquals(JsonNull, payloadPatch["thinking"])
    assertFalse(payloadPatch.containsKey("message"))
  }

  @Test
  fun intervalPatchPreservesAnchorAndOmitsUnchangedPayload() {
    val original =
      requireNotNull(
        parseGatewayCronJobDetail(
          jobJson(schedule = """{"kind":"every","everyMs":60000,"anchorMs":1000}"""),
        ),
      )
    val initial = original.toCronJobEdit()
    val schedule = initial.schedule as GatewayCronScheduleEdit.Every
    val edit = initial.copy(schedule = schedule.copy(everyMs = "120000"))

    val patch =
      objectJson(buildCronUpdateParams(original = original, edit = edit))
        .getValue("patch")
        .jsonObject
    val schedulePatch = patch.getValue("schedule").jsonObject

    assertEquals(setOf("schedule"), patch.keys)
    assertEquals("120000", schedulePatch.getValue("everyMs").jsonPrimitive.content)
    assertEquals("1000", schedulePatch.getValue("anchorMs").jsonPrimitive.content)
  }

  @Test
  fun deleteAfterRunStaysAvailableOnlyForOneShotSchedules() {
    val recurring =
      requireNotNull(
        parseGatewayCronJobDetail(jobJson(deleteAfterRun = true)),
      ).toCronJobEdit()
    val oneShot =
      requireNotNull(
        parseGatewayCronJobDetail(
          jobJson(
            deleteAfterRun = true,
            schedule = """{"kind":"at","at":"2026-07-10T09:00:00Z"}""",
          ),
        ),
      ).toCronJobEdit()

    assertFalse(recurring.deleteAfterRun)
    assertTrue(oneShot.deleteAfterRun)
    assertFalse(
      oneShot
        .withSchedule(GatewayCronScheduleEdit.Every(everyMs = "60000", anchorMs = ""))
        .deleteAfterRun,
    )
  }

  @Test
  fun commandArgvRejectsNonStringJsonPrimitives() {
    val original =
      requireNotNull(
        parseGatewayCronJobDetail(
          jobJson(payload = """{"kind":"command","argv":["echo"],"cwd":"/tmp"}"""),
        ),
      )
    val initial = original.toCronJobEdit()
    val payload = initial.payload as GatewayCronPayloadEdit.Command
    val edit = initial.copy(payload = payload.copy(argvJson = """["echo",1,true,null]"""))

    val error = runCatching { buildCronUpdateParams(original = original, edit = edit) }.exceptionOrNull()

    assertEquals("Command argv entries must be non-empty strings.", error?.message)
  }

  @Test
  fun commandArgvPreservesWhitespaceOnlyEntriesAllowedByGateway() {
    val original =
      requireNotNull(
        parseGatewayCronJobDetail(
          jobJson(payload = """{"kind":"command","argv":["printf"," "],"cwd":"/tmp"}"""),
        ),
      )
    val edit = original.toCronJobEdit().copy(name = "Renamed command")

    val patch =
      objectJson(buildCronUpdateParams(original = original, edit = edit))
        .getValue("patch")
        .jsonObject

    assertEquals(setOf("name"), patch.keys)
    assertEquals("Renamed command", patch.getValue("name").jsonPrimitive.content)
  }

  @Test
  fun commandPayloadRejectsClearingAnExistingWorkingDirectory() {
    val original =
      requireNotNull(
        parseGatewayCronJobDetail(
          jobJson(payload = """{"kind":"command","argv":["echo"],"cwd":"/tmp"}"""),
        ),
      )
    val initial = original.toCronJobEdit()
    val payload = initial.payload as GatewayCronPayloadEdit.Command

    val error =
      runCatching {
        buildCronUpdateParams(
          original = original,
          edit = initial.copy(payload = payload.copy(cwd = "")),
        )
      }.exceptionOrNull()

    assertEquals("The gateway does not support clearing a command working directory.", error?.message)
  }

  @Test
  fun historyParserRequiresTimestampAndKeepsUsefulFields() {
    val entries =
      Json
        .parseToJsonElement(
          """
          [
            {"ts":1000,"runId":"run-1","status":"ok","summary":"done","durationMs":42},
            {"runId":"missing-ts"}
          ]
          """.trimIndent(),
        ).jsonArray

    val runs = parseGatewayCronRunHistory(entries)

    assertEquals(1, runs.size)
    assertEquals("run-1", runs.single().runId)
    assertEquals(42L, runs.single().durationMs)
  }

  @Test
  fun invalidSpecSkipRefreshesPersistedDiagnosticsWithoutRefreshingOtherSkips() {
    assertTrue(cronRunShouldRefresh(GatewayCronRunOutcome.Started(runId = "run-1")))
    assertTrue(
      cronRunShouldRefresh(
        GatewayCronRunOutcome.Skipped(GatewayCronRunSkipReason.InvalidSpec),
      ),
    )
    assertFalse(
      cronRunShouldRefresh(
        GatewayCronRunOutcome.Skipped(GatewayCronRunSkipReason.AlreadyRunning),
      ),
    )
    assertFalse(cronRunShouldRefresh(GatewayCronRunOutcome.Rejected))
  }

  @Test
  fun queuedRunCompletionNoticeMatchesTerminalHistoryStatus() {
    listOf(
      Triple("ok", "Automation run finished.", GatewayCronNoticeKind.Success),
      Triple("skipped", "Automation run skipped.", GatewayCronNoticeKind.Warning),
      Triple("error", "Automation run failed.", GatewayCronNoticeKind.Error),
      Triple(null, "Automation run finished with an unknown status.", GatewayCronNoticeKind.Warning),
    ).forEach { (status, message, kind) ->
      assertEquals(
        GatewayCronActionState.Notice(id = "job", message = message, kind = kind),
        cronRunCompletionNotice("job", status),
      )
    }
  }

  @Test
  fun pendingRunRegistryDedupesOnlyTheSameJobAndIgnoresStaleTrackers() {
    val registry = PendingCronRunRegistry()
    val snapshots = mutableListOf<Set<String>>()

    assertTrue(registry.begin("job-a", "run-a") { snapshots += it })
    assertFalse(registry.begin("job-a", "run-a-duplicate") { snapshots += it })
    assertTrue(registry.begin("job-b", "run-b") { snapshots += it })
    assertTrue(registry.contains("job-a"))
    assertTrue(registry.contains("job-b"))
    assertFalse(registry.finish("job-a", "stale-run") { snapshots += it })
    assertTrue(registry.finish("job-a", "run-a") { snapshots += it })
    assertFalse(registry.contains("job-a"))
    assertTrue(registry.contains("job-b"))
    registry.clear { snapshots += it }
    assertFalse(registry.contains("job-b"))
    assertEquals(
      listOf(setOf("job-a"), setOf("job-a", "job-b"), setOf("job-b"), emptySet()),
      snapshots,
    )
  }

  @Test
  fun mapsCronRevisionConflicts() {
    val conflict =
      GatewaySession.ErrorShape(
        code = "INVALID_REQUEST",
        message = "changed",
        details =
          GatewayErrorDetails(
            code = "CRON_JOB_CHANGED",
            canRetryWithDeviceToken = false,
            recommendedNextStep = null,
          ),
      )
    val generic = conflict.copy(details = conflict.details?.copy(code = "OTHER"))

    assertTrue(isCronJobRevisionConflict(conflict))
    assertFalse(isCronJobRevisionConflict(generic))
  }

  @Test
  fun updateFailsClosedWhenGatewayDoesNotProvideConfigRevision() {
    val original = requireNotNull(parseGatewayCronJobDetail(jobJson(configRevision = null)))
    val error =
      runCatching {
        buildCronUpdateParams(
          original = original,
          edit = original.toCronJobEdit().copy(name = "Renamed"),
        )
      }.exceptionOrNull()

    assertEquals("Update the gateway before saving cron changes from Android.", error?.message)
  }

  @Test
  fun detailAndHistoryGenerationsAdvanceIndependently() {
    val detailGuard = CronJobDetailRequestGuard()
    val historyGuard = CronJobDetailRequestGuard()
    val detailA = requireNotNull(detailGuard.begin("job-a"))
    val historyA = requireNotNull(historyGuard.begin("job-a"))
    val historyB = requireNotNull(historyGuard.begin("job-b"))
    var detailPublished = false
    var historyPublished = "none"

    assertTrue(detailGuard.publishIfCurrent(detailA) { detailPublished = true })
    assertFalse(historyGuard.publishIfCurrent(historyA) { historyPublished = "a" })
    assertTrue(historyGuard.publishIfCurrent(historyB) { historyPublished = "b" })
    assertTrue(detailPublished)
    assertEquals("b", historyPublished)
  }

  @Test
  fun editorDraftPreservesDirtyFieldsAndMarksIncomingRevisionConflict() {
    val original = requireNotNull(parseGatewayCronJobDetail(jobJson()))
    var draft = CronEditorDraftState.from(original)
    draft = draft.withEdit(draft.edit.copy(name = "Unsaved name"))
    val unrelated =
      requireNotNull(
        parseGatewayCronJobDetail(
          jobJson(name = "Gateway revision"),
        ),
      )

    draft = draft.observeJob(unrelated)

    assertEquals("Unsaved name", draft.edit.name)
    assertTrue(draft.isDirty)
    assertTrue(draft.hasIncomingConflict)
    assertTrue(draft.requiresResolution)
    val returnedToBaseline = draft.withEdit(draft.baseline)
    assertFalse(returnedToBaseline.isDirty)
    assertTrue(returnedToBaseline.requiresResolution)
    val reverted = CronEditorDraftState.from(unrelated)
    assertEquals("Gateway revision", reverted.edit.name)
    assertFalse(reverted.isDirty)
    assertFalse(reverted.hasIncomingConflict)
  }

  @Test
  fun editorDraftIgnoresRuntimeOnlyTimestampUpdates() {
    val original = requireNotNull(parseGatewayCronJobDetail(jobJson()))
    val draft =
      CronEditorDraftState
        .from(original)
        .withEdit(original.toCronJobEdit().copy(name = "Unsaved name"))
    val runtimeUpdate =
      requireNotNull(
        parseGatewayCronJobDetail(
          jobJson(updatedAtMs = 3000),
        ),
      )

    val observed = draft.observeJob(runtimeUpdate)

    assertEquals("Unsaved name", observed.edit.name)
    assertTrue(observed.isDirty)
    assertFalse(observed.hasIncomingConflict)
  }

  @Test
  fun editorDraftAdoptsOnlyTheNewRevisionAfterSuccessfulSave() {
    val original = requireNotNull(parseGatewayCronJobDetail(jobJson()))
    var draft = CronEditorDraftState.from(original)
    draft = draft.withEdit(draft.edit.copy(name = "Saved name"))

    draft = draft.saveStarted().saveAborted()
    assertFalse(draft.savePending)
    assertEquals("Saved name", draft.edit.name)
    draft = draft.saveStarted().observeSaveNotice(GatewayCronNoticeKind.Error)
    assertEquals("Saved name", draft.edit.name)
    draft = draft.saveStarted().observeSaveNotice(GatewayCronNoticeKind.Success)
    assertEquals("Saved name", draft.observeJob(original).edit.name)

    val saved =
      requireNotNull(
        parseGatewayCronJobDetail(
          jobJson(name = "Saved name", updatedAtMs = 4000, configRevision = "sha256:saved"),
        ),
      )
    draft = draft.observeJob(saved)

    assertEquals("Saved name", draft.baseline.name)
    assertEquals(draft.baseline, draft.edit)
    assertFalse(draft.savePending)
    assertFalse(draft.saveSucceeded)
  }

  @Test
  fun restoredPendingSaveTracksRetainedRuntimeAndRecoversAfterProcessDeath() {
    val original = requireNotNull(parseGatewayCronJobDetail(jobJson()))
    val pending =
      CronEditorDraftState
        .from(original)
        .withEdit(original.toCronJobEdit().copy(name = "Saved name"))
        .saveStarted()
    val running = GatewayCronActionState.Running(id = original.id, action = GatewayCronAction.Save)
    val success =
      GatewayCronActionState.Notice(
        id = original.id,
        message = "Automation updated.",
        kind = GatewayCronNoticeKind.Success,
      )

    assertEquals(
      pending,
      pending.reconcileRestoredAction(isConnected = true, jobId = original.id, actionState = running),
    )
    assertEquals(
      pending,
      pending.reconcileRestoredAction(isConnected = true, jobId = original.id, actionState = success),
    )
    assertFalse(
      pending
        .reconcileRestoredAction(
          isConnected = true,
          jobId = original.id,
          actionState = GatewayCronActionState.Idle,
        ).savePending,
    )
    assertFalse(
      pending
        .reconcileRestoredAction(
          isConnected = false,
          jobId = original.id,
          actionState = running,
        ).savePending,
    )

    val applied =
      requireNotNull(
        parseGatewayCronJobDetail(
          jobJson(name = "Saved name", updatedAtMs = 4000),
        ),
      )
    val recovered = pending.saveAborted().observeJob(applied)
    assertEquals(recovered.baseline, recovered.edit)
    assertFalse(recovered.requiresResolution)
  }

  @Test
  fun latestRefreshGuardRejectsStaleAndInvalidatedResults() {
    val guard = LatestGatewayRefreshGuard()
    val stale = guard.begin()
    val current = guard.begin()
    var published = "none"

    assertFalse(guard.publishIfCurrent(stale) { published = "stale" })
    assertTrue(guard.publishIfCurrent(current) { published = "current" })
    guard.invalidate()
    assertFalse(guard.publishIfCurrent(current) { published = "invalidated" })
    assertEquals("current", published)
  }

  @Test
  fun cronJobsPaginationFollowsEveryGatewayPage() {
    assertEquals(
      200,
      nextCronJobsPageOffset(
        objectJson("""{"total":450,"offset":0,"hasMore":true,"nextOffset":200}"""),
        requestedOffset = 0,
        pageCount = 200,
      ),
    )
    assertEquals(
      400,
      nextCronJobsPageOffset(
        objectJson("""{"total":450,"offset":200,"hasMore":true}"""),
        requestedOffset = 200,
        pageCount = 200,
      ),
    )
    assertEquals(
      null,
      nextCronJobsPageOffset(
        objectJson("""{"total":450,"offset":400,"hasMore":false,"nextOffset":null}"""),
        requestedOffset = 400,
        pageCount = 50,
      ),
    )
  }

  @Test
  fun cronJobsPaginationRejectsNonAdvancingGatewayPages() {
    val error =
      runCatching {
        nextCronJobsPageOffset(
          objectJson("""{"total":450,"offset":200,"hasMore":true,"nextOffset":200}"""),
          requestedOffset = 200,
          pageCount = 200,
        )
      }.exceptionOrNull()

    assertEquals("Gateway returned a non-advancing cron jobs page.", error?.message)
  }

  private fun objectJson(raw: String) = Json.parseToJsonElement(raw).jsonObject

  private fun jobJson(
    name: String = "Daily report",
    updatedAtMs: Long = 2000,
    configRevision: String? = "sha256:fixture",
    deleteAfterRun: Boolean = false,
    schedule: String = """{"kind":"cron","expr":"0 9 * * *","tz":"UTC"}""",
    payload: String =
      """{"kind":"agentTurn","message":"Summarize the day","model":"openai/gpt-5.5","thinking":"high"}""",
  ): JsonObject {
    val configRevisionField =
      configRevision?.let { """"configRevision":"$it",""" }.orEmpty()
    return objectJson(
      """
      {
        "id":"job-1",
        "name":"$name",
        "description":"Daily digest",
        "enabled":true,
        "deleteAfterRun":$deleteAfterRun,
        "createdAtMs":1000,
        "updatedAtMs":$updatedAtMs,
        $configRevisionField
        "schedule":$schedule,
        "sessionTarget":"isolated",
        "wakeMode":"next-heartbeat",
        "payload":$payload,
        "state":{}
      }
      """.trimIndent(),
    )
  }
}
