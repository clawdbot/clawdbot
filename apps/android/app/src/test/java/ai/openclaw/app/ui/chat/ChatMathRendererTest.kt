package ai.openclaw.app.ui.chat

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotEquals
import org.junit.Test

class ChatMathRendererTest {
  @Test
  fun queuePreservesOrderAndDeduplicatesMatchingJobs() {
    val harness = RenderHarness()
    val results = mutableListOf<String>()
    val first = request("first")
    val second = request("second")

    harness.coordinator.render(first) { result -> results.add("a:${result.value()}") }
    harness.coordinator.render(first) { result -> results.add("b:${result.value()}") }
    harness.coordinator.render(second) { result -> results.add("c:${result.value()}") }

    assertEquals(listOf(first), harness.backend.requests)
    harness.backend.complete(ChatMathRenderResult.Success("one"))
    assertEquals(listOf(first, second), harness.backend.requests)
    assertEquals(listOf("a:one", "b:one"), results)
    harness.backend.complete(ChatMathRenderResult.Success("two"))
    assertEquals(listOf("a:one", "b:one", "c:two"), results)
  }

  @Test
  fun cacheKeyBucketsWidthAndIncludesDarkMode() {
    val lightA = request("x", widthPx = 321, darkMode = false)
    val lightB = request("x", widthPx = 350, darkMode = false)
    val dark = request("x", widthPx = 321, darkMode = true)

    assertEquals(lightA.key, lightB.key)
    assertNotEquals(lightA.key, dark.key)
  }

  @Test
  fun presentationChangeWithSameKeyRendersAgain() {
    val harness = RenderHarness()
    val first = request("x")
    val recolored = first.copy(textColor = 0xffffffff.toInt())

    harness.coordinator.render(first) {}
    harness.backend.complete(ChatMathRenderResult.Success("first"))
    harness.coordinator.render(recolored) {}

    assertEquals(first.key, recolored.key)
    assertEquals(listOf(first, recolored), harness.backend.requests)
  }

  @Test
  fun negativeResultsAreCachedWithoutAnotherBackendJob() {
    val harness = RenderHarness()
    val request = request("bad")
    val results = mutableListOf<ChatMathRenderResult<String>>()

    harness.coordinator.render(request, results::add)
    harness.backend.complete(ChatMathRenderResult.Failure)
    harness.coordinator.render(request, results::add)

    assertEquals(1, harness.backend.requests.size)
    assertEquals(listOf(ChatMathRenderResult.Failure, ChatMathRenderResult.Failure), results)
  }

  @Test
  fun transientFailuresCanRetryTheSameKey() {
    val harness = RenderHarness()
    val request = request("retry")

    harness.coordinator.render(request) {}
    harness.backend.complete(ChatMathRenderResult.TransientFailure)
    harness.coordinator.render(request) {}

    assertEquals(listOf(request, request), harness.backend.requests)
  }

  @Test
  fun cancelDropsQueuedJobWithoutInterruptingActiveCacheWarmup() {
    val harness = RenderHarness()
    val first = request("first")
    val canceled = request("canceled")
    val last = request("last")

    harness.coordinator.render(first) {}
    harness.coordinator.render(canceled) {}.cancel()
    harness.coordinator.render(last) {}
    harness.backend.complete(ChatMathRenderResult.Success("one"))

    assertEquals(listOf(first, last), harness.backend.requests)
  }

  @Test
  fun timeoutFailsCurrentJobAndAdvancesQueue() {
    val harness = RenderHarness()
    val results = mutableListOf<ChatMathRenderResult<String>>()
    val first = request("first")
    val second = request("second")

    harness.coordinator.render(first, results::add)
    harness.coordinator.render(second, results::add)
    harness.scheduler.fire()

    assertEquals(listOf(ChatMathRenderResult.TransientFailure), results)
    assertEquals(listOf(first, second), harness.backend.requests)
  }

  @Test
  fun staleCompletionAfterTimeoutCannotCompleteRetry() {
    val harness = RenderHarness()
    val firstResults = mutableListOf<ChatMathRenderResult<String>>()
    val retryResults = mutableListOf<ChatMathRenderResult<String>>()
    val request = request("retry")

    harness.coordinator.render(request, firstResults::add)
    val staleCompletion = harness.backend.completions.removeAt(0)
    harness.scheduler.fire()
    harness.coordinator.render(request, retryResults::add)
    staleCompletion(ChatMathRenderResult.Success("stale"))

    assertEquals(listOf(ChatMathRenderResult.TransientFailure), firstResults)
    assertEquals(emptyList<ChatMathRenderResult<String>>(), retryResults)
    harness.backend.complete(ChatMathRenderResult.Success("fresh"))
    assertEquals(listOf(ChatMathRenderResult.Success("fresh")), retryResults)
  }

  private class RenderHarness {
    val backend = FakeBackend()
    val cache = FakeCache()
    val scheduler = FakeScheduler()
    val coordinator = ChatMathRenderCoordinator(backend, cache, scheduler)
  }

  private class FakeBackend : ChatMathRenderBackend<String> {
    val requests = mutableListOf<ChatMathRenderRequest>()
    val completions = mutableListOf<(ChatMathRenderResult<String>) -> Unit>()

    override fun render(
      request: ChatMathRenderRequest,
      completion: (ChatMathRenderResult<String>) -> Unit,
    ) {
      requests.add(request)
      completions.add(completion)
    }

    fun complete(result: ChatMathRenderResult<String>) {
      completions.removeAt(0).invoke(result)
    }
  }

  private class FakeCache : ChatMathRenderCache<String> {
    private val entries = mutableMapOf<ChatMathRenderRequest, ChatMathCacheEntry<String>>()

    override fun get(request: ChatMathRenderRequest): ChatMathCacheEntry<String> = entries[request] ?: ChatMathCacheEntry.Missing

    override fun put(
      request: ChatMathRenderRequest,
      result: ChatMathRenderResult<String>,
    ) {
      entries[request] =
        when (result) {
          is ChatMathRenderResult.Success -> ChatMathCacheEntry.Success(result.value)
          ChatMathRenderResult.Failure -> ChatMathCacheEntry.Failure
          ChatMathRenderResult.TransientFailure -> ChatMathCacheEntry.Missing
        }
    }
  }

  private class FakeScheduler : ChatMathTimeoutScheduler {
    private var action: (() -> Unit)? = null

    override fun schedule(
      delayMs: Long,
      action: () -> Unit,
    ): ChatMathTimeout {
      this.action = action
      return ChatMathTimeout { if (this.action === action) this.action = null }
    }

    fun fire() {
      val pending = action
      action = null
      checkNotNull(pending).invoke()
    }
  }

  private fun ChatMathRenderResult<String>.value(): String =
    when (this) {
      is ChatMathRenderResult.Success -> value
      ChatMathRenderResult.Failure -> "failure"
      ChatMathRenderResult.TransientFailure -> "transient failure"
    }

  private fun request(
    latex: String,
    widthPx: Int = 321,
    darkMode: Boolean = false,
  ): ChatMathRenderRequest =
    ChatMathRenderRequest.create(
      latex = latex,
      widthPx = widthPx,
      darkMode = darkMode,
      textColor = 0xff000000.toInt(),
      fontSizePx = 16f,
      density = 1f,
    )
}
