package ai.openclaw.app

import ai.openclaw.app.gateway.GatewayEndpoint
import ai.openclaw.app.gateway.GatewayErrorDetails
import ai.openclaw.app.gateway.GatewayRequestOutcomeUnknown
import ai.openclaw.app.gateway.GatewayRequestRejected
import ai.openclaw.app.gateway.GatewaySession
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.Job
import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.currentCoroutineContext
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.job
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.withTimeout
import kotlinx.serialization.json.Json
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
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
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicInteger

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34])
class ClawHubSkillRuntimeTest {
  private val runtimes = mutableListOf<NodeRuntime>()

  @Before
  fun clearPlainPrefs() {
    RuntimeEnvironment
      .getApplication()
      .getSharedPreferences("openclaw.node", android.content.Context.MODE_PRIVATE)
      .edit()
      .clear()
      .commit()
  }

  @After
  fun closeRuntimes() {
    runtimes.forEach(::closeNodeRuntimeTestFixture)
  }

  @Test
  fun installResultsPreserveGatewayMessagesAndAuditWarnings() {
    val success =
      GatewaySession.RpcResult(
        ok = true,
        payloadJson = """{"message":"Installed @alice/alpha.","warning":"  ClawHub audit details.\n "}""",
        error = null,
      )
    val rejections =
      listOf("Blocked by ClawHub.", "Security verification unavailable.").map { message ->
        GatewaySession.RpcResult(
          ok = false,
          payloadJson = null,
          error =
            GatewaySession.ErrorShape(
              code = "UNAVAILABLE",
              message = message,
              details =
                GatewayErrorDetails(
                  code = null,
                  canRetryWithDeviceToken = false,
                  recommendedNextStep = null,
                  clawhubWarning = "  ClawHub audit details.\n ",
                ),
            ),
        )
      }

    for (result in listOf(success) + rejections) {
      val runtime = createTestRuntime()
      seedConnectedAdminRuntime(runtime)
      val requests = mutableListOf<String?>()
      runtime.gatewayDataRequestOverrideForTests = { _, method, params ->
        when (method) {
          "skills.install" -> {
            requests += params
            result.error?.let { throw GatewayRequestRejected(it) }
            checkNotNull(result.payloadJson)
          }

          "skills.status" -> {
            skillsStatus(installed = false)
          }

          else -> {
            error("unexpected method $method")
          }
        }
      }

      try {
        val install = runtime.installClawHubSkill("@alice/alpha", version = "1.2.3") ?: error("install job missing")
        runBlocking { install.join() }

        assertEquals(
          Json.parseToJsonElement("""{"source":"clawhub","slug":"@alice/alpha","version":"1.2.3","timeoutMs":120000}"""),
          Json.parseToJsonElement(checkNotNull(requests.single())),
        )
        val state = runtime.clawHubSkillSearchState.value
        if (result.ok) {
          assertEquals("Installed @alice/alpha.\n\nClawHub audit details.", state.messageText)
          assertNull(state.errorText)
        } else {
          assertEquals("${result.error?.message}\n\nClawHub audit details.", state.errorText)
          assertNull(state.messageText)
        }
        assertTrue(state.installingSlugs.isEmpty())
      } finally {
        runtime.disconnect()
      }
    }
  }

  @Test
  fun unknownInstallOutcomeAllowsSafeExactRetryAndConfirmsProvenance() {
    val runtime = createTestRuntime()
    seedConnectedAdminRuntime(runtime)
    val installCalls = AtomicInteger()
    var installed = false
    var installTimeoutMs: Long? = null
    runtime.gatewayDataRequestTimeoutObserverForTests = { method, timeoutMs ->
      if (method == "skills.install") installTimeoutMs = timeoutMs
    }
    runtime.gatewayDataRequestOverrideForTests = { _, method, _ ->
      when (method) {
        "skills.install" -> {
          installCalls.incrementAndGet()
          throw GatewayRequestOutcomeUnknown("response lost")
        }

        "skills.status" -> {
          skillsStatus(installed)
        }

        else -> {
          error("unexpected method $method")
        }
      }
    }

    val firstInstall =
      runtime.installClawHubSkill("registry-slug", version = "1.2.3")
        ?: error("install job missing")
    runBlocking { firstInstall.join() }

    assertEquals(CLAWHUB_INSTALL_REQUEST_TIMEOUT_MS, installTimeoutMs)
    assertTrue(
      runtime.clawHubSkillSearchState.value.errorText
        .orEmpty()
        .contains("result for registry-slug is unknown"),
    )
    val retryInstall =
      runtime.installClawHubSkill("registry-slug", version = "1.2.3")
        ?: error("retry job missing")
    runBlocking { retryInstall.join() }

    installed = true
    val confirmedInstall =
      runtime.installClawHubSkill("registry-slug", version = "1.2.3")
        ?: error("confirm job missing")
    runBlocking { confirmedInstall.join() }

    assertEquals(3, installCalls.get())
    assertFalse(
      runtime.clawHubSkillSearchState.value.errorText
        .orEmpty()
        .contains("unknown"),
    )
    assertEquals("Installed registry-slug.", runtime.clawHubSkillSearchState.value.messageText)
  }

  @Test
  fun installReadbackSurvivesNewerSkillsRefresh() =
    runBlocking {
      val outcomes =
        listOf(
          GatewayRequestOutcomeUnknown("response lost"),
          GatewayRequestRejected(
            GatewaySession.ErrorShape(code = "UNAVAILABLE", message = "Install still running", details = null),
          ),
          null,
        )
      for (outcome in outcomes) {
        val runtime = createTestRuntime()
        seedConnectedAdminRuntime(runtime)
        val installCalls = AtomicInteger()
        val statusRequests = Channel<Pair<CompletableDeferred<String>, Job>>(Channel.UNLIMITED)
        runtime.gatewayDataRequestOverrideForTests = { _, method, _ ->
          when (method) {
            "skills.install" -> {
              installCalls.incrementAndGet()
              outcome?.let { throw it }
              """{"message":"Installed registry-slug."}"""
            }

            "skills.status" -> {
              val response = CompletableDeferred<String>()
              statusRequests.send(response to currentCoroutineContext().job)
              response.await()
            }

            else -> {
              error("unexpected method $method")
            }
          }
        }

        val install = runtime.installClawHubSkill("registry-slug", version = "1.2.3") ?: error("install job missing")
        val (readback, _) = withTimeout(2_000) { statusRequests.receive() }
        runtime.refreshSkills()
        val (newerResponse, newerRefresh) = withTimeout(2_000) { statusRequests.receive() }
        try {
          newerResponse.complete(skillsStatus(installed = false))
          withTimeout(2_000) { newerRefresh.join() }
          readback.complete(skillsStatus(installed = true))
          withTimeout(2_000) { install.join() }

          assertEquals("Installed registry-slug.", runtime.clawHubSkillSearchState.value.messageText)
          assertNull(runtime.clawHubSkillSearchState.value.errorText)
          assertTrue(
            checkNotNull(runtime.skillsState.value.summary)
              .skills
              .isEmpty(),
          )
          assertEquals(1, installCalls.get())
        } finally {
          readback.complete("{}")
          newerResponse.complete("{}")
          statusRequests.close()
        }
      }
    }

  @Test
  fun staleGatewayCannotClaimAnInstallAfterGatewaySwitch() {
    val runtime = createTestRuntime()
    seedConnectedAdminRuntime(runtime)
    val installCalls = AtomicInteger()
    runtime.gatewayDataRequestOverrideForTests = { _, _, _ ->
      installCalls.incrementAndGet()
      error("stale gateway request must not run")
    }
    val waitingToClaim = CountDownLatch(1)
    runtime.clawHubSkillInstallBeforeClaimObserverForTests = { waitingToClaim.countDown() }
    val installMutex = readField<Mutex>(runtime, "clawHubSkillInstallMutex")
    runBlocking { installMutex.lock() }

    val installJob =
      runtime.installClawHubSkill("registry-slug", version = "1.2.3")
        ?: error("install job missing")
    assertTrue(waitingToClaim.await(5, TimeUnit.SECONDS))
    writeField(runtime, "connectedEndpoint", GatewayEndpoint.manual("127.0.0.2", 18789))
    writeField(runtime, "gatewayDataGeneration", readField<Long>(runtime, "gatewayDataGeneration") + 1)
    readField<MutableStateFlow<GatewayClawHubSkillSearchState>>(runtime, "_clawHubSkillSearchState").value =
      GatewayClawHubSkillSearchState()
    installMutex.unlock()

    runBlocking { installJob.join() }
    assertTrue(
      runtime.clawHubSkillSearchState.value.installingSlugs
        .isEmpty(),
    )
    assertEquals(0, installCalls.get())
  }

  private fun skillsStatus(installed: Boolean): String =
    if (!installed) {
      """{"managedSkillsDir":"/tmp/skills","skills":[]}"""
    } else {
      """{"managedSkillsDir":"/tmp/skills","skills":[{"skillKey":"custom-frontmatter-key","name":"Installed skill","source":"openclaw-managed","disabled":false,"eligible":true,"blockedByAllowlist":false,"blockedByAgentFilter":false,"bundled":false,"clawhub":{"status":"linked","valid":true,"slug":"registry-slug","installedVersion":"1.2.3"}}]}"""
    }

  private fun createTestRuntime(): NodeRuntime {
    val app = RuntimeEnvironment.getApplication()
    val securePrefs =
      app.getSharedPreferences(
        "openclaw.node.secure.test.${UUID.randomUUID()}",
        android.content.Context.MODE_PRIVATE,
      )
    return NodeRuntime(app, SecurePrefs(app, securePrefsOverride = securePrefs)).also(runtimes::add)
  }

  private fun seedConnectedAdminRuntime(runtime: NodeRuntime) {
    writeField(runtime, "connectedEndpoint", GatewayEndpoint.manual("127.0.0.1", 18789))
    writeField(runtime, "operatorConnected", true)
    readField<MutableStateFlow<List<String>>>(runtime, "_operatorScopes").value = listOf("operator.admin")
    readField<MutableStateFlow<Boolean>>(runtime, "_clawHubSkillMethodsAvailable").value = true
    waitUntil { runtime.operatorAdminScopeAvailable.value }
  }

  private fun waitUntil(condition: () -> Boolean) {
    repeat(100) {
      if (condition()) return
      Thread.sleep(10)
    }
    error("Expected condition to become true")
  }

  private fun writeField(
    target: Any,
    name: String,
    value: Any?,
  ) {
    field(target, name).set(target, value)
  }

  @Suppress("UNCHECKED_CAST")
  private fun <T> readField(
    target: Any,
    name: String,
  ): T = field(target, name).get(target) as T

  private fun field(
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
}
