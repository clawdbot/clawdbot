package ai.openclaw.app

import ai.openclaw.app.gateway.GatewayEndpoint
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.withTimeout
import org.junit.Assert.assertEquals
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import org.robolectric.annotation.Config
import java.lang.reflect.Field
import java.util.UUID

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34])
class CronRuntimeGuardTest {
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
  fun nonAdminConnectionRejectsMutationBeforeGatewayRequest() {
    val runtime = createTestRuntime()
    seedConnectedRuntime(runtime)

    runtime.runCronJob("job-1")

    assertEquals(
      GatewayCronActionState.Notice(
        id = "job-1",
        message = "Cron changes require operator.admin access.",
        kind = GatewayCronNoticeKind.Error,
      ),
      runtime.cronActionState.value,
    )
  }

  @Test
  fun activeCronActionSerializesLaterMutationCalls() =
    runBlocking {
      val runtime = createTestRuntime()
      seedConnectedRuntime(runtime)
      readField<MutableStateFlow<List<String>>>(runtime, "_operatorScopes").value =
        listOf("operator.admin")
      withTimeout(2_000) {
        while (!runtime.operatorAdminScopeAvailable.value) delay(10)
      }
      val actionMutex = readField<Mutex>(runtime, "cronActionMutex")
      actionMutex.lock()
      try {
        runtime.runCronJob("job-1")
        runtime.setCronJobEnabled(id = "job-1", enabled = false)
        delay(50)

        assertEquals(
          GatewayCronActionState.Notice(
            id = "job-1",
            message = "Another cron action is still finishing.",
            kind = GatewayCronNoticeKind.Warning,
          ),
          runtime.cronActionState.value,
        )
      } finally {
        actionMutex.unlock()
      }
    }

  @Test
  fun completedDeleteDoesNotClearNewerJobSelection() {
    val runtime = createTestRuntime()
    val detailState = readField<MutableStateFlow<GatewayCronJobDetailState>>(runtime, "_cronJobDetailState")
    val historyState = readField<MutableStateFlow<GatewayCronRunHistoryState>>(runtime, "_cronRunHistoryState")
    requireNotNull(readField<CronJobDetailRequestGuard>(runtime, "cronJobDetailRequestGuard").begin("job-b"))
    requireNotNull(readField<CronJobDetailRequestGuard>(runtime, "cronRunHistoryRequestGuard").begin("job-b"))
    detailState.value = GatewayCronJobDetailState.Loading("job-b")
    historyState.value = GatewayCronRunHistoryState.Loading("job-b")

    invokeStringMethod(runtime, "clearDeletedCronSelection", "job-a")

    assertEquals(GatewayCronJobDetailState.Loading("job-b"), detailState.value)
    assertEquals(GatewayCronRunHistoryState.Loading("job-b"), historyState.value)

    invokeStringMethod(runtime, "clearDeletedCronSelection", "job-b")

    assertEquals(GatewayCronJobDetailState.Idle, detailState.value)
    assertEquals(GatewayCronRunHistoryState.Idle, historyState.value)
  }

  @Test
  fun detailDisposalRetainsNoticeUntilExplicitJobDismissal() {
    val runtime = createTestRuntime()
    val actionState = readField<MutableStateFlow<GatewayCronActionState>>(runtime, "_cronActionState")
    val notice =
      GatewayCronActionState.Notice(
        id = "job-a",
        message = "Cron job updated.",
        kind = GatewayCronNoticeKind.Success,
      )
    actionState.value = notice

    runtime.clearCronJobDetail()
    assertEquals(notice, actionState.value)
    runtime.dismissCronActionNotice("job-b")
    assertEquals(notice, actionState.value)
    runtime.dismissCronActionNotice("job-a")
    assertEquals(GatewayCronActionState.Idle, actionState.value)
  }

  @Test
  fun pendingCronRunSurvivesReconnectButClearsWhenGatewayScopeRetires() {
    val runtime = createTestRuntime()
    val registry = readField<PendingCronRunRegistry>(runtime, "pendingCronRunRegistry")
    val pending = readField<MutableStateFlow<Set<String>>>(runtime, "_pendingCronRunJobIds")
    assertEquals(true, registry.begin("job-1", "run-1") { pending.value = it })

    invokeBooleanMethod(runtime, "clearOperatorGatewayState", false)
    assertEquals(setOf("job-1"), pending.value)

    invokeBooleanMethod(runtime, "clearOperatorGatewayState", true)
    assertEquals(emptySet<String>(), pending.value)
  }

  @Test
  fun runningStateBlocksMutationAfterMutexRelease() =
    runBlocking {
      val runtime = createTestRuntime()
      seedConnectedRuntime(runtime)
      readField<MutableStateFlow<List<String>>>(runtime, "_operatorScopes").value =
        listOf("operator.admin")
      withTimeout(2_000) {
        while (!runtime.operatorAdminScopeAvailable.value) delay(10)
      }
      val running = GatewayCronActionState.Running(id = "job-1", action = GatewayCronAction.Save)
      readField<MutableStateFlow<GatewayCronActionState>>(runtime, "_cronActionState").value = running

      runtime.runCronJob("job-1")
      delay(50)

      assertEquals(running, runtime.cronActionState.value)
    }

  private fun createTestRuntime(): NodeRuntime {
    val app = RuntimeEnvironment.getApplication()
    val securePrefs =
      app.getSharedPreferences(
        "openclaw.node.cron.guard.test.${UUID.randomUUID()}",
        android.content.Context.MODE_PRIVATE,
      )
    return NodeRuntime(app, SecurePrefs(app, securePrefsOverride = securePrefs))
  }

  private fun seedConnectedRuntime(runtime: NodeRuntime) {
    writeField(runtime, "connectedEndpoint", GatewayEndpoint.manual("127.0.0.1", 18789))
    writeField(runtime, "operatorConnected", true)
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

  private fun invokeStringMethod(
    target: Any,
    name: String,
    value: String,
  ) {
    target.javaClass
      .getDeclaredMethod(name, String::class.java)
      .apply { isAccessible = true }
      .invoke(target, value)
  }

  private fun invokeBooleanMethod(
    target: Any,
    name: String,
    value: Boolean,
  ) {
    target.javaClass
      .getDeclaredMethod(name, java.lang.Boolean.TYPE)
      .apply { isAccessible = true }
      .invoke(target, value)
  }
}
