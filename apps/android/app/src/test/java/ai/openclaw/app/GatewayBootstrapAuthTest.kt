package ai.openclaw.app

import ai.openclaw.app.chat.ChatMessage
import ai.openclaw.app.chat.ChatSessionEntry
import ai.openclaw.app.chat.ChatTranscriptCache
import ai.openclaw.app.gateway.DeviceAuthStore
import ai.openclaw.app.gateway.DeviceIdentityStore
import ai.openclaw.app.gateway.GatewayConnectOptions
import ai.openclaw.app.gateway.GatewayEndpoint
import ai.openclaw.app.gateway.GatewayErrorDetails
import ai.openclaw.app.gateway.GatewayHelloSummary
import ai.openclaw.app.gateway.GatewayRegistryEntry
import ai.openclaw.app.gateway.GatewayRegistryEntryKind
import ai.openclaw.app.gateway.GatewaySession
import ai.openclaw.app.gateway.GatewayTlsParams
import ai.openclaw.app.gateway.GatewayTlsProbeFailure
import ai.openclaw.app.gateway.GatewayTlsProbeResult
import ai.openclaw.app.node.ConnectionManager
import ai.openclaw.app.node.InvokeDispatcher
import ai.openclaw.app.protocol.OpenClawCameraCommand
import ai.openclaw.app.protocol.OpenClawLocationCommand
import ai.openclaw.app.protocol.OpenClawTalkCommand
import ai.openclaw.app.ui.canFinishOnboarding
import ai.openclaw.app.voice.MicCaptureManager
import ai.openclaw.app.voice.TalkModeManager
import android.Manifest
import android.net.ConnectivityManager
import android.net.NetworkCapabilities
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.asCoroutineDispatcher
import kotlinx.coroutines.async
import kotlinx.coroutines.cancelAndJoin
import kotlinx.coroutines.currentCoroutineContext
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.job
import kotlinx.coroutines.joinAll
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.test.resetMain
import kotlinx.coroutines.test.setMain
import kotlinx.coroutines.withTimeout
import kotlinx.coroutines.withTimeoutOrNull
import kotlinx.coroutines.yield
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import okhttp3.mockwebserver.Dispatcher
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import okhttp3.mockwebserver.QueueDispatcher
import okhttp3.mockwebserver.RecordedRequest
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertSame
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.junit.runners.model.MultipleFailureException
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import org.robolectric.Shadows.shadowOf
import org.robolectric.annotation.Config
import org.robolectric.shadows.ShadowNetwork
import org.robolectric.shadows.ShadowNetworkCapabilities
import java.io.IOException
import java.lang.reflect.Field
import java.net.InetAddress
import java.net.Proxy
import java.net.ProxySelector
import java.net.SocketAddress
import java.net.URI
import java.util.UUID
import java.util.concurrent.CountDownLatch
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicInteger
import java.util.concurrent.atomic.AtomicLong

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34])
class GatewayBootstrapAuthTest {
  private data class RuntimeFixture(
    val runtime: NodeRuntime,
    val startupJobs: List<Job>,
  )

  private val runtimes = mutableListOf<RuntimeFixture>()
  private val previousProxySelector = ProxySelector.getDefault()
  private val gatewayServerDelegate =
    lazy {
      MockWebServer().apply {
        (dispatcher as QueueDispatcher).setFailFast(MockResponse().setResponseCode(503))
        start(InetAddress.getByName("127.0.0.1"), 0)
      }
    }
  private val gatewayServer by gatewayServerDelegate

  @After
  fun closeFixtures() {
    val failures =
      runtimes
        .mapNotNull { (runtime, startupJobs) ->
          runCatching {
            try {
              drainWithMainLooper {
                // Stop discovery/fleet producers before snapshotting sessions. Keep their shared
                // parent alive until disconnect tails have drained accepted frames and callbacks.
                startupJobs.forEach { it.cancel() }
                startupJobs.joinAll()
                val sessions =
                  listOf(readField<GatewaySession>(runtime, "operatorSession"), readField<GatewaySession>(runtime, "nodeSession")) +
                    readField<Map<String, Any>>(runtime, "secondaryOperatorSessions").values.map { readField<GatewaySession>(it, "session") }
                runtime.disconnect()
                sessions.forEach { it.disconnectAndJoin() }
              }
            } finally {
              closeNodeRuntimeTestFixture(runtime)
            }
          }.exceptionOrNull()
        }.toMutableList()
    try {
      if (gatewayServerDelegate.isInitialized()) {
        runCatching { gatewayServer.shutdown() }.exceptionOrNull()?.let(failures::add)
      }
    } finally {
      ProxySelector.setDefault(previousProxySelector)
    }
    MultipleFailureException.assertEmpty(failures)
  }

  private fun trackRuntime(runtime: NodeRuntime): NodeRuntime =
    runtime.also {
      runtimes +=
        RuntimeFixture(
          it,
          readField<CoroutineScope>(it, "scope")
            .coroutineContext.job.children
            .toList(),
        )
    }

  private fun gatewayEndpoint(): GatewayEndpoint = GatewayEndpoint.manual("127.0.0.1", gatewayServer.port)

  private fun tlsGatewayEndpoint(): GatewayEndpoint = GatewayEndpoint.manual("gateway.test", gatewayServer.port, tlsEnabled = true)

  @Before
  fun setUpFixtures() {
    RuntimeEnvironment
      .getApplication()
      .getSharedPreferences("openclaw.node", android.content.Context.MODE_PRIVATE)
      .edit()
      .clear()
      .commit()
    // Numeric loopback is not a system-trust candidate. Route the synthetic DNS
    // authority through our proxy, and keep loopback independent of machine proxy settings.
    ProxySelector.setDefault(
      object : ProxySelector() {
        override fun select(uri: URI): List<Proxy> = if (uri.host == "gateway.test") listOf(gatewayServer.toProxyAddress()) else listOf(Proxy.NO_PROXY)

        override fun connectFailed(
          uri: URI,
          address: SocketAddress,
          failure: IOException,
        ) = Unit
      },
    )
  }

  @Test
  fun networkAttachmentWakesEveryDesiredSecondaryGateway() =
    runBlocking {
      data class Peer(
        val server: MockWebServer,
        val stalled: CompletableDeferred<Unit>,
        val resumed: CompletableDeferred<Unit>,
        val release: CountDownLatch,
      )
      val (app, prefs, runtime) = gatewayFixture()
      val peers =
        List(2) {
          val stalled = CompletableDeferred<Unit>()
          val resumed = CompletableDeferred<Unit>()
          val release = CountDownLatch(1)
          val attempts = AtomicInteger()
          val server =
            MockWebServer().apply {
              dispatcher =
                object : Dispatcher() {
                  override fun dispatch(request: RecordedRequest): MockResponse {
                    when (attempts.incrementAndGet()) {
                      3 -> {
                        stalled.complete(Unit)
                        release.await(10, TimeUnit.SECONDS)
                      }

                      4 -> {
                        resumed.complete(Unit)
                      }
                    }
                    return MockResponse().setResponseCode(503)
                  }
                }
              start()
            }
          Peer(server, stalled, resumed, release)
        }
      try {
        for (peer in peers) {
          val endpoint = GatewayEndpoint.manual("127.0.0.1", peer.server.port)
          prefs.gatewayRegistry.upsert(
            GatewayRegistryEntry(
              stableId = endpoint.stableId,
              kind = GatewayRegistryEntryKind.MANUAL,
              name = endpoint.name,
              host = endpoint.host,
              port = endpoint.port,
              tls = false,
            ),
          )
          prefs.saveGatewayCredentials(endpoint.stableId, token = "shared-token")
          runtime.setGatewayConnectionEnabled(endpoint.stableId, true)
        }
        // The real fleet collector creates both sessions. Hold their third HTTP upgrade
        // responses so only a recovery wake can admit another attempt before release.
        withTimeout(10_000) { peers.forEach { it.stalled.await() } }
        val network = ShadowNetwork.newInstance(321)
        val capabilities = ShadowNetworkCapabilities.newInstance()
        shadowOf(capabilities).addCapability(NetworkCapabilities.NET_CAPABILITY_VALIDATED)
        shadowOf(app.getSystemService(ConnectivityManager::class.java)).networkCallbacks.toList().forEach { callback ->
          callback.onAvailable(network)
          callback.onCapabilitiesChanged(network, capabilities)
        }
        withTimeout(2_000) { peers.forEach { it.resumed.await() } }
      } finally {
        peers.forEach { it.release.countDown() }
        runtime.disconnect()
        peers.forEach { it.server.shutdown() }
      }
    }

  @Test
  fun nodeFirstBootstrapBecomesReadyWhenOperatorConnects() {
    assertReadyAfterBothSessionsConnect(nodeFirst = true)
  }

  @Test
  fun operatorFirstConnectionRefreshesApprovalWhenNodeConnects() {
    assertReadyAfterBothSessionsConnect(nodeFirst = false)
  }

  private fun assertReadyAfterBothSessionsConnect(nodeFirst: Boolean) =
    runBlocking {
      val (app, prefs, runtime) = gatewayFixture()
      val runtimeJob = requireNotNull(readField<CoroutineScope>(runtime, "scope").coroutineContext[Job])
      try {
        // Stop startup collectors before callbacks register a gateway, but keep the scope live
        // so the real ready callbacks can launch their refreshes without opening sockets.
        withTimeout(10_000) {
          val startupJobs = runtimeJob.children.toList()
          startupJobs.forEach { it.cancel() }
          startupJobs.forEach { it.join() }
        }
        writeField(runtime, "connectedEndpoint", GatewayEndpoint.manual("127.0.0.1", 18789))
        val deviceId = DeviceIdentityStore.withPrefs(app, prefs).loadOrCreate().deviceId
        val initialNodeListRead = CompletableDeferred<Job>()
        runtime.gatewayDataRequestOverrideForTests = { _, method, _ ->
          when (method) {
            "node.list" -> {
              if (runtime.nodeConnected.value) {
                """{"nodes":[{"nodeId":"$deviceId","paired":true,"connected":true,"approvalState":"approved"}]}"""
              } else {
                initialNodeListRead.complete(requireNotNull(currentCoroutineContext()[Job]))
                """{"nodes":[]}"""
              }
            }

            else -> {
              "{}"
            }
          }
        }
        val hello =
          GatewayHelloSummary(
            serverName = "Test gateway",
            remoteAddress = "127.0.0.1:18789",
            serverVersion = null,
            mainSessionKey = null,
            updateAvailable = null,
            authScopes = listOf("operator.read"),
            methods = setOf("node.list"),
          )

        fun connectSession(fieldName: String) {
          val session = readField<GatewaySession>(runtime, fieldName)
          readField<(GatewayHelloSummary) -> Unit>(session, "onConnected")(hello)
        }

        fun ready(): Boolean =
          canFinishOnboarding(
            isConnected = runtime.gatewayConnectionDisplay.value.isConnected,
            isNodeConnected = runtime.nodeConnected.value,
            nodeCapabilityApproval = runtime.nodeCapabilityApproval.value,
          )

        connectSession(if (nodeFirst) "nodeSession" else "operatorSession")
        withTimeout(10_000) {
          if (nodeFirst) {
            // Finish the offline node refresh before operator success can make it usable.
            runtimeJob.children.toList().forEach { it.join() }
          } else {
            // Settle the empty read before node success can hide a missing node-ready refresh.
            initialNodeListRead.await().join()
          }
        }
        assertEquals(GatewayNodeCapabilityApproval.Loading, runtime.nodeCapabilityApproval.value)
        assertFalse(ready())
        assertFalse(runtime.nodesDevicesRefreshing.value)

        connectSession(if (nodeFirst) "operatorSession" else "nodeSession")
        withTimeoutOrNull(10_000) {
          runtime.nodeCapabilityApproval.first { it == GatewayNodeCapabilityApproval.Approved }
        }

        assertEquals(GatewayNodeCapabilityApproval.Approved, runtime.nodeCapabilityApproval.value)
        assertTrue(ready())
      } finally {
        runtime.disconnect()
        runtimeJob.cancelAndJoin()
      }
    }

  @Test
  fun standaloneStatusPreservesLiveOperatorConnection() {
    val runtime = createTestRuntime(RuntimeEnvironment.getApplication())
    writeField(runtime, "operatorConnected", true)
    val method = runtime.javaClass.getDeclaredMethod("setStandaloneGatewayStatus", String::class.java)
    method.isAccessible = true

    method.invoke(runtime, "Verify gateway TLS fingerprint…")

    assertTrue(runtime.gatewayConnectionDisplay.value.isConnected)
    assertEquals("Verify gateway TLS fingerprint…", runtime.gatewayConnectionDisplay.value.statusText)
    assertNull(runtime.gatewayConnectionDisplay.value.problem)
  }

  @Test
  fun unstructuredRetryClearsEarlierOperatorAuthProblem() {
    val runtime = createTestRuntime(RuntimeEnvironment.getApplication())
    val session = readField<GatewaySession>(runtime, "operatorSession")
    val onDisconnected = readField<(String) -> Unit>(session, "onDisconnected")
    val onConnectFailure = readField<(GatewaySession.ErrorShape, Boolean) -> Unit>(session, "onConnectFailure")

    onDisconnected("Gateway error: unauthorized")
    onConnectFailure(
      GatewaySession.ErrorShape(
        code = "UNAUTHORIZED",
        message = "unauthorized",
        details =
          GatewayErrorDetails(
            code = "AUTH_TOKEN_MISSING",
            canRetryWithDeviceToken = false,
            recommendedNextStep = "provide_token",
          ),
      ),
      true,
    )
    val problemCode =
      runtime.gatewayConnectionDisplay.value.problem
        ?.code
    assertEquals(
      "AUTH_TOKEN_MISSING",
      problemCode,
    )

    onDisconnected("Reconnecting…")
    assertEquals("Reconnecting…", runtime.gatewayConnectionDisplay.value.statusText)
    assertNull(runtime.gatewayConnectionDisplay.value.problem)

    onDisconnected("Gateway error: timeout")
    assertEquals("Gateway error: timeout", runtime.gatewayConnectionDisplay.value.statusText)
    assertNull(runtime.gatewayConnectionDisplay.value.problem)
  }

  @Test
  fun retryableNodePairingProblemSurvivesReconnectStatus() {
    val runtime = createTestRuntime(RuntimeEnvironment.getApplication())
    val session = readField<GatewaySession>(runtime, "nodeSession")
    val onDisconnected = readField<(String) -> Unit>(session, "onDisconnected")
    val onConnectFailure = readField<(GatewaySession.ErrorShape, Boolean) -> Unit>(session, "onConnectFailure")

    onDisconnected("Gateway error: pairing required")
    onConnectFailure(
      GatewaySession.ErrorShape(
        code = "NOT_PAIRED",
        message = "pairing required",
        details =
          GatewayErrorDetails(
            code = "PAIRING_REQUIRED",
            canRetryWithDeviceToken = false,
            recommendedNextStep = "wait_then_retry",
            reason = "not-paired",
            requestId = "request-1",
            retryable = true,
          ),
      ),
      false,
    )

    onDisconnected("Reconnecting…")

    val reconnectDisplay = runtime.gatewayConnectionDisplay.value
    assertEquals("Reconnecting…", reconnectDisplay.statusText)
    assertEquals("PAIRING_REQUIRED", reconnectDisplay.problem?.code)
    assertEquals("request-1", reconnectDisplay.problem?.requestId)

    onDisconnected("Gateway error: timeout")
    assertNull(runtime.gatewayConnectionDisplay.value.problem)
  }

  @Test
  fun doesNotConnectOperatorSessionWhenOnlyBootstrapAuthExists() {
    assertFalse(operatorAuth(auth(token = "", bootstrapToken = "bootstrap-1", password = ""), "") != null)
    assertFalse(operatorAuth(auth(bootstrapToken = "bootstrap-1")) != null)
  }

  @Test
  fun connectsOperatorSessionWhenSharedPasswordOrStoredAuthExists() {
    assertTrue(operatorAuth(auth(token = "shared-token", bootstrapToken = "bootstrap-1")) != null)
    assertTrue(operatorAuth(auth(bootstrapToken = "bootstrap-1", password = "shared-password")) != null)
    assertTrue(operatorAuth(auth(bootstrapToken = "bootstrap-1"), "stored-token") != null)
    assertTrue(operatorAuth(auth(bootstrapToken = "")) != null)
  }

  @Test
  fun resolveOperatorSessionConnectAuthUsesStoredTokenPathAfterBootstrapHandoff() {
    val resolved =
      operatorAuth(auth(bootstrapToken = "bootstrap-1"), "stored-token")

    assertEquals(auth(), resolved)
  }

  @Test
  fun resolveOperatorSessionConnectAuthIgnoresBootstrapWhenNoStoredOperatorTokenExists() {
    val resolved =
      operatorAuth(auth(bootstrapToken = "bootstrap-1"))

    assertNull(resolved)
  }

  @Test
  fun resolveOperatorSessionConnectAuthUsesNoAuthWhenGatewayHasNoAuth() {
    val resolved =
      operatorAuth(auth())

    assertEquals(auth(), resolved)
  }

  @Test
  fun resolveOperatorSessionConnectAuthPrefersExplicitSharedAuth() {
    val resolved =
      operatorAuth(auth(token = "shared-token", bootstrapToken = "bootstrap-1", password = "shared-password"), "stored-token")

    assertEquals(
      auth(token = "shared-token"),
      resolved,
    )
  }

  @Test
  fun resolveGatewayControlPageAuthFallsBackToStoredOperatorToken() {
    val resolved =
      resolveGatewayControlPageAuth(
        auth = auth(bootstrapToken = "bootstrap-1"),
        storedOperatorToken = " stored-token ",
      )

    assertEquals(
      auth(token = "stored-token"),
      resolved,
    )
  }

  @Test
  fun resolveGatewayControlPageAuthPrefersExplicitSharedAuth() {
    assertEquals(
      auth(token = "shared-token"),
      resolveGatewayControlPageAuth(
        auth = auth(token = " shared-token ", bootstrapToken = "bootstrap-1", password = "shared-password"),
        storedOperatorToken = "stored-token",
      ),
    )
    assertEquals(
      auth(password = "shared-password"),
      resolveGatewayControlPageAuth(
        auth = auth(bootstrapToken = "bootstrap-1", password = " shared-password "),
        storedOperatorToken = "stored-token",
      ),
    )
  }

  @Test
  fun operatorConnectScopesForAuthUsesNativeScopesWhenNoStoredOperatorMetadata() {
    assertEquals(
      listOf(
        "operator.admin",
        "operator.approvals",
        "operator.questions",
        "operator.read",
        "operator.talk.secrets",
        "operator.write",
      ),
      operatorConnectScopesForAuth(
        usesStoredDeviceToken = false,
        storedOperatorScopes = null,
      ),
    )
  }

  @Test
  fun operatorConnectScopesForAuthPreservesStoredScopesForReconnects() {
    val storedScopes = listOf("operator.approvals", "operator.read", "operator.write")

    assertEquals(
      storedScopes,
      operatorConnectScopesForAuth(
        usesStoredDeviceToken = true,
        storedOperatorScopes = storedScopes,
      ),
    )
  }

  @Test
  fun operatorConnectScopesForAuthFallsBackToLegacyScopesForOldStoredDeviceTokens() {
    assertEquals(
      ConnectionManager.legacyOperatorScopes,
      operatorConnectScopesForAuth(
        usesStoredDeviceToken = true,
        storedOperatorScopes = emptyList(),
      ),
    )
  }

  @Test
  fun operatorConnectScopesForAuthUsesNativeScopesForExplicitReauth() {
    assertEquals(
      ConnectionManager.nativeClientOperatorScopes,
      operatorConnectScopesForAuth(
        usesStoredDeviceToken = false,
        storedOperatorScopes = listOf("operator.approvals", "operator.read", "operator.write"),
      ),
    )
  }

  @Test
  fun operatorSessionUsesStoredDeviceTokenOnlyWithoutExplicitSharedAuth() {
    assertTrue(usesStoredOperatorToken(auth(bootstrapToken = "bootstrap-1")))
    assertFalse(usesStoredOperatorToken(auth(token = "shared-token")))
    assertFalse(usesStoredOperatorToken(auth(password = "password")))
  }

  @Test
  fun resolveGatewayConnectAuth_prefersExplicitSetupAuthOverStoredPrefs() {
    val (_, prefs, runtime) = gatewayFixture()
    val endpoint = GatewayEndpoint.manual("gateway.example", 18789)
    prefs.saveGatewayCredentials(endpoint.stableId, token = "stale-shared-token", password = "stale-password")

    val auth =
      runtime.resolveGatewayConnectAuth(
        endpoint,
        auth(bootstrapToken = "setup-bootstrap-token"),
      )

    assertNull(auth.token)
    assertEquals("setup-bootstrap-token", auth.bootstrapToken)
    assertNull(auth.password)
  }

  @Test
  fun acceptGatewayTrustPrompt_preservesExplicitSetupAuth() =
    runBlocking {
      val (_, prefs, runtime) =
        gatewayFixture { _, _ -> GatewayTlsProbeResult(fingerprintSha256 = "ab".repeat(32)) }
      val endpoint = tlsGatewayEndpoint()
      prefs.saveGatewayCredentials(endpoint.stableId, token = "stale-shared-token", password = "stale-password")
      val explicitAuth = auth(bootstrapToken = "setup-bootstrap-token")

      runtime.connect(endpoint, explicitAuth)
      val prompt = waitForGatewayTrustPrompt(runtime)
      assertEquals("setup-bootstrap-token", prompt.auth.bootstrapToken)

      runtime.acceptGatewayTrustPrompt()

      assertEquals("ab".repeat(32), prefs.loadGatewayTlsFingerprint(endpoint.stableId))
      assertEquals("setup-bootstrap-token", waitForDesiredBootstrapToken(runtime, "nodeSession"))
      assertEquals("ab".repeat(32), runtime.gatewayControlPage.value?.tlsFingerprintSha256)
      assertNull(desiredBootstrapToken(runtime, "operatorSession"))
    }

  @Test
  fun connect_promptsBeforeReplacingChangedTlsFingerprint() =
    runBlocking {
      val (_, prefs, runtime) =
        gatewayFixture { _, _ -> GatewayTlsProbeResult(fingerprintSha256 = "bb".repeat(32), systemTrusted = true) }
      val endpoint = tlsGatewayEndpoint()
      val oldFingerprint = "aa".repeat(32)
      val newFingerprint = "bb".repeat(32)
      prefs.saveGatewayTlsFingerprint(endpoint.stableId, oldFingerprint)

      runtime.connect(
        endpoint,
        auth(token = "shared-token"),
      )

      val prompt = waitForGatewayTrustPrompt(runtime)
      assertEquals(oldFingerprint, prompt.previousFingerprintSha256)
      assertEquals(newFingerprint, prompt.fingerprintSha256)
      assertTrue(prompt.systemTrustAvailable)
      assertEquals(oldFingerprint, prefs.loadGatewayTlsFingerprint(endpoint.stableId))

      runtime.declineGatewayTrustPrompt()

      assertEquals(oldFingerprint, prefs.loadGatewayTlsFingerprint(endpoint.stableId))

      runtime.connect(
        endpoint,
        auth(token = "shared-token"),
      )
      waitForGatewayTrustPrompt(runtime)
      runtime.acceptGatewayTrustPrompt()

      assertEquals(newFingerprint, prefs.loadGatewayTlsFingerprint(endpoint.stableId))
    }

  @Test
  fun connect_systemTrustedCandidateWithoutStoredPinUsesPlatformTrust() {
    val (_, prefs, runtime) =
      gatewayFixture { _, _ -> GatewayTlsProbeResult(fingerprintSha256 = "bb".repeat(32), systemTrusted = true) }
    val endpoint = tlsGatewayEndpoint()

    runtime.connect(
      endpoint,
      auth(token = "test-token-placeholder"),
    )

    val desired = waitForDesiredConnection(runtime, "nodeSession")
    val tls = readField<GatewayTlsParams>(desired, "tls")
    assertNull(tls.expectedFingerprint)
    assertNull(prefs.loadGatewayTlsFingerprint(endpoint.stableId))
    assertEquals(endpoint.stableId, prefs.gatewayRegistry.activeStableId.value)
    assertNull(runtime.pendingGatewayTrust.value)
    val request = gatewayServer.takeRequest(5, TimeUnit.SECONDS)
    assertNotNull("The TLS candidate must use the test-owned proxy", request)
    assertEquals("CONNECT gateway.test:${gatewayServer.port} HTTP/1.1", request!!.requestLine)
  }

  @Test
  fun connect_systemTrustedChangedPinSwitchClearsPinAndUsesPlatformTrust() {
    val oldFingerprint = "aa".repeat(32)
    val newFingerprint = "bb".repeat(32)
    val (_, prefs, runtime) =
      gatewayFixture { _, _ -> GatewayTlsProbeResult(fingerprintSha256 = newFingerprint, systemTrusted = true) }
    val endpoint = tlsGatewayEndpoint()
    prefs.saveGatewayTlsFingerprint(endpoint.stableId, oldFingerprint)

    runtime.connect(
      endpoint,
      auth(token = "test-token-placeholder"),
    )

    val prompt = waitForGatewayTrustPrompt(runtime)
    assertTrue(prompt.systemTrustAvailable)
    assertEquals(oldFingerprint, prefs.loadGatewayTlsFingerprint(endpoint.stableId))

    runtime.useSystemGatewayTrustPrompt()

    val desired = waitForDesiredConnection(runtime, "nodeSession")
    val tls = readField<GatewayTlsParams>(desired, "tls")
    assertNull(tls.expectedFingerprint)
    assertNull(prefs.loadGatewayTlsFingerprint(endpoint.stableId))
  }

  @Test
  fun connect_ignoresStaleTlsProbeAfterDisconnect() =
    runBlocking {
      val fingerprint = "aa".repeat(32)
      val probeJob = CompletableDeferred<Job>()
      val probeResult = CompletableDeferred<GatewayTlsProbeResult>()
      val (_, prefs, runtime) =
        gatewayFixture { _, _ ->
          probeJob.complete(checkNotNull(currentCoroutineContext()[Job]))
          probeResult.await()
        }
      val endpoint = tlsGatewayEndpoint()
      prefs.saveGatewayTlsFingerprint(endpoint.stableId, fingerprint)

      runtime.connect(
        endpoint,
        auth(token = "shared-token"),
      )
      val tlsProbeJob = probeJob.await()

      runtime.disconnect()
      probeResult.complete(GatewayTlsProbeResult(fingerprintSha256 = fingerprint))
      // Join the owning coroutine so assertions run after its stale-attempt guard.
      tlsProbeJob.join()

      assertNull(runtime.pendingGatewayTrust.value)
      assertNull(desiredBootstrapToken(runtime, "nodeSession"))
      assertEquals(fingerprint, prefs.loadGatewayTlsFingerprint(endpoint.stableId))
    }

  @Test
  fun forgetGatewayCancelsInFlightTlsProbeBeforePurgingAuth() =
    runBlocking {
      val probeStarted = CompletableDeferred<Unit>()
      val probeResult = CompletableDeferred<GatewayTlsProbeResult>()
      val (_, prefs, runtime) =
        gatewayFixture { _, _ ->
          probeStarted.complete(Unit)
          probeResult.await()
        }
      val endpoint = tlsGatewayEndpoint()
      prefs.gatewayRegistry.upsert(
        GatewayRegistryEntry(
          stableId = endpoint.stableId,
          kind = GatewayRegistryEntryKind.MANUAL,
          name = endpoint.name,
          host = endpoint.host,
          port = endpoint.port,
        ),
      )
      prefs.saveGatewayCredentials(endpoint.stableId, token = "shared-token")

      runtime.connect(endpoint)
      probeStarted.await()
      assertTrue(runtime.forgetGateway(endpoint.stableId))
      probeResult.complete(GatewayTlsProbeResult(fingerprintSha256 = "aa".repeat(32)))
      yield()

      assertNull(
        prefs.gatewayRegistry.entries.value
          .firstOrNull { it.stableId == endpoint.stableId },
      )
      assertEquals(GatewayCredentials(), prefs.loadGatewayCredentials(endpoint.stableId))
      assertNull(runtime.pendingGatewayTrust.value)
      assertNull(desiredConnection(runtime, "nodeSession"))
    }

  @Test
  fun refreshGatewayConnection_reconnectsSavedManualEndpointAfterDisconnect() {
    val (runtime, prefs) = createNeutralizedRuntime()
    armSavedActiveManualGateway(prefs)

    runtime.connect(
      gatewayEndpoint(),
      auth(token = "initial-token"),
    )
    runtime.disconnect()
    assertNull(desiredConnection(runtime, "nodeSession"))

    runtime.refreshGatewayConnection()

    val desired = waitForDesiredConnection(runtime, "nodeSession")
    val endpoint = readField<GatewayEndpoint>(desired, "endpoint")
    assertEquals("127.0.0.1", endpoint.host)
    assertEquals(gatewayServer.port, endpoint.port)
    assertEquals("shared-token", readField<String?>(desired, "token"))
  }

  @Test
  fun foregroundAfterExplicitDisconnectStaysOfflineUntilExplicitReconnect() {
    val (runtime, prefs) = createNeutralizedRuntime()
    armSavedActiveManualGateway(prefs)

    runtime.connect(gatewayEndpoint())
    runtime.disconnect()
    runtime.setCameraEnabled(true)
    runtime.setLocationMode(LocationMode.WhileUsing)
    runtime.setForeground(false)
    runtime.setForeground(true)

    assertNull(desiredConnection(runtime, "nodeSession"))

    runtime.refreshGatewayConnection()

    val desired = waitForDesiredConnection(runtime, "nodeSession")
    assertEquals("127.0.0.1", readField<GatewayEndpoint>(desired, "endpoint").host)
  }

  @Test
  fun advertisedSurfaceSettingsReconnectNodeWithCurrentCommands() {
    val (runtime, prefs) = createNeutralizedRuntime()
    armSavedActiveManualGateway(prefs)
    val endpoint = gatewayEndpoint()
    runBlocking { assertTrue(runtime.connectSwitchingGateway(endpoint)) }

    runtime.setCameraEnabled(true)

    val cameraOptions =
      readField<GatewayConnectOptions>(
        waitForDesiredConnection(runtime, "nodeSession"),
        "options",
      )
    assertTrue(cameraOptions.commands.contains(OpenClawCameraCommand.Snap.rawValue))
    assertFalse(cameraOptions.commands.contains(OpenClawLocationCommand.Get.rawValue))

    runtime.setLocationMode(LocationMode.WhileUsing)

    val locationOptions =
      readField<GatewayConnectOptions>(
        waitForDesiredConnection(runtime, "nodeSession"),
        "options",
      )
    assertTrue(locationOptions.commands.contains(OpenClawCameraCommand.Snap.rawValue))
    assertTrue(locationOptions.commands.contains(OpenClawLocationCommand.Get.rawValue))
  }

  @Test
  fun permissionSurfaceReconnectsOnlyAfterAndroidAuthorityChanges() {
    val app: android.app.Application = RuntimeEnvironment.getApplication()
    shadowOf(app).denyPermissions(Manifest.permission.CAMERA)
    val (runtime, prefs) = createNeutralizedRuntime()
    armSavedActiveManualGateway(prefs)
    runBlocking { assertTrue(runtime.connectSwitchingGateway(gatewayEndpoint())) }
    val original = waitForDesiredConnection(runtime, "nodeSession")

    runtime.refreshNodePermissionSurface()
    assertSame(original, desiredConnection(runtime, "nodeSession"))

    shadowOf(app).grantPermissions(Manifest.permission.CAMERA)
    runtime.refreshNodePermissionSurface()

    val options =
      readField<GatewayConnectOptions>(
        waitForDesiredConnection(runtime, "nodeSession"),
        "options",
      )
    assertTrue(options.permissions.getValue("camera"))
  }

  @Test
  fun connect_showsSecureEndpointGuidanceWhenTlsProbeFails() {
    val (_, _, runtime) =
      gatewayFixture { _, _ -> GatewayTlsProbeResult(failure = GatewayTlsProbeFailure.TLS_UNAVAILABLE) }

    runtime.connect(
      tlsGatewayEndpoint(),
      auth(token = "shared-token"),
    )

    val prompt = waitForGatewayTrustPrompt(runtime)
    assertEquals(
      "Failed: no secure gateway endpoint was detected. Enable gateway TLS or Tailscale Serve, or use a trusted private LAN address with Unencrypted selected.",
      runtime.statusText.value,
    )
    assertNull(prompt.fingerprintSha256)
    assertEquals(GatewayTlsProbeFailure.TLS_UNAVAILABLE, prompt.probeFailure)
  }

  @Test
  fun connect_enforcesAcceptedManualFingerprintAfterTlsProbeFailure() {
    val (_, prefs, runtime) =
      gatewayFixture { _, _ -> GatewayTlsProbeResult(failure = GatewayTlsProbeFailure.TLS_UNAVAILABLE) }
    val endpoint = tlsGatewayEndpoint()

    runtime.connect(
      endpoint,
      auth(token = "test-token-placeholder"),
    )
    waitForGatewayTrustPrompt(runtime)
    val manualFingerprint = "cd".repeat(32)
    runtime.acceptGatewayTrustPrompt("SHA256: ${manualFingerprint.uppercase()}")

    val desired = waitForDesiredConnection(runtime, "nodeSession")
    val tls = readField<GatewayTlsParams>(desired, "tls")
    assertEquals(manualFingerprint, tls.expectedFingerprint)
    assertEquals(manualFingerprint, prefs.loadGatewayTlsFingerprint(endpoint.stableId))
  }

  @Test
  fun connect_showsTlsTimeoutGuidanceWhenFingerprintProbeTimesOut() {
    val (_, _, runtime) =
      gatewayFixture { _, _ -> GatewayTlsProbeResult(failure = GatewayTlsProbeFailure.TLS_HANDSHAKE_TIMEOUT) }

    runtime.connect(
      tlsGatewayEndpoint(),
      auth(token = "shared-token"),
    )

    val prompt = waitForGatewayTrustPrompt(runtime)
    assertEquals(
      "Failed: secure endpoint reached, but TLS fingerprint verification timed out. Check Tailscale Serve or gateway TLS and retry.",
      runtime.statusText.value,
    )
    assertNull(prompt.fingerprintSha256)
    assertEquals(GatewayTlsProbeFailure.TLS_HANDSHAKE_TIMEOUT, prompt.probeFailure)
  }

  @Test
  fun resetGatewaySetupAuth_clearsOnlyTargetGatewayCredentialsAndDeviceTokens() =
    runBlocking {
      val (app, prefs, runtime) = gatewayFixture()
      val deviceId = DeviceIdentityStore.withPrefs(app, prefs).loadOrCreate().deviceId
      val authStore = DeviceAuthStore(prefs)
      val target = GatewayEndpoint.manual("target.example", 18789).stableId
      val other = GatewayEndpoint.manual("other.example", 18789).stableId
      prefs.saveGatewayCredentials(target, token = "target-token")
      prefs.saveGatewayCredentials(other, token = "other-token")
      authStore.saveToken(target, deviceId, "node", "target-node-token")
      authStore.saveToken(other, deviceId, "node", "other-node-token")

      assertTrue(runtime.resetGatewaySetupAuth(target))

      assertEquals(GatewayCredentials(), prefs.loadGatewayCredentials(target))
      assertEquals("other-token", prefs.loadGatewayCredentials(other).token)
      assertNull(authStore.loadToken(target, deviceId, "node"))
      assertEquals("other-node-token", authStore.loadToken(other, deviceId, "node"))
    }

  @Test
  fun resetGatewaySetupAuthClearsInjectedTranscriptStore() =
    runBlocking {
      val app = RuntimeEnvironment.getApplication()
      val prefs = testPrefs(app)
      val transcriptCache = RecordingTranscriptCache()
      val runtime = trackRuntime(NodeRuntime(app, prefs, transcriptCache))
      val target = GatewayEndpoint.manual("target.example", 18789).stableId

      assertTrue(runtime.resetGatewaySetupAuth(target))

      assertEquals(listOf(target), transcriptCache.clearedGatewayIds)
    }

  @Test
  fun switchToUndiscoveredGatewayKeepsCurrentConnectionAndActiveGateway() {
    val (_, prefs, runtime) = gatewayFixture()
    neutralizeColdStartAutoConnect(runtime)
    val current = gatewayEndpoint()
    val missingStableId = "bonjour-missing"
    prefs.gatewayRegistry.upsert(
      GatewayRegistryEntry(
        stableId = current.stableId,
        kind = GatewayRegistryEntryKind.MANUAL,
        name = current.name,
        host = current.host,
        port = current.port,
        tls = false,
      ),
    )
    prefs.gatewayRegistry.upsert(
      GatewayRegistryEntry(
        stableId = missingStableId,
        kind = GatewayRegistryEntryKind.DISCOVERED,
        name = "Missing gateway",
      ),
    )
    prefs.gatewayRegistry.setActive(current.stableId)
    writeField(runtime, "connectedEndpoint", current)

    assertFalse(runBlocking { runtime.switchToGateway(missingStableId) })

    assertEquals(current, readField<GatewayEndpoint?>(runtime, "connectedEndpoint"))
    assertEquals(current.stableId, prefs.gatewayRegistry.activeStableId.value)
    assertEquals("Gateway not currently discoverable", runtime.statusText.value)
  }

  @Test
  fun gatewayConnectDoesNotHoldAuthMonitorWhileWaitingForSessionLifecycle() =
    runBlocking {
      val app = RuntimeEnvironment.getApplication()
      val prefs = testPrefs(app).apply { setManualTls(false) }
      val runtime = trackRuntime(NodeRuntime(app, prefs))
      neutralizeColdStartAutoConnect(runtime)
      val connectFrame = CompletableDeferred<JsonObject>()
      gatewayServer.enqueue(
        MockResponse().withWebSocketUpgrade(
          object : WebSocketListener() {
            override fun onOpen(
              webSocket: WebSocket,
              response: Response,
            ) {
              webSocket.send("""{"type":"event","event":"connect.challenge","payload":{"nonce":"bootstrap-test","ts":1700000000123}}""")
            }

            override fun onMessage(
              webSocket: WebSocket,
              text: String,
            ) {
              connectFrame.complete(Json.parseToJsonElement(text).jsonObject)
            }
          },
        ),
      )
      val endpoint = gatewayEndpoint()
      val auth = auth(bootstrapToken = "bootstrap")
      val nodeSession = readField<GatewaySession>(runtime, "nodeSession")
      val lifecycleLock = readField<Any>(nodeSession, "lifecycleLock")
      val connectWithAuth =
        runtime.javaClass.declaredMethods.single { method ->
          method.name == "connectWithAuth" && method.parameterTypes.size == 3
        }
      connectWithAuth.isAccessible = true
      val lockHeld = CompletableDeferred<Unit>()
      val releaseLock = CompletableDeferred<Unit>()
      val lifecycleDispatcher = Executors.newFixedThreadPool(3).asCoroutineDispatcher()
      val workers = CoroutineScope(SupervisorJob() + lifecycleDispatcher)
      val lockHolder =
        workers.async {
          synchronized(lifecycleLock) {
            lockHeld.complete(Unit)
            runBlocking { releaseLock.await() }
          }
        }
      try {
        withTimeout(5_000) { lockHeld.await() }
        val connect = workers.async { connectWithAuth.invoke(runtime, endpoint, auth, { Unit }) }
        withTimeout(5_000) {
          while (readField<Int>(runtime, "gatewayConnectOperationsInFlight") == 0) delay(10)
        }
        val callback =
          workers.async {
            val method = runtime.javaClass.getDeclaredMethod("runGatewayConnectOperation", Function0::class.java)
            method.isAccessible = true
            method.invoke(runtime, { Unit })
          }
        withTimeout(1_000) { callback.await() }
        releaseLock.complete(Unit)
        withTimeout(5_000) {
          lockHolder.await()
          connect.await()
        }
        val request = gatewayServer.takeRequest(5, TimeUnit.SECONDS)
        assertNotNull("The runtime must reach the test-owned listener after lifecycle release", request)
        assertEquals("websocket", request!!.getHeader("Upgrade"))
        val frame = withTimeout(5_000) { connectFrame.await() }
        assertEquals("connect", frame["method"]?.jsonPrimitive?.content)
        val params = frame.getValue("params").jsonObject
        assertEquals("node", params["role"]?.jsonPrimitive?.content)
        assertEquals(
          "bootstrap",
          params
            .getValue("auth")
            .jsonObject["bootstrapToken"]
            ?.jsonPrimitive
            ?.content,
        )
      } finally {
        releaseLock.complete(Unit)
        try {
          workers.coroutineContext.job.cancelAndJoin()
        } finally {
          lifecycleDispatcher.close()
        }
      }
      Unit
    }

  @Test
  fun restoredManualMicWithoutRecordAudioClearsStalePreference() {
    val app = RuntimeEnvironment.getApplication()
    shadowOf(app).denyPermissions(Manifest.permission.RECORD_AUDIO)
    val prefs = testPrefs(app)
    prefs.setVoiceMicEnabled(true)

    val runtime = trackRuntime(NodeRuntime(app, prefs))

    assertEquals(VoiceCaptureMode.Off, runtime.voiceCaptureMode.value)
    assertFalse(prefs.voiceMicEnabled.value)
    assertFalse(readField<MutableStateFlow<Boolean>>(runtime, "externalAudioCaptureActive").value)
  }

  @Test
  fun revokedRecordAudioPermissionStopsGatewayPttBeforeMicStart() {
    val app = RuntimeEnvironment.getApplication()
    val runtime = createVoiceRuntime(app)
    val talkMode = readField<Lazy<TalkModeManager>>(runtime, "talkMode\$delegate").value
    writeField(talkMode, "activePttCaptureId", "capture-1")
    talkMode.ttsOnAllResponses = true
    readField<MutableStateFlow<Boolean>>(runtime, "externalAudioCaptureActive").value = true
    shadowOf(app).denyPermissions(Manifest.permission.RECORD_AUDIO)

    runtime.setMicEnabled(true)

    assertEquals(VoiceCaptureMode.Off, runtime.voiceCaptureMode.value)
    assertNull(talkMode.activePushToTalkCaptureId)
    assertFalse(talkMode.ttsOnAllResponses)
    assertFalse(readField<MutableStateFlow<Boolean>>(runtime, "externalAudioCaptureActive").value)
    assertFalse(runtime.prefs.voiceMicEnabled.value)
  }

  @Test
  @OptIn(ExperimentalCoroutinesApi::class)
  fun voiceNoteMicOwnershipBlocksLocalVoiceAndGatewayPtt() =
    runBlocking {
      val runtime = createVoiceRuntime()
      val dispatcher = readField<InvokeDispatcher>(runtime, "invokeDispatcher")
      Dispatchers.setMain(Dispatchers.Unconfined)
      try {
        assertTrue(runtime.tryAcquireVoiceNoteMic())

        runtime.setMicEnabled(true)
        runtime.setTalkModeEnabled(true)
        val ptt = dispatcher.handleInvoke(OpenClawTalkCommand.PttStart.rawValue, null)

        assertEquals(VoiceCaptureMode.Off, runtime.voiceCaptureMode.value)
        assertEquals("MIC_BUSY", ptt.error?.code)
        assertEquals("MIC_BUSY: voice note recording is active", ptt.error?.message)
        assertFalse(readField<MutableStateFlow<Boolean>>(runtime, "externalAudioCaptureActive").value)
      } finally {
        runtime.releaseVoiceNoteMic()
        Dispatchers.resetMain()
      }
    }

  @Test
  @OptIn(ExperimentalCoroutinesApi::class)
  fun dictationMicOwnershipBlocksLocalVoiceAndGatewayPtt() =
    runBlocking {
      val runtime = createVoiceRuntime()
      val dispatcher = readField<InvokeDispatcher>(runtime, "invokeDispatcher")
      Dispatchers.setMain(Dispatchers.Unconfined)
      try {
        assertTrue(runtime.tryAcquireDictationMic())

        runtime.setMicEnabled(true)
        runtime.setTalkModeEnabled(true)
        val ptt = dispatcher.handleInvoke(OpenClawTalkCommand.PttStart.rawValue, null)

        assertEquals(VoiceCaptureMode.Off, runtime.voiceCaptureMode.value)
        assertEquals("MIC_BUSY", ptt.error?.code)
        assertEquals("MIC_BUSY: dictation is active", ptt.error?.message)
        assertFalse(readField<MutableStateFlow<Boolean>>(runtime, "externalAudioCaptureActive").value)
      } finally {
        runtime.releaseDictationMic()
        Dispatchers.resetMain()
      }
    }

  @Test
  @OptIn(ExperimentalCoroutinesApi::class)
  fun talkPttStart_cleansPreparedCaptureWhenBeginFails() =
    runBlocking {
      val runtime = createVoiceRuntime()
      val dispatcher = readField<InvokeDispatcher>(runtime, "invokeDispatcher")
      Dispatchers.setMain(Dispatchers.Unconfined)
      try {
        val result = dispatcher.handleInvoke(OpenClawTalkCommand.PttStart.rawValue, null)

        assertEquals("UNAVAILABLE", result.error?.code)
        assertEquals(VoiceCaptureMode.Off, runtime.voiceCaptureMode.value)
        assertFalse(readField<MutableStateFlow<Boolean>>(runtime, "externalAudioCaptureActive").value)
        val talkMode = readField<Lazy<TalkModeManager>>(runtime, "talkMode\$delegate").value
        assertFalse(talkMode.ttsOnAllResponses)
      } finally {
        Dispatchers.resetMain()
      }
    }

  @Test
  fun talkPttStart_rejectsNewCaptureWhenBackgrounded() =
    runBlocking {
      val runtime = createVoiceRuntime()
      runtime.setForeground(false)
      val dispatcher = readField<InvokeDispatcher>(runtime, "invokeDispatcher")

      val result = dispatcher.handleInvoke(OpenClawTalkCommand.PttStart.rawValue, null)

      assertEquals("NODE_BACKGROUND_UNAVAILABLE", result.error?.code)
      assertEquals("NODE_BACKGROUND_UNAVAILABLE: command requires foreground", result.error?.message)
      assertEquals(VoiceCaptureMode.Off, runtime.voiceCaptureMode.value)
      assertFalse(readField<MutableStateFlow<Boolean>>(runtime, "externalAudioCaptureActive").value)
    }

  @Test
  fun staleTalkPttCleanupPreservesNewerManualMicOwnership() {
    val runtime = createVoiceRuntime()
    val ownershipEpoch = readField<AtomicLong>(runtime, "voiceCaptureOwnershipEpoch")
    ownershipEpoch.set(41L)

    runtime.setMicEnabled(true)
    val cleanup = runtime.javaClass.getDeclaredMethod("cleanupFailedTalkCapture", Long::class.javaPrimitiveType)
    cleanup.isAccessible = true
    cleanup.invoke(runtime, 41L)

    assertEquals(VoiceCaptureMode.ManualMic, runtime.voiceCaptureMode.value)
    assertTrue(readField<MutableStateFlow<Boolean>>(runtime, "externalAudioCaptureActive").value)
  }

  @Test
  fun talkPttOnceRetryReturnsBusyWithoutPreparingCapture() =
    runBlocking {
      val runtime = createVoiceRuntime()
      val talkMode = readField<Lazy<TalkModeManager>>(runtime, "talkMode\$delegate").value
      writeField(talkMode, "activePttCaptureId", "capture-1")
      val dispatcher = readField<InvokeDispatcher>(runtime, "invokeDispatcher")
      val preparationMutex = readField<Mutex>(runtime, "voiceCapturePreparationMutex")
      preparationMutex.lock()
      try {
        val retry =
          withTimeout(1_000) { dispatcher.handleInvoke(OpenClawTalkCommand.PttOnce.rawValue, null) }
        assertNull(retry.error)
        assertEquals("""{"captureId":"capture-1","status":"busy"}""", retry.payloadJson)
        assertEquals("capture-1", talkMode.activePushToTalkCaptureId)
        assertFalse(readField<MutableStateFlow<Boolean>>(runtime, "externalAudioCaptureActive").value)
      } finally {
        preparationMutex.unlock()
      }
    }

  @Test
  @OptIn(ExperimentalCoroutinesApi::class)
  fun talkPttOnceRechecksFinishingTurnAfterPreparationWait() =
    runBlocking {
      val runtime = createVoiceRuntime()
      val talkMode = readField<Lazy<TalkModeManager>>(runtime, "talkMode\$delegate").value
      val dispatcher = readField<InvokeDispatcher>(runtime, "invokeDispatcher")
      val preparationMutex = readField<Mutex>(runtime, "voiceCapturePreparationMutex")
      preparationMutex.lock()
      try {
        val request = async { dispatcher.handleInvoke(OpenClawTalkCommand.PttOnce.rawValue, null) }
        yield()
        writeField(talkMode, "finishingPttCaptureId", "capture-finishing")
        preparationMutex.unlock()

        val result = withTimeout(5_000) { request.await() }

        assertNull(result.error)
        assertEquals("""{"captureId":"capture-finishing","status":"busy"}""", result.payloadJson)
        assertFalse(readField<MutableStateFlow<Boolean>>(runtime, "externalAudioCaptureActive").value)
        assertEquals(VoiceCaptureMode.Off, runtime.voiceCaptureMode.value)
      } finally {
        if (preparationMutex.isLocked) preparationMutex.unlock()
      }
    }

  @Test
  fun talkPttStartRejectsFinishingTurnWithoutPreparingCapture() =
    runBlocking {
      val runtime = createVoiceRuntime()
      val talkMode = readField<Lazy<TalkModeManager>>(runtime, "talkMode\$delegate").value
      writeField(talkMode, "finishingPttCaptureId", "capture-1")
      val dispatcher = readField<InvokeDispatcher>(runtime, "invokeDispatcher")
      val preparationMutex = readField<Mutex>(runtime, "voiceCapturePreparationMutex")
      preparationMutex.lock()
      try {
        val retry =
          withTimeout(1_000) { dispatcher.handleInvoke(OpenClawTalkCommand.PttStart.rawValue, null) }

        assertEquals("PTT_BUSY", retry.error?.code)
        assertEquals("PTT_BUSY: previous push-to-talk turn is still finishing", retry.error?.message)
        assertFalse(readField<MutableStateFlow<Boolean>>(runtime, "externalAudioCaptureActive").value)
      } finally {
        preparationMutex.unlock()
      }
    }

  @Test
  @OptIn(ExperimentalCoroutinesApi::class)
  fun pttStartQueuedAfterCancelUsesNewCommandEpoch() =
    runBlocking {
      val runtime = createVoiceRuntime()
      val dispatcher = readField<InvokeDispatcher>(runtime, "invokeDispatcher")
      val preparationMutex = readField<Mutex>(runtime, "voiceCapturePreparationMutex")
      Dispatchers.setMain(Dispatchers.Unconfined)
      try {
        preparationMutex.lock()
        val cancel = async { dispatcher.handleInvoke(OpenClawTalkCommand.PttCancel.rawValue, null) }
        yield()
        val start = async { dispatcher.handleInvoke(OpenClawTalkCommand.PttStart.rawValue, null) }
        yield()
        preparationMutex.unlock()

        assertNull(withTimeout(5_000) { cancel.await() }.error)
        assertEquals("UNAVAILABLE", withTimeout(5_000) { start.await() }.error?.code)
        val talkMode = readField<Lazy<TalkModeManager>>(runtime, "talkMode\$delegate").value
        assertNull(talkMode.activePushToTalkCaptureId)
        assertFalse(readField<MutableStateFlow<Boolean>>(runtime, "externalAudioCaptureActive").value)
      } finally {
        if (preparationMutex.isLocked) preparationMutex.unlock()
        Dispatchers.resetMain()
      }
    }

  @Test
  @OptIn(ExperimentalCoroutinesApi::class)
  fun pttStartWaitingForPreparationIsInvalidatedByCancel() =
    runBlocking {
      val runtime = createVoiceRuntime()
      val dispatcher = readField<InvokeDispatcher>(runtime, "invokeDispatcher")
      val preparationMutex = readField<Mutex>(runtime, "voiceCapturePreparationMutex")
      Dispatchers.setMain(Dispatchers.Unconfined)
      preparationMutex.lock()
      try {
        val start = async { dispatcher.handleInvoke(OpenClawTalkCommand.PttStart.rawValue, null) }
        yield()
        val cancel = async { dispatcher.handleInvoke(OpenClawTalkCommand.PttCancel.rawValue, null) }
        yield()
        preparationMutex.unlock()

        assertEquals("NODE_BACKGROUND_UNAVAILABLE", withTimeout(5_000) { start.await() }.error?.code)
        assertNull(withTimeout(5_000) { cancel.await() }.error)
        val talkMode = readField<Lazy<TalkModeManager>>(runtime, "talkMode\$delegate").value
        assertNull(talkMode.activePushToTalkCaptureId)
        assertFalse(readField<MutableStateFlow<Boolean>>(runtime, "externalAudioCaptureActive").value)
      } finally {
        if (preparationMutex.isLocked) preparationMutex.unlock()
        Dispatchers.resetMain()
      }
    }

  @Test
  fun sameManualMicModeReassertsCaptureAndInvalidatesPendingPtt() {
    val runtime = createVoiceRuntime()
    runtime.setMicEnabled(true)
    val commandEpoch = readField<AtomicLong>(runtime, "talkPttCommandEpoch")
    val epochBeforeReassertion = commandEpoch.get()
    val micCapture = readField<Lazy<MicCaptureManager>>(runtime, "micCapture\$delegate").value
    val talkMode = readField<Lazy<TalkModeManager>>(runtime, "talkMode\$delegate").value
    micCapture.setMicEnabled(false)
    writeField(talkMode, "activePttCaptureId", "capture-stale")

    runtime.setMicEnabled(true)

    assertTrue(runtime.micEnabled.value)
    assertNull(talkMode.activePushToTalkCaptureId)
    assertTrue(commandEpoch.get() > epochBeforeReassertion)
    assertEquals(VoiceCaptureMode.ManualMic, runtime.voiceCaptureMode.value)
  }

  @Test
  fun backgroundingStopsTalkModeCapture() {
    val runtime = createTestRuntime(RuntimeEnvironment.getApplication())
    val talkMode = readField<Lazy<TalkModeManager>>(runtime, "talkMode\$delegate").value
    readField<MutableStateFlow<VoiceCaptureMode>>(runtime, "_voiceCaptureMode").value = VoiceCaptureMode.TalkMode
    readField<MutableStateFlow<Boolean>>(talkMode, "_isEnabled").value = true
    readField<MutableStateFlow<Boolean>>(runtime, "externalAudioCaptureActive").value = true
    talkMode.ttsOnAllResponses = true

    assertEquals(VoiceCaptureMode.TalkMode, runtime.voiceCaptureMode.value)
    assertTrue(talkMode.isEnabled.value)
    assertTrue(readField<MutableStateFlow<Boolean>>(runtime, "externalAudioCaptureActive").value)

    runtime.setForeground(false)

    assertEquals(VoiceCaptureMode.Off, runtime.voiceCaptureMode.value)
    assertFalse(talkMode.isEnabled.value)
    assertFalse(talkMode.ttsOnAllResponses)
    assertFalse(readField<MutableStateFlow<Boolean>>(runtime, "externalAudioCaptureActive").value)
  }

  @Test
  fun backgroundingStopsGatewayPttWhenVoiceModeIsOff() {
    val runtime = createVoiceRuntime()
    val talkMode = readField<Lazy<TalkModeManager>>(runtime, "talkMode\$delegate").value
    writeField(talkMode, "activePttCaptureId", "capture-1")
    readField<MutableStateFlow<Boolean>>(runtime, "externalAudioCaptureActive").value = true

    assertEquals(VoiceCaptureMode.Off, runtime.voiceCaptureMode.value)

    runtime.setForeground(false)

    assertNull(readField<String?>(talkMode, "activePttCaptureId"))
    assertEquals(VoiceCaptureMode.Off, runtime.voiceCaptureMode.value)
    assertFalse(readField<MutableStateFlow<Boolean>>(runtime, "externalAudioCaptureActive").value)
  }

  @Test
  fun coldStartAutoConnectConnectsSavedActiveGatewayWhenNoExplicitIntentExists() {
    val (runtime, prefs) = createNeutralizedRuntime()
    armSavedActiveManualGateway(prefs)

    invokeAutoConnectIfNeeded(runtime)

    val desired = waitForDesiredConnection(runtime, "nodeSession")
    assertEquals("127.0.0.1", readField<GatewayEndpoint>(desired, "endpoint").host)
    assertEquals("shared-token", readField<String?>(desired, "token"))
  }

  @Test
  fun coldStartAutoConnectStandsDownAfterExplicitLifecycleIntent() {
    val (runtime, prefs) = createNeutralizedRuntime()
    armSavedActiveManualGateway(prefs)
    runtime.disconnect()

    invokeAutoConnectIfNeeded(runtime)

    assertNull(desiredConnection(runtime, "nodeSession"))
  }

  // Arms the registry only after the runtime's startup work is neutralized, so the real
  // discovery collector can never observe an auto-connectable active gateway.
  private fun createNeutralizedRuntime(): Pair<NodeRuntime, SecurePrefs> {
    val app = RuntimeEnvironment.getApplication()
    val prefs = testPrefs(app)
    val runtime = trackRuntime(NodeRuntime(app, prefs))
    neutralizeColdStartAutoConnect(runtime)
    return runtime to prefs
  }

  private fun armSavedActiveManualGateway(prefs: SecurePrefs) {
    val savedEndpoint = gatewayEndpoint()
    prefs.setManualEnabled(true)
    prefs.setManualHost(savedEndpoint.host)
    prefs.setManualPort(savedEndpoint.port)
    prefs.setManualTls(false)
    prefs.gatewayRegistry.upsert(
      GatewayRegistryEntry(
        stableId = savedEndpoint.stableId,
        kind = GatewayRegistryEntryKind.MANUAL,
        name = savedEndpoint.name,
        host = savedEndpoint.host,
        port = savedEndpoint.port,
        tls = false,
      ),
    )
    prefs.gatewayRegistry.setActive(savedEndpoint.stableId)
    prefs.saveGatewayCredentials(savedEndpoint.stableId, token = "shared-token")
  }

  private fun invokeAutoConnectIfNeeded(runtime: NodeRuntime) {
    val method = runtime.javaClass.getDeclaredMethod("autoConnectIfNeeded")
    method.isAccessible = true
    method.invoke(runtime)
  }

  // NodeRuntime's init collects gateway discovery on a background dispatcher and auto-connects
  // the saved active gateway whenever that collector happens to run, racing scripted lifecycle
  // steps (observed as CI-only flakes on loaded Linux runners). Cancel and join startup jobs
  // before arming the registry, but keep the parent live for subsequent real session IO.
  private fun neutralizeColdStartAutoConnect(runtime: NodeRuntime) {
    runBlocking {
      val jobs = runtimes.single { it.runtime === runtime }.startupJobs
      jobs.forEach { it.cancel() }
      jobs.joinAll()
    }
  }

  private fun waitForGatewayTrustPrompt(runtime: NodeRuntime): NodeRuntime.GatewayTrustPrompt {
    repeat(50) {
      runtime.pendingGatewayTrust.value?.let { return it }
      Thread.sleep(10)
    }
    error("Expected pending gateway trust prompt")
  }

  private fun createTestRuntime(app: android.app.Application): NodeRuntime = trackRuntime(NodeRuntime(app, testPrefs(app)))

  private fun createVoiceRuntime(
    app: android.app.Application = RuntimeEnvironment.getApplication(),
  ): NodeRuntime {
    shadowOf(app).grantPermissions(Manifest.permission.RECORD_AUDIO)
    return createTestRuntime(app)
  }

  private fun testPrefs(app: android.app.Application): SecurePrefs =
    SecurePrefs(
      app,
      app.getSharedPreferences(
        "openclaw.node.secure.test.${UUID.randomUUID()}",
        android.content.Context.MODE_PRIVATE,
      ),
    )

  private data class GatewayFixture(
    val app: android.app.Application,
    val prefs: SecurePrefs,
    val runtime: NodeRuntime,
  )

  private fun gatewayFixture(
    tlsFingerprintProbe: (suspend (String, Int) -> GatewayTlsProbeResult)? = null,
  ): GatewayFixture {
    val app: android.app.Application = RuntimeEnvironment.getApplication()
    val prefs = testPrefs(app)
    val runtime =
      tlsFingerprintProbe?.let { NodeRuntime(app, prefs, tlsFingerprintProbe = it) }
        ?: NodeRuntime(app, prefs)
    return GatewayFixture(app, prefs, trackRuntime(runtime))
  }

  private fun auth(
    token: String? = null,
    bootstrapToken: String? = null,
    password: String? = null,
  ): NodeRuntime.GatewayConnectAuth = NodeRuntime.GatewayConnectAuth(token, bootstrapToken, password)

  private fun operatorAuth(
    auth: NodeRuntime.GatewayConnectAuth,
    storedToken: String? = null,
  ): NodeRuntime.GatewayConnectAuth? = resolveOperatorSessionConnectAuth(auth, storedToken)

  private fun usesStoredOperatorToken(auth: NodeRuntime.GatewayConnectAuth): Boolean = operatorSessionUsesStoredDeviceToken(auth, "stored-token")

  private fun desiredBootstrapToken(
    runtime: NodeRuntime,
    sessionFieldName: String,
  ): String? {
    val desired = desiredConnection(runtime, sessionFieldName) ?: return null
    return readField(desired, "bootstrapToken")
  }

  private fun desiredConnection(
    runtime: NodeRuntime,
    sessionFieldName: String,
  ): Any? {
    val session = readField<GatewaySession>(runtime, sessionFieldName)
    return readField(session, "desired")
  }

  private fun waitForDesiredConnection(
    runtime: NodeRuntime,
    sessionFieldName: String,
  ): Any {
    repeat(50) {
      desiredConnection(runtime, sessionFieldName)?.let { return it }
      Thread.sleep(10)
    }
    error("Expected desired connection for $sessionFieldName")
  }

  private fun writeField(
    target: Any,
    name: String,
    value: Any?,
  ) {
    findTestField(target, name).set(target, value)
  }

  private fun waitForDesiredBootstrapToken(
    runtime: NodeRuntime,
    sessionFieldName: String,
  ): String {
    var lastObserved: String? = null
    repeat(50) {
      desiredBootstrapToken(runtime, sessionFieldName)?.let { token ->
        lastObserved = token
        return token
      }
      Thread.sleep(10)
    }
    error("Expected desired bootstrap token for $sessionFieldName; last observed=$lastObserved")
  }

  private fun <T> readField(
    target: Any,
    name: String,
  ): T {
    @Suppress("UNCHECKED_CAST")
    return findTestField(target, name).get(target) as T
  }

  private class RecordingTranscriptCache : ChatTranscriptCache {
    val clearedGatewayIds = mutableListOf<String>()

    override suspend fun loadLastDefaultAgentId(gatewayId: String): String? = null

    override suspend fun saveLastDefaultAgentId(
      gatewayId: String,
      agentId: String,
    ) = Unit

    override suspend fun loadSessions(
      gatewayId: String,
      agentId: String,
    ): List<ChatSessionEntry> = emptyList()

    override suspend fun loadTranscript(
      gatewayId: String,
      agentId: String,
      sessionKey: String,
    ): List<ChatMessage> = emptyList()

    override suspend fun saveSessions(
      gatewayId: String,
      agentId: String,
      sessions: List<ChatSessionEntry>,
      retainedSessionKey: String?,
    ) = Unit

    override suspend fun saveTranscript(
      gatewayId: String,
      agentId: String,
      sessionKey: String,
      messages: List<ChatMessage>,
    ) = Unit

    override suspend fun deleteSession(
      gatewayId: String,
      agentId: String,
      sessionKey: String,
    ) = Unit

    override suspend fun clearGateway(gatewayId: String) {
      clearedGatewayIds += gatewayId
    }
  }
}

internal fun findTestField(
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
