package com.clawdbot.android.bridge

import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.cancelAndJoin
import kotlinx.coroutines.delay
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.coroutines.withContext
import com.clawdbot.android.BuildConfig
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import java.io.BufferedReader
import java.io.BufferedWriter
import java.io.InputStreamReader
import java.io.OutputStreamWriter
import java.net.InetSocketAddress
import java.net.URI
import java.net.Socket
import java.util.UUID
import java.util.concurrent.ConcurrentHashMap

class BridgeSession(
  private val scope: CoroutineScope,
  private val onConnected: (serverName: String, remoteAddress: String?, mainSessionKey: String?) -> Unit,
  private val onDisconnected: (message: String) -> Unit,
  private val onEvent: (event: String, payloadJson: String?) -> Unit,
  private val onInvoke: suspend (InvokeRequest) -> InvokeResult,
) {
  data class Hello(
    val nodeId: String,
    val displayName: String?,
    val token: String?,
    val platform: String?,
    val version: String?,
    val deviceFamily: String?,
    val modelIdentifier: String?,
    val caps: List<String>?,
    val commands: List<String>?,
  )

  data class InvokeRequest(val id: String, val command: String, val paramsJson: String?)

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

  private var desired: Pair<BridgeEndpoint, Hello>? = null
  private var job: Job? = null

  fun connect(endpoint: BridgeEndpoint, hello: Hello) {
    desired = endpoint to hello
    if (job == null) {
      job = scope.launch(Dispatchers.IO) { runLoop() }
    }
  }

  suspend fun updateHello(hello: Hello) {
    val target = desired ?: return
    desired = target.first to hello
    val conn = currentConnection ?: return
    conn.sendJson(buildHelloJson(hello))
  }

  fun disconnect() {
    desired = null
    // Unblock connectOnce() read loop. Coroutine cancellation alone won't interrupt BufferedReader.readLine().
    currentConnection?.closeQuietly()
    scope.launch(Dispatchers.IO) {
      job?.cancelAndJoin()
      job = null
      canvasHostUrl = null
      mainSessionKey = null
      onDisconnected("Offline")
    }
  }

  fun currentCanvasHostUrl(): String? = canvasHostUrl
  fun currentMainSessionKey(): String? = mainSessionKey

  suspend fun sendEvent(event: String, payloadJson: String?) {
    val conn = currentConnection ?: return
    conn.sendJson(
      buildJsonObject {
        put("type", JsonPrimitive("event"))
        put("event", JsonPrimitive(event))
        if (payloadJson != null) put("payloadJSON", JsonPrimitive(payloadJson)) else put("payloadJSON", JsonNull)
      },
    )
  }

  suspend fun request(method: String, paramsJson: String?): String {
    val conn = currentConnection ?: throw IllegalStateException("not connected")
    val id = UUID.randomUUID().toString()
    val deferred = CompletableDeferred<RpcResponse>()
    pending[id] = deferred
    conn.sendJson(
      buildJsonObject {
        put("type", JsonPrimitive("req"))
        put("id", JsonPrimitive(id))
        put("method", JsonPrimitive(method))
        if (paramsJson != null) put("paramsJSON", JsonPrimitive(paramsJson)) else put("paramsJSON", JsonNull)
      },
    )
    val res = deferred.await()
    if (res.ok) return res.payloadJson ?: ""
    val err = res.error
    throw IllegalStateException("${err?.code ?: "UNAVAILABLE"}: ${err?.message ?: "request failed"}")
  }

  private data class RpcResponse(val id: String, val ok: Boolean, val payloadJson: String?, val error: ErrorShape?)

  private class Connection(private val socket: Socket, private val reader: BufferedReader, private val writer: BufferedWriter, private val writeLock: Mutex) {
    val remoteAddress: String? =
      socket.inetAddress?.hostAddress?.takeIf { it.isNotBlank() }?.let { "${it}:${socket.port}" }

    suspend fun sendJson(obj: JsonObject) {
      writeLock.withLock {
        writer.write(obj.toString())
        writer.write("\n")
        writer.flush()
      }
    }

    fun closeQuietly() {
      try {
        socket.close()
      } catch (_: Throwable) {
        // ignore
      }
    }
  }

  @Volatile private var currentConnection: Connection? = null

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

      val (endpoint, hello) = target
      try {
        onDisconnected(if (attempt == 0) "Connecting…" else "Reconnecting…")
        connectOnce(endpoint, hello)
        attempt = 0
      } catch (err: Throwable) {
        attempt += 1
        onDisconnected("Bridge error: ${err.message ?: err::class.java.simpleName}")
        val sleepMs = minOf(8_000L, (350.0 * Math.pow(1.7, attempt.toDouble())).toLong())
        delay(sleepMs)
      }
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

  private suspend fun connectOnce(endpoint: BridgeEndpoint, hello: Hello) =
    withContext(Dispatchers.IO) {
      val socket = Socket()
      socket.tcpNoDelay = true
      socket.connect(InetSocketAddress(endpoint.host, endpoint.port), 8_000)
      socket.soTimeout = 0

      val reader = BufferedReader(InputStreamReader(socket.getInputStream(), Charsets.UTF_8))
      val writer = BufferedWriter(OutputStreamWriter(socket.getOutputStream(), Charsets.UTF_8))

      val conn = Connection(socket, reader, writer, writeLock)
      currentConnection = conn

      try {
        conn.sendJson(buildHelloJson(hello))

        val firstLine = reader.readLine() ?: throw IllegalStateException("bridge closed connection")
        val first = json.parseToJsonElement(firstLine).asObjectOrNull()
          ?: throw IllegalStateException("unexpected bridge response")
        when (first["type"].asStringOrNull()) {
          "hello-ok" -> {
            val name = first["serverName"].asStringOrNull() ?: "Bridge"
            val rawCanvasUrl = first["canvasHostUrl"].asStringOrNull()?.trim()?.ifEmpty { null }
            val rawMainSessionKey = first["mainSessionKey"].asStringOrNull()?.trim()?.ifEmpty { null }
            canvasHostUrl = normalizeCanvasHostUrl(rawCanvasUrl, endpoint)
            mainSessionKey = rawMainSessionKey
            if (BuildConfig.DEBUG) {
              // Local JVM unit tests use android.jar stubs; Log.d can throw "not mocked".
              runCatching {
                android.util.Log.d(
                  "ClawdbotBridge",
                  "canvasHostUrl resolved=${canvasHostUrl ?: "none"} (raw=${rawCanvasUrl ?: "none"})",
                )
              }
            }
            onConnected(name, conn.remoteAddress, rawMainSessionKey)
          }
          "error" -> {
            val code = first["code"].asStringOrNull() ?: "UNAVAILABLE"
            val msg = first["message"].asStringOrNull() ?: "connect failed"
            throw IllegalStateException("$code: $msg")
          }
          else -> throw IllegalStateException("unexpected bridge response")
        }

        while (scope.isActive) {
          val line = reader.readLine() ?: break
          val frame = json.parseToJsonElement(line).asObjectOrNull() ?: continue
          when (frame["type"].asStringOrNull()) {
            "event" -> {
              val event = frame["event"].asStringOrNull() ?: return@withContext
              val payload = frame["payloadJSON"].asStringOrNull()
              onEvent(event, payload)
            }
            "ping" -> {
              val id = frame["id"].asStringOrNull() ?: ""
              conn.sendJson(buildJsonObject { put("type", JsonPrimitive("pong")); put("id", JsonPrimitive(id)) })
            }
            "res" -> {
              val id = frame["id"].asStringOrNull() ?: continue
              val ok = frame["ok"].asBooleanOrNull() ?: false
              val payloadJson = frame["payloadJSON"].asStringOrNull()
              val error =
                frame["error"]?.let {
                  val obj = it.asObjectOrNull() ?: return@let null
                  val code = obj["code"].asStringOrNull() ?: "UNAVAILABLE"
                  val msg = obj["message"].asStringOrNull() ?: "request failed"
                  ErrorShape(code, msg)
                }
              pending.remove(id)?.complete(RpcResponse(id, ok, payloadJson, error))
            }
            "invoke" -> {
              val id = frame["id"].asStringOrNull() ?: continue
              val command = frame["command"].asStringOrNull() ?: ""
              val params = frame["paramsJSON"].asStringOrNull()
              val result =
                try {
                  onInvoke(InvokeRequest(id, command, params))
                } catch (err: Throwable) {
                  invokeErrorFromThrowable(err)
                }
              conn.sendJson(
                buildJsonObject {
                  put("type", JsonPrimitive("invoke-res"))
                  put("id", JsonPrimitive(id))
                  put("ok", JsonPrimitive(result.ok))
                  if (result.payloadJson != null) put("payloadJSON", JsonPrimitive(result.payloadJson))
                  if (result.error != null) {
                    put(
                      "error",
                      buildJsonObject {
                        put("code", JsonPrimitive(result.error.code))
                        put("message", JsonPrimitive(result.error.message))
                      },
                    )
                  }
                },
              )
            }
            "invoke-res" -> {
              // gateway->node only (ignore)
            }
          }
        }
      } finally {
        currentConnection = null
        for ((_, waiter) in pending) {
          waiter.cancel()
        }
        pending.clear()
        conn.closeQuietly()
      }
    }

  private fun buildHelloJson(hello: Hello): JsonObject =
    buildJsonObject {
      put("type", JsonPrimitive("hello"))
      put("nodeId", JsonPrimitive(hello.nodeId))
      hello.displayName?.let { put("displayName", JsonPrimitive(it)) }
      hello.token?.let { put("token", JsonPrimitive(it)) }
      hello.platform?.let { put("platform", JsonPrimitive(it)) }
      hello.version?.let { put("version", JsonPrimitive(it)) }
      hello.deviceFamily?.let { put("deviceFamily", JsonPrimitive(it)) }
      hello.modelIdentifier?.let { put("modelIdentifier", JsonPrimitive(it)) }
      hello.caps?.let { put("caps", JsonArray(it.map(::JsonPrimitive))) }
      hello.commands?.let { put("commands", JsonArray(it.map(::JsonPrimitive))) }
    }

  private fun normalizeCanvasHostUrl(raw: String?, endpoint: BridgeEndpoint): String? {
    val trimmed = raw?.trim().orEmpty()
    val parsed = trimmed.takeIf { it.isNotBlank() }?.let { runCatching { URI(it) }.getOrNull() }
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
