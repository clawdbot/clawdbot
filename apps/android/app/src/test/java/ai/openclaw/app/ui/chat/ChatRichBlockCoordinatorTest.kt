package ai.openclaw.app.ui.chat

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertNull
import org.junit.Test

class ChatRichBlockCoordinatorTest {
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
    harness.backend.complete(ChatRichBlockResult.Success("one"))
    assertEquals(listOf(first, second), harness.backend.requests)
    assertEquals(listOf("a:one", "b:one"), results)
    harness.backend.complete(ChatRichBlockResult.Success("two"))
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
    harness.backend.complete(ChatRichBlockResult.Success("first"))
    harness.coordinator.render(recolored) {}

    assertEquals(first.key, recolored.key)
    assertEquals(listOf(first, recolored), harness.backend.requests)
  }

  @Test
  fun negativeResultsAreCachedWithoutAnotherBackendJob() {
    val harness = RenderHarness()
    val request = request("bad")
    val results = mutableListOf<ChatRichBlockResult<String>>()

    harness.coordinator.render(request, results::add)
    harness.backend.complete(ChatRichBlockResult.Failure)
    harness.coordinator.render(request, results::add)

    assertEquals(1, harness.backend.requests.size)
    assertEquals(listOf(ChatRichBlockResult.Failure, ChatRichBlockResult.Failure), results)
  }

  @Test
  fun transientFailuresCanRetryTheSameKey() {
    val harness = RenderHarness()
    val request = request("retry")

    harness.coordinator.render(request) {}
    harness.backend.complete(ChatRichBlockResult.TransientFailure)
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
    harness.backend.complete(ChatRichBlockResult.Success("one"))

    assertEquals(listOf(first, last), harness.backend.requests)
  }

  @Test
  fun timeoutFailsCurrentJobAndAdvancesQueue() {
    val harness = RenderHarness()
    val results = mutableListOf<ChatRichBlockResult<String>>()
    val first = request("first")
    val second = request("second")

    harness.coordinator.render(first, results::add)
    harness.coordinator.render(second, results::add)
    harness.scheduler.fire()

    assertEquals(listOf(ChatRichBlockResult.TransientFailure), results)
    assertEquals(listOf(first, second), harness.backend.requests)
    assertEquals(listOf("render:first", "reset", "render:second"), harness.backend.events)
  }

  @Test
  fun staleCompletionAfterTimeoutCannotCompleteRetry() {
    val harness = RenderHarness()
    val firstResults = mutableListOf<ChatRichBlockResult<String>>()
    val retryResults = mutableListOf<ChatRichBlockResult<String>>()
    val request = request("retry")

    harness.coordinator.render(request, firstResults::add)
    val staleCompletion = harness.backend.completions.removeAt(0)
    harness.scheduler.fire()
    harness.coordinator.render(request, retryResults::add)
    staleCompletion(ChatRichBlockResult.Success("stale"))

    assertEquals(listOf(ChatRichBlockResult.TransientFailure), firstResults)
    assertEquals(emptyList<ChatRichBlockResult<String>>(), retryResults)
    harness.backend.complete(ChatRichBlockResult.Success("fresh"))
    assertEquals(listOf(ChatRichBlockResult.Success("fresh")), retryResults)
  }

  @Test
  fun parsesStructuredRenderCompletionMessages() {
    assertEquals(
      ChatRichBlockRenderMessage(
        id = "7",
        widthCssPx = 12.5,
        heightCssPx = 8.0,
        success = true,
        svg = null,
      ),
      parseChatRichBlockRenderMessage(
        """{"id":"7","widthCssPx":12.5,"heightCssPx":8,"success":true}""",
        ChatRichBlockKind.Math,
      ),
    )
    assertNull(parseChatRichBlockRenderMessage("""{"id":"7"}""", ChatRichBlockKind.Math))
  }

  @Test
  fun diagramCompletionRequiresBoundedSvgButErrorsDoNotRequireDimensions() {
    val valid = """{"id":"8","success":true,"widthCssPx":240,"heightCssPx":100,"svg":"<svg/>"}"""
    assertEquals("<svg/>", parseChatRichBlockRenderMessage(valid, ChatRichBlockKind.Mermaid)?.svg)
    val withoutSvg = """{"id":"8","success":true,"widthCssPx":240,"heightCssPx":100}"""
    assertNull(parseChatRichBlockRenderMessage(withoutSvg, ChatRichBlockKind.Mermaid))
    assertNull(parseChatRichBlockRenderMessage(valid.replace("<svg/>", "x".repeat(1_000_001)), ChatRichBlockKind.Mermaid))
    assertEquals(
      false,
      parseChatRichBlockRenderMessage("""{"id":"8","success":false,"error":"Invalid diagram"}""", ChatRichBlockKind.Mermaid)?.success,
    )
    assertEquals(
      true,
      parseChatRichBlockRenderMessage("""{"id":"8","success":false,"error":"Renderer unavailable","retryable":true}""", ChatRichBlockKind.Mermaid)?.retryable,
    )
    assertEquals(
      false,
      parseChatRichBlockRenderMessage("""{"id":"8","success":false,"error":"Invalid diagram","retryable":false}""", ChatRichBlockKind.Mermaid)?.retryable,
    )
    assertEquals(
      false,
      parseChatRichBlockRenderMessage("""{"id":"8","success":false}""", ChatRichBlockKind.Math)?.retryable,
    )
  }

  @Test
  fun visibleMathRequestsDrainWithoutUserRetry() {
    val harness = RenderHarness()
    val requests = (0 until 40).map { request("x_{$it}^2") }
    val outcomes = mutableListOf<ChatRichBlockResult<String>>()
    requests.forEach { harness.coordinator.render(it, outcomes::add) }

    assertEquals(emptyList<ChatRichBlockResult<String>>(), outcomes)
    requests.forEach { harness.backend.complete(ChatRichBlockResult.Success(it.source)) }

    assertEquals(requests, harness.backend.requests)
    assertEquals(requests.map { ChatRichBlockResult.Success(it.source) }, outcomes)
  }

  @Test
  fun mathRequestsDrainAfterSynchronousRendererLoss() {
    val harness = RenderHarness()
    val requests = (0 until 5_000).map { request("x_{$it}") }
    val outcomes = mutableListOf<ChatRichBlockResult<String>>()
    requests.forEach { harness.coordinator.render(it, outcomes::add) }

    harness.backend.synchronousResult = ChatRichBlockResult.TransientFailure
    harness.backend.complete(ChatRichBlockResult.TransientFailure)

    assertEquals(requests, harness.backend.requests)
    assertEquals(requests.map { ChatRichBlockResult.TransientFailure }, outcomes)
  }

  @Test
  fun cancelingQueuedWorkFreesCapacityWithoutDroppingAdmittedJobs() {
    val harness = RenderHarness()
    val outcomes = mutableListOf<ChatRichBlockResult<String>>()
    harness.coordinator.render(diagramRequest("active"), outcomes::add)
    val subscriptions = (0 until 100).map { harness.coordinator.render(diagramRequest("queued-$it"), outcomes::add) }
    val rejected = outcomes.size
    org.junit.Assert.assertTrue(rejected > 0)
    org.junit.Assert.assertTrue(outcomes.all { it == ChatRichBlockResult.TransientFailure })
    subscriptions.first().cancel()
    harness.coordinator.render(diagramRequest("replacement"), outcomes::add)
    assertEquals(rejected, outcomes.size)
    harness.backend.complete(ChatRichBlockResult.Success("active"))
    assertEquals(
      "queued-1",
      harness.backend.requests
        .last()
        .source,
    )
  }

  @Test
  fun bitmapDimensionsRejectNonFiniteNonPositiveAndOversizedValues() {
    assertEquals(25, bitmapDimension(cssPixels = 12.5, density = 2f))
    assertNull(bitmapDimension(cssPixels = Double.NaN, density = 1f))
    assertNull(bitmapDimension(cssPixels = Double.POSITIVE_INFINITY, density = 1f))
    assertNull(bitmapDimension(cssPixels = 0.0, density = 1f))
    assertNull(bitmapDimension(cssPixels = 1.0, density = Float.NaN))
    assertNull(bitmapDimension(cssPixels = 8193.0, density = 1f))
    assertNull(bitmapDimension(cssPixels = 4097.0, density = 2f))
  }

  private class RenderHarness {
    val backend = FakeBackend()
    val cache = FakeCache()
    val scheduler = FakeScheduler()
    val coordinator = ChatRichBlockCoordinator(backend, cache, scheduler)
  }

  private class FakeBackend : ChatRichBlockBackend<String> {
    val requests = mutableListOf<ChatRichBlockRequest>()
    val completions = mutableListOf<(ChatRichBlockResult<String>) -> Unit>()
    val events = mutableListOf<String>()
    var synchronousResult: ChatRichBlockResult<String>? = null

    override fun reset() {
      events += "reset"
    }

    override fun render(
      request: ChatRichBlockRequest,
      completion: (ChatRichBlockResult<String>) -> Unit,
    ) {
      requests.add(request)
      events += "render:${request.source}"
      val immediate = synchronousResult
      if (immediate == null) completions.add(completion) else completion(immediate)
    }

    fun complete(result: ChatRichBlockResult<String>) {
      completions.removeAt(0).invoke(result)
    }
  }

  private class FakeCache : ChatRichBlockCache<String> {
    private val entries = mutableMapOf<ChatRichBlockRequest, ChatRichBlockResult<String>>()

    override fun get(request: ChatRichBlockRequest): ChatRichBlockResult<String>? = entries[request]

    override fun put(
      request: ChatRichBlockRequest,
      result: ChatRichBlockResult<String>,
    ) {
      if (result != ChatRichBlockResult.TransientFailure) entries[request] = result
    }
  }

  private class FakeScheduler : ChatRenderTimeoutScheduler {
    private var action: (() -> Unit)? = null

    override fun schedule(
      delayMs: Long,
      action: () -> Unit,
    ): ChatRenderCancellation {
      this.action = action
      return ChatRenderCancellation { if (this.action === action) this.action = null }
    }

    fun fire() {
      val pending = action
      action = null
      checkNotNull(pending).invoke()
    }
  }

  private fun ChatRichBlockResult<String>.value(): String =
    when (this) {
      is ChatRichBlockResult.Success -> value
      ChatRichBlockResult.Failure -> "failure"
      ChatRichBlockResult.TransientFailure -> "transient failure"
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

  private fun diagramRequest(source: String): ChatMermaidRequest =
    ChatMermaidRequest(
      source = source,
      widthPx = 320,
      density = 1f,
      theme = ChatMermaidTheme("#fff", "#000", "#666", "#ccc", "#f00", false),
    )
}
