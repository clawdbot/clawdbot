package ai.openclaw.app.ui.chat

import org.json.JSONObject

internal enum class ChatRichBlockKind(
  val assetDirectory: String,
  val entryPoint: String,
  val bridgeName: String,
  val timeoutMillis: Long,
  val cacheBytes: Int,
  val maxBitmapPixels: Int,
) {
  Math("katex", "renderMath", "ChatMathBridge", 3_000, 4 * 1024 * 1024, 1024 * 1024),

  // The shared Mermaid renderer has a 15 s watchdog; leave time for its result and image decode.
  Mermaid("mermaid", "renderMermaid", "ChatMermaidBridge", 20_000, 12 * 1024 * 1024, 4 * 1024 * 1024),
}

internal sealed interface ChatRichBlockRequest {
  val kind: ChatRichBlockKind
  val source: String
  val widthPx: Int
  val density: Float

  fun payload(id: String): JSONObject
}

internal sealed interface ChatRichBlockResult<out T> {
  data class Success<T>(
    val value: T,
  ) : ChatRichBlockResult<T>

  data object Failure : ChatRichBlockResult<Nothing>

  data object TransientFailure : ChatRichBlockResult<Nothing>
}

internal interface ChatRichBlockCache<T> {
  fun get(request: ChatRichBlockRequest): ChatRichBlockResult<T>?

  fun put(
    request: ChatRichBlockRequest,
    result: ChatRichBlockResult<T>,
  )
}

internal interface ChatRichBlockBackend<T> {
  fun render(
    request: ChatRichBlockRequest,
    completion: (ChatRichBlockResult<T>) -> Unit,
  )

  fun reset()
}

internal fun interface ChatRenderCancellation {
  fun cancel()
}

internal fun interface ChatRenderTimeoutScheduler {
  fun schedule(
    delayMs: Long,
    action: () -> Unit,
  ): ChatRenderCancellation
}

/** Owns deduplication and late completion fencing for one bounded local renderer. */
internal class ChatRichBlockCoordinator<T>(
  private val backend: ChatRichBlockBackend<T>,
  private val cache: ChatRichBlockCache<T>,
  private val timeoutScheduler: ChatRenderTimeoutScheduler,
) {
  private val queued = LinkedHashMap<ChatRichBlockRequest, PendingRender<T>>()
  private var active: PendingRender<T>? = null
  private var callbackId = 0L
  private var attemptId = 0L
  private var timeout: ChatRenderCancellation? = null
  private var pumping = false

  fun render(
    request: ChatRichBlockRequest,
    completion: (ChatRichBlockResult<T>) -> Unit,
  ): ChatRenderCancellation {
    cache.get(request)?.let { cached ->
      completion(cached)
      return ChatRenderCancellation {}
    }
    val id = ++callbackId
    val pending = active?.takeIf { it.request == request } ?: queued[request]
    if (pending != null) {
      pending.callbacks[id] = completion
    } else if (request.kind == ChatRichBlockKind.Mermaid && queued.size >= MAX_QUEUED_DIAGRAMS) {
      // Diagrams expose a retry action. Preserve math's existing admission
      // behavior so visible formulas cannot become permanent source fallbacks.
      completion(ChatRichBlockResult.TransientFailure)
    } else {
      queued[request] = PendingRender(request, linkedMapOf(id to completion))
      pump()
    }
    return ChatRenderCancellation {
      active?.callbacks?.remove(id)
      val iterator = queued.iterator()
      while (iterator.hasNext()) {
        val item = iterator.next().value
        item.callbacks.remove(id)
        if (item.callbacks.isEmpty()) iterator.remove()
      }
    }
  }

  private fun pump() {
    if (pumping) return
    pumping = true
    try {
      // Host loss can fail queued work synchronously. Drain iteratively so a
      // large transcript cannot exhaust the main-thread stack during teardown.
      while (active == null) {
        val next = queued.entries.firstOrNull() ?: break
        queued.remove(next.key)
        active = next.value
        val currentAttempt = ++attemptId
        timeout =
          timeoutScheduler.schedule(next.key.kind.timeoutMillis) {
            if (currentAttempt != attemptId || active == null) return@schedule
            // Retire the document before admitting another request: a timed-out script must
            // not repaint the next job or retain its native completion capability.
            backend.reset()
            finish(currentAttempt, ChatRichBlockResult.TransientFailure)
          }
        backend.render(next.value.request) { result -> finish(currentAttempt, result) }
      }
    } finally {
      pumping = false
    }
  }

  private fun finish(
    currentAttempt: Long,
    result: ChatRichBlockResult<T>,
  ) {
    if (currentAttempt != attemptId) return
    val current = active ?: return
    timeout?.cancel()
    timeout = null
    active = null
    cache.put(current.request, result)
    current.callbacks.values
      .toList()
      .forEach { callback -> callback(result) }
    pump()
  }

  private data class PendingRender<T>(
    val request: ChatRichBlockRequest,
    val callbacks: MutableMap<Long, (ChatRichBlockResult<T>) -> Unit>,
  )

  private companion object {
    const val MAX_QUEUED_DIAGRAMS = 32
  }
}
