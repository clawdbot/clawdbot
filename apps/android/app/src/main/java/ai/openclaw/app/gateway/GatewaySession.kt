package ai.openclaw.app.gateway

import android.util.Log
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.TimeoutCancellationException
import kotlinx.coroutines.cancelAndJoin
import kotlinx.coroutines.delay
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.coroutines.withContext
import kotlinx.coroutines.withTimeout
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

data class GatewayConnectErrorDetails(
  val code: String?,
  val canRetryWithDeviceToken: Boolean,
  val recommendedNextStep: String?,
  val reason: String? = null,
)

private data class SelectedConnectAuth(
  val authToken: String?,
  val authBootstrapToken: String?,
  val authDeviceToken: String?,
  val authPassword: String?,
  val signatureToken: String?,
  val authSource: GatewayConnectAuthSource,
  val attemptedDeviceTokenRetry: Boolean,
)

private class GatewayConnectFailure(
  val gatewayError: GatewaySession.ErrorShape,
) : IllegalStateException(gatewayError.message)

class GatewaySession(
  private val scope: CoroutineScope,
  private val identityStore: DeviceIdentityStore,
  private val deviceAuthStore: DeviceAuthTokenStore,
  private val onConnected: (serverName: String?, remoteAddress: String?, mainSessionKey: String?) -> Unit,
  private val onDisconnected: (message: String) -> Unit,
  private val onEvent: (event: String, payloadJson: String?) -> Unit,
  private val onInvoke: (suspend (InvokeRequest) -> InvokeResult)? = null,
  private val onTlsFingerprint: ((stableId: String, fingerprint: String) -> Unit)? = null,
) {
  private companion object {
    // Keep connect timeout above observed gateway unauthorized close on lower-end devices.
    private const val CONNECT_RPC_TIMEOUT_MS = 12_000L
  }

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
    val details: GatewayConnectErrorDetails? = null,
  )

  data class RpcResult(
    val ok: Boolean,
    val payloadJson: String?,
    val error: ErrorShape?,
  )

  private val json = Json { ignoreUnknownKeys = true }
  private val writeLock = Mutex()
  private val pending = ConcurrentHashMap<String, CompletableDeferred<RpcResponse>>()

  @Volatile private var canvasHostUrl: String? = null

  @Volatile private var mainSessionKey: String? = null

  private data class DesiredConnection(
    val endpoint: GatewayEndpoint,
    val token: String?,
    val bootstrapToken: String?,
    val password: String?,
    val options: GatewayConnectOptions,
    val tls: GatewayTlsParams?,
  )

  private var desired: DesiredConnection? = null
  private var job: Job? = null

  @Volatile private var currentConnection: Connection? = null

  @Volatile private var pendingDeviceTokenRetry = false

  @Volatile private var deviceTokenRetryBudgetUsed = false

  @Volatile private var reconnectPausedForAuthFailure = false

  fun connect(
    endpoint: GatewayEndpoint,
    token: String?,
    bootstrapToken: String?,
    password: String?,
    options: GatewayConnectOptions,
    tls: GatewayTlsParams? = null,
  ) {
    desired = DesiredConnection(endpoint, token, bootstrapToken, password, options, tls)
    pendingDeviceTokenRetry = false
    deviceTokenRetryBudgetUsed = false
    reconnectPausedForAuthFailure = false
    if (job == null) {
      job = scope.launch(Dispatchers.IO) { runLoop() }
    }
  }

  fun disconnect() {
    desired = null
    pendingDeviceTokenRetry = false
    deviceTokenRetryBudgetUsed = false
    reconnectPausedForAuthFailure = false
    currentConnection?.closeQuietly()
    scope.launch(Dispatchers.IO) {
      job?.cancelAndJoin()
      job = null
      canvasHostUrl = null
      mainSessionKey = null
      onDisconnected("Offline")
    }
  }

  fun reconnect() {
    reconnectPausedForAuthFailure = false
    currentConnection?.closeQuietly()
  }

  fun currentCanvasHostUrl(): String? = canvasHostUrl

  fun currentMainSessionKey(): String? = mainSessionKey

  suspend fun sendNodeEvent(
    event: String,
    payloadJson: String?,
  ): Boolean {
    val conn = currentConnection ?: return false
    return try {
      conn.request(
        "node.event",
        buildNodeEventParams(event = event, payloadJson = payloadJson),
        timeoutMs = 8_000,
      )
      true
    } catch (err: Throwable) {
      Log.w("OpenClawGateway", "node.event failed: ${err::class.java.simpleName}")
      false
    }
  }

  suspend fun sendNodeEventDetailed(
    event: String,
    payloadJson: String?,
    timeoutMs: Long = 8_000,
  ): RpcResult {
    val conn =
      currentConnection
        ?: return RpcResult(
          ok = false,
          payloadJson = null,
          error = ErrorShape("UNAVAILABLE", "not connected"),
        )
    val params = buildNodeEventParams(event = event, payloadJson = payloadJson)
    try {
      val res = conn.request("node.event", params, timeoutMs = timeoutMs)
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
    buildJsonObject {
      put("event", JsonPrimitive(event))
      put("payloadJSON", JsonPrimitive(payloadJson ?: "{}"))
    }

  suspend fun request(
    method: String,
    paramsJson: String?,
    timeoutMs: Long = 15_000,
  ): String {
    val res = requestDetailed(method = method, paramsJson = paramsJson, timeoutMs = timeoutMs)
    if (res.ok) return res.payloadJson ?: ""
    val err = res.error
    throw IllegalStateException("${err?.code ?: "UNAVAILABLE"}: ${err?.message ?: "request failed"}")
  }

  suspend fun requestDetailed(
    method: String,
    paramsJson: String?,
    timeoutMs: Long = 15_000,
  ): RpcResult {
    val conn = currentConnection ?: throw IllegalStateException("not connected")
    val params =
      if (paramsJson.isNullOrBlank()) {
        null
      } else {
        json.parseToJsonElement(paramsJson)
      }
    val res = conn.request(method, params, timeoutMs)
    return RpcResult(ok = res.ok, payloadJson = res.payloadJson, error = res.error)
  }

  suspend fun refreshNodeCanvasCapability(timeoutMs: Long = 8_000): Boolean {
    val conn = currentConnection ?: return false
    val response =
      try {
        conn.request(
          "node.canvas.capability.refresh",
          params = buildJsonObject {},
          timeoutMs = timeoutMs,
        )
      } catch (err: Throwable) {
        Log.w("OpenClawGateway", "node.canvas.capability.refresh failed: ${err.message ?: err::class.java.simpleName}")
        return false
      }
    if (!response.ok) {
      val err = response.error
      Log.w(
        "OpenClawGateway",
        "node.canvas.capability.refresh rejected: ${err?.code ?: "UNAVAILABLE"}: ${err?.message ?: "request failed"}",
      )
      return false
    }
    val payloadObj = response.payloadJson?.let(::parseJsonOrNull)?.asObjectOrNull()
    val refreshedCapability =
      payloadObj
        ?.get("canvasCapability")
        .asStringOrNull()
        ?.trim()
        .orEmpty()
    if (refreshedCapability.isEmpty()) {
      Log.w("OpenClawGateway", "node.canvas.capability.refresh missing canvasCapability")
      return false
    }
    val scopedCanvasHostUrl = canvasHostUrl?.trim().orEmpty()
    if (scopedCanvasHostUrl.isEmpty()) {
      Log.w("OpenClawGateway", "node.canvas.capability.refresh missing local canvasHostUrl")
      return false
    }
    val refreshedUrl = replaceCanvasCapabilityInScopedHostUrl(scopedCanvasHostUrl, refreshedCapability)
    if (refreshedUrl == null) {
      Log.w("OpenClawGateway", "node.canvas.capability.refresh unable to rewrite scoped canvas URL")
      return false
    }
    canvasHostUrl = refreshedUrl
    return true
  }

  private data class RpcResponse(
    val id: String,
    val ok: Boolean,
    val payloadJson: String?,
    val error: ErrorShape?,
  )

  private inner class Connection(
    private val endpoint: GatewayEndpoint,
    private val token: String?,
    private val bootstrapToken: String?,
    private val password: String?,
    private val options: GatewayConnectOptions,
    private val tls: GatewayTlsParams?,
  ) {
    private val connectDeferred = CompletableDeferred<Unit>()
    private val closedDeferred = CompletableDeferred<Unit>()
    private val isClosed = AtomicBoolean(false)
    private val connectNonceDeferred = CompletableDeferred<String>()
    private val client: OkHttpClient = buildClient()
    private var socket: WebSocket? = null
    private val loggerTag = "OpenClawGateway"

    val remoteAddress: String = formatGatewayAuthority(endpoint.host, endpoint.port)

    suspend fun connect() {
      val url = buildGatewayWebSocketUrl(endpoint.host, endpoint.port, tls != null)
      val request = Request.Builder().url(url).build()
      socket = client.newWebSocket(request, Listener())
      try {
        connectDeferred.await()
      } catch (err: Throwable) {
        throw err
      }
    }

    suspend fun request(
      method: String,
      params: JsonElement?,
      timeoutMs: Long,
    ): RpcResponse {
      val id = UUID.randomUUID().toString()
      val deferred = CompletableDeferred<RpcResponse>()
      pending[id] = deferred
      val frame =
        buildJsonObject {
          put("type", JsonPrimitive("req"))
          put("id", JsonPrimitive(id))
          put("method", JsonPrimitive(method))
          if (params != null) put("params", params)
        }
      sendJson(frame)
      return try {
        withTimeout(timeoutMs) { deferred.await() }
      } catch (err: TimeoutCancellationException) {
        pending.remove(id)
        throw IllegalStateException("request timeout")
      }
    }

    suspend fun sendJson(obj: JsonObject) {
      val jsonString = obj.toString()
      writeLock.withLock {
        socket?.send(jsonString)
      }
    }

    suspend fun awaitClose() = closedDeferred.await()

    fun closeQuietly() {
      if (isClosed.compareAndSet(false, true)) {
        socket?.close(1000, "bye")
        socket = null
        closedDeferred.complete(Unit)
      }
    }

    private fun buildClient(): OkHttpClient {
      val builder =
        OkHttpClient
          .Builder()
          .writeTimeout(60, java.util.concurrent.TimeUnit.SECONDS)
          .readTimeout(0, java.util.concurrent.TimeUnit.SECONDS)
          .pingInterval(30, java.util.concurrent.TimeUnit.SECONDS)
      val tlsConfig =
        buildGatewayTlsConfig(tls) { fingerprint ->
          onTlsFingerprint?.invoke(tls?.stableId ?: endpoint.stableId, fingerprint)
        }
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
        scope.launch {
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
        scope.launch { handleMessage(text) }
      }

      override fun onFailure(
        webSocket: WebSocket,
        t: Throwable,
        response: Response?,
      ) {
        if (!connectDeferred.isCompleted) {
          connectDeferred.completeExceptionally(t)
        }
        if (isClosed.compareAndSet(false, true)) {
          failPending()
          closedDeferred.complete(Unit)
          onDisconnected("Gateway error: ${t.message ?: t::class.java.simpleName}")
        }
      }

      override fun onClosed(
        webSocket: WebSocket,
        code: Int,
        reason: String,
      ) {
        if (!connectDeferred.isCompleted) {
          connectDeferred.completeExceptionally(IllegalStateException("Gateway closed: $reason"))
        }
        if (isClosed.compareAndSet(false, true)) {
          failPending()
          closedDeferred.complete(Unit)
          onDisconnected("Gateway closed: $reason")
        }
      }
    }

    private suspend fun sendConnect(connectNonce: String) {
      val identity = identityStore.loadOrCreate()
      val storedToken = deviceAuthStore.loadToken(identity.deviceId, options.role)?.trim()
      val selectedAuth =
        selectConnectAuth(
          endpoint = endpoint,
          tls = tls,
          role = options.role,
          explicitGatewayToken = token?.trim()?.takeIf { it.isNotEmpty() },
          explicitBootstrapToken = bootstrapToken?.trim()?.takeIf { it.isNotEmpty() },
          explicitPassword = password?.trim()?.takeIf { it.isNotEmpty() },
          storedToken = storedToken?.takeIf { it.isNotEmpty() },
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
      val res = request("connect", payload, timeoutMs = CONNECT_RPC_TIMEOUT_MS)
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
          deviceAuthStore.clearToken(identity.deviceId, options.role)
        }
        throw GatewayConnectFailure(error)
      }
      handleConnectSuccess(res, identity.deviceId, selectedAuth.authSource)
      connectDeferred.complete(Unit)
    }

    private fun shouldPersistBootstrapHandoffTokens(authSource: GatewayConnectAuthSource): Boolean {
      if (authSource != GatewayConnectAuthSource.BOOTSTRAP_TOKEN) return false
      if (isLoopbackGatewayHost(endpoint.host)) return true
      return tls != null
    }

    private fun filteredBootstrapHandoffScopes(
      role: String,
      scopes: List<String>,
    ): List<String>? =
      when (role.trim()) {
        "node" -> emptyList()
        "operator" -> {
          val allowedOperatorScopes =
            setOf(
              "operator.approvals",
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
      deviceAuthStore.saveToken(deviceId, role, token, filteredScopes)
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
      deviceAuthStore.saveToken(deviceId, role, token, scopes)
    }

    private fun handleConnectSuccess(
      res: RpcResponse,
      deviceId: String,
      authSource: GatewayConnectAuthSource,
    ) {
      val payloadJson = res.payloadJson ?: throw IllegalStateException("connect failed: missing payload")
      val obj = json.parseToJsonElement(payloadJson).asObjectOrNull() ?: throw IllegalStateException("connect failed")
      pendingDeviceTokenRetry = false
      deviceTokenRetryBudgetUsed = false
      reconnectPausedForAuthFailure = false
      val serverName = obj["server"].asObjectOrNull()?.get("host").asStringOrNull()
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
      val rawCanvas = obj["canvasHostUrl"].asStringOrNull()
      canvasHostUrl = normalizeCanvasHostUrl(rawCanvas, endpoint, isTlsConnection = tls != null)
      val sessionDefaults =
        obj["snapshot"]
          .asObjectOrNull()
          ?.get("sessionDefaults")
          .asObjectOrNull()
      mainSessionKey = sessionDefaults?.get("mainSessionKey").asStringOrNull()
      onConnected(serverName, remoteAddress, mainSessionKey)
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

      val signedAtMs = System.currentTimeMillis()
      val payload =
        DeviceAuthPayload.buildV3(
          deviceId = identity.deviceId,
          clientId = client.id,
          clientMode = client.mode,
          role = options.role,
          scopes = options.scopes,
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
        put("minProtocol", JsonPrimitive(GATEWAY_PROTOCOL_VERSION))
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
        if (options.scopes.isNotEmpty()) put("scopes", JsonArray(options.scopes.map(::JsonPrimitive)))
        authJson?.let { put("auth", it) }
        deviceJson?.let { put("device", it) }
        put("locale", JsonPrimitive(locale))
        options.userAgent?.trim()?.takeIf { it.isNotEmpty() }?.let {
          put("userAgent", JsonPrimitive(it))
        }
      }
    }

    private suspend fun handleMessage(text: String) {
      val frame = json.parseToJsonElement(text).asObjectOrNull() ?: return
      when (frame["type"].asStringOrNull()) {
        "res" -> handleResponse(frame)
        "event" -> handleEvent(frame)
      }
    }

    private fun handleResponse(frame: JsonObject) {
      val id = frame["id"].asStringOrNull() ?: return
      val ok = frame["ok"].asBooleanOrNull() ?: false
      val payloadJson = frame["payload"]?.let { payload -> payload.toString() }
      val error =
        frame["error"]?.asObjectOrNull()?.let { obj ->
          val code = obj["code"].asStringOrNull() ?: "UNAVAILABLE"
          val msg = obj["message"].asStringOrNull() ?: "request failed"
          val detailObj = obj["details"].asObjectOrNull()
          val details =
            detailObj?.let {
              GatewayConnectErrorDetails(
                code = it["code"].asStringOrNull(),
                canRetryWithDeviceToken = it["canRetryWithDeviceToken"].asBooleanOrNull() == true,
                recommendedNextStep = it["recommendedNextStep"].asStringOrNull(),
                reason = it["reason"].asStringOrNull(),
              )
            }
          ErrorShape(code, msg, details)
        }
      pending.remove(id)?.complete(RpcResponse(id, ok, payloadJson, error))
    }

    private fun handleEvent(frame: JsonObject) {
      val event = frame["event"].asStringOrNull() ?: return
      val payloadJson =
        frame["payload"]?.let { it.toString() } ?: frame["payloadJSON"].asStringOrNull()
      if (event == "connect.challenge") {
        val nonce = extractConnectNonce(payloadJson)
        if (!connectNonceDeferred.isCompleted && !nonce.isNullOrBlank()) {
          connectNonceDeferred.complete(nonce.trim())
        }
        return
      }
      if (event == "node.invoke.request" && payloadJson != null && onInvoke != null) {
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
        try {
          json.parseToJsonElement(payloadJson).asObjectOrNull()
        } catch (_: Throwable) {
          null
        } ?: return
      val id = payload["id"].asStringOrNull() ?: return
      val nodeId = payload["nodeId"].asStringOrNull() ?: return
      val command = payload["command"].asStringOrNull() ?: return
      val params =
        payload["paramsJSON"].asStringOrNull()
          ?: payload["params"]?.let { value -> if (value is JsonNull) null else value.toString() }
      val timeoutMs = payload["timeoutMs"].asLongOrNull()
      scope.launch {
        val result =
          try {
            onInvoke?.invoke(InvokeRequest(id, nodeId, command, params, timeoutMs))
              ?: InvokeResult.error("UNAVAILABLE", "invoke handler missing")
          } catch (err: Throwable) {
            invokeErrorFromThrowable(err)
          }
        sendInvokeResult(id, nodeId, result, timeoutMs)
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
        buildJsonObject {
          put("id", JsonPrimitive(id))
          put("nodeId", JsonPrimitive(nodeId))
          put("ok", JsonPrimitive(result.ok))
          if (parsedPayload != null) {
            put("payload", parsedPayload)
          } else if (result.payloadJson != null) {
            put("payloadJSON", JsonPrimitive(result.payloadJson))
          }
          result.error?.let { err ->
            put(
              "error",
              buildJsonObject {
                put("code", JsonPrimitive(err.code))
                put("message", JsonPrimitive(err.message))
              },
            )
          }
        }
      val ackTimeoutMs = resolveInvokeResultAckTimeoutMs(invokeTimeoutMs)
      try {
        request("node.invoke.result", params, timeoutMs = ackTimeoutMs)
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
      for ((_, waiter) in pending) {
        waiter.cancel()
      }
      pending.clear()
    }
  }

  private suspend fun runLoop() {
    var attempt = 0
    while (scope.isActive) {
      val target = desired
      if (target == null) {
        currentConnection?.closeQuietly()
        currentConnection = null
        delay(250)
        continue
      }
      if (reconnectPausedForAuthFailure) {
        delay(250)
        continue
      }

      try {
        onDisconnected(if (attempt == 0) "Connecting…" else "Reconnecting…")
        connectOnce(target)
        attempt = 0
      } catch (err: Throwable) {
        attempt += 1
        onDisconnected("Gateway error: ${err.message ?: err::class.java.simpleName}")
        if (
          err is GatewayConnectFailure &&
          shouldPauseReconnectAfterAuthFailure(err.gatewayError)
        ) {
          reconnectPausedForAuthFailure = true
          continue
        }
        val sleepMs = minOf(8_000L, (350.0 * Math.pow(1.7, attempt.toDouble())).toLong())
        delay(sleepMs)
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
      currentConnection = conn
      try {
        conn.connect()
        conn.awaitClose()
      } finally {
        currentConnection = null
        canvasHostUrl = null
        mainSessionKey = null
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
    return error.details?.canRetryWithDeviceToken == true ||
      recommendedNextStep == "retry_with_device_token" ||
      detailCode == "AUTH_TOKEN_MISMATCH"
  }

  private fun shouldPauseReconnectAfterAuthFailure(error: ErrorShape): Boolean =
    when (error.details?.code) {
      "AUTH_TOKEN_MISSING",
      "AUTH_BOOTSTRAP_TOKEN_INVALID",
      "AUTH_PASSWORD_MISSING",
      "AUTH_PASSWORD_MISMATCH",
      "AUTH_RATE_LIMITED",
      "PAIRING_REQUIRED",
      "CONTROL_UI_DEVICE_IDENTITY_REQUIRED",
      "DEVICE_IDENTITY_REQUIRED",
      -> true
      "AUTH_TOKEN_MISMATCH" -> deviceTokenRetryBudgetUsed && !pendingDeviceTokenRetry
      else -> false
    }

  private fun shouldClearStoredDeviceTokenAfterRetry(error: ErrorShape): Boolean = error.details?.code == "AUTH_DEVICE_TOKEN_MISMATCH"

  private fun isTrustedDeviceRetryEndpoint(
    endpoint: GatewayEndpoint,
    tls: GatewayTlsParams?,
  ): Boolean {
    if (isLoopbackGatewayHost(endpoint.host)) {
      return true
    }
    return tls?.expectedFingerprint?.trim()?.isNotEmpty() == true
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

private fun parseJsonOrNull(payload: String): JsonElement? {
  val trimmed = payload.trim()
  if (trimmed.isEmpty()) return null
  return try {
    Json.parseToJsonElement(trimmed)
  } catch (_: Throwable) {
    null
  }
}

internal fun replaceCanvasCapabilityInScopedHostUrl(
  scopedUrl: String,
  capability: String,
): String? {
  val marker = "/__openclaw__/cap/"
  val markerStart = scopedUrl.indexOf(marker)
  if (markerStart < 0) return null
  val capabilityStart = markerStart + marker.length
  val slashEnd = scopedUrl.indexOf("/", capabilityStart).takeIf { it >= 0 }
  val queryEnd = scopedUrl.indexOf("?", capabilityStart).takeIf { it >= 0 }
  val fragmentEnd = scopedUrl.indexOf("#", capabilityStart).takeIf { it >= 0 }
  val capabilityEnd = listOfNotNull(slashEnd, queryEnd, fragmentEnd).minOrNull() ?: scopedUrl.length
  if (capabilityEnd <= capabilityStart) return null
  return scopedUrl.substring(0, capabilityStart) + capability + scopedUrl.substring(capabilityEnd)
}

internal fun resolveInvokeResultAckTimeoutMs(invokeTimeoutMs: Long?): Long {
  val normalized = invokeTimeoutMs?.takeIf { it > 0L } ?: 15_000L
  return normalized.coerceIn(15_000L, 120_000L)
}
