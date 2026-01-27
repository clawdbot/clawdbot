package com.clawdbot.android.gateway

import android.util.Log
import java.util.Locale
import java.util.UUID
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.atomic.AtomicBoolean
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

class GatewaySession(
  private val scope: CoroutineScope,
  private val identityStore: DeviceIdentityStore,
  private val deviceAuthStore: DeviceAuthStore,
  private val onConnected: (serverName: String?, remoteAddress: String?, mainSessionKey: String?) -> Unit,
  private val onDisconnected: (message: String) -> Unit,
  private val onEvent: (event: String, payloadJson: String?) -> Unit,
  private val onInvoke: (suspend (InvokeRequest) -> InvokeResult)? = null,
  private val onTlsFingerprint: ((stableId: String, fingerprint: String) -> Unit)? = null,
) {
  data class InvokeRequest(
    val id: String,
    val nodeId: String,
    val command: String,
    val paramsJson: String?,
    val timeoutMs: Long?,
  )

  data class InvokeResult(val ok: Boolean, val payloadJson: String?, val error: ErrorShape?) {
    companion object {
      fun ok(payloadJson: String?) = InvokeResult(ok = true, payloadJson = payloadJson, error = null)
      fun error(code: String, message: String) =
        InvokeResult(ok = false, payloadJson = null, error = ErrorShape(code = code, message = message))
    }
  }

  data class ErrorShape(val code: String, val message: String)

  private val json = Json { ignoreUnknownKeys = true }
  private val writeLock = Mutex()
  private val pending = ConcurrentHashMap<String, CompletableDeferred<RpcResponse>>()

  @Volatile private var canvasHostUrl: String? = null
  @Volatile private var mainSessionKey: String? = null

  private data class DesiredConnection(
    val endpoint: GatewayEndpoint,
    val token: String?,
    val password: String?,
    val options: GatewayConnectOptions,
    val tls: GatewayTlsParams?,
  )

  private var desired: DesiredConnection? = null
  private var job: Job? = null
  @Volatile private var currentConnection: Connection? = null

  fun connect(
    endpoint: GatewayEndpoint,
    token: String?,
    password: String?,
    options: GatewayConnectOptions,
    tls: GatewayTlsParams? = null,
  ) {
    desired = DesiredConnection(endpoint, token, password, options, tls)
    if (job == null) {
      job = scope.launch(Dispatchers.IO) { runLoop() }
    }
  }

  fun disconnect() {
    desired = null
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
    currentConnection?.closeQuietly()
  }

  fun currentCanvasHostUrl(): String? = canvasHostUrl
  fun currentMainSessionKey(): String? = mainSessionKey

  suspend fun sendNodeEvent(event: String, payloadJson: String?) {
    val conn = currentConnection ?: return
    val parsedPayload = payloadJson?.let { parseJsonOrNull(it) }
    val params =
      buildJsonObject {
        put("event", JsonPrimitive(event))
        if (parsedPayload != null) {
          put("payload", parsedPayload)
        } else if (payloadJson != null) {
          put("payloadJSON", JsonPrimitive(payloadJson))
        } else {
          put("payloadJSON", JsonNull)
        }
      }
    try {
      conn.request("node.event", params, timeoutMs = 8_000)
    } catch (err: Throwable) {
      Log.w("MoltbotGateway", "node.event failed: ${err.message ?: err::class.java.simpleName}")
    }
  }

  suspend fun request(method: String, paramsJson: String?, timeoutMs: Long = 15_000): String {
    val conn = currentConnection ?: throw IllegalStateException("not connected")
    val params =
      if (paramsJson.isNullOrBlank()) {
        null
      } else {
        json.parseToJsonElement(paramsJson)
      }
    val res = conn.request(method, params, timeoutMs)
    if (res.ok) return res.payloadJson ?: ""
    val err = res.error
    throw IllegalStateException("${err?.code ?: "UNAVAILABLE"}: ${err?.message ?: "request failed"}")
  }

  private data class RpcResponse(val id: String, val ok: Boolean, val payloadJson: String?, val error: ErrorShape?)

  private inner class Connection(
    private val endpoint: GatewayEndpoint,
    private val token: String?,
    private val password: String?,
    private val options: GatewayConnectOptions,
    private val tls: GatewayTlsParams?,
  ) {
    private val connectDeferred = CompletableDeferred<Unit>()
    private val closedDeferred = CompletableDeferred<Unit>()
    private val isClosed = AtomicBoolean(false)
    private val connectNonceDeferred = CompletableDeferred<String?>()
    private val client: OkHttpClient = buildClient()
    private var socket: WebSocket? = null
    private val loggerTag = "MoltbotGateway"

    val remoteAddress: String =
      if (endpoint.host.contains(":")) {
        "[${endpoint.host}]:${endpoint.port}"
      } else {
        "${endpoint.host}:${endpoint.port}"
      }

    suspend fun connect() {
      val scheme = if (tls != null) "wss" else "ws"
      val url = "$scheme://${endpoint.host}:${endpoint.port}"
      val request = Request.Builder().url(url).build()
      socket = client.newWebSocket(request, Listener())
      try {
        connectDeferred.await()
      } catch (err: Throwable) {
        throw err
      }
    }

    suspend fun request(method: String, params: JsonElement?, timeoutMs: Long): RpcResponse {
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
      val builder = OkHttpClient.Builder()
      val tlsConfig = buildGatewayTlsConfig(tls) { fingerprint ->
        onTlsFingerprint?.invoke(tls?.stableId ?: endpoint.stableId, fingerprint)
      }
      if (tlsConfig != null) {
        builder.sslSocketFactory(tlsConfig.sslSocketFactory, tlsConfig.trustManager)
        builder.hostnameVerifier(tlsConfig.hostnameVerifier)
      }
      return builder.build()
    }

    private inner class Listener : WebSocketListener() {
      override fun onOpen(webSocket: WebSocket, response: Response) {
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

      override fun onMessage(webSocket: WebSocket, text: String) {
        scope.launch { handleMessage(text) }
      }

      override fun onFailure(webSocket: WebSocket, t: Throwable, response: Response?) {
        if (!connectDeferred.isCompleted) {
          connectDeferred.completeExceptionally(t)
        }
        if (isClosed.compareAndSet(false, true)) {
          failPending()
          closedDeferred.complete(Unit)
          onDisconnected("Gateway error: ${t.message ?: t::class.java.simpleName}")
        }
      }

      override fun onClosed(webSocket: WebSocket, code: Int, reason: String) {
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

    private suspend fun sendConnect(connectNonce: String?) {
      val identity = identityStore.loadOrCreate()
      val storedToken = deviceAuthStore.loadToken(identity.deviceId, options.role)
      val trimmedToken = token?.trim().orEmpty()
      val authToken = if (storedToken.isNullOrBlank()) trimmedToken else storedToken
      val canFallbackToShared = !storedToken.isNullOrBlank() && trimmedToken.isNotBlank()
      val payload = buildConnectParams(identity, connectNonce, authToken, password?.trim())
      val res = request("connect", payload, timeoutMs = 8_000)
      if (!res.ok) {
        val msg = res.error?.message ?: "connect failed"
        if (canFallbackToShared) {
          deviceAuthStore.clearToken(identity.deviceId, options.role)
        }
        throw IllegalStateException(msg)
      }
      val payloadJson = res.payloadJson ?: throw IllegalStateException("connect failed: missing payload")
      val obj = json.parseToJsonElement(payloadJson).asObjectOrNull() ?: throw IllegalStateException("connect failed")
      val serverName = obj["server"].asObjectOrNull()?.get("host").asStringOrNull()
      val authObj = obj["auth"].asObjectOrNull()
      val deviceToken = authObj?.get("deviceToken").asStringOrNull()
      val authRole = authObj?.get("role").asStringOrNull() ?: options.role
      if (!deviceToken.isNullOrBlank()) {
        deviceAuthStore.saveToken(identity.deviceId, authRole, deviceToken)
      }
      val rawCanvas = obj["canvasHostUrl"].asStringOrNull()
      canvasHostUrl = normalizeCanvasHostUrl(rawCanvas, endpoint)
      val sessionDefaults =
        obj["snapshot"].asObjectOrNull()
          ?.get("sessionDefaults").asObjectOrNull()
      mainSessionKey = sessionDefaults?.get("mainSessionKey").asStringOrNull()
      onConnected(serverName, remoteAddress, mainSessionKey)
      connectDeferred.complete(Unit)
    }

    private fun buildConnectParams(
      identity: DeviceIdentity,
      connectNonce: String?,
      authToken: String,
      authPassword: String?,
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

      val password = authPassword?.trim().orEmpty()
      val authJson =
        when {
          authToken.isNotEmpty() ->
            buildJsonObject {
              put("token", JsonPrimitive(authToken))
            }
          password.isNotEmpty() ->
            buildJsonObject {
              put("password", JsonPrimitive(password))
            }
          else -> null
        }

      val signedAtMs = System.currentTimeMillis()
      val payload =
        buildDeviceAuthPayload(
          deviceId = identity.deviceId,
          clientId = client.id,
          clientMode = client.mode,
          role = options.role,
          scopes = options.scopes,
          signedAtMs = signedAtMs,
          token = if (authToken.isNotEmpty()) authToken else null,
          nonce = connectNonce,
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
            if (!connectNonce.isNullOrBlank()) {
              put("nonce", JsonPrimitive(connectNonce))
            }
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
          ErrorShape(code, msg)
        }
      pending.remove(id)?.complete(RpcResponse(id, ok, payloadJson, error))
    }

    private fun handleEvent(frame: JsonObject) {
      val event = frame["event"].asStringOrNull() ?: return
      val payloadJson =
        frame["payload"]?.let { it.toString() } ?: frame["payloadJSON"].asStringOrNull()
      if (event == "connect.challenge") {
        val nonce = extractConnectNonce(payloadJson)
        if (!connectNonceDeferred.isCompleted) {
          connectNonceDeferred.complete(nonce)
        }
        return
      }
      if (event == "node.invoke.request" && payloadJson != null && onInvoke != null) {
        handleInvokeEvent(payloadJson)
        return
      }
      onEvent(event, payloadJson)
    }

    private suspend fun awaitConnectNonce(): String? {
      if (isLoopbackHost(endpoint.host)) return null
      return try {
        withTimeout(2_000) { connectNonceDeferred.await() }
      } catch (_: Throwable) {
        null
      }
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
        sendInvokeResult(id, nodeId, result)
      }
    }

    private suspend fun sendInvokeResult(id: String, nodeId: String, result: InvokeResult) {
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
      try {
        request("node.invoke.result", params, timeoutMs = 15_000)
      } catch (err: Throwable) {
        Log.w(loggerTag, "node.invoke.result failed: ${err.message ?: err::class.java.simpleName}")
      }
    }

    private fun invokeErrorFromThrowable(err: Throwable): InvokeResult {
      val msg = err.message?.trim().takeIf { !it.isNullOrEmpty() } ?: err::class.java.simpleName
      val parts = msg.split(":", limit = 2)
      if (parts.size == 2) {
        val code = parts[0].trim()
        val rest = parts[1].trim()
        if (code.isNotEmpty() && code.all { it.isUpperCase() || it == '_' }) {
          return InvokeResult.error(code = code, message = rest.ifEmpty { msg })
        }
      }
      return InvokeResult.error(code = "UNAVAILABLE", message = msg)
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

      try {
        onDisconnected(if (attempt == 0) "Connecting…" else "Reconnecting…")
        connectOnce(target)
        attempt = 0
      } catch (err: Throwable) {
        attempt += 1
        onDisconnected("Gateway error: ${err.message ?: err::class.java.simpleName}")
        val sleepMs = minOf(8_000L, (350.0 * Math.pow(1.7, attempt.toDouble())).toLong())
        delay(sleepMs)
      }
    }
  }

  private suspend fun connectOnce(target: DesiredConnection) = withContext(Dispatchers.IO) {
    val conn = Connection(target.endpoint, target.token, target.password, target.options, target.tls)
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

  private fun buildDeviceAuthPayload(
    deviceId: String,
    clientId: String,
    clientMode: String,
    role: String,
    scopes: List<String>,
    signedAtMs: Long,
    token: String?,
    nonce: String?,
  ): String {
    val scopeString = scopes.joinToString(",")
    val authToken = token.orEmpty()
    val version = if (nonce.isNullOrBlank()) "v1" else "v2"
    val parts =
      mutableListOf(
        version,
        deviceId,
        clientId,
        clientMode,
        role,
        scopeString,
        signedAtMs.toString(),
        authToken,
      )
    if (!nonce.isNullOrBlank()) {
      parts.add(nonce)
    }
    return parts.joinToString("|")
  }

  private fun normalizeCanvasHostUrl(raw: String?, endpoint: GatewayEndpoint): String? {
    val trimmed = raw?.trim().orEmpty()
    val parsed = trimmed.takeIf { it.isNotBlank() }?.let { runCatching { java.net.URI(it) }.getOrNull() }
    val host = parsed?.host?.trim().orEmpty()
    val port = parsed?.port ?: -1
    val scheme = parsed?.scheme?.trim().orEmpty().ifBlank { "http" }

    if (trimmed.isNotBlank() && !isLoopbackHost(host)) {
      return trimmed
    }

    val fallbackHost =
      endpoint.tailnetDns?.trim().takeIf { !it.isNullOrEmpty() }
        ?: endpoint.lanHost?.trim().takeIf { !it.isNullOrEmpty() }
        ?: endpoint.host.trim()
    if (fallbackHost.isEmpty()) return trimmed.ifBlank { null }

    val fallbackPort = endpoint.canvasPort ?: if (port > 0) port else 18793
    val formattedHost = if (fallbackHost.contains(":")) "[${fallbackHost}]" else fallbackHost
    return "$scheme://$formattedHost:$fallbackPort"
  }

  private fun isLoopbackHost(raw: String?): Boolean {
    val host = raw?.trim()?.lowercase().orEmpty()
    if (host.isEmpty()) return false
    if (host == "localhost") return true
    if (host == "::1") return true
    if (host == "0.0.0.0" || host == "::") return true
    return host.startsWith("127.")
  }
}

private fun JsonElement?.asObjectOrNull(): JsonObject? = this as? JsonObject

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
