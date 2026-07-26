package ai.openclaw.app

import ai.openclaw.app.gateway.GatewayEndpoint
import ai.openclaw.app.gateway.GatewayErrorDetails
import ai.openclaw.app.gateway.GatewayRequestOutcomeUnknown
import ai.openclaw.app.gateway.GatewayRequestRejected
import ai.openclaw.app.gateway.GatewaySession
import ai.openclaw.app.i18n.verbatimText
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeout
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import org.robolectric.annotation.Config
import java.lang.reflect.Field
import java.util.UUID
import java.util.concurrent.atomic.AtomicInteger

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34])
class GatewayExecApprovalRuntimeTest {
  @Before
  fun clearPlainPrefs() {
    RuntimeEnvironment
      .getApplication()
      .getSharedPreferences("openclaw.node", android.content.Context.MODE_PRIVATE)
      .edit()
      .clear()
      .commit()
  }

  @Test
  fun anotherSurfaceWinnerClosesLocalCardFromCanonicalResolveResult() =
    runBlocking {
      val runtime = createTestRuntime()
      seedConnectedRuntime(runtime, unifiedMethods)
      seedApproval(runtime)
      val requests = mutableListOf<Pair<String, String?>>()
      runtime.gatewayDataRequestOverrideForTests = { _, method, params ->
        requests += method to params
        check(method == "approval.resolve")
        unifiedResolve(applied = false, status = "denied", decision = "deny")
      }

      runtime.resolveExecApproval("approval-1", "allow-once")
      waitUntil { runtime.execApprovals.value.isEmpty() }

      assertEquals(listOf("approval.resolve"), requests.map { it.first })
      assertEquals(
        """{"id":"approval-1","kind":"exec","decision":"allow-once"}""",
        requests.single().second,
      )
      assertEquals("A prior response already denied this approval.", runtime.execApprovalsNotice.value?.message)
    }

  @Test
  fun exactApprovalIdsCannotCrossTargetThroughKotlinWhitespaceNormalization() =
    runBlocking {
      val runtime = createTestRuntime()
      seedConnectedRuntime(runtime, unifiedMethods)
      val controlPrefixedId = "\u001Capproval-1"
      seedApprovals(
        runtime,
        listOf(
          approvalSummary(id = controlPrefixedId, commandText = "echo selected"),
          approvalSummary(id = "approval-1", commandText = "echo other"),
        ),
      )
      val requestParams = CompletableDeferred<String>()
      val requestCount = AtomicInteger()
      runtime.gatewayDataRequestOverrideForTests = { _, method, params ->
        check(method == "approval.resolve")
        requestCount.incrementAndGet()
        requestParams.complete(requireNotNull(params))
        unifiedResolve(
          applied = true,
          status = "denied",
          decision = "deny",
          id = controlPrefixedId,
        )
      }

      runtime.resolveExecApproval(".", "deny")
      delay(50)
      assertFalse(requestParams.isCompleted)

      runtime.resolveExecApproval(controlPrefixedId, "deny")
      val params = Json.parseToJsonElement(withTimeout(2_000) { requestParams.await() }).jsonObject
      waitUntil { runtime.execApprovals.value.map { it.id } == listOf("approval-1") }

      assertEquals(1, requestCount.get())
      assertEquals(controlPrefixedId, params["id"]?.jsonPrimitive?.content)
      assertEquals(
        "approval-1",
        runtime.execApprovals.value
          .single()
          .id,
      )
    }

  @Test
  fun approvalEventsPreserveExactStringIdsAndRejectNonStrings() =
    runBlocking {
      val runtime = createTestRuntime()
      seedConnectedRuntime(runtime, unifiedMethods)
      val controlPrefixedId = "\u001Capproval-1"
      val requestedIds = mutableListOf<String>()
      val methods = mutableListOf<String>()
      runtime.gatewayDataRequestOverrideForTests = { _, method, params ->
        methods += method
        when (method) {
          "approval.get" -> {
            val parsed = Json.parseToJsonElement(requireNotNull(params)).jsonObject
            requestedIds += requireNotNull(parsed["id"]?.jsonPrimitive?.content)
            unifiedGet(status = "pending", decision = null, id = controlPrefixedId)
          }
          "exec.approval.list" -> "[]"
          else -> error("unexpected method $method")
        }
      }

      invokeApprovalEvent(
        runtime,
        "exec.approval.requested",
        """{"id":${JsonPrimitive(controlPrefixedId)}}""",
      )
      waitUntil {
        runtime.execApprovals.value
          .singleOrNull()
          ?.id == controlPrefixedId
      }
      invokeApprovalEvent(runtime, "exec.approval.requested", """{"id":123}""")
      waitUntil { methods.contains("exec.approval.list") }

      assertEquals(listOf(controlPrefixedId), requestedIds)
    }

  @Test
  fun malformedOrMismatchedWriteResultFreezesThenUsesCanonicalReadback() =
    runBlocking {
      val runtime = createTestRuntime()
      seedConnectedRuntime(runtime, unifiedMethods)
      seedApproval(runtime)
      val methods = mutableListOf<String>()
      runtime.gatewayDataRequestOverrideForTests = { _, method, _ ->
        methods += method
        when (method) {
          // `applied=true` cannot claim a different decision than this phone sent.
          "approval.resolve" -> unifiedResolve(applied = true, status = "allowed", decision = "allow-always")
          "approval.get" -> unifiedGet(status = "allowed", decision = "allow-always")
          else -> error("unexpected method $method")
        }
      }

      runtime.resolveExecApproval("approval-1", "allow-once")
      waitUntil { runtime.execApprovals.value.isEmpty() }

      assertEquals(listOf("approval.resolve", "approval.get"), methods)
      assertEquals(
        "A prior response already allowed this command and saved the choice.",
        runtime.execApprovalsNotice.value?.message,
      )
    }

  @Test
  fun unknownWriteOutcomeStaysFrozenAndReconcilesAfterReconnect() =
    runBlocking {
      val runtime = createTestRuntime()
      seedConnectedRuntime(runtime, unifiedMethods)
      seedApproval(runtime)
      runtime.gatewayDataRequestOverrideForTests = { _, method, _ ->
        when (method) {
          "approval.resolve", "approval.get" -> throw GatewayRequestOutcomeUnknown("disconnected")
          else -> error("unexpected method $method")
        }
      }

      runtime.resolveExecApproval("approval-1", "deny")
      waitUntil {
        runtime.execApprovals.value
          .singleOrNull()
          ?.errorText
          ?.startsWith("Resolution outcome unknown") == true
      }
      val frozen = runtime.execApprovals.value.single()
      assertEquals("deny", frozen.resolvingDecision)

      invokeClearOperatorState(runtime, retirePendingRuns = false)
      seedConnectedRuntime(runtime, unifiedMethods)
      val reconnectMethods = mutableListOf<String>()
      runtime.gatewayDataRequestOverrideForTests = { _, method, _ ->
        reconnectMethods += method
        when (method) {
          "exec.approval.list" -> "[]"
          "approval.get" -> unifiedGet(status = "denied", decision = "deny")
          else -> error("unexpected method $method")
        }
      }

      runtime.refreshExecApprovals()
      waitUntil { reconnectMethods.contains("approval.get") && runtime.execApprovalsNotice.value != null }

      assertTrue(runtime.execApprovals.value.isEmpty())
      assertEquals("A prior response already denied this approval.", runtime.execApprovalsNotice.value?.message)
    }

  @Test
  fun reconnectListHydrationPublishesTerminalForRetainedUnknownWrite() =
    runBlocking {
      val runtime = createTestRuntime()
      seedConnectedRuntime(runtime, unifiedMethods)
      seedApproval(runtime)
      runtime.gatewayDataRequestOverrideForTests = { _, method, _ ->
        when (method) {
          "approval.resolve", "approval.get" -> throw GatewayRequestOutcomeUnknown("disconnected")
          else -> error("unexpected method $method")
        }
      }

      runtime.resolveExecApproval("approval-1", "deny")
      waitUntil {
        runtime.execApprovals.value
          .singleOrNull()
          ?.errorText
          ?.startsWith("Resolution outcome unknown") == true
      }

      invokeClearOperatorState(runtime, retirePendingRuns = false)
      seedConnectedRuntime(runtime, unifiedMethods)
      runtime.gatewayDataRequestOverrideForTests = { _, method, _ ->
        when (method) {
          "exec.approval.list" ->
            """[{"id":"approval-1","createdAtMs":100,"expiresAtMs":4000000000000}]"""
          "approval.get" -> unifiedGet(status = "denied", decision = "deny")
          else -> error("unexpected method $method")
        }
      }

      runtime.refreshExecApprovals()
      waitUntil { runtime.execApprovalsNotice.value != null }

      assertTrue(runtime.execApprovals.value.isEmpty())
      assertEquals("A prior response already denied this approval.", runtime.execApprovalsNotice.value?.message)
    }

  @Test
  fun reconnectKeepsInFlightWriteDisabledBeforeRetiredWaiterFails() =
    runBlocking {
      val runtime = createTestRuntime()
      seedConnectedRuntime(runtime, unifiedMethods)
      seedApproval(runtime)
      val resolveStarted = CompletableDeferred<Unit>()
      val releaseUnknownOutcome = CompletableDeferred<Unit>()
      val pendingReadCompleted = CompletableDeferred<Unit>()
      val winnerReadStarted = CompletableDeferred<Unit>()
      val releaseWinnerRead = CompletableDeferred<Unit>()
      val approvalReads = AtomicInteger()
      runtime.gatewayDataRequestOverrideForTests = { _, method, _ ->
        when (method) {
          "approval.resolve" -> {
            resolveStarted.complete(Unit)
            releaseUnknownOutcome.await()
            throw GatewayRequestOutcomeUnknown("disconnected before response")
          }
          "exec.approval.list" ->
            """[{"id":"approval-1","createdAtMs":100,"expiresAtMs":4000000000000}]"""
          "approval.get" -> {
            if (approvalReads.incrementAndGet() == 1) {
              pendingReadCompleted.complete(Unit)
              unifiedGet(status = "pending", decision = null)
            } else {
              winnerReadStarted.complete(Unit)
              releaseWinnerRead.await()
              unifiedGet(status = "denied", decision = "deny")
            }
          }
          else -> error("unexpected method $method")
        }
      }

      runtime.resolveExecApproval("approval-1", "deny")
      withTimeout(10_000) { resolveStarted.await() }

      // GatewaySession runs onDisconnected before failing the retired socket's
      // request waiters. Recreate that production ordering on the same stable ID.
      invokeClearOperatorState(runtime, retirePendingRuns = false)
      seedConnectedRuntime(runtime, unifiedMethods)
      runtime.refreshExecApprovals()
      withTimeout(2_000) { pendingReadCompleted.await() }
      waitUntil { !runtime.execApprovalsRefreshing.value }

      val reconnected = runtime.execApprovals.value.single()
      assertEquals("deny", reconnected.resolvingDecision)
      assertTrue(reconnected.errorText?.startsWith("Resolution outcome unknown") == true)
      assertFalse(releaseUnknownOutcome.isCompleted)
      assertFalse(winnerReadStarted.isCompleted)

      releaseUnknownOutcome.complete(Unit)
      withTimeout(2_000) { winnerReadStarted.await() }
      releaseWinnerRead.complete(Unit)

      waitUntil { runtime.execApprovals.value.isEmpty() }
      assertTrue(approvalReads.get() >= 2)
      assertEquals("A prior response already denied this approval.", runtime.execApprovalsNotice.value?.message)
    }

  @Test
  fun fullRefreshCannotUnlockApprovalWhileResolveRequestIsInFlight() =
    runBlocking {
      val runtime = createTestRuntime()
      seedConnectedRuntime(runtime, unifiedMethods)
      seedApproval(runtime)
      val resolveStarted = CompletableDeferred<Unit>()
      val releaseResolve = CompletableDeferred<Unit>()
      val refreshReadCompleted = CompletableDeferred<Unit>()
      val approvalReads = AtomicInteger()
      runtime.gatewayDataRequestOverrideForTests = { _, method, _ ->
        when (method) {
          "approval.resolve" -> {
            resolveStarted.complete(Unit)
            releaseResolve.await()
            unifiedResolve(applied = true, status = "denied", decision = "deny")
          }
          "exec.approval.list" ->
            """[{"id":"approval-1","createdAtMs":100,"expiresAtMs":4000000000000}]"""
          "approval.get" -> {
            approvalReads.incrementAndGet()
            refreshReadCompleted.complete(Unit)
            unifiedGet(status = "pending", decision = null)
          }
          else -> error("unexpected method $method")
        }
      }

      runtime.resolveExecApproval("approval-1", "deny")
      withTimeout(10_000) { resolveStarted.await() }
      runtime.refreshExecApprovals()
      withTimeout(2_000) { refreshReadCompleted.await() }
      waitUntil { !runtime.execApprovalsRefreshing.value }
      delay(100)

      val inFlight = runtime.execApprovals.value.single()
      assertEquals("deny", inFlight.resolvingDecision)
      assertNull(inFlight.errorText)
      assertEquals(1, approvalReads.get())

      releaseResolve.complete(Unit)
      waitUntil { runtime.execApprovals.value.isEmpty() }
      assertEquals("Approval denied.", runtime.execApprovalsNotice.value?.message)
    }

  @Test
  fun unknownWriteInvalidatesRefreshSnapshotBuiltWhileRequestWasInFlight() =
    runBlocking {
      val runtime = createTestRuntime()
      seedConnectedRuntime(runtime, unifiedMethods)
      seedApprovals(
        runtime,
        listOf(
          approvalSummary(id = "approval-1", commandText = "echo selected"),
          approvalSummary(id = "approval-2", commandText = "echo retained"),
        ),
      )
      val resolveStarted = CompletableDeferred<Unit>()
      val releaseUnknownOutcome = CompletableDeferred<Unit>()
      val retainedReadStarted = CompletableDeferred<Unit>()
      val releaseRetainedRead = CompletableDeferred<Unit>()
      val retainedReadReturning = CompletableDeferred<Unit>()
      val selectedReads = AtomicInteger()
      runtime.gatewayDataRequestOverrideForTests = { _, method, params ->
        when (method) {
          "approval.resolve" -> {
            resolveStarted.complete(Unit)
            releaseUnknownOutcome.await()
            throw GatewayRequestOutcomeUnknown("response lost")
          }
          "exec.approval.list" ->
            """
            [
              {"id":"approval-1","createdAtMs":100,"expiresAtMs":4000000000000},
              {"id":"approval-2","createdAtMs":101,"expiresAtMs":4000000000000}
            ]
            """.trimIndent()
          "approval.get" -> {
            val id =
              Json
                .parseToJsonElement(requireNotNull(params))
                .jsonObject["id"]
                ?.jsonPrimitive
                ?.content
                ?: error("missing approval id")
            if (id == "approval-2") {
              retainedReadStarted.complete(Unit)
              releaseRetainedRead.await()
              retainedReadReturning.complete(Unit)
              unifiedGet(status = "pending", decision = null, id = id)
            } else if (selectedReads.incrementAndGet() == 1) {
              unifiedGet(status = "pending", decision = null, id = id)
            } else {
              throw GatewayRequestOutcomeUnknown("readback unavailable")
            }
          }
          else -> error("unexpected method $method")
        }
      }

      runtime.resolveExecApproval("approval-1", "deny")
      withTimeout(10_000) { resolveStarted.await() }
      runtime.refreshExecApprovals()
      withTimeout(2_000) { retainedReadStarted.await() }

      releaseUnknownOutcome.complete(Unit)
      waitUntil {
        runtime.execApprovals.value
          .firstOrNull { it.id == "approval-1" }
          ?.errorText
          ?.startsWith("Resolution outcome unknown") == true
      }

      releaseRetainedRead.complete(Unit)
      withTimeout(2_000) { retainedReadReturning.await() }
      delay(100)

      val selected = runtime.execApprovals.value.first { it.id == "approval-1" }
      assertEquals("deny", selected.resolvingDecision)
      assertTrue(selected.errorText?.startsWith("Resolution outcome unknown") == true)
      assertTrue(runtime.execApprovals.value.any { it.id == "approval-2" })
      assertTrue(selectedReads.get() >= 2)
    }

  @Test
  fun canonicalPendingReadbackInvalidatesConcurrentStaleRefresh() =
    runBlocking {
      val runtime = createTestRuntime()
      seedConnectedRuntime(runtime, unifiedMethods)
      seedApproval(runtime)
      val pendingReadStarted = CompletableDeferred<Unit>()
      val staleRefreshReadStarted = CompletableDeferred<Unit>()
      val releasePendingRead = CompletableDeferred<Unit>()
      val releaseStaleRefreshRead = CompletableDeferred<Unit>()
      val staleRefreshResponseReturning = CompletableDeferred<Unit>()
      val approvalReads = AtomicInteger()
      runtime.gatewayDataRequestOverrideForTests = { _, method, _ ->
        when (method) {
          "approval.resolve" -> throw GatewayRequestOutcomeUnknown("response lost")
          "exec.approval.list" ->
            """[{"id":"approval-1","createdAtMs":100,"expiresAtMs":4000000000000}]"""
          "approval.get" ->
            when (approvalReads.incrementAndGet()) {
              1 -> {
                pendingReadStarted.complete(Unit)
                releasePendingRead.await()
                unifiedGet(status = "pending", decision = null)
              }
              2 -> {
                staleRefreshReadStarted.complete(Unit)
                releaseStaleRefreshRead.await()
                staleRefreshResponseReturning.complete(Unit)
                unifiedGet(status = "pending", decision = null)
              }
              else -> error("unexpected extra approval.get")
            }
          else -> error("unexpected method $method")
        }
      }

      runtime.resolveExecApproval("approval-1", "deny")
      withTimeout(2_000) { pendingReadStarted.await() }
      runtime.refreshExecApprovals()
      withTimeout(2_000) { staleRefreshReadStarted.await() }

      releasePendingRead.complete(Unit)
      waitUntil {
        runtime.execApprovals.value.singleOrNull()?.let { row ->
          row.resolvingDecision == null &&
            row.errorText == "The Gateway still shows this approval as pending. Review it before trying again."
        } == true
      }

      releaseStaleRefreshRead.complete(Unit)
      withTimeout(2_000) { staleRefreshResponseReturning.await() }
      delay(100)

      val finalRow = runtime.execApprovals.value.single()
      assertNull(finalRow.resolvingDecision)
      assertEquals(
        "The Gateway still shows this approval as pending. Review it before trying again.",
        finalRow.errorText,
      )
      assertEquals(2, approvalReads.get())
    }

  @Test
  fun legacyUnknownWriteUnlocksAfterReconnectProvesApprovalStillPending() =
    runBlocking {
      val runtime = createTestRuntime()
      seedConnectedRuntime(runtime, legacyMethods)
      seedApproval(runtime)
      runtime.gatewayDataRequestOverrideForTests = { _, method, _ ->
        when (method) {
          "exec.approval.resolve", "exec.approval.get" -> throw GatewayRequestOutcomeUnknown("disconnected")
          else -> error("unexpected method $method")
        }
      }

      runtime.resolveExecApproval("approval-1", "deny")
      waitUntil {
        runtime.execApprovals.value
          .singleOrNull()
          ?.errorText
          ?.startsWith("Resolution outcome unknown") == true
      }
      assertEquals(
        "deny",
        runtime.execApprovals.value
          .single()
          .resolvingDecision,
      )

      invokeClearOperatorState(runtime, retirePendingRuns = false)
      seedConnectedRuntime(runtime, legacyMethods)
      val reconnectMethods = mutableListOf<String>()
      runtime.gatewayDataRequestOverrideForTests = { _, method, _ ->
        reconnectMethods += method
        when (method) {
          "exec.approval.list" ->
            """[{"id":"approval-1","createdAtMs":100,"expiresAtMs":4000000000000}]"""
          "exec.approval.get" -> legacyGet()
          "exec.approval.resolve" -> """{"ok":true}"""
          else -> error("unexpected method $method")
        }
      }

      runtime.refreshExecApprovals()
      waitUntil {
        runtime.execApprovals.value.singleOrNull()?.let { row ->
          row.resolvingDecision == null &&
            row.errorText == "The Gateway still shows this approval as pending. Review it before trying again."
        } == true
      }

      runtime.resolveExecApproval("approval-1", "deny")
      waitUntil { runtime.execApprovals.value.isEmpty() }

      assertEquals(
        listOf(
          "exec.approval.list",
          "exec.approval.get",
          "exec.approval.get",
          "exec.approval.resolve",
        ),
        reconnectMethods,
      )
    }

  @Test
  fun legacySuccessUsesNeutralWinnerAttribution() =
    runBlocking {
      val runtime = createTestRuntime()
      seedConnectedRuntime(runtime, legacyMethods)
      seedApproval(runtime)
      runtime.gatewayDataRequestOverrideForTests = { _, method, _ ->
        check(method == "exec.approval.resolve")
        """{"ok":true}"""
      }

      runtime.resolveExecApproval("approval-1", "allow-once")
      waitUntil { runtime.execApprovals.value.isEmpty() }

      assertEquals("Gateway recorded approval once.", runtime.execApprovalsNotice.value?.message)
    }

  @Test
  fun resolutionEventWinsRaceAgainstLateLocalResponse() =
    runBlocking {
      val runtime = createTestRuntime()
      seedConnectedRuntime(runtime, unifiedMethods)
      seedApproval(runtime)
      val resolveStarted = CompletableDeferred<Unit>()
      val releaseResolve = CompletableDeferred<Unit>()
      runtime.gatewayDataRequestOverrideForTests = { _, method, _ ->
        when (method) {
          "approval.resolve" -> {
            resolveStarted.complete(Unit)
            releaseResolve.await()
            unifiedResolve(applied = true, status = "allowed", decision = "allow-once")
          }
          "approval.get" -> unifiedGet(status = "denied", decision = "deny")
          else -> error("unexpected method $method")
        }
      }

      runtime.resolveExecApproval("approval-1", "allow-once")
      withTimeout(10_000) { resolveStarted.await() }
      invokeApprovalEvent(
        runtime,
        "exec.approval.resolved",
        """{"id":"approval-1","decision":"deny","resolvedBy":"other","ts":150}""",
      )
      waitUntil { runtime.execApprovals.value.isEmpty() }
      assertEquals("A prior response already denied this approval.", runtime.execApprovalsNotice.value?.message)

      releaseResolve.complete(Unit)
      delay(100)
      assertEquals("A prior response already denied this approval.", runtime.execApprovalsNotice.value?.message)
    }

  @Test
  fun legacyResolutionEventWinsBeforeLateResponseAndListFailure() =
    runBlocking {
      val runtime = createTestRuntime()
      seedConnectedRuntime(runtime, legacyMethods)
      seedApprovals(
        runtime,
        listOf(
          approvalSummary(id = "approval-1", commandText = "echo selected"),
          approvalSummary(id = "approval-2", commandText = "echo retained"),
        ),
      )
      val methods = mutableListOf<String>()
      val resolveStarted = CompletableDeferred<Unit>()
      val releaseResolve = CompletableDeferred<Unit>()
      runtime.gatewayDataRequestOverrideForTests = { _, method, _ ->
        methods += method
        when (method) {
          "exec.approval.resolve" -> {
            resolveStarted.complete(Unit)
            releaseResolve.await()
            """{"ok":true}"""
          }
          "exec.approval.list", "exec.approval.get" ->
            throw GatewayRequestRejected(
              GatewaySession.ErrorShape(
                code = "UNAVAILABLE",
                message = "$method failed",
              ),
            )
          else -> error("unexpected method $method")
        }
      }

      runtime.resolveExecApproval("approval-1", "allow-once")
      withTimeout(10_000) { resolveStarted.await() }
      invokeApprovalEvent(
        runtime,
        "exec.approval.resolved",
        """{"id":"approval-1","decision":"deny","resolvedBy":"other","ts":150,"request":{}}""",
      )

      assertEquals(listOf("approval-2"), runtime.execApprovals.value.map { it.id })
      assertEquals("approval-1", runtime.execApprovalsNotice.value?.approvalId)
      assertEquals("A prior response already denied this approval.", runtime.execApprovalsNotice.value?.message)
      assertEquals(listOf("exec.approval.resolve"), methods)

      releaseResolve.complete(Unit)
      delay(100)
      assertEquals("A prior response already denied this approval.", runtime.execApprovalsNotice.value?.message)

      runtime.refreshExecApprovals()
      waitUntil { runtime.execApprovalsErrorText.value != null && !runtime.execApprovalsRefreshing.value }

      assertEquals(listOf("exec.approval.resolve", "exec.approval.list"), methods)
      assertEquals(listOf("approval-2"), runtime.execApprovals.value.map { it.id })
    }

  @Test
  fun legacyAlreadyResolvedRejectionRetiresExactCardWithoutEvent() =
    runBlocking {
      val runtime = createTestRuntime()
      seedConnectedRuntime(runtime, legacyMethods)
      seedApprovals(
        runtime,
        listOf(
          approvalSummary(id = "approval-1", commandText = "echo selected"),
          approvalSummary(id = "approval-2", commandText = "echo retryable"),
        ),
      )
      val resolvedIds = mutableListOf<String>()
      runtime.gatewayDataRequestOverrideForTests = { _, method, params ->
        check(method == "exec.approval.resolve")
        val request = Json.parseToJsonElement(requireNotNull(params)).jsonObject
        val id =
          request["id"]
            ?.jsonPrimitive
            ?.content
            ?: error("missing approval id")
        resolvedIds += id
        val reason = if (id == "approval-1") "APPROVAL_ALREADY_RESOLVED" else "OTHER_REJECTION"
        throw GatewayRequestRejected(
          GatewaySession.ErrorShape(
            code = "INVALID_REQUEST",
            message = "approval rejected",
            details = gatewayErrorDetails(reason),
          ),
        )
      }

      runtime.resolveExecApproval("approval-1", "allow-once")
      waitUntil { runtime.execApprovals.value.map { it.id } == listOf("approval-2") }

      assertEquals("approval-1", runtime.execApprovalsNotice.value?.approvalId)
      assertEquals("A prior response already resolved this approval.", runtime.execApprovalsNotice.value?.message)
      assertTrue(runtime.execApprovalsNotice.value?.warning == true)

      runtime.resolveExecApproval("approval-2", "deny")
      waitUntil {
        runtime.execApprovals.value.singleOrNull()?.let { row ->
          row.id == "approval-2" &&
            row.resolvingDecision == null &&
            row.errorText == "Could not resolve approval. Refresh and try again."
        } == true
      }

      assertEquals(listOf("approval-1", "approval-2"), resolvedIds)
    }

  @Test
  fun legacyAlreadyResolvedRacingMethodsEpochBumpReconcilesWrite() =
    runBlocking {
      val runtime = createTestRuntime()
      seedConnectedRuntime(runtime, legacyMethods)
      seedApproval(runtime)
      val resolveStarted = CompletableDeferred<Unit>()
      val releaseResolve = CompletableDeferred<Unit>()
      val methods = mutableListOf<String>()
      runtime.gatewayDataRequestOverrideForTests = { _, method, _ ->
        methods += method
        when (method) {
          "exec.approval.resolve" -> {
            resolveStarted.complete(Unit)
            releaseResolve.await()
            throw GatewayRequestRejected(
              GatewaySession.ErrorShape(
                code = "INVALID_REQUEST",
                message = "approval rejected",
                details = gatewayErrorDetails("APPROVAL_ALREADY_RESOLVED"),
              ),
            )
          }
          "exec.approval.get" -> legacyGet()
          else -> error("unexpected method $method")
        }
      }

      runtime.resolveExecApproval("approval-1", "allow-once")
      withTimeout(10_000) { resolveStarted.await() }
      // Replacement hello on the same stable endpoint: the epoch bump makes the
      // already-resolved publish a no-op, leaving only the pending-write record.
      invokeReplaceGatewayMethods(runtime, legacyMethods)
      releaseResolve.complete(Unit)

      // The settled rejection must reconcile through current canonical state instead
      // of freezing until a perfectly timed manual refresh.
      waitUntil {
        runtime.execApprovals.value.singleOrNull()?.let { row ->
          row.resolvingDecision == null &&
            row.errorText == "The Gateway still shows this approval as pending. Review it before trying again."
        } == true
      }

      assertEquals(listOf("exec.approval.resolve", "exec.approval.get"), methods)
    }

  @Test
  fun terminalNoticeSurvivesRefreshUntilUserDismissal() =
    runBlocking {
      val runtime = createTestRuntime()
      seedConnectedRuntime(runtime, unifiedMethods)
      seedApprovals(
        runtime,
        listOf(
          approvalSummary(id = "approval-1", commandText = "echo losing"),
          approvalSummary(id = "approval-2", commandText = "echo retained"),
        ),
      )
      runtime.gatewayDataRequestOverrideForTests = { _, method, _ ->
        check(method == "approval.resolve")
        unifiedResolve(applied = false, status = "denied", decision = "deny")
      }

      runtime.resolveExecApproval("approval-1", "allow-once")
      waitUntil { runtime.execApprovals.value.map { it.id } == listOf("approval-2") }
      assertEquals("A prior response already denied this approval.", runtime.execApprovalsNotice.value?.message)

      val refreshMethods = mutableListOf<String>()
      runtime.gatewayDataRequestOverrideForTests = { _, method, _ ->
        refreshMethods += method
        when (method) {
          "exec.approval.list" ->
            """[{"id":"approval-2","createdAtMs":101,"expiresAtMs":4000000000000}]"""
          "approval.get" -> unifiedGet(status = "pending", decision = null, id = "approval-2")
          else -> error("unexpected method $method")
        }
      }
      runtime.refreshExecApprovals()
      waitUntil { refreshMethods.contains("approval.get") && !runtime.execApprovalsRefreshing.value }
      assertEquals(listOf("approval-2"), runtime.execApprovals.value.map { it.id })

      // A refresh must not wipe an unacknowledged losing outcome; only the user (or a
      // replacement terminal notice) clears the banner.
      assertEquals("A prior response already denied this approval.", runtime.execApprovalsNotice.value?.message)
      assertEquals("approval-1", runtime.execApprovalsNotice.value?.approvalId)

      runtime.dismissExecApprovalsNotice(requireNotNull(runtime.execApprovalsNotice.value))
      assertNull(runtime.execApprovalsNotice.value)
    }

  @Test
  fun unrelatedApprovalWriteKeepsUnacknowledgedTerminalNotice() =
    runBlocking {
      val runtime = createTestRuntime()
      seedConnectedRuntime(runtime, unifiedMethods)
      seedApprovals(
        runtime,
        listOf(
          approvalSummary(id = "approval-1", commandText = "echo losing"),
          approvalSummary(id = "approval-2", commandText = "echo unrelated"),
        ),
      )
      runtime.gatewayDataRequestOverrideForTests = { _, method, params ->
        check(method == "approval.resolve")
        val request = Json.parseToJsonElement(requireNotNull(params)).jsonObject
        when (val id = request["id"]?.jsonPrimitive?.content) {
          "approval-1" -> unifiedResolve(applied = false, status = "denied", decision = "deny")
          "approval-2" ->
            throw GatewayRequestRejected(
              GatewaySession.ErrorShape(code = "UNAVAILABLE", message = "resolve failed"),
            )
          else -> error("unexpected approval id $id")
        }
      }

      runtime.resolveExecApproval("approval-1", "allow-once")
      waitUntil { runtime.execApprovals.value.map { it.id } == listOf("approval-2") }
      assertEquals("approval-1", runtime.execApprovalsNotice.value?.approvalId)

      runtime.resolveExecApproval("approval-2", "deny")
      waitUntil {
        runtime.execApprovals.value.singleOrNull()?.let { row ->
          row.id == "approval-2" &&
            row.resolvingDecision == null &&
            row.errorText == "Could not resolve approval. Refresh and try again."
        } == true
      }

      // Starting (and failing) a write for approval-2 must not clear the unacknowledged
      // losing outcome for approval-1; only the user or a replacement terminal clears it.
      assertEquals("approval-1", runtime.execApprovalsNotice.value?.approvalId)
      assertEquals("A prior response already denied this approval.", runtime.execApprovalsNotice.value?.message)
    }

  @Test
  fun staleDismissLeavesReplacementNoticeVisible() =
    runBlocking {
      val runtime = createTestRuntime()
      seedConnectedRuntime(runtime, unifiedMethods)
      seedApprovals(
        runtime,
        listOf(
          approvalSummary(id = "approval-1", commandText = "echo first"),
          approvalSummary(id = "approval-2", commandText = "echo second"),
        ),
      )
      runtime.gatewayDataRequestOverrideForTests = { _, method, _ ->
        when (method) {
          "approval.resolve" -> unifiedResolve(applied = false, status = "denied", decision = "deny")
          // Readback for the approval-2 resolved event: this terminal-notice publisher
          // does not hold execApprovalsStateLock, the exact writer the atomic dismiss
          // must not race.
          "approval.get" -> unifiedGet(status = "denied", decision = "deny", id = "approval-2")
          else -> error("unexpected method $method")
        }
      }

      runtime.resolveExecApproval("approval-1", "allow-once")
      waitUntil { runtime.execApprovals.value.map { it.id } == listOf("approval-2") }
      val staleNotice = requireNotNull(runtime.execApprovalsNotice.value)
      assertEquals("approval-1", staleNotice.approvalId)

      invokeApprovalEvent(runtime, "exec.approval.resolved", """{"id":"approval-2"}""")
      waitUntil { runtime.execApprovals.value.isEmpty() }
      val replacement = requireNotNull(runtime.execApprovalsNotice.value)
      assertEquals("approval-2", replacement.approvalId)

      // compareAndSet semantics: a close tap captured for the first notice must leave
      // the replacement untouched; only dismissing the rendered notice clears it.
      runtime.dismissExecApprovalsNotice(staleNotice)
      assertEquals(replacement, runtime.execApprovalsNotice.value)

      runtime.dismissExecApprovalsNotice(replacement)
      assertNull(runtime.execApprovalsNotice.value)
    }

  @Test
  fun staleDismissCannotClearStructurallyEqualReplacementNotice() =
    runBlocking {
      val runtime = createTestRuntime()
      seedConnectedRuntime(runtime, unifiedMethods)
      seedApproval(runtime)
      runtime.gatewayDataRequestOverrideForTests = { _, method, _ ->
        when (method) {
          "approval.resolve" -> unifiedResolve(applied = false, status = "denied", decision = "deny")
          "approval.get" -> unifiedGet(status = "pending", decision = null)
          else -> error("unexpected method $method")
        }
      }

      runtime.resolveExecApproval("approval-1", "allow-once")
      waitUntil { runtime.execApprovals.value.isEmpty() }
      val staleNotice = requireNotNull(runtime.execApprovalsNotice.value)

      // The same approval id is re-requested and loses again: the replacement notice
      // carries identical id/message/warning but is a distinct publication.
      invokeApprovalEvent(runtime, "exec.approval.requested", """{"id":"approval-1"}""")
      waitUntil { runtime.execApprovals.value.map { it.id } == listOf("approval-1") }
      runtime.resolveExecApproval("approval-1", "allow-once")
      waitUntil { runtime.execApprovals.value.isEmpty() }
      val replacement = requireNotNull(runtime.execApprovalsNotice.value)
      assertEquals(staleNotice.approvalId, replacement.approvalId)
      assertEquals(staleNotice.message, replacement.message)
      assertEquals(staleNotice.warning, replacement.warning)
      assertNotEquals(staleNotice, replacement)

      // A close tap captured for the first banner must not clear the equal-looking
      // replacement outcome the user has not acknowledged yet.
      runtime.dismissExecApprovalsNotice(staleNotice)
      assertEquals(replacement, runtime.execApprovalsNotice.value)

      runtime.dismissExecApprovalsNotice(replacement)
      assertNull(runtime.execApprovalsNotice.value)
    }

  @Test
  fun oldGatewayUsesOnlyShippedExecMethods() =
    runBlocking {
      val runtime = createTestRuntime()
      seedConnectedRuntime(
        runtime,
        setOf("exec.approval.list", "exec.approval.get", "exec.approval.resolve"),
      )
      val methods = mutableListOf<String>()
      runtime.gatewayDataRequestOverrideForTests = { _, method, _ ->
        methods += method
        when (method) {
          "exec.approval.list" ->
            """[{"id":"approval-1","createdAtMs":100,"expiresAtMs":4000000000000}]"""
          "exec.approval.get" -> legacyGet()
          "exec.approval.resolve" -> """{"ok":true}"""
          else -> error("unexpected method $method")
        }
      }

      runtime.refreshExecApprovals()
      waitUntil {
        runtime.execApprovals.value
          .singleOrNull()
          ?.allowedDecisions == listOf("allow-once", "deny")
      }
      runtime.resolveExecApproval("approval-1", "deny")
      waitUntil { runtime.execApprovals.value.isEmpty() }

      assertEquals(
        listOf("exec.approval.list", "exec.approval.get", "exec.approval.resolve"),
        methods,
      )
      assertFalse(methods.any { it == "approval.get" || it == "approval.resolve" })
    }

  @Test
  fun partialCanonicalCatalogCannotMixWithLegacyApprovalMethods() =
    runBlocking {
      val runtime = createTestRuntime()
      val mixedMethods = legacyMethods + "approval.get"
      seedConnectedRuntime(runtime, mixedMethods)
      val methods = mutableListOf<String>()
      runtime.gatewayDataRequestOverrideForTests = { _, method, _ ->
        methods += method
        when (method) {
          "exec.approval.list" ->
            """[{"id":"approval-1","createdAtMs":100,"expiresAtMs":4000000000000}]"""
          else -> error("an inconsistent hello must not select approval RPC $method")
        }
      }

      runtime.refreshExecApprovals()
      waitUntil {
        runtime.execApprovals.value
          .singleOrNull()
          ?.errorText ==
          "Could not load approval details. Refresh and try again."
      }
      runtime.resolveExecApproval("approval-1", "deny")
      waitUntil {
        runtime.execApprovals.value
          .singleOrNull()
          ?.let { row ->
            row.resolvingDecision == null && row.errorText == "Could not resolve approval. Refresh and try again."
          } == true
      }

      assertEquals(listOf("exec.approval.list"), methods)
    }

  @Test
  fun canonicalUnknownReadFailsClosedWithoutLegacyDowngrade() =
    runBlocking {
      val runtime = createTestRuntime()
      seedConnectedRuntime(runtime, allApprovalMethods)
      val methods = mutableListOf<String>()
      runtime.gatewayDataRequestOverrideForTests = { _, method, _ ->
        methods += method
        when (method) {
          "exec.approval.list" ->
            """[{"id":"approval-1","createdAtMs":100,"expiresAtMs":4000000000000}]"""
          "approval.get" ->
            throw GatewayRequestRejected(
              GatewaySession.ErrorShape(
                code = "INVALID_REQUEST",
                message = "unknown method: approval.get",
              ),
            )
          "exec.approval.get" -> error("canonical hello must never downgrade")
          else -> error("unexpected method $method")
        }
      }

      runtime.refreshExecApprovals()
      waitUntil {
        runtime.execApprovals.value
          .singleOrNull()
          ?.errorText ==
          "Could not load approval details. Refresh and try again."
      }

      assertEquals(listOf("exec.approval.list", "approval.get"), methods)
    }

  @Test
  fun canonicalUnknownResolveFailsClosedWithoutLegacyDowngrade() =
    runBlocking {
      val runtime = createTestRuntime()
      seedConnectedRuntime(runtime, allApprovalMethods)
      seedApproval(runtime)
      val methods = mutableListOf<String>()
      runtime.gatewayDataRequestOverrideForTests = { _, method, _ ->
        methods += method
        when (method) {
          "approval.resolve" ->
            throw GatewayRequestRejected(
              GatewaySession.ErrorShape(
                code = "INVALID_REQUEST",
                message = "unknown method: approval.resolve",
              ),
            )
          "exec.approval.resolve" -> error("canonical hello must never downgrade")
          else -> error("unexpected method $method")
        }
      }

      runtime.resolveExecApproval("approval-1", "deny")
      waitUntil {
        runtime.execApprovals.value
          .singleOrNull()
          ?.let { row ->
            row.resolvingDecision == null && row.errorText == "Could not resolve approval. Refresh and try again."
          } == true
      }

      assertEquals(listOf("approval.resolve"), methods)
    }

  @Test
  fun staleCanonicalRejectionFromRetiredSocketCannotAffectReplacementCatalog() =
    runBlocking {
      val runtime = createTestRuntime()
      seedConnectedRuntime(runtime, unifiedMethods)
      seedApproval(runtime)
      val firstResolveStarted = CompletableDeferred<Unit>()
      val releaseFirstResolve = CompletableDeferred<Unit>()
      val methods = mutableListOf<String>()
      var unifiedResolveCalls = 0
      runtime.gatewayDataRequestOverrideForTests = { _, method, _ ->
        methods += method
        when (method) {
          "approval.resolve" -> {
            unifiedResolveCalls += 1
            if (unifiedResolveCalls == 1) {
              firstResolveStarted.complete(Unit)
              releaseFirstResolve.await()
              throw GatewayRequestRejected(
                GatewaySession.ErrorShape(
                  code = "INVALID_REQUEST",
                  message = "unknown method: approval.resolve",
                ),
              )
            }
            unifiedResolve(applied = true, status = "denied", decision = "deny")
          }
          "exec.approval.resolve" -> error("stale rejection must not trigger legacy fallback")
          else -> error("unexpected method $method")
        }
      }

      runtime.resolveExecApproval("approval-1", "deny")
      withTimeout(2_000) { firstResolveStarted.await() }

      invokeClearOperatorState(runtime, retirePendingRuns = false)
      seedConnectedRuntime(runtime, unifiedMethods)
      seedApproval(runtime)
      releaseFirstResolve.complete(Unit)
      delay(100)

      runtime.resolveExecApproval("approval-1", "deny")
      waitUntil { runtime.execApprovals.value.isEmpty() }

      assertEquals(listOf("approval.resolve", "approval.resolve"), methods)
    }

  private fun createTestRuntime(): NodeRuntime {
    val app = RuntimeEnvironment.getApplication()
    val securePrefs =
      app.getSharedPreferences(
        "openclaw.node.approval.runtime.test.${UUID.randomUUID()}",
        android.content.Context.MODE_PRIVATE,
      )
    return NodeRuntime(app, SecurePrefs(app, securePrefsOverride = securePrefs))
  }

  private fun seedConnectedRuntime(
    runtime: NodeRuntime,
    methods: Set<String>,
  ) {
    writeField(runtime, "connectedEndpoint", GatewayEndpoint.manual("127.0.0.1", 18789))
    writeField(runtime, "operatorConnected", true)
    invokeReplaceGatewayMethods(runtime, methods)
  }

  private fun seedApproval(runtime: NodeRuntime) {
    seedApprovals(runtime, listOf(approvalSummary()))
  }

  private fun seedApprovals(
    runtime: NodeRuntime,
    approvals: List<GatewayExecApprovalSummary>,
  ) {
    readField<MutableStateFlow<List<GatewayExecApprovalSummary>>>(runtime, "_execApprovals").value =
      approvals
  }

  private fun approvalSummary(
    id: String = "approval-1",
    commandText: String = "echo ok",
  ): GatewayExecApprovalSummary =
    GatewayExecApprovalSummary(
      id = id,
      commandText = verbatimText(commandText),
      commandPreview = "echo",
      warningText = null,
      allowedDecisions = listOf("allow-once", "allow-always", "deny"),
      host = "gateway",
      nodeId = null,
      agentId = "main",
      createdAtMs = 100,
      expiresAtMs = 4_000_000_000_000,
    )

  private suspend fun waitUntil(condition: () -> Boolean) {
    // Generous ceiling for loaded CI runners; passing tests exit on first poll.
    withTimeout(10_000) {
      while (!condition()) delay(10)
    }
  }

  private fun invokeApprovalEvent(
    runtime: NodeRuntime,
    event: String,
    payloadJson: String,
  ) {
    runtime.javaClass
      .getDeclaredMethod("handleExecApprovalGatewayEvent", String::class.java, String::class.java)
      .apply { isAccessible = true }
      .invoke(runtime, event, payloadJson)
  }

  private fun invokeClearOperatorState(
    runtime: NodeRuntime,
    retirePendingRuns: Boolean,
  ) {
    runtime.javaClass
      .getDeclaredMethod("clearOperatorGatewayState", java.lang.Boolean.TYPE)
      .apply { isAccessible = true }
      .invoke(runtime, retirePendingRuns)
    writeField(runtime, "operatorConnected", false)
  }

  private fun invokeReplaceGatewayMethods(
    runtime: NodeRuntime,
    methods: Set<String>,
  ) {
    runtime.javaClass
      .getDeclaredMethod("replaceGatewayMethods", Set::class.java)
      .apply { isAccessible = true }
      .invoke(runtime, methods)
  }

  private fun writeField(
    target: Any,
    name: String,
    value: Any?,
  ) {
    findField(target, name).set(target, value)
  }

  private fun <T> readField(
    target: Any,
    name: String,
  ): T {
    @Suppress("UNCHECKED_CAST")
    return findField(target, name).get(target) as T
  }

  private fun findField(
    target: Any,
    name: String,
  ): Field {
    var type: Class<*>? = target.javaClass
    while (type != null) {
      try {
        return type.getDeclaredField(name).apply { isAccessible = true }
      } catch (_: NoSuchFieldException) {
        type = type.superclass
      }
    }
    error("Field $name not found on ${target.javaClass.name}")
  }

  private fun unifiedResolve(
    applied: Boolean,
    status: String,
    decision: String?,
    id: String = "approval-1",
  ): String = """{"applied":$applied,"approval":${approval(status, decision, id)}}"""

  private fun unifiedGet(
    status: String,
    decision: String?,
    id: String = "approval-1",
  ): String = """{"approval":${approval(status, decision, id)}}"""

  private fun approval(
    status: String,
    decision: String?,
    id: String,
  ): String {
    val terminalFields =
      if (status == "pending") {
        ""
      } else {
        val reason = if (status == "expired") "timeout" else "user"
        val decisionField = decision?.let { ",\"decision\":\"$it\"" }.orEmpty()
        ",\"resolvedAtMs\":150,\"reason\":\"$reason\"$decisionField"
      }
    return """
      {
        "id":${JsonPrimitive(id)},
        "urlPath":"/approve/approval-1",
        "status":"$status",
        "createdAtMs":100,
        "expiresAtMs":4000000000000,
        "presentation":{
          "kind":"exec",
          "commandText":"echo ok",
          "commandPreview":"echo",
          "warningText":null,
          "host":"gateway",
          "nodeId":null,
          "agentId":"main",
          "allowedDecisions":["allow-once","allow-always","deny"]
        }$terminalFields
      }
      """.trimIndent()
  }

  private fun legacyGet(): String =
    """
    {
      "id":"approval-1",
      "commandText":"echo ok",
      "commandPreview":"echo",
      "allowedDecisions":["allow-once","deny"],
      "host":"gateway",
      "nodeId":null,
      "agentId":"main",
      "expiresAtMs":4000000000000
    }
    """.trimIndent()

  private fun gatewayErrorDetails(reason: String): GatewayErrorDetails =
    GatewayErrorDetails(
      code = null,
      canRetryWithDeviceToken = false,
      recommendedNextStep = null,
      reason = reason,
    )

  private val unifiedMethods = setOf("approval.get", "approval.resolve", "exec.approval.list")
  private val legacyMethods = setOf("exec.approval.list", "exec.approval.get", "exec.approval.resolve")
  private val allApprovalMethods = unifiedMethods + legacyMethods
}
