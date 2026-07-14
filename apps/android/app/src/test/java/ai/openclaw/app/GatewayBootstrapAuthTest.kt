package ai.openclaw.app

import ai.openclaw.app.gateway.DeviceAuthStore
import ai.openclaw.app.gateway.DeviceIdentityStore
import ai.openclaw.app.gateway.GatewayConnectErrorDetails
import ai.openclaw.app.gateway.GatewayConnectOptions
import ai.openclaw.app.gateway.GatewayEndpoint
import ai.openclaw.app.gateway.GatewayRegistryEntry
import ai.openclaw.app.gateway.GatewayRegistryEntryKind
import ai.openclaw.app.gateway.GatewaySession
import ai.openclaw.app.gateway.GatewayTlsProbeFailure
import ai.openclaw.app.gateway.GatewayTlsProbeResult
import ai.openclaw.app.node.ConnectionManager
import ai.openclaw.app.node.InvokeDispatcher
import ai.openclaw.app.protocol.OpenClawCameraCommand
import ai.openclaw.app.protocol.OpenClawLocationCommand
import ai.openclaw.app.protocol.OpenClawTalkCommand
import ai.openclaw.app.voice.MicCaptureManager
import ai.openclaw.app.voice.TalkModeManager
import android.Manifest
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.Job
import kotlinx.coroutines.asCoroutineDispatcher
import kotlinx.coroutines.async
import kotlinx.coroutines.cancelAndJoin
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.test.resetMain
import kotlinx.coroutines.test.setMain
import kotlinx.coroutines.withTimeout
import kotlinx.coroutines.yield
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import org.robolectric.Shadows.shadowOf
import org.robolectric.annotation.Config
import java.lang.reflect.Field
import java.util.UUID
import java.util.concurrent.Executors
import java.util.concurrent.atomic.AtomicLong

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34])
class GatewayBootstrapAuthTest {
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
          GatewayConnectErrorDetails(
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
          GatewayConnectErrorDetails(
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
    assertFalse(
      resolveOperatorSessionConnectAuth(
        NodeRuntime.GatewayConnectAuth(token = "", bootstrapToken = "bootstrap-1", password = ""),
        storedOperatorToken = "",
      ) != null,
    )
    assertFalse(
      resolveOperatorSessionConnectAuth(
        NodeRuntime.GatewayConnectAuth(token = null, bootstrapToken = "bootstrap-1", password = null),
        storedOperatorToken = null,
      ) != null,
    )
  }

  @Test
  fun connectsOperatorSessionWhenSharedPasswordOrStoredAuthExists() {
    assertTrue(
      resolveOperatorSessionConnectAuth(
        NodeRuntime.GatewayConnectAuth(token = "shared-token", bootstrapToken = "bootstrap-1", password = null),
        storedOperatorToken = null,
      ) != null,
    )
    assertTrue(
      resolveOperatorSessionConnectAuth(
        NodeRuntime.GatewayConnectAuth(token = null, bootstrapToken = "bootstrap-1", password = "shared-password"),
        storedOperatorToken = null,
      ) != null,
    )
    assertTrue(
      resolveOperatorSessionConnectAuth(
        NodeRuntime.GatewayConnectAuth(token = null, bootstrapToken = "bootstrap-1", password = null),
        storedOperatorToken = "stored-token",
      ) != null,
    )
    assertTrue(
      resolveOperatorSessionConnectAuth(
        NodeRuntime.GatewayConnectAuth(token = null, bootstrapToken = "", password = null),
        storedOperatorToken = null,
      ) != null,
    )
  }

  @Test
  fun resolveOperatorSessionConnectAuthUsesStoredTokenPathAfterBootstrapHandoff() {
    val resolved =
      resolveOperatorSessionConnectAuth(
        auth = NodeRuntime.GatewayConnectAuth(token = null, bootstrapToken = "bootstrap-1", password = null),
        storedOperatorToken = "stored-token",
      )

    assertEquals(NodeRuntime.GatewayConnectAuth(token = null, bootstrapToken = null, password = null), resolved)
  }

  @Test
  fun resolveOperatorSessionConnectAuthIgnoresBootstrapWhenNoStoredOperatorTokenExists() {
    val resolved =
      resolveOperatorSessionConnectAuth(
        auth = NodeRuntime.GatewayConnectAuth(token = null, bootstrapToken = "bootstrap-1", password = null),
        storedOperatorToken = null,
      )

    assertNull(resolved)
  }

  @Test
  fun resolveOperatorSessionConnectAuthUsesNoAuthWhenGatewayHasNoAuth() {
    val resolved =
      resolveOperatorSessionConnectAuth(
        auth = NodeRuntime.GatewayConnectAuth(token = null, bootstrapToken = null, password = null),
        storedOperatorToken = null,
      )

    assertEquals(NodeRuntime.GatewayConnectAuth(token = null, bootstrapToken = null, password = null), resolved)
  }

  @Test
  fun resolveOperatorSessionConnectAuthPrefersExplicitSharedAuth() {
    val resolved =
      resolveOperatorSessionConnectAuth(
        auth = NodeRuntime.GatewayConnectAuth(token = "shared-token", bootstrapToken = "bootstrap-1", password = "shared-password"),
        storedOperatorToken = "stored-token",
      )

    assertEquals(
      NodeRuntime.GatewayConnectAuth(token = "shared-token", bootstrapToken = null, password = null),
      resolved,
    )
  }

  @Test
  fun resolveGatewayControlPageAuthFallsBackToStoredOperatorToken() {
    val resolved =
      resolveGatewayControlPageAuth(
        auth = NodeRuntime.GatewayConnectAuth(token = null, bootstrapToken = "bootstrap-1", password = null),
        storedOperatorToken = " stored-token ",
      )

    assertEquals(
      NodeRuntime.GatewayConnectAuth(token = "stored-token", bootstrapToken = null, password = null),
      resolved,
    )
  }

  @Test
  fun resolveGatewayControlPageAuthPrefersExplicitSharedAuth() {
    assertEquals(
      NodeRuntime.GatewayConnectAuth(token = "shared-token", bootstrapToken = null, password = null),
      resolveGatewayControlPageAuth(
        auth =
          NodeRuntime.GatewayConnectAuth(
            token = " shared-token ",
            bootstrapToken = "bootstrap-1",
            password = "shared-password",
          ),
        storedOperatorToken = "stored-token",
      ),
    )
    assertEquals(
      NodeRuntime.GatewayConnectAuth(token = null, bootstrapToken = null, password = "shared-password"),
      resolveGatewayControlPageAuth(
        auth =
          NodeRuntime.GatewayConnectAuth(
            token = null,
            bootstrapToken = "bootstrap-1",
            password = " shared-password ",
          ),
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
    assertTrue(
      operatorSessionUsesStoredDeviceToken(
        auth = NodeRuntime.GatewayConnectAuth(token = null, bootstrapToken = "bootstrap-1", password = null),
        storedOperatorToken = "stored-token",
      ),
    )
    assertFalse(
      operatorSessionUsesStoredDeviceToken(
        auth = NodeRuntime.GatewayConnectAuth(token = "shared-token", bootstrapToken = null, password = null),
        storedOperatorToken = "stored-token",
      ),
    )
    assertFalse(
      operatorSessionUsesStoredDeviceToken(
        auth = NodeRuntime.GatewayConnectAuth(token = null, bootstrapToken = null, password = "password"),
        storedOperatorToken = "stored-token",
      ),
    )
  }

  @Test
  fun nodeConnectStartsOperatorAfterBootstrapHandoffWhenOperatorWasConnecting() {
    val app = RuntimeEnvironment.getApplication()
    val securePrefs =
      app.getSharedPreferences(
        "openclaw.node.secure.test.${UUID.randomUUID()}",
        android.content.Context.MODE_PRIVATE,
      )
    val prefs = SecurePrefs(app, securePrefsOverride = securePrefs)
    val runtime = NodeRuntime(app, prefs)
    val deviceId = DeviceIdentityStore(app).loadOrCreate().deviceId
    val endpoint = GatewayEndpoint.manual(host = "127.0.0.1", port = 18789)
    DeviceAuthStore(prefs).saveToken(endpoint.stableId, deviceId, "operator", "bootstrap-operator-token")

    writeField(runtime, "operatorStatusText", "Connecting…")
    invokeMaybeStartOperatorSessionAfterNodeConnect(
      runtime = runtime,
      endpoint = endpoint,
      auth = NodeRuntime.GatewayConnectAuth(token = null, bootstrapToken = "setup-bootstrap-token", password = null),
    )

    val desired = desiredConnection(runtime, "operatorSession")
    assertNotNull(desired)
    assertNull(readField<String?>(desired!!, "bootstrapToken"))
  }

  @Test
  fun resolveGatewayConnectAuth_prefersExplicitSetupAuthOverStoredPrefs() {
    val app = RuntimeEnvironment.getApplication()
    val securePrefs =
      app.getSharedPreferences(
        "openclaw.node.secure.test.${UUID.randomUUID()}",
        android.content.Context.MODE_PRIVATE,
      )
    val prefs = SecurePrefs(app, securePrefsOverride = securePrefs)
    val endpoint = GatewayEndpoint.manual("gateway.example", 18789)
    prefs.saveGatewayCredentials(endpoint.stableId, token = "stale-shared-token", password = "stale-password")
    val runtime = NodeRuntime(app, prefs)

    val auth =
      runtime.resolveGatewayConnectAuth(
        endpoint,
        NodeRuntime.GatewayConnectAuth(
          token = null,
          bootstrapToken = "setup-bootstrap-token",
          password = null,
        ),
      )

    assertNull(auth.token)
    assertEquals("setup-bootstrap-token", auth.bootstrapToken)
    assertNull(auth.password)
  }

  @Test
  fun acceptGatewayTrustPrompt_preservesExplicitSetupAuth() =
    runBlocking {
      val app = RuntimeEnvironment.getApplication()
      val securePrefs =
        app.getSharedPreferences(
          "openclaw.node.secure.test.${UUID.randomUUID()}",
          android.content.Context.MODE_PRIVATE,
        )
      val prefs = SecurePrefs(app, securePrefsOverride = securePrefs)
      val endpoint = GatewayEndpoint.manual(host = "gateway.example", port = 18789)
      prefs.saveGatewayCredentials(endpoint.stableId, token = "stale-shared-token", password = "stale-password")
      val runtime =
        NodeRuntime(
          app,
          prefs,
          tlsFingerprintProbe = { _, _ -> GatewayTlsProbeResult(fingerprintSha256 = "fp:1") },
        )
      val explicitAuth =
        NodeRuntime.GatewayConnectAuth(
          token = null,
          bootstrapToken = "setup-bootstrap-token",
          password = null,
        )

      runtime.connect(endpoint, explicitAuth)
      val prompt = waitForGatewayTrustPrompt(runtime)
      assertEquals("setup-bootstrap-token", prompt.auth.bootstrapToken)

      runtime.acceptGatewayTrustPrompt()

      assertEquals("f1", prefs.loadGatewayTlsFingerprint(endpoint.stableId))
      assertEquals("setup-bootstrap-token", waitForDesiredBootstrapToken(runtime, "nodeSession"))
      assertNull(desiredBootstrapToken(runtime, "operatorSession"))
    }

  @Test
  fun connect_promptsBeforeReplacingChangedTlsFingerprint() =
    runBlocking {
      val app = RuntimeEnvironment.getApplication()
      val securePrefs =
        app.getSharedPreferences(
          "openclaw.node.secure.test.${UUID.randomUUID()}",
          android.content.Context.MODE_PRIVATE,
        )
      val prefs = SecurePrefs(app, securePrefsOverride = securePrefs)
      val endpoint = GatewayEndpoint.manual(host = "gateway.example", port = 18789)
      prefs.saveGatewayTlsFingerprint(endpoint.stableId, "sha256:aa:aa:aa:aa")
      val runtime =
        NodeRuntime(
          app,
          prefs,
          tlsFingerprintProbe = { _, _ -> GatewayTlsProbeResult(fingerprintSha256 = "sha256:bb:bb:bb:bb") },
        )

      runtime.connect(
        endpoint,
        NodeRuntime.GatewayConnectAuth(token = "shared-token", bootstrapToken = null, password = null),
      )

      val prompt = waitForGatewayTrustPrompt(runtime)
      assertEquals("aaaaaaaa", prompt.previousFingerprintSha256)
      assertEquals("bbbbbbbb", prompt.fingerprintSha256)
      assertEquals("sha256:aa:aa:aa:aa", prefs.loadGatewayTlsFingerprint(endpoint.stableId))

      runtime.declineGatewayTrustPrompt()

      assertEquals("sha256:aa:aa:aa:aa", prefs.loadGatewayTlsFingerprint(endpoint.stableId))

      runtime.connect(
        endpoint,
        NodeRuntime.GatewayConnectAuth(token = "shared-token", bootstrapToken = null, password = null),
      )
      waitForGatewayTrustPrompt(runtime)
      runtime.acceptGatewayTrustPrompt()

      assertEquals("bbbbbbbb", prefs.loadGatewayTlsFingerprint(endpoint.stableId))
    }

  @Test
  fun connect_ignoresStaleTlsProbeAfterDisconnect() =
    runBlocking {
      val app = RuntimeEnvironment.getApplication()
      val securePrefs =
        app.getSharedPreferences(
          "openclaw.node.secure.test.${UUID.randomUUID()}",
          android.content.Context.MODE_PRIVATE,
        )
      val prefs = SecurePrefs(app, securePrefsOverride = securePrefs)
      val endpoint = GatewayEndpoint.manual(host = "gateway.example", port = 18789)
      prefs.saveGatewayTlsFingerprint(endpoint.stableId, "aaaaaaaa")
      val probeStarted = CompletableDeferred<Unit>()
      val probeResult = CompletableDeferred<GatewayTlsProbeResult>()
      val runtime =
        NodeRuntime(
          app,
          prefs,
          tlsFingerprintProbe = { _, _ ->
            probeStarted.complete(Unit)
            probeResult.await()
          },
        )
      val runtimeScope = readField<CoroutineScope>(runtime, "scope")
      val existingJobs =
        runtimeScope.coroutineContext[Job]
          ?.children
          ?.toSet()
          .orEmpty()

      runtime.connect(
        endpoint,
        NodeRuntime.GatewayConnectAuth(token = "shared-token", bootstrapToken = null, password = null),
      )
      probeStarted.await()
      val probeJob =
        runtimeScope.coroutineContext[Job]
          ?.children
          ?.singleOrNull { it !in existingJobs }
          ?: error("Expected one TLS probe job")

      runtime.disconnect()
      probeResult.complete(GatewayTlsProbeResult(fingerprintSha256 = "aaaaaaaa"))
      // Join the owning coroutine so assertions run after its stale-attempt guard.
      probeJob.join()

      assertNull(runtime.pendingGatewayTrust.value)
      assertNull(desiredBootstrapToken(runtime, "nodeSession"))
      assertEquals("aaaaaaaa", prefs.loadGatewayTlsFingerprint(endpoint.stableId))
    }

  @Test
  fun forgetGatewayCancelsInFlightTlsProbeBeforePurgingAuth() =
    runBlocking {
      val app = RuntimeEnvironment.getApplication()
      val securePrefs =
        app.getSharedPreferences(
          "openclaw.node.secure.test.${UUID.randomUUID()}",
          android.content.Context.MODE_PRIVATE,
        )
      val prefs = SecurePrefs(app, securePrefsOverride = securePrefs)
      val endpoint = GatewayEndpoint.manual(host = "gateway.example", port = 18789)
      val probeStarted = CompletableDeferred<Unit>()
      val probeResult = CompletableDeferred<GatewayTlsProbeResult>()
      val runtime =
        NodeRuntime(
          app,
          prefs,
          tlsFingerprintProbe = { _, _ ->
            probeStarted.complete(Unit)
            probeResult.await()
          },
        )
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
      probeResult.complete(GatewayTlsProbeResult(fingerprintSha256 = "aaaaaaaa"))
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
      GatewayEndpoint.manual(host = "127.0.0.1", port = 18789),
      NodeRuntime.GatewayConnectAuth(token = "initial-token", bootstrapToken = null, password = null),
    )
    runtime.disconnect()
    assertNull(desiredConnection(runtime, "nodeSession"))

    runtime.refreshGatewayConnection()

    val desired = waitForDesiredConnection(runtime, "nodeSession")
    val endpoint = readField<GatewayEndpoint>(desired, "endpoint")
    assertEquals("127.0.0.1", endpoint.host)
    assertEquals(18789, endpoint.port)
    assertEquals("shared-token", readField<String?>(desired, "token"))
  }

  @Test
  fun foregroundAfterExplicitDisconnectStaysOfflineUntilExplicitReconnect() {
    val (runtime, prefs) = createNeutralizedRuntime()
    armSavedActiveManualGateway(prefs)

    runtime.connect(GatewayEndpoint.manual(host = "127.0.0.1", port = 18789))
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
    val endpoint = GatewayEndpoint.manual(host = "127.0.0.1", port = 18789)
    writeField(runtime, "connectedEndpoint", endpoint)

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
  fun connect_showsSecureEndpointGuidanceWhenTlsProbeFails() {
    val app = RuntimeEnvironment.getApplication()
    val runtime =
      NodeRuntime(
        app,
        SecurePrefs(
          app,
          app.getSharedPreferences("openclaw.node.secure.test.${UUID.randomUUID()}", android.content.Context.MODE_PRIVATE),
        ),
        tlsFingerprintProbe = { _, _ ->
          GatewayTlsProbeResult(failure = GatewayTlsProbeFailure.TLS_UNAVAILABLE)
        },
      )

    runtime.connect(
      GatewayEndpoint.manual(host = "gateway.example", port = 18789),
      NodeRuntime.GatewayConnectAuth(token = "shared-token", bootstrapToken = null, password = null),
    )

    assertEquals(
      "Failed: no secure gateway endpoint was detected. Enable gateway TLS or Tailscale Serve, or use a trusted private LAN address with Unencrypted selected.",
      waitForStatusText(runtime),
    )
    assertNull(runtime.pendingGatewayTrust.value)
  }

  @Test
  fun connect_showsTlsTimeoutGuidanceWhenFingerprintProbeTimesOut() {
    val app = RuntimeEnvironment.getApplication()
    val runtime =
      NodeRuntime(
        app,
        SecurePrefs(
          app,
          app.getSharedPreferences("openclaw.node.secure.test.${UUID.randomUUID()}", android.content.Context.MODE_PRIVATE),
        ),
        tlsFingerprintProbe = { _, _ ->
          GatewayTlsProbeResult(failure = GatewayTlsProbeFailure.TLS_HANDSHAKE_TIMEOUT)
        },
      )

    runtime.connect(
      GatewayEndpoint.manual(host = "gateway.example", port = 18789),
      NodeRuntime.GatewayConnectAuth(token = "shared-token", bootstrapToken = null, password = null),
    )

    assertEquals(
      "Failed: secure endpoint reached, but TLS fingerprint verification timed out. Check Tailscale Serve or gateway TLS and retry.",
      waitForStatusText(runtime),
    )
    assertNull(runtime.pendingGatewayTrust.value)
  }

  @Test
  fun resetGatewaySetupAuth_clearsOnlyTargetGatewayCredentialsAndDeviceTokens() =
    runBlocking {
      val app = RuntimeEnvironment.getApplication()
      val securePrefs =
        app.getSharedPreferences(
          "openclaw.node.secure.test.${UUID.randomUUID()}",
          android.content.Context.MODE_PRIVATE,
        )
      val prefs = SecurePrefs(app, securePrefsOverride = securePrefs)
      val runtime = NodeRuntime(app, prefs)
      val deviceId = DeviceIdentityStore(app).loadOrCreate().deviceId
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
  fun switchToUndiscoveredGatewayKeepsCurrentConnectionAndActiveGateway() {
    val app = RuntimeEnvironment.getApplication()
    val securePrefs =
      app.getSharedPreferences(
        "openclaw.node.secure.test.${UUID.randomUUID()}",
        android.content.Context.MODE_PRIVATE,
      )
    val prefs = SecurePrefs(app, securePrefsOverride = securePrefs)
    val runtime = NodeRuntime(app, prefs)
    neutralizeColdStartAutoConnect(runtime)
    val current = GatewayEndpoint.manual("127.0.0.1", 18789)
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
      val securePrefs =
        app.getSharedPreferences(
          "openclaw.node.secure.test.${UUID.randomUUID()}",
          android.content.Context.MODE_PRIVATE,
        )
      val runtime = NodeRuntime(app, SecurePrefs(app, securePrefsOverride = securePrefs))
      val endpoint = GatewayEndpoint.manual("127.0.0.1", 18789)
      val auth = NodeRuntime.GatewayConnectAuth(token = null, bootstrapToken = "bootstrap", password = null)
      val nodeSession = readField<GatewaySession>(runtime, "nodeSession")
      val lifecycleLock = readField<Any>(nodeSession, "lifecycleLock")
      val connectWithAuth =
        runtime.javaClass.declaredMethods.single { method ->
          method.name == "connectWithAuth" && method.parameterTypes.size == 4
        }
      connectWithAuth.isAccessible = true
      val lockHeld = CompletableDeferred<Unit>()
      val releaseLock = CompletableDeferred<Unit>()
      val lifecycleDispatcher = Executors.newFixedThreadPool(3).asCoroutineDispatcher()
      val lockHolder =
        async(lifecycleDispatcher) {
          synchronized(lifecycleLock) {
            lockHeld.complete(Unit)
            runBlocking { releaseLock.await() }
          }
        }
      lockHeld.await()

      val connect =
        async(lifecycleDispatcher) {
          connectWithAuth.invoke(runtime, endpoint, auth, false, { Unit })
        }
      try {
        withTimeout(5_000) {
          while (readField<Int>(runtime, "gatewayConnectOperationsInFlight") == 0) delay(10)
        }
        val callback =
          async(lifecycleDispatcher) {
            val method =
              runtime.javaClass.getDeclaredMethod(
                "maybeStartOperatorSessionAfterNodeConnect",
                GatewayEndpoint::class.java,
                NodeRuntime.GatewayConnectAuth::class.java,
              )
            method.isAccessible = true
            method.invoke(runtime, endpoint, auth)
          }
        withTimeout(1_000) { callback.await() }
      } finally {
        releaseLock.complete(Unit)
        try {
          withTimeout(5_000) {
            lockHolder.await()
            connect.await()
          }
        } finally {
          lifecycleDispatcher.close()
          runtime.disconnect()
          readField<CoroutineScope>(runtime, "scope").coroutineContext[Job]?.cancel()
        }
      }
      Unit
    }

  @Test
  fun restoredManualMicWithoutRecordAudioClearsStalePreference() {
    val app = RuntimeEnvironment.getApplication()
    shadowOf(app).denyPermissions(Manifest.permission.RECORD_AUDIO)
    val securePrefs =
      app.getSharedPreferences(
        "openclaw.node.secure.test.${UUID.randomUUID()}",
        android.content.Context.MODE_PRIVATE,
      )
    val prefs = SecurePrefs(app, securePrefsOverride = securePrefs)
    prefs.setVoiceMicEnabled(true)

    val runtime = NodeRuntime(app, prefs)

    assertEquals(VoiceCaptureMode.Off, runtime.voiceCaptureMode.value)
    assertFalse(prefs.voiceMicEnabled.value)
    assertFalse(readField<MutableStateFlow<Boolean>>(runtime, "externalAudioCaptureActive").value)
  }

  @Test
  fun revokedRecordAudioPermissionStopsGatewayPttBeforeMicStart() {
    val app = RuntimeEnvironment.getApplication()
    shadowOf(app).grantPermissions(Manifest.permission.RECORD_AUDIO)
    val runtime = createTestRuntime(app)
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
      val app = RuntimeEnvironment.getApplication()
      shadowOf(app).grantPermissions(Manifest.permission.RECORD_AUDIO)
      val runtime = createTestRuntime(app)
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
  fun talkPttStart_cleansPreparedCaptureWhenBeginFails() =
    runBlocking {
      val app = RuntimeEnvironment.getApplication()
      shadowOf(app).grantPermissions(Manifest.permission.RECORD_AUDIO)
      val runtime = createTestRuntime(app)
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
      val app = RuntimeEnvironment.getApplication()
      shadowOf(app).grantPermissions(Manifest.permission.RECORD_AUDIO)
      val runtime = createTestRuntime(app)
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
    val app = RuntimeEnvironment.getApplication()
    shadowOf(app).grantPermissions(Manifest.permission.RECORD_AUDIO)
    val runtime = createTestRuntime(app)
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
      val app = RuntimeEnvironment.getApplication()
      shadowOf(app).grantPermissions(Manifest.permission.RECORD_AUDIO)
      val runtime = createTestRuntime(app)
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
      val app = RuntimeEnvironment.getApplication()
      shadowOf(app).grantPermissions(Manifest.permission.RECORD_AUDIO)
      val runtime = createTestRuntime(app)
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
      val app = RuntimeEnvironment.getApplication()
      shadowOf(app).grantPermissions(Manifest.permission.RECORD_AUDIO)
      val runtime = createTestRuntime(app)
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
      val app = RuntimeEnvironment.getApplication()
      shadowOf(app).grantPermissions(Manifest.permission.RECORD_AUDIO)
      val runtime = createTestRuntime(app)
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
      val app = RuntimeEnvironment.getApplication()
      shadowOf(app).grantPermissions(Manifest.permission.RECORD_AUDIO)
      val runtime = createTestRuntime(app)
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
    val app = RuntimeEnvironment.getApplication()
    shadowOf(app).grantPermissions(Manifest.permission.RECORD_AUDIO)
    val runtime = createTestRuntime(app)
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
  fun sameTalkModeReassertionStopsManualMicCapture() {
    val app = RuntimeEnvironment.getApplication()
    shadowOf(app).grantPermissions(Manifest.permission.RECORD_AUDIO)
    val runtime = createTestRuntime(app)
    readField<CoroutineScope>(runtime, "scope").coroutineContext[Job]?.cancel()
    runtime.setTalkModeEnabled(true)
    val micCapture = readField<Lazy<MicCaptureManager>>(runtime, "micCapture\$delegate").value
    micCapture.setMicEnabled(true)

    runtime.setTalkModeEnabled(true)

    assertFalse(runtime.micEnabled.value)
    assertEquals(VoiceCaptureMode.TalkMode, runtime.voiceCaptureMode.value)
    val talkMode = readField<Lazy<TalkModeManager>>(runtime, "talkMode\$delegate").value
    assertTrue(talkMode.isEnabled.value)
  }

  @Test
  fun backgroundingStopsTalkModeCapture() {
    val app = RuntimeEnvironment.getApplication()
    val runtime = createTestRuntime(app)
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
    val app = RuntimeEnvironment.getApplication()
    shadowOf(app).grantPermissions(Manifest.permission.RECORD_AUDIO)
    val runtime = createTestRuntime(app)
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

    val desired = desiredConnection(runtime, "nodeSession") ?: error("Expected desired node connection")
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

  // Arms the registry only after the runtime's background work is neutralized, so the real
  // discovery collector can never observe an auto-connectable active gateway.
  private fun createNeutralizedRuntime(): Pair<NodeRuntime, SecurePrefs> {
    val app = RuntimeEnvironment.getApplication()
    val securePrefs =
      app.getSharedPreferences(
        "openclaw.node.secure.test.${UUID.randomUUID()}",
        android.content.Context.MODE_PRIVATE,
      )
    val prefs = SecurePrefs(app, securePrefsOverride = securePrefs)
    val runtime = NodeRuntime(app, prefs)
    neutralizeColdStartAutoConnect(runtime)
    return runtime to prefs
  }

  private fun armSavedActiveManualGateway(prefs: SecurePrefs) {
    prefs.setManualEnabled(true)
    prefs.setManualHost("127.0.0.1")
    prefs.setManualPort(18789)
    prefs.setManualTls(false)
    val savedEndpoint = GatewayEndpoint.manual(host = "127.0.0.1", port = 18789)
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
  // steps (observed as CI-only flakes on loaded Linux runners). Cancel and join all runtime-scope
  // work so nothing runs in the background; arm the registry only afterwards.
  private fun neutralizeColdStartAutoConnect(runtime: NodeRuntime) {
    runBlocking { readField<CoroutineScope>(runtime, "scope").coroutineContext[Job]?.cancelAndJoin() }
  }

  private fun waitForGatewayTrustPrompt(runtime: NodeRuntime): NodeRuntime.GatewayTrustPrompt {
    repeat(50) {
      runtime.pendingGatewayTrust.value?.let { return it }
      Thread.sleep(10)
    }
    error("Expected pending gateway trust prompt")
  }

  private fun createTestRuntime(app: android.app.Application): NodeRuntime {
    val securePrefs =
      app.getSharedPreferences(
        "openclaw.node.secure.test.${UUID.randomUUID()}",
        android.content.Context.MODE_PRIVATE,
      )
    return NodeRuntime(app, SecurePrefs(app, securePrefsOverride = securePrefs))
  }

  private fun waitForStatusText(runtime: NodeRuntime): String {
    repeat(50) {
      val status = runtime.statusText.value
      if (status != "Verify gateway TLS fingerprint…") {
        return status
      }
      Thread.sleep(10)
    }
    error("Expected status text update")
  }

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

  private fun invokeMaybeStartOperatorSessionAfterNodeConnect(
    runtime: NodeRuntime,
    endpoint: GatewayEndpoint,
    auth: NodeRuntime.GatewayConnectAuth,
  ) {
    val method =
      runtime.javaClass.getDeclaredMethod(
        "maybeStartOperatorSessionAfterNodeConnect",
        GatewayEndpoint::class.java,
        NodeRuntime.GatewayConnectAuth::class.java,
      )
    method.isAccessible = true
    method.invoke(runtime, endpoint, auth)
  }

  private fun writeField(
    target: Any,
    name: String,
    value: Any?,
  ) {
    var type: Class<*>? = target.javaClass
    while (type != null) {
      try {
        val field: Field = type.getDeclaredField(name)
        field.isAccessible = true
        field.set(target, value)
        return
      } catch (_: NoSuchFieldException) {
        type = type.superclass
      }
    }
    error("Field $name not found on ${target.javaClass.name}")
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
    var type: Class<*>? = target.javaClass
    while (type != null) {
      try {
        val field: Field = type.getDeclaredField(name)
        field.isAccessible = true
        @Suppress("UNCHECKED_CAST")
        return field.get(target) as T
      } catch (_: NoSuchFieldException) {
        type = type.superclass
      }
    }
    error("Field $name not found on ${target.javaClass.name}")
  }
}
