package ai.openclaw.app.gateway

import kotlinx.coroutines.suspendCancellableCoroutine
import okhttp3.Call
import okhttp3.Callback
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import okhttp3.Response
import okio.Buffer
import java.io.IOException
import java.util.concurrent.TimeUnit
import kotlin.coroutines.resume
import kotlin.coroutines.resumeWithException

/** A physical-connection-bound HTTP route; never logs the SDP or bearer capability. */
internal class GatewayRealtimeOffer(
  private val url: String,
  client: OkHttpClient,
  private val transportHeaders: Map<String, String>,
  private val isCurrent: () -> Boolean,
) {
  private val client =
    client
      .newBuilder()
      .followRedirects(false)
      .followSslRedirects(false)
      .callTimeout(30, TimeUnit.SECONDS)
      .build()

  suspend fun exchange(
    secret: String,
    headers: Map<String, String>,
    sdp: String,
  ): String =
    suspendCancellableCoroutine { continuation ->
      if (!isCurrent()) {
        continuation.resumeWithException(IOException("Gateway connection changed"))
        return@suspendCancellableCoroutine
      }
      val request = Request.Builder().url(url).post(sdp.toRequestBody("application/sdp".toMediaType()))
      for ((name, value) in transportHeaders + headers) {
        if (!name.equals("Authorization", true) && !name.equals("Content-Type", true)) request.header(name, value)
      }
      request.header("Authorization", "Bearer $secret")
      val call = client.newCall(request.build())
      continuation.invokeOnCancellation { call.cancel() }
      call.enqueue(
        object : Callback {
          override fun onFailure(
            call: Call,
            e: IOException,
          ) {
            if (continuation.isActive) continuation.resumeWithException(IOException("Realtime offer exchange failed"))
          }

          override fun onResponse(
            call: Call,
            response: Response,
          ) {
            try {
              val answer =
                response.use {
                  check(it.isSuccessful) { "Realtime offer rejected (HTTP ${it.code})" }
                  val body = it.body
                  check(body.contentLength() <= 262_144) { "Realtime answer exceeds limit" }
                  val buffer = Buffer()
                  val source = body.source()
                  while (source.read(buffer, minOf(8192, 262_145 - buffer.size)) != -1L) {
                    check(buffer.size <= 262_144) { "Realtime answer exceeds limit" }
                  }
                  buffer.readUtf8().also { text -> check(text.startsWith("v=0")) { "Invalid realtime SDP answer" } }
                }
              check(isCurrent()) { "Gateway connection changed" }
              if (continuation.isActive) continuation.resume(answer)
            } catch (_: Exception) {
              if (continuation.isActive) continuation.resumeWithException(IOException("Realtime offer rejected or invalid answer"))
            }
          }
        },
      )
    }
}
