package ai.openclaw.app.gateway

import android.util.Log
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.CoroutineStart
import kotlinx.coroutines.DelicateCoroutinesApi
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.NonCancellable
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.TimeoutCancellationException
import kotlinx.coroutines.async
import kotlinx.coroutines.cancelAndJoin
import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.coroutines.withContext
import kotlinx.coroutines.withTimeout
import kotlinx.coroutines.withTimeoutOrNull
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import java.util.Locale
import java.util.UUID
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicReference

/**
 * Identity advertised during gateway connect; these fields become the device row users approve.
 */
data class GatewayClientInfo(
  val id: String,
  val displayName: String?,
  val version: String,
  val platform: String,
  val mode: String,
  val instanceId: String?,
  val deviceFamily: String?,
  val modelIdentifier: String?,
)

/**
 * Role, scopes, commands, and permission snapshot sent with the connect frame.
 */
data class GatewayConnectOptions(
  val role: String,
  val scopes: List<String>,
  val caps: List<String>,
  val commands: List<String>,
  val permissions: Map<String, Boolean>,
  val client: GatewayClientInfo,
  val userAgent: String? = null,
)

private enum class GatewayConnectAuthSource {
  DEVICE_TOKEN,
  SHARED_TOKEN,
  BOOTSTRAP_TOKEN,
  PASSWORD,
  NONE,
}

/**
 * Structured gateway error details, preserved for reconnect, authorization, and UI decisions.
 */
data class GatewayErrorDetails(
  val code: String?,
  val canRetryWithDeviceToken: Boolean,
  val recommendedNextStep: String?,
  val pauseReconnect: Boolean? = null,
  val reason: String? = null,
  val requestId: String? = null,
  val retryable: Boolean = false,
  val clientMinProtocol: Int? = null,
  val clientMaxProtocol: Int? = null,
  val expectedProtocol: Int? = null,
  val minimumProbeProtocol: Int? = null,
  val clawhubTrustCode: String? = null,
  val clawhubWarning: String? = null,
  val clawhubVersion: String? = null,
  val missingScope: String? = null,
  val requiredScopes: List<String> = emptyList(),
)

data class GatewayMissingScopeErrorDetails(
  val missingScope: String,
  val requiredScopes: List<String>,
)

private val legacyMissingScopePattern = Regex("\\bmissing scope:\\s*([a-z0-9._-]+)", RegexOption.IGNORE_CASE)

private val gatewayApprovalRequestIdPattern = Regex("^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$")

/** Keeps copied approval commands single-argument and safe for a gateway host shell. */
internal fun normalizeGatewayApprovalRequestId(requestId: String?): String? {
  val trimmed = requestId?.trim()?.takeIf { it.isNotEmpty() } ?: return null
  return trimmed.takeIf { gatewayApprovalRequestIdPattern.matches(it) }
}

/**
 * Server hello fields cached by the Android runtime after a successful connect.
 */
data class GatewayHelloSummary(
  val serverName: String?,
  val remoteAddress: String?,
  val serverVersion: String?,
  val mainSessionKey: String?,
  val updateAvailable: GatewayUpdateAvailableSummary?,
  val authRole: String? = null,
  val authScopes: List<String> = emptyList(),
  val methods: Set<String> = emptySet(),
)

data class GatewayUpdateAvailableSummary(
  val currentVersion: String?,
  val latestVersion: String?,
  val channel: String?,
)

private data class SelectedConnectAuth(
  val authToken: String?,
  val authBootstrapToken: String?,
  val authDeviceToken: String?,
  val authPassword: String?,
  val signatureToken: String?,
  val storedScopes: List<String>,
  val authSource: GatewayConnectAuthSource,
  val attemptedDeviceTokenRetry: Boolean,
)

private class GatewayConnectFailure(
  val gatewayError: GatewaySession.ErrorShape,
) : IllegalStateException(gatewayError.message)

internal sealed class GatewayRequestDefinitiveFailure(
  message: String,
) : IllegalStateException(message)

internal class GatewayRequestNotEnqueued(
  message: String,
) : GatewayRequestDefinitiveFailure(message)

internal class GatewayRequestRejected(
  val gatewayError: GatewaySession.ErrorShape,
) : GatewayRequestDefinitiveFailure("${gatewayError.code}: ${gatewayError.message}")

/** Request frame was sent, but no response proved whether the gateway applied it. */
internal class GatewayRequestOutcomeUnknown(
  message: String,
) : IllegalStateException(message)

internal enum class NodeEventSendOutcome {
  COMPLETED,
  DISCONNECTED,
  FAILED,
}

internal data class GatewayCanvasHostRoute(
  val url: String,
  val tlsFingerprintSha256: String?,
)

/**
 * WebSocket RPC session that maintains gateway connection lifecycle, auth, events, and node invokes.
 */
class GatewaySession(
  private val scope: CoroutineScope,
  private val identityStore: DeviceIdentityStore,
  private val deviceAuthStore: DeviceAuthTokenStore,
  private val onConnected: (GatewayHelloSummary) -> Unit,
  private val onDisconnected: (message: String) -> Unit,
  private val onConnectFailure: (error: ErrorShape, pauseReconnect: Boolean) -> Unit = { _, _ -> },
  private val onEvent: (event: String, payloadJson: String?) -> Unit,
  private val onInvoke: (suspend (InvokeRequest) -> InvokeResult)? = null,
  private val onTlsFingerprint: ((stableId: String, fingerprint: String) -> Unit)? = null,
  private val customHeadersProvider: ((stableId: String) -> Map<String, String>)? = null,
) {
  private companion object {
    // Keep connect timeout above observed gateway unauthorized close on lower-end devices.
    private const val CONNECT_RPC_TIMEOUT_MS = 12_000L
  }

  /**
   * Gateway node.invoke request routed to Android command handlers.
   */
  data class InvokeRequest(
    val id: String,
    val nodeId: String,
    val command: String,
    val paramsJson: String?,
    val timeoutMs: Long?,
  )

  data class InvokeResult(
    val ok: Boolean,
    val payloadJson: String?,
    val error: ErrorShape?,
  ) {
    companion object {
      fun ok(payloadJson: String?) = InvokeResult(ok = true, payloadJson = payloadJson, error = null)

      fun error(
        code: String,
        message: String,
      ) = InvokeResult(ok = false, payloadJson = null, error = ErrorShape(code = code, message = message))
    }
  }

  data class ErrorShape(
    val code: String,
    val message: String,
    val details: GatewayErrorDetails? = null,
  ) {
    fun missingScopeDetails(): GatewayMissingScopeErrorDetails? {
      val details = details ?: return null
      val missingScope = details.missingScope?.trim().orEmpty()
      val requiredScopes = details.requiredScopes.map { it.trim() }
      if (details.code != "MISSING_SCOPE" || missingScope.isEmpty() || requiredScopes.any { it.isEmpty() }) {
        return null
      }
      return requiredScopes.takeIf { it.isNotEmpty() }?.let {
        GatewayMissingScopeErrorDetails(missingScope = missingScope, requiredScopes = it)
      }
    }

    fun missingScope(): String? {
      missingScopeDetails()?.let { return it.missingScope }
      if (code != "FORBIDDEN" && code != "INVALID_REQUEST") return null
      return legacyMissingScopePattern.find(message)?.groupValues?.getOrNull(1)
    }
  }

  /**
   * Structured RPC result used by callers that need error codes without exceptions.
   */
  data class RpcResult(
    val ok: Boolean,
    val payloadJson: String?,
    val error: ErrorShape?,
  )

  /** One ready physical WebSocket captured before queued work starts waiting. */
  internal class RequestLease internal constructor(
    val endpointStableId: String,
    private val isCurrentImpl: () -> Boolean = { true },
    private val commitIfCurrentImpl: ((block: () -> Unit) -> Boolean)? = null,
    private val requestImpl: suspend (method: String, paramsJson: String?, timeoutMs: Long) -> String,
  ) {
    fun isCurrent(): Boolean = isCurrentImpl()

    fun commitIfCurrent(block: () -> Unit): Boolean {
      commitIfCurrentImpl?.let { return it(block) }
      if (!isCurrentImpl()) return false
      block()
      return true
    }

    suspend fun request(
      method: String,
      paramsJson: String?,
      timeoutMs: Long = 15_000,
    ): String = requestImpl(method, paramsJson, timeoutMs)
  }

  private val json =
    Json {
      ignoreUnknownKeys = true
      encodeDefaults = true
      explicitNulls = false
    }
  private val writeLock = Mutex()

  @Volatile private var pluginSurfaceUrls: Map<String, String> = emptyMap()

  @Volatile private var mainSessionKey: String? = null

  private data class DesiredConnection(
    val endpoint: GatewayEndpoint,
    val token: String?,
    val bootstrapToken: String?,
    val password: String?,
    val options: GatewayConnectOptions,
    val tls: GatewayTlsParams?,
  )

  private val lifecycleLock = Any()

  @Volatile private var desired: DesiredConnection? = null

  private var job: Job? = null

  // Disconnect cleanups form one ordered tail so an awaited auth reset also waits for any earlier
  // fire-and-forget disconnect that already detached the reconnect job from this session.
  private var disconnectTail: Job? = null

  @Volatile private var currentConnection: Connection? = null

  // One reconnect can retry a shared-token mismatch by pairing the shared token with the stored device token.
  @Volatile private var pendingDeviceTokenRetry = false

  // Keep the mismatch retry single-shot so an invalid stored token cannot create an auth loop.
  @Volatile private var deviceTokenRetryBudgetUsed = false

  @Volatile private var reconnectPausedForAuthFailure = false

  // Network recovery must interrupt the current backoff without creating a parallel loop.
  private val reconnectSignal = Channel<Unit>(Channel.CONFLATED)

  /** Starts or replaces the desired gateway connection and launches the reconnect loop. */
  fun connect(
    endpoint: GatewayEndpoint,
    token: String?,
    bootstrapToken: String?,
    password: String?,
    options: GatewayConnectOptions,
    tls: GatewayTlsParams? = null,
  ) {
    val connectionToClose: Connection?
    synchronized(lifecycleLock) {
      desired = DesiredConnection(endpoint, token, bootstrapToken, password, options, tls)
      pendingDeviceTokenRetry = false
      deviceTokenRetryBudgetUsed = false
      reconnectPausedForAuthFailure = false
      connectionToClose = currentConnection
      if (job?.isActive != true) {
        job = scope.launch(Dispatchers.IO) { runLoop() }
      } else {
        reconnectSignal.trySend(Unit)
      }
    }
    connectionToClose?.closeQuietly()
  }

  /** Clears desired connection state, closes the socket, and stops reconnect attempts. */
  fun disconnect() {
    scheduleDisconnect()
  }

  /** Disconnects and waits until the old reconnect loop and its final callback have stopped. */
  suspend fun disconnectAndJoin() {
    scheduleDisconnect().join()
  }

  private fun scheduleDisconnect(): Job {
    val jobToCancel: Job?
    val connectionToClose: Connection?
    val cleanup: Job
    synchronized(lifecycleLock) {
      desired = null
      pendingDeviceTokenRetry = false
      deviceTokenRetryBudgetUsed = false
      reconnectPausedForAuthFailure = false
      drainReconnectSignals()
      connectionToClose = currentConnection
      jobToCancel = job
      job = null
      val previousCleanup = disconnectTail
      cleanup =
        scope.launch(Dispatchers.IO, start = CoroutineStart.LAZY) {
          previousCleanup?.join()
          jobToCancel?.cancelAndJoin()
          connectionToClose?.joinOwnedWork()
          if (desired == null) {
            pluginSurfaceUrls = emptyMap()
            mainSessionKey = null
            onDisconnected("Offline")
          }
        }
      disconnectTail = cleanup
    }
    connectionToClose?.closeQuietly()
    cleanup.start()
    return cleanup
  }

  /** Forces the current socket closed so the loop reconnects to the current desired endpoint. */
  fun reconnect() {
    signalReconnect(resumeAuthPaused = true)
  }

  /** Wakes transport backoff without overriding a deliberate auth-failure pause. */
  internal fun retryAfterNetworkRestore() {
    signalReconnect(resumeAuthPaused = false)
  }

  private fun signalReconnect(resumeAuthPaused: Boolean) {
    synchronized(lifecycleLock) {
      if (resumeAuthPaused) {
        reconnectPausedForAuthFailure = false
      } else if (reconnectPausedForAuthFailure) {
        return
      }
      if (desired == null) return
      currentConnection?.closeQuietly()
      reconnectSignal.trySend(Unit)
    }
  }

  private fun drainReconnectSignals() {
    while (reconnectSignal.tryReceive().isSuccess) {
      // A newly ready connection already incorporates every earlier retry request.
    }
  }

  private fun readyConnection(): Connection? = currentConnection?.takeIf { it.isReady() }

  internal fun isReady(): Boolean = readyConnection() != null

  internal fun currentCanvasHostUrl(): String? = pluginSurfaceUrls["canvas"]

  internal fun currentCanvasHostRoute(): GatewayCanvasHostRoute? =
    synchronized(lifecycleLock) {
      val connection = readyConnection() ?: return@synchronized null
      val url = pluginSurfaceUrls["canvas"] ?: return@synchronized null
      // TOFU can learn the certificate during the WebSocket handshake. Read
      // the live TLS config so the widget document inherits that exact trust.
      val fingerprint =
        connection.tlsConfig
          ?.effectiveFingerprintSha256
          ?.let(::normalizeGatewayTlsFingerprint)
          ?.takeIf { it.length == 64 }
      GatewayCanvasHostRoute(
        url = url,
        tlsFingerprintSha256 =
          gatewayTlsFingerprintForCanvasSurface(
            fingerprint = fingerprint,
            surfaceUrl = url,
            endpoint = connection.endpoint,
            isTlsConnection = connection.tlsConfig != null,
          ),
      )
    }

  internal suspend fun refreshCanvasHostUrl(): String? = refreshCanvasHostUrl(observedSurfaceUrl = null, requireObservedMatch = false)

  internal suspend fun refreshCanvasHostUrlIfCurrent(observedSurfaceUrl: String?): String? = refreshCanvasHostUrl(observedSurfaceUrl = observedSurfaceUrl, requireObservedMatch = true)

  internal suspend fun refreshCanvasHostRouteIfCurrent(observedSurfaceUrl: String?): GatewayCanvasHostRoute? {
    refreshCanvasHostUrlIfCurrent(observedSurfaceUrl)
    // Pair the URL with the currently installed connection after suspension;
    // a reconnect can replace both the capability and its certificate pin.
    return currentCanvasHostRoute()
  }

  private suspend fun refreshCanvasHostUrl(
    observedSurfaceUrl: String?,
    requireObservedMatch: Boolean,
  ): String? {
    val (lease, target, requestObservedSurfaceUrl) =
      synchronized(lifecycleLock) {
        val current = pluginSurfaceUrls["canvas"]
        if (requireObservedMatch && current != observedSurfaceUrl) return current
        val capturedLease = captureRequestLease() ?: return null
        val capturedTarget =
          desired
            ?.takeIf { it.endpoint.stableId == capturedLease.endpointStableId }
            ?: return null
        Triple(capturedLease, capturedTarget, current)
      }
    val refreshMethod =
      when (
        target.options.role
          .trim()
          .lowercase(Locale.ROOT)
      ) {
        "node" -> GatewayMethod.NodePluginSurfaceRefresh
        "operator" -> GatewayMethod.PluginSurfaceRefresh
        else -> return null
      }
    val response =
      runCatching {
        lease.request(
          refreshMethod.rawValue,
          buildJsonObject {
            put("surface", JsonPrimitive("canvas"))
            requestObservedSurfaceUrl?.let { put("observedUrl", JsonPrimitive(it)) }
          }.toString(),
          timeoutMs = 8_000,
        )
      }.getOrNull() ?: return null
    val raw =
      parseJsonOrNull(response)
        .asObjectOrNull()
        ?.get("pluginSurfaceUrls")
        .asObjectOrNull()
        ?.get("canvas")
        .asStringOrNull()
    val refreshed = normalizeCanvasHostUrl(raw, target.endpoint, isTlsConnection = target.tls != null) ?: return null
    var result: String? = null
    val committed =
      lease.commitIfCurrent {
        val current = pluginSurfaceUrls["canvas"]
        result =
          if (requireObservedMatch && current != observedSurfaceUrl) {
            current
          } else {
            pluginSurfaceUrls = pluginSurfaceUrls + ("canvas" to refreshed)
            refreshed
          }
      }
    return if (committed) result else null
  }

  /** Current physical connection identity, including events sent during connect publication. */
  internal fun currentEndpointStableId(): String? = currentConnection?.endpoint?.stableId

  /** Sends a best-effort node.event and returns false instead of throwing on failure. */
  suspend fun sendNodeEvent(
    event: String,
    payloadJson: String?,
  ): Boolean = sendNodeEventWithOutcome(event, payloadJson) == NodeEventSendOutcome.COMPLETED

  internal suspend fun sendNodeEventForEndpoint(
    expectedEndpointStableId: String?,
    event: String,
    payloadJson: String?,
  ): Boolean =
    sendNodeEventWithOutcomeForEndpoint(expectedEndpointStableId, event, payloadJson) ==
      NodeEventSendOutcome.COMPLETED

  internal suspend fun sendNodeEventWithOutcome(
    event: String,
    payloadJson: String?,
  ): NodeEventSendOutcome = sendNodeEventWithOutcomeForEndpoint(expectedEndpointStableId = null, event, payloadJson)

  internal suspend fun sendNodeEventWithOutcomeForEndpoint(
    expectedEndpointStableId: String?,
    event: String,
    payloadJson: String?,
  ): NodeEventSendOutcome {
    val conn = readyConnection(expectedEndpointStableId) ?: return NodeEventSendOutcome.DISCONNECTED
    return try {
      conn.request(
        GatewayMethod.NodeEvent.rawValue,
        buildNodeEventParams(event = event, payloadJson = payloadJson),
        timeoutMs = 8_000,
      )
      NodeEventSendOutcome.COMPLETED
    } catch (_: GatewayRequestNotEnqueued) {
      NodeEventSendOutcome.DISCONNECTED
    } catch (err: CancellationException) {
      // Voice/audio ownership takeover must cancel before a stale node event dispatches.
      throw err
    } catch (err: Throwable) {
      Log.w("OpenClawGateway", "node.event failed: ${err::class.java.simpleName}")
      NodeEventSendOutcome.FAILED
    }
  }

  /** Sends node.event and preserves the gateway RPC error shape for callers that need diagnostics. */
  suspend fun sendNodeEventDetailed(
    event: String,
    payloadJson: String?,
    timeoutMs: Long = 8_000,
  ): RpcResult = sendNodeEventDetailedForEndpoint(null, event, payloadJson, timeoutMs)

  internal suspend fun sendNodeEventDetailedForEndpoint(
    expectedEndpointStableId: String?,
    event: String,
    payloadJson: String?,
    timeoutMs: Long = 8_000,
  ): RpcResult {
    val conn =
      readyConnection(expectedEndpointStableId)
        ?: return RpcResult(
          ok = false,
          payloadJson = null,
          error = ErrorShape("UNAVAILABLE", "not connected"),
        )
    val params = buildNodeEventParams(event = event, payloadJson = payloadJson)
    try {
      val res = conn.request(GatewayMethod.NodeEvent.rawValue, params, timeoutMs = timeoutMs)
      return RpcResult(ok = res.ok, payloadJson = res.payloadJson, error = res.error)
    } catch (err: Throwable) {
      Log.w("OpenClawGateway", "node.event failed: ${err::class.java.simpleName}")
      return RpcResult(
        ok = false,
        payloadJson = null,
        error = ErrorShape("UNAVAILABLE", "node.event failed"),
      )
    }
  }

  private fun buildNodeEventParams(
    event: String,
    payloadJson: String?,
  ): JsonObject =
    json
      .encodeToJsonElement(
        GatewayNodeEventParams.serializer(),
        GatewayNodeEventParams(event = event, payloadJson = payloadJson ?: "{}"),
      ).asObjectOrNull() ?: error("GatewayNodeEventParams must encode as an object")

  /** Sends an RPC request and throws a code-prefixed exception when the gateway returns an error. */
  suspend fun request(
    method: String,
    paramsJson: String?,
    timeoutMs: Long = 15_000,
  ): String {
    val res = requestDetailed(method = method, paramsJson = paramsJson, timeoutMs = timeoutMs)
    if (res.ok) return res.payloadJson ?: ""
    throw GatewayRequestRejected(res.error ?: ErrorShape("UNAVAILABLE", "request failed"))
  }

  internal suspend fun requestForEndpoint(
    expectedEndpointStableId: String,
    method: String,
    paramsJson: String?,
    timeoutMs: Long = 15_000,
  ): String {
    val res = requestDetailed(expectedEndpointStableId, method, paramsJson, timeoutMs)
    if (res.ok) return res.payloadJson ?: ""
    throw GatewayRequestRejected(res.error ?: ErrorShape("UNAVAILABLE", "request failed"))
  }

  /** Captures the current physical connection; requests never resolve a replacement socket. */
  internal fun captureRequestLease(expectedEndpointStableId: String? = null): RequestLease? =
    synchronized(lifecycleLock) {
      val conn = readyConnection(expectedEndpointStableId) ?: return@synchronized null
      RequestLease(
        endpointStableId = conn.endpoint.stableId,
        isCurrentImpl = { currentConnection === conn && conn.isReady() },
        commitIfCurrentImpl = { block ->
          synchronized(lifecycleLock) {
            if (currentConnection !== conn || !conn.isReady()) {
              false
            } else {
              block()
              true
            }
          }
        },
      ) { method, paramsJson, timeoutMs ->
        val res = requestDetailed(conn, method, paramsJson, timeoutMs)
        if (!res.ok) {
          throw GatewayRequestRejected(res.error ?: ErrorShape("UNAVAILABLE", "request failed"))
        }
        res.payloadJson ?: ""
      }
    }

  /** Sends an RPC request and returns the structured success/error payload. */
  suspend fun requestDetailed(
    method: String,
    paramsJson: String?,
    timeoutMs: Long = 15_000,
  ): RpcResult =
    requestDetailed(
      expectedEndpointStableId = null,
      method,
      paramsJson,
      timeoutMs,
    )

  private suspend fun requestDetailed(
    expectedEndpointStableId: String?,
    method: String,
    paramsJson: String?,
    timeoutMs: Long,
  ): RpcResult {
    val conn = readyConnection(expectedEndpointStableId) ?: throw GatewayRequestNotEnqueued("not connected")
    return requestDetailed(conn, method, paramsJson, timeoutMs)
  }

  private suspend fun requestDetailed(
    conn: Connection,
    method: String,
    paramsJson: String?,
    timeoutMs: Long,
  ): RpcResult {
    val params =
      if (paramsJson.isNullOrBlank()) {
        null
      } else {
        json.parseToJsonElement(paramsJson)
      }
    // Readiness and identity are checked after parsing, immediately before enqueue.
    // A later reconnect can only close this exact socket, never retarget the lease.
    if (currentConnection !== conn || !conn.isReady()) {
      throw GatewayRequestNotEnqueued("gateway request lease changed")
    }
    val res = conn.request(method, params, timeoutMs)
    return RpcResult(ok = res.ok, payloadJson = res.payloadJson, error = res.error)
  }

  private fun readyConnection(expectedEndpointStableId: String?): Connection? =
    readyConnection()?.takeIf { connection ->
      expectedEndpointStableId == null || connection.endpoint.stableId == expectedEndpointStableId
    }

  /** Sends an RPC request frame and reports errors asynchronously through [onError]. */
  suspend fun sendRequestFrame(
    method: String,
    paramsJson: String?,
    timeoutMs: Long = 15_000,
    onError: (ErrorShape) -> Unit = {},
  ) = sendRequestFrameForEndpoint(null, method, paramsJson, timeoutMs, onError)

  internal suspend fun sendRequestFrameForEndpoint(
    expectedEndpointStableId: String?,
    method: String,
    paramsJson: String?,
    timeoutMs: Long = 15_000,
    onError: (ErrorShape) -> Unit = {},
  ) {
    val conn = readyConnection(expectedEndpointStableId) ?: throw IllegalStateException("not connected")
    val params =
      if (paramsJson.isNullOrBlank()) {
        null
      } else {
        json.parseToJsonElement(paramsJson)
      }
    conn.sendRequestFrame(method = method, params = params, timeoutMs = timeoutMs, onError = onError)
  }

  private data class RpcResponse(
    val id: String,
    val ok: Boolean,
    val payloadJson: String?,
    val error: ErrorShape?,
  )

  private data class ConnectedGateway(
    val pluginSurfaceUrls: Map<String, String>,
    val mainSessionKey: String?,
    val hello: GatewayHelloSummary,
  )

  private enum class ConnectionState {
    CONNECTING,
    READY,
    CLOSED,
  }

  private inner class Connection(
    val endpoint: GatewayEndpoint,
    private val token: String?,
    private val bootstrapToken: String?,
    private val password: String?,
    private val options: GatewayConnectOptions,
    val tls: GatewayTlsParams?,
  ) {
    private val connectionJob = SupervisorJob(scope.coroutineContext[Job])
    private val connectionScope = CoroutineScope(scope.coroutineContext + connectionJob)
    private val state = AtomicReference(ConnectionState.CONNECTING)
    private val connectDeferred = CompletableDeferred<ConnectedGateway>()
    private val closedDeferred = CompletableDeferred<Unit>()
    private val connectNonceDeferred = CompletableDeferred<String>()
    private val terminalCallbackClaimed = AtomicBoolean(false)
    private val connectResponseAccepted = AtomicBoolean(false)

    @Volatile
    private var connectHandshakeJob: Job? = null

    @Volatile
    private var connectRequestId: String? = null
    val tlsConfig: GatewayTlsConfig? =
      buildGatewayTlsConfig(tls) { fingerprint ->
        onTlsFingerprint?.invoke(tls?.stableId ?: endpoint.stableId, fingerprint)
      }
    private val client: OkHttpClient = buildClient()
    private val listener = Listener()
    private var socket: WebSocket? = null
    private val loggerTag = "OpenClawGateway"
    private val incomingMessages = Channel<String>(Channel.UNLIMITED)

    // RPC waiters belong to this socket generation. Closing it must not touch a replacement connection.
    private val pending = ConcurrentHashMap<String, CompletableDeferred<RpcResponse>>()

    private val pendingLock = Any()
    private val messagePumpJob =
      connectionScope.launch(Dispatchers.IO) {
        for (text in incomingMessages) {
          try {
            handleMessage(text)
          } catch (err: CancellationException) {
            throw err
          } catch (err: Throwable) {
            Log.w(
              loggerTag,
              "gateway message handling failed: ${err.message ?: err::class.java.simpleName}",
            )
          }
        }
      }

    val remoteAddress: String = formatGatewayAuthority(endpoint.host, endpoint.port)

    suspend fun connect(): ConnectedGateway {
      val request =
        buildGatewayWebSocketUpgradeRequest(
          endpoint = endpoint,
          tls = tls,
          customHeadersProvider = customHeadersProvider,
        )
      socket = client.newWebSocket(request, listener)
      return connectDeferred.await()
    }

    suspend fun request(
      method: String,
      params: JsonElement?,
      timeoutMs: Long,
    ): RpcResponse {
      val id = UUID.randomUUID().toString()
      if (method == "connect") connectRequestId = id
      val deferred = registerPending(id)
      try {
        sendJson(buildRequestFrame(id = id, method = method, params = params))
        return withTimeout(timeoutMs) { deferred.await() }
      } catch (err: TimeoutCancellationException) {
        throw GatewayRequestOutcomeUnknown("request timeout")
      } finally {
        pending.remove(id)
        if (connectRequestId == id) connectRequestId = null
      }
    }

    @OptIn(DelicateCoroutinesApi::class)
    suspend fun sendRequestFrame(
      method: String,
      params: JsonElement?,
      timeoutMs: Long,
      onError: (ErrorShape) -> Unit,
    ) {
      val id = UUID.randomUUID().toString()
      val deferred = registerPending(id)
      try {
        sendJson(buildRequestFrame(id = id, method = method, params = params))
      } catch (err: Throwable) {
        pending.remove(id)
        throw err
      }
      // ATOMIC start: joinOwnedWork() cancels connectionJob right after failPending(); a
      // DEFAULT-start watcher still queued for dispatch would be cancelled without ever running
      // and silently drop the terminal onError owed to fire-and-forget callers. ATOMIC
      // guarantees this block runs; await() on the already-failed deferred then surfaces the
      // disconnect outcome without suspending.
      connectionScope.launch(Dispatchers.IO, start = CoroutineStart.ATOMIC) {
        try {
          val response =
            try {
              withTimeout(timeoutMs) { deferred.await() }
            } catch (_: TimeoutCancellationException) {
              onError(ErrorShape("UNAVAILABLE", "request timeout"))
              return@launch
            } catch (_: CancellationException) {
              return@launch
            } catch (err: GatewayRequestOutcomeUnknown) {
              onError(ErrorShape("UNAVAILABLE", err.message ?: "request outcome unknown"))
              return@launch
            }
          if (!response.ok) {
            onError(response.error ?: ErrorShape("UNAVAILABLE", "request failed"))
          }
        } finally {
          pending.remove(id)
        }
      }
    }

    private fun registerPending(id: String): CompletableDeferred<RpcResponse> {
      val deferred = CompletableDeferred<RpcResponse>()
      // Registration and the close drain are one lifecycle decision; no waiter may slip between them.
      synchronized(pendingLock) {
        if (state.get() == ConnectionState.CLOSED) {
          throw GatewayRequestNotEnqueued("Gateway closed")
        }
        pending[id] = deferred
      }
      return deferred
    }

    suspend fun sendJson(obj: JsonObject) {
      val jsonString = obj.toString()
      writeLock.withLock {
        if (socket?.send(jsonString) != true) {
          // OkHttp returning false means this frame never entered its outgoing queue.
          throw GatewayRequestNotEnqueued("gateway send failed")
        }
      }
    }

    private fun buildRequestFrame(
      id: String,
      method: String,
      params: JsonElement?,
    ): JsonObject =
      json
        .encodeToJsonElement(
          GatewayRequestFrame.serializer(),
          GatewayRequestFrame(id = id, method = method, params = params),
        ).asObjectOrNull() ?: error("GatewayRequestFrame must encode as an object")

    suspend fun awaitClose() = closedDeferred.await()

    suspend fun joinOwnedWork() {
      // Close the inbound channel before joining so already accepted frames drain in order. A
      // connect response may contain the one-time device token needed after bootstrap auth.
      messagePumpJob.join()
      closedDeferred.await()
      failPending()
      // handleResponse() completes the request deferred; the separate handshake continuation must
      // still parse and persist its issued token before remaining connection work is cancelled.
      connectHandshakeJob?.join()
      connectionJob.cancelAndJoin()
    }

    fun isReady(): Boolean = state.get() == ConnectionState.READY

    fun markReady(): Boolean = state.compareAndSet(ConnectionState.CONNECTING, ConnectionState.READY)

    fun closeQuietly() {
      if (state.getAndSet(ConnectionState.CLOSED) != ConnectionState.CLOSED) {
        incomingMessages.close()
        if (!connectDeferred.isCompleted) {
          connectDeferred.completeExceptionally(IllegalStateException("Gateway closed"))
        }
      }
      // Explicit retirement is immediate. WebSocket.close() only queues a close frame and can
      // leave the old transport live for OkHttp's full close timeout.
      socket?.cancel() ?: closedDeferred.complete(Unit)
    }

    @OptIn(DelicateCoroutinesApi::class)
    private fun finishTransport(
      message: String,
      connectError: Throwable,
    ) {
      if (!terminalCallbackClaimed.compareAndSet(false, true)) return
      val shouldNotify = state.getAndSet(ConnectionState.CLOSED) != ConnectionState.CLOSED
      incomingMessages.close()
      // Completion handlers run synchronously and cannot own app-level disconnect cleanup.
      connectionScope.launch(Dispatchers.IO, start = CoroutineStart.ATOMIC) {
        // Preserve accepted-frame ordering even if the parent scope is cancelled during failure.
        withContext(NonCancellable) {
          try {
            messagePumpJob.join()
            if (connectResponseAccepted.get()) {
              connectHandshakeJob?.join()
            } else {
              connectNonceDeferred.completeExceptionally(connectError)
            }
            if (shouldNotify) onDisconnected(message)
          } finally {
            finalizeTransport(connectError)
          }
        }
      }
    }

    private fun finalizeTransport(connectError: Throwable) {
      if (!connectDeferred.isCompleted) connectDeferred.completeExceptionally(connectError)
      socket = null
      closedDeferred.complete(Unit)
    }

    private fun buildClient(): OkHttpClient {
      val builder =
        OkHttpClient
          .Builder()
          .writeTimeout(60, java.util.concurrent.TimeUnit.SECONDS)
          .readTimeout(0, java.util.concurrent.TimeUnit.SECONDS)
          .pingInterval(30, java.util.concurrent.TimeUnit.SECONDS)
      if (tlsConfig != null) {
        builder.sslSocketFactory(tlsConfig.sslSocketFactory, tlsConfig.trustManager)
        builder.hostnameVerifier(tlsConfig.hostnameVerifier)
      }
      return builder.build()
    }

    private inner class Listener : WebSocketListener() {
      override fun onOpen(
        webSocket: WebSocket,
        response: Response,
      ) {
        connectHandshakeJob =
          connectionScope.launch {
            try {
              val nonce = awaitConnectNonce()
              sendConnect(nonce)
            } catch (err: Throwable) {
              connectDeferred.completeExceptionally(err)
              closeQuietly()
            }
          }
      }

      override fun onMessage(
        webSocket: WebSocket,
        text: String,
      ) {
        incomingMessages.trySend(text)
      }

      override fun onFailure(
        webSocket: WebSocket,
        t: Throwable,
        response: Response?,
      ) {
        finishTransport(
          message = "Gateway error: ${t.message ?: t::class.java.simpleName}",
          connectError = t,
        )
      }

      override fun onClosing(
        webSocket: WebSocket,
        code: Int,
        reason: String,
      ) {
        // OkHttp requires the client to acknowledge a peer-initiated close before onClosed fires.
        webSocket.close(code, reason)
      }

      override fun onClosed(
        webSocket: WebSocket,
        code: Int,
        reason: String,
      ) {
        finishTransport(
          message = "Gateway closed: $reason",
          connectError = IllegalStateException("Gateway closed: $reason"),
        )
      }
    }

    private suspend fun sendConnect(connectNonce: String) {
      val identity = identityStore.loadOrCreate()
      val storedEntry = deviceAuthStore.loadEntry(endpoint.stableId, identity.deviceId, options.role)
      val storedToken = storedEntry?.token?.trim()
      val selectedAuth =
        selectConnectAuth(
          endpoint = endpoint,
          tls = tls,
          role = options.role,
          explicitGatewayToken = token?.trim()?.takeIf { it.isNotEmpty() },
          explicitBootstrapToken = bootstrapToken?.trim()?.takeIf { it.isNotEmpty() },
          explicitPassword = password?.trim()?.takeIf { it.isNotEmpty() },
          storedToken = storedToken?.takeIf { it.isNotEmpty() },
          storedScopes = storedEntry?.scopes.orEmpty(),
        )
      if (selectedAuth.attemptedDeviceTokenRetry) {
        pendingDeviceTokenRetry = false
      }
      val payload =
        buildConnectParams(
          identity = identity,
          connectNonce = connectNonce,
          selectedAuth = selectedAuth,
        )
      val res = request(GatewayMethod.Connect.rawValue, payload, timeoutMs = CONNECT_RPC_TIMEOUT_MS)
      if (!res.ok) {
        val error = res.error ?: ErrorShape("UNAVAILABLE", "connect failed")
        val shouldRetryWithDeviceToken =
          shouldRetryWithStoredDeviceToken(
            error = error,
            explicitGatewayToken = token?.trim()?.takeIf { it.isNotEmpty() },
            storedToken = storedToken?.takeIf { it.isNotEmpty() },
            attemptedDeviceTokenRetry = selectedAuth.attemptedDeviceTokenRetry,
            endpoint = endpoint,
            tls = tls,
          )
        if (shouldRetryWithDeviceToken) {
          pendingDeviceTokenRetry = true
          deviceTokenRetryBudgetUsed = true
        } else if (
          selectedAuth.attemptedDeviceTokenRetry &&
          shouldClearStoredDeviceTokenAfterRetry(error)
        ) {
          deviceAuthStore.clearToken(endpoint.stableId, identity.deviceId, options.role)
        }
        throw GatewayConnectFailure(error)
      }
      val connected = parseConnectSuccess(res, identity.deviceId, selectedAuth.authSource)
      connectDeferred.complete(connected)
    }

    private fun shouldPersistBootstrapHandoffTokens(authSource: GatewayConnectAuthSource): Boolean {
      if (authSource != GatewayConnectAuthSource.BOOTSTRAP_TOKEN) return false
      if (isLocalCleartextGatewayHost(endpoint.host)) return true
      return tls != null
    }

    private fun filteredBootstrapHandoffScopes(
      role: String,
      scopes: List<String>,
    ): List<String>? =
      when (role.trim()) {
        "node" -> emptyList()
        // The Gateway bounds setup-code handoff to a closed mobile profile. Persist
        // only the supported full or limited scope set and drop unexpected extras.
        "operator" -> {
          val allowedOperatorScopes =
            setOf(
              "operator.admin",
              "operator.approvals",
              "operator.questions",
              "operator.read",
              "operator.talk.secrets",
              "operator.write",
            )
          scopes.filter { allowedOperatorScopes.contains(it) }.distinct().sorted()
        }
        else -> null
      }

    private fun persistBootstrapHandoffToken(
      deviceId: String,
      role: String,
      token: String,
      scopes: List<String>,
    ) {
      val filteredScopes = filteredBootstrapHandoffScopes(role, scopes) ?: return
      deviceAuthStore.saveToken(endpoint.stableId, deviceId, role, token, filteredScopes)
    }

    private fun persistIssuedDeviceToken(
      authSource: GatewayConnectAuthSource,
      deviceId: String,
      role: String,
      token: String,
      scopes: List<String>,
    ) {
      if (authSource == GatewayConnectAuthSource.BOOTSTRAP_TOKEN) {
        if (!shouldPersistBootstrapHandoffTokens(authSource)) return
        persistBootstrapHandoffToken(deviceId, role, token, scopes)
        return
      }
      deviceAuthStore.saveToken(endpoint.stableId, deviceId, role, token, scopes)
    }

    private fun parseConnectSuccess(
      res: RpcResponse,
      deviceId: String,
      authSource: GatewayConnectAuthSource,
    ): ConnectedGateway {
      val payloadJson = res.payloadJson ?: throw IllegalStateException("connect failed: missing payload")
      val obj = json.parseToJsonElement(payloadJson).asObjectOrNull() ?: throw IllegalStateException("connect failed")
      pendingDeviceTokenRetry = false
      deviceTokenRetryBudgetUsed = false
      reconnectPausedForAuthFailure = false
      val server = obj["server"].asObjectOrNull()
      val serverName = server?.get("host").asStringOrNull()
      val serverVersion = server?.get("version").asStringOrNull()
      val methods =
        obj["features"]
          .asObjectOrNull()
          ?.get("methods")
          .asArrayOrNull()
          ?.mapNotNull { it.asStringOrNull()?.trim()?.takeIf { method -> method.isNotEmpty() } }
          ?.toSet()
          .orEmpty()
      val authObj = obj["auth"].asObjectOrNull()
      val deviceToken = authObj?.get("deviceToken").asStringOrNull()
      val authRole = authObj?.get("role").asStringOrNull() ?: options.role
      val authScopes =
        authObj
          ?.get("scopes")
          .asArrayOrNull()
          ?.mapNotNull { it.asStringOrNull() }
          ?: emptyList()
      if (!deviceToken.isNullOrBlank()) {
        persistIssuedDeviceToken(authSource, deviceId, authRole, deviceToken, authScopes)
      }
      if (shouldPersistBootstrapHandoffTokens(authSource)) {
        // Bootstrap connects can mint role-specific device tokens; store only locally trusted handoffs.
        authObj
          ?.get("deviceTokens")
          .asArrayOrNull()
          ?.mapNotNull { it.asObjectOrNull() }
          ?.forEach { tokenEntry ->
            val handoffToken = tokenEntry["deviceToken"].asStringOrNull()
            val handoffRole = tokenEntry["role"].asStringOrNull()
            val handoffScopes =
              tokenEntry["scopes"]
                .asArrayOrNull()
                ?.mapNotNull { it.asStringOrNull() }
                ?: emptyList()
            if (!handoffToken.isNullOrBlank() && !handoffRole.isNullOrBlank()) {
              persistBootstrapHandoffToken(deviceId, handoffRole, handoffToken, handoffScopes)
            }
          }
      }
      val rawPluginSurfaceUrls = obj["pluginSurfaceUrls"].asObjectOrNull()
      val normalizedPluginSurfaceUrls =
        rawPluginSurfaceUrls?.mapNotNull { (surface, value) ->
          // Canvas URLs may be loopback gateway metadata; normalize them to the reachable Android endpoint.
          normalizeCanvasHostUrl(value.asStringOrNull(), endpoint, isTlsConnection = tls != null)
            ?.let { normalized -> surface to normalized }
        } ?: emptyList()
      val nextPluginSurfaceUrls = normalizedPluginSurfaceUrls.toMap()
      val snapshot = obj["snapshot"].asObjectOrNull()
      val sessionDefaults =
        snapshot
          ?.get("sessionDefaults")
          .asObjectOrNull()
      val nextMainSessionKey = sessionDefaults?.get("mainSessionKey").asStringOrNull()
      return ConnectedGateway(
        pluginSurfaceUrls = nextPluginSurfaceUrls,
        mainSessionKey = nextMainSessionKey,
        hello =
          GatewayHelloSummary(
            serverName = serverName,
            remoteAddress = remoteAddress,
            serverVersion = serverVersion,
            mainSessionKey = nextMainSessionKey,
            updateAvailable = parseUpdateAvailable(snapshot?.get("updateAvailable").asObjectOrNull()),
            authRole = authRole,
            authScopes = authScopes,
            methods = methods,
          ),
      )
    }

    private fun parseUpdateAvailable(value: JsonObject?): GatewayUpdateAvailableSummary? {
      if (value == null) return null
      val latestVersion = value["latestVersion"].asStringOrNull()?.trim()?.takeIf { it.isNotEmpty() }
      val currentVersion = value["currentVersion"].asStringOrNull()?.trim()?.takeIf { it.isNotEmpty() }
      val channel = value["channel"].asStringOrNull()?.trim()?.takeIf { it.isNotEmpty() }
      return GatewayUpdateAvailableSummary(
        currentVersion = currentVersion,
        latestVersion = latestVersion,
        channel = channel,
      )
    }

    private fun buildConnectParams(
      identity: DeviceIdentity,
      connectNonce: String,
      selectedAuth: SelectedConnectAuth,
    ): JsonObject {
      val client = options.client
      val locale = Locale.getDefault().toLanguageTag()
      val clientObj =
        buildJsonObject {
          put("id", JsonPrimitive(client.id))
          client.displayName?.let { put("displayName", JsonPrimitive(it)) }
          put("version", JsonPrimitive(client.version))
          put("platform", JsonPrimitive(client.platform))
          put("mode", JsonPrimitive(client.mode))
          client.instanceId?.let { put("instanceId", JsonPrimitive(it)) }
          client.deviceFamily?.let { put("deviceFamily", JsonPrimitive(it)) }
          client.modelIdentifier?.let { put("modelIdentifier", JsonPrimitive(it)) }
        }

      val authJson =
        when {
          selectedAuth.authToken != null ->
            buildJsonObject {
              put("token", JsonPrimitive(selectedAuth.authToken))
              selectedAuth.authDeviceToken?.let { put("deviceToken", JsonPrimitive(it)) }
            }
          selectedAuth.authBootstrapToken != null ->
            buildJsonObject {
              put("bootstrapToken", JsonPrimitive(selectedAuth.authBootstrapToken))
            }
          selectedAuth.authPassword != null ->
            buildJsonObject {
              put("password", JsonPrimitive(selectedAuth.authPassword))
            }
          else -> null
        }

      val connectScopes = resolveConnectScopes(selectedAuth)
      val signedAtMs = System.currentTimeMillis()
      // V3 signatures bind the auth token, nonce, role, and scopes so replayed connect frames fail.
      val payload =
        DeviceAuthPayload.buildV3(
          deviceId = identity.deviceId,
          clientId = client.id,
          clientMode = client.mode,
          role = options.role,
          scopes = connectScopes,
          signedAtMs = signedAtMs,
          token = selectedAuth.signatureToken,
          nonce = connectNonce,
          platform = client.platform,
          deviceFamily = client.deviceFamily,
        )
      val signature = identityStore.signPayload(payload, identity)
      val publicKey = identityStore.publicKeyBase64Url(identity)
      val deviceJson =
        if (!signature.isNullOrBlank() && !publicKey.isNullOrBlank()) {
          buildJsonObject {
            put("id", JsonPrimitive(identity.deviceId))
            put("publicKey", JsonPrimitive(publicKey))
            put("signature", JsonPrimitive(signature))
            put("signedAt", JsonPrimitive(signedAtMs))
            put("nonce", JsonPrimitive(connectNonce))
          }
        } else {
          null
        }

      return buildJsonObject {
        put("minProtocol", JsonPrimitive(GATEWAY_MIN_PROTOCOL_VERSION))
        put("maxProtocol", JsonPrimitive(GATEWAY_PROTOCOL_VERSION))
        put("client", clientObj)
        if (options.caps.isNotEmpty()) put("caps", JsonArray(options.caps.map(::JsonPrimitive)))
        if (options.commands.isNotEmpty()) put("commands", JsonArray(options.commands.map(::JsonPrimitive)))
        if (options.permissions.isNotEmpty()) {
          put(
            "permissions",
            buildJsonObject {
              options.permissions.forEach { (key, value) ->
                put(key, JsonPrimitive(value))
              }
            },
          )
        }
        put("role", JsonPrimitive(options.role))
        if (connectScopes.isNotEmpty()) put("scopes", JsonArray(connectScopes.map(::JsonPrimitive)))
        authJson?.let { put("auth", it) }
        deviceJson?.let { put("device", it) }
        put("locale", JsonPrimitive(locale))
        options.userAgent?.trim()?.takeIf { it.isNotEmpty() }?.let {
          put("userAgent", JsonPrimitive(it))
        }
      }
    }

    private fun resolveConnectScopes(selectedAuth: SelectedConnectAuth): List<String> {
      if (selectedAuth.authSource == GatewayConnectAuthSource.BOOTSTRAP_TOKEN) {
        return filteredBootstrapHandoffScopes(options.role, options.scopes).orEmpty()
      }
      if (selectedAuth.authSource == GatewayConnectAuthSource.DEVICE_TOKEN && selectedAuth.storedScopes.isNotEmpty()) {
        return selectedAuth.storedScopes
      }
      return options.scopes
    }

    private suspend fun handleMessage(text: String) {
      val frame = json.parseToJsonElement(text).asObjectOrNull() ?: return
      val frameType = frame["type"].asStringOrNull()
      if (
        state.get() == ConnectionState.CLOSED &&
        (frameType != "res" || frame["id"].asStringOrNull() != connectRequestId)
      ) {
        return
      }
      when (frameType) {
        "res" -> handleResponse(frame)
        "event" -> handleEvent(frame)
      }
    }

    private fun handleResponse(frame: JsonObject) {
      val response =
        runCatching {
          json.decodeFromJsonElement(GatewayResponseFrame.serializer(), frame)
        }.getOrNull() ?: return
      val id = response.id
      if (id == connectRequestId) connectResponseAccepted.set(true)
      // Read the raw element so an explicit JSON null remains distinguishable from an omitted payload.
      val payloadJson = frame["payload"]?.toString()
      val error =
        response.error?.let { wireError ->
          val detailObj = wireError.details.asObjectOrNull()
          val details =
            detailObj?.let {
              GatewayErrorDetails(
                code = it["code"].asStringOrNull(),
                canRetryWithDeviceToken = it["canRetryWithDeviceToken"].asBooleanOrNull() == true,
                recommendedNextStep = it["recommendedNextStep"].asStringOrNull(),
                pauseReconnect = it["pauseReconnect"].asBooleanOrNull(),
                reason = it["reason"].asStringOrNull(),
                requestId = normalizeGatewayApprovalRequestId(it["requestId"].asStringOrNull()),
                retryable = it["retryable"].asBooleanOrNull() == true || wireError.retryable == true,
                clientMinProtocol = it["clientMinProtocol"].asIntOrNull(),
                clientMaxProtocol = it["clientMaxProtocol"].asIntOrNull(),
                expectedProtocol = it["expectedProtocol"].asIntOrNull(),
                minimumProbeProtocol = it["minimumProbeProtocol"].asIntOrNull(),
                clawhubTrustCode = it["clawhubTrustCode"].asStringOrNull(),
                clawhubWarning = it["warning"].asStringOrNull(),
                clawhubVersion = it["version"].asStringOrNull(),
                missingScope = it["missingScope"].asStringOrNull(),
                requiredScopes =
                  it["requiredScopes"]
                    .asArrayOrNull()
                    ?.mapNotNull { scope -> scope.asStringOrNull() }
                    .orEmpty(),
              )
            }
          ErrorShape(wireError.code, wireError.message, details)
        }
      pending.remove(id)?.complete(RpcResponse(id, response.ok, payloadJson, error))
    }

    private fun handleEvent(frame: JsonObject) {
      val gatewayEvent =
        runCatching {
          json.decodeFromJsonElement(GatewayEventFrame.serializer(), frame)
        }.getOrNull() ?: return
      val event = gatewayEvent.event
      val payloadJson =
        frame["payload"]?.toString() ?: frame["payloadJSON"].asStringOrNull()
      if (event == GatewayEvent.ConnectChallenge.rawValue) {
        val nonce = extractConnectNonce(payloadJson)
        if (!connectNonceDeferred.isCompleted && !nonce.isNullOrBlank()) {
          connectNonceDeferred.complete(nonce.trim())
        }
        return
      }
      // Retired sockets can still drain queued frames after reconnect. Never let them mutate current state.
      if (currentConnection !== this) return
      if (event == GatewayEvent.NodeInvokeRequest.rawValue && payloadJson != null && onInvoke != null) {
        handleInvokeEvent(payloadJson)
        return
      }
      onEvent(event, payloadJson)
    }

    private suspend fun awaitConnectNonce(): String =
      try {
        withTimeout(2_000) { connectNonceDeferred.await() }
      } catch (err: Throwable) {
        throw IllegalStateException("connect challenge timeout", err)
      }

    private fun extractConnectNonce(payloadJson: String?): String? {
      if (payloadJson.isNullOrBlank()) return null
      val obj = parseJsonOrNull(payloadJson)?.asObjectOrNull() ?: return null
      return obj["nonce"].asStringOrNull()
    }

    private fun handleInvokeEvent(payloadJson: String) {
      val payload =
        runCatching {
          json.decodeFromString(GatewayNodeInvokeRequest.serializer(), payloadJson)
        }.getOrNull() ?: return
      // Older gateways sent structured `params`; keep accepting that shipped wire shape while
      // generated models follow the canonical `paramsJSON` schema.
      val paramsJson =
        payload.paramsJson
          ?: runCatching {
            json.parseToJsonElement(payloadJson).asObjectOrNull()?.get("params")
          }.getOrNull()?.let { value -> if (value is JsonNull) null else value.toString() }
      connectionScope.launch {
        val request =
          InvokeRequest(
            id = payload.id,
            nodeId = payload.nodeId,
            command = payload.command,
            paramsJson = paramsJson,
            timeoutMs = payload.timeoutMs,
          )
        val result = executeInvokeRequest(request)
        sendInvokeResult(payload.id, payload.nodeId, result, payload.timeoutMs)
      }
    }

    private suspend fun executeInvokeRequest(request: InvokeRequest): InvokeResult {
      val handler = onInvoke ?: return InvokeResult.error("UNAVAILABLE", "invoke handler missing")
      return try {
        val timeoutMs = resolveInvokeExecutionTimeoutMs(request.timeoutMs)
        if (timeoutMs == null) {
          handler(request)
        } else {
          // Keep the deadline owner separate so a blocking handler cannot delay the timeout result.
          // Cancellation still reaches cooperative handlers; late results are never sent.
          val handlerTask = connectionScope.async { handler(request) }
          try {
            withTimeoutOrNull(timeoutMs) { handlerTask.await() }
              ?: run {
                handlerTask.cancel(CancellationException("node invoke timed out"))
                InvokeResult.error("TIMEOUT", "node invoke timed out")
              }
          } catch (err: CancellationException) {
            handlerTask.cancel(err)
            throw err
          }
        }
      } catch (err: TimeoutCancellationException) {
        InvokeResult.error("TIMEOUT", err.message ?: "node invoke timed out")
      } catch (err: CancellationException) {
        throw err
      } catch (err: Throwable) {
        invokeErrorFromThrowable(err)
      }
    }

    private suspend fun sendInvokeResult(
      id: String,
      nodeId: String,
      result: InvokeResult,
      invokeTimeoutMs: Long?,
    ) {
      val parsedPayload = result.payloadJson?.let { parseJsonOrNull(it) }
      val params =
        json
          .encodeToJsonElement(
            GatewayNodeInvokeResultParams.serializer(),
            GatewayNodeInvokeResultParams(
              id = id,
              nodeId = nodeId,
              ok = result.ok,
              payload = parsedPayload,
              payloadJson = if (parsedPayload == null) result.payloadJson else null,
              error =
                result.error?.let { err ->
                  GatewayNodeInvokeResultParamsError(code = err.code, message = err.message)
                },
            ),
          ).asObjectOrNull() ?: error("GatewayNodeInvokeResultParams must encode as an object")
      val ackTimeoutMs = resolveInvokeResultAckTimeoutMs(invokeTimeoutMs)
      try {
        request(GatewayMethod.NodeInvokeResult.rawValue, params, timeoutMs = ackTimeoutMs)
      } catch (err: Throwable) {
        Log.w(
          loggerTag,
          "node.invoke.result failed (ackTimeoutMs=$ackTimeoutMs): ${err.message ?: err::class.java.simpleName}",
        )
      }
    }

    private fun invokeErrorFromThrowable(err: Throwable): InvokeResult {
      val parsed = parseInvokeErrorFromThrowable(err, fallbackMessage = err::class.java.simpleName)
      return InvokeResult.error(code = parsed.code, message = parsed.message)
    }

    private fun failPending() {
      val waiters =
        synchronized(pendingLock) {
          pending.values.toList().also { pending.clear() }
        }
      for (waiter in waiters) {
        waiter.completeExceptionally(GatewayRequestOutcomeUnknown("Gateway disconnected before response"))
      }
    }
  }

  private suspend fun runLoop() {
    var attempt = 0
    while (scope.isActive) {
      val target = desired
      if (target == null) {
        currentConnection?.closeQuietly()
        currentConnection = null
        withTimeoutOrNull(250) { reconnectSignal.receive() }
        continue
      }
      if (reconnectPausedForAuthFailure) {
        withTimeoutOrNull(250) { reconnectSignal.receive() }
        continue
      }

      try {
        onDisconnected(if (attempt == 0) "Connecting…" else "Reconnecting…")
        drainReconnectSignals()
        connectOnce(target)
        attempt = 0
      } catch (err: Throwable) {
        attempt += 1
        onDisconnected("Gateway error: ${err.message ?: err::class.java.simpleName}")
        val gatewayConnectFailure = err as? GatewayConnectFailure
        val pauseForAuthFailure =
          gatewayConnectFailure
            ?.let { shouldPauseReconnectAfterAuthFailure(it.gatewayError) } == true
        if (gatewayConnectFailure != null) {
          onConnectFailure(gatewayConnectFailure.gatewayError, pauseForAuthFailure)
        }
        if (pauseForAuthFailure) {
          synchronized(lifecycleLock) {
            reconnectPausedForAuthFailure = true
          }
          continue
        }
        val sleepMs = minOf(8_000L, (350.0 * Math.pow(1.7, attempt.toDouble())).toLong())
        withTimeoutOrNull(sleepMs) { reconnectSignal.receive() }
      }
    }
  }

  private suspend fun connectOnce(target: DesiredConnection) =
    withContext(Dispatchers.IO) {
      val conn =
        Connection(
          target.endpoint,
          target.token,
          target.bootstrapToken,
          target.password,
          target.options,
          target.tls,
        )
      val shouldConnect =
        synchronized(lifecycleLock) {
          if (desired === target) {
            currentConnection = conn
            true
          } else {
            false
          }
        }
      if (!shouldConnect) {
        conn.closeQuietly()
        conn.joinOwnedWork()
        return@withContext
      }
      try {
        val connected = conn.connect()
        val published =
          synchronized(lifecycleLock) {
            if (currentConnection !== conn || desired !== target || !conn.markReady()) {
              false
            } else {
              // Readiness and its metadata must become visible before callbacks flush queued events.
              pluginSurfaceUrls = connected.pluginSurfaceUrls
              mainSessionKey = connected.mainSessionKey
              onConnected(connected.hello)
              true
            }
          }
        if (!published) {
          conn.closeQuietly()
          return@withContext
        }
        drainReconnectSignals()
        conn.awaitClose()
      } finally {
        // Callback failures and cancellation must drain this socket's owned work before the loop
        // forgets it. Otherwise a retired connect can restore device auth after a later reset.
        withContext(NonCancellable) {
          conn.closeQuietly()
          conn.joinOwnedWork()
        }
        synchronized(lifecycleLock) {
          if (currentConnection === conn) {
            currentConnection = null
            pluginSurfaceUrls = emptyMap()
            mainSessionKey = null
          }
        }
      }
    }

  private fun normalizeCanvasHostUrl(
    raw: String?,
    endpoint: GatewayEndpoint,
    isTlsConnection: Boolean,
  ): String? {
    val trimmed = raw?.trim().orEmpty()
    val parsed = trimmed.takeIf { it.isNotBlank() }?.let { runCatching { java.net.URI(it) }.getOrNull() }
    val host = parsed?.host?.trim().orEmpty()
    val port = parsed?.port ?: -1
    val scheme =
      parsed
        ?.scheme
        ?.trim()
        .orEmpty()
        .ifBlank { "http" }
    val suffix = buildUrlSuffix(parsed)

    // If raw URL is a non-loopback address and this connection uses TLS,
    // normalize scheme/port to the endpoint we actually connected to.
    if (trimmed.isNotBlank() && host.isNotBlank() && !isLoopbackGatewayHost(host)) {
      val needsTlsRewrite =
        isTlsConnection &&
          (
            !scheme.equals("https", ignoreCase = true) ||
              (port > 0 && port != endpoint.port) ||
              (port <= 0 && endpoint.port != 443)
          )
      if (needsTlsRewrite) {
        return buildCanvasUrl(host = host, scheme = "https", port = endpoint.port, suffix = suffix)
      }
      return trimmed
    }

    val fallbackHost =
      endpoint.tailnetDns?.trim().takeIf { !it.isNullOrEmpty() }
        ?: endpoint.lanHost?.trim().takeIf { !it.isNullOrEmpty() }
        ?: endpoint.host.trim()
    if (fallbackHost.isEmpty()) return trimmed.ifBlank { null }

    // For TLS connections, use the connected endpoint's scheme/port instead of raw canvas metadata.
    val fallbackScheme = if (isTlsConnection) "https" else scheme
    // For TLS, always use the connected endpoint port.
    val fallbackPort = if (isTlsConnection) endpoint.port else (endpoint.canvasPort ?: endpoint.port)
    return buildCanvasUrl(host = fallbackHost, scheme = fallbackScheme, port = fallbackPort, suffix = suffix)
  }

  private fun buildCanvasUrl(
    host: String,
    scheme: String,
    port: Int,
    suffix: String,
  ): String {
    val loweredScheme = scheme.lowercase()
    val formattedHost = formatGatewayAuthorityHost(host)
    val portSuffix = if ((loweredScheme == "https" && port == 443) || (loweredScheme == "http" && port == 80)) "" else ":$port"
    return "$loweredScheme://$formattedHost$portSuffix$suffix"
  }

  private fun buildUrlSuffix(uri: java.net.URI?): String {
    if (uri == null) return ""
    val path = uri.rawPath?.takeIf { it.isNotBlank() } ?: ""
    val query = uri.rawQuery?.takeIf { it.isNotBlank() }?.let { "?$it" } ?: ""
    val fragment = uri.rawFragment?.takeIf { it.isNotBlank() }?.let { "#$it" } ?: ""
    return "$path$query$fragment"
  }

  private fun selectConnectAuth(
    endpoint: GatewayEndpoint,
    tls: GatewayTlsParams?,
    role: String,
    explicitGatewayToken: String?,
    explicitBootstrapToken: String?,
    explicitPassword: String?,
    storedToken: String?,
    storedScopes: List<String>,
  ): SelectedConnectAuth {
    val shouldUseDeviceRetryToken =
      pendingDeviceTokenRetry &&
        explicitGatewayToken != null &&
        storedToken != null &&
        isTrustedDeviceRetryEndpoint(endpoint, tls)
    val authToken =
      explicitGatewayToken
        ?: if (
          explicitPassword == null &&
          (explicitBootstrapToken == null || storedToken != null)
        ) {
          storedToken
        } else {
          null
        }
    val authDeviceToken = if (shouldUseDeviceRetryToken) storedToken else null
    val authBootstrapToken = if (authToken == null) explicitBootstrapToken else null
    val authSource =
      when {
        authDeviceToken != null || (explicitGatewayToken == null && authToken != null) ->
          GatewayConnectAuthSource.DEVICE_TOKEN
        authToken != null -> GatewayConnectAuthSource.SHARED_TOKEN
        authBootstrapToken != null -> GatewayConnectAuthSource.BOOTSTRAP_TOKEN
        explicitPassword != null -> GatewayConnectAuthSource.PASSWORD
        else -> GatewayConnectAuthSource.NONE
      }
    return SelectedConnectAuth(
      authToken = authToken,
      authBootstrapToken = authBootstrapToken,
      authDeviceToken = authDeviceToken,
      authPassword = explicitPassword,
      signatureToken = authToken ?: authBootstrapToken,
      storedScopes = storedScopes,
      authSource = authSource,
      attemptedDeviceTokenRetry = shouldUseDeviceRetryToken,
    )
  }

  private fun shouldRetryWithStoredDeviceToken(
    error: ErrorShape,
    explicitGatewayToken: String?,
    storedToken: String?,
    attemptedDeviceTokenRetry: Boolean,
    endpoint: GatewayEndpoint,
    tls: GatewayTlsParams?,
  ): Boolean {
    if (deviceTokenRetryBudgetUsed) return false
    if (attemptedDeviceTokenRetry) return false
    if (explicitGatewayToken == null || storedToken == null) return false
    if (!isTrustedDeviceRetryEndpoint(endpoint, tls)) return false
    val detailCode = error.details?.code
    val recommendedNextStep = error.details?.recommendedNextStep
    // New gateways set canRetryWithDeviceToken; older builds expose equivalent string codes.
    return error.details?.canRetryWithDeviceToken == true ||
      recommendedNextStep == "retry_with_device_token" ||
      detailCode == "AUTH_TOKEN_MISMATCH"
  }

  private fun shouldPauseReconnectAfterAuthFailure(error: ErrorShape): Boolean {
    val target = desired
    return shouldPauseGatewayReconnectAfterAuthFailure(
      error = error,
      hasBootstrapToken = target?.bootstrapToken?.trim()?.isNotEmpty() == true,
      role = target?.options?.role,
      scopes = target?.options?.scopes ?: emptyList(),
      pendingDeviceTokenRetry = pendingDeviceTokenRetry,
    )
  }

  private fun shouldClearStoredDeviceTokenAfterRetry(error: ErrorShape): Boolean = error.details?.code == "AUTH_DEVICE_TOKEN_MISMATCH"

  private fun isTrustedDeviceRetryEndpoint(
    endpoint: GatewayEndpoint,
    tls: GatewayTlsParams?,
  ): Boolean {
    if (isLocalCleartextGatewayHost(endpoint.host)) return true
    // Retrying a stored device token alongside a shared token is only safe for
    // remote gateways when an existing TLS pin already identifies the endpoint.
    return tls?.expectedFingerprint?.trim()?.isNotEmpty() == true
  }
}

/** Decides whether auth failures should stop reconnect churn until the user changes credentials. */
internal fun shouldPauseGatewayReconnectAfterAuthFailure(
  error: GatewaySession.ErrorShape,
  hasBootstrapToken: Boolean,
  role: String?,
  scopes: List<String>,
  pendingDeviceTokenRetry: Boolean,
): Boolean {
  val details = error.details
  val code = details?.code
  if (code == "PAIRING_REQUIRED") {
    val pairingDetails = details
    return !(
      hasBootstrapToken &&
        role?.trim() == "node" &&
        scopes.isEmpty() &&
        pairingDetails.reason == "not-paired" &&
        (
          pairingDetails.pauseReconnect == false ||
            pairingDetails.recommendedNextStep == "wait_then_retry"
        )
    )
  }
  // Gateway rate limits last minutes; generic retry advice must not trigger the short reconnect loop.
  if (code == "AUTH_RATE_LIMITED") return true
  when (details?.recommendedNextStep) {
    "wait_then_retry" -> return false
    "retry_with_device_token" -> return !pendingDeviceTokenRetry
    "update_auth_configuration",
    "update_auth_credentials",
    "review_auth_configuration",
    -> return true
  }
  return when (code) {
    "AUTH_TOKEN_MISSING",
    "AUTH_TOKEN_NOT_CONFIGURED",
    "AUTH_DEVICE_TOKEN_MISMATCH",
    "AUTH_BOOTSTRAP_TOKEN_INVALID",
    "AUTH_PASSWORD_MISSING",
    "AUTH_PASSWORD_MISMATCH",
    "AUTH_PASSWORD_NOT_CONFIGURED",
    "AUTH_SCOPE_MISMATCH",
    "CONTROL_UI_DEVICE_IDENTITY_REQUIRED",
    "DEVICE_IDENTITY_REQUIRED",
    -> true
    // The first shared-token mismatch may schedule one trusted stored-device-token retry.
    // Once no retry is pending, keep the terminal recovery action visible until credentials change.
    "AUTH_TOKEN_MISMATCH" -> !pendingDeviceTokenRetry
    "PROTOCOL_MISMATCH" -> true
    else -> false
  }
}

/** Builds the gateway WebSocket URL from endpoint authority and TLS policy. */
internal fun gatewayTlsFingerprintForCanvasSurface(
  fingerprint: String?,
  surfaceUrl: String,
  endpoint: GatewayEndpoint,
  isTlsConnection: Boolean,
): String? {
  if (!isTlsConnection || fingerprint == null) return null
  val surface = runCatching { java.net.URI(surfaceUrl) }.getOrNull() ?: return null
  if (!surface.scheme.equals("https", ignoreCase = true)) return null
  val surfaceHost = surface.host?.trim()?.trimEnd('.') ?: return null
  val gatewayHost = endpoint.host.trim().trimEnd('.')
  val surfacePort = surface.port.takeIf { it > 0 } ?: 443
  return fingerprint.takeIf {
    surfaceHost.equals(gatewayHost, ignoreCase = true) && surfacePort == endpoint.port
  }
}

internal fun buildGatewayWebSocketUrl(
  host: String,
  port: Int,
  useTls: Boolean,
): String {
  val scheme = if (useTls) "wss" else "ws"
  return "$scheme://${formatGatewayAuthority(host, port)}"
}

/** Builds one gateway upgrade request without exposing proxy credentials to cleartext routes. */
internal fun buildGatewayWebSocketUpgradeRequest(
  endpoint: GatewayEndpoint,
  tls: GatewayTlsParams?,
  customHeadersProvider: ((stableId: String) -> Map<String, String>)?,
): Request {
  val request = Request.Builder().url(buildGatewayWebSocketUrl(endpoint.host, endpoint.port, tls != null))
  if (tls == null) return request.build()

  // Read at connect time so edits apply on the next reconnect. Headers may contain service tokens
  // or Authorization values, so the cleartext branch above must never invoke the provider.
  for ((name, value) in GatewayCustomHeaders.sanitized(customHeadersProvider?.invoke(tls.stableId).orEmpty())) {
    request.addHeader(name, value)
  }
  return request.build()
}

/** Formats host/port for gateway URLs, including IPv6 bracket wrapping. */
internal fun formatGatewayAuthority(
  host: String,
  port: Int,
): String = "${formatGatewayAuthorityHost(host)}:$port"

private fun formatGatewayAuthorityHost(host: String): String {
  val normalizedHost = host.trim().trim('[', ']')
  return if (normalizedHost.contains(":")) "[$normalizedHost]" else normalizedHost
}

private fun JsonElement?.asObjectOrNull(): JsonObject? = this as? JsonObject

private fun JsonElement?.asArrayOrNull(): JsonArray? = this as? JsonArray

private fun JsonElement?.asStringOrNull(): String? =
  when (this) {
    is JsonNull -> null
    is JsonPrimitive -> content
    else -> null
  }

private fun JsonElement?.asBooleanOrNull(): Boolean? =
  when (this) {
    is JsonPrimitive -> {
      val c = content.trim()
      when {
        c.equals("true", ignoreCase = true) -> true
        c.equals("false", ignoreCase = true) -> false
        else -> null
      }
    }
    else -> null
  }

private fun JsonElement?.asLongOrNull(): Long? =
  when (this) {
    is JsonPrimitive -> content.toLongOrNull()
    else -> null
  }

private fun JsonElement?.asIntOrNull(): Int? =
  when (this) {
    is JsonPrimitive -> content.toIntOrNull()
    else -> null
  }

private fun parseJsonOrNull(payload: String): JsonElement? {
  val trimmed = payload.trim()
  if (trimmed.isEmpty()) return null
  return try {
    Json.parseToJsonElement(trimmed)
  } catch (_: Throwable) {
    null
  }
}

/** Keeps invoke-result ack waits inside the gateway-supported timeout window. */
internal fun resolveInvokeResultAckTimeoutMs(invokeTimeoutMs: Long?): Long {
  val normalized = invokeTimeoutMs?.takeIf { it > 0L } ?: 15_000L
  return normalized.coerceIn(15_000L, 120_000L)
}

/** Zero disables the deadline; an omitted value uses the same 30s default as Gateway/iOS. */
internal fun resolveInvokeExecutionTimeoutMs(invokeTimeoutMs: Long?): Long? {
  val normalized = invokeTimeoutMs ?: 30_000L
  if (normalized <= 0L) return null
  return normalized.coerceAtMost(Int.MAX_VALUE.toLong())
}
