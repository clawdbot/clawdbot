package ai.openclaw.app

import ai.openclaw.app.gateway.GatewayEndpoint
import android.content.Context
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.CoroutineStart
import kotlinx.coroutines.async
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeout
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import org.robolectric.annotation.Config
import org.robolectric.util.ReflectionHelpers
import java.util.UUID
import java.util.concurrent.atomic.AtomicReference
import kotlin.coroutines.Continuation
import kotlin.coroutines.intrinsics.suspendCoroutineUninterceptedOrReturn

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34])
class SessionCatalogRuntimeTest {
  @Test
  fun olderProgressCannotPopulateAnotherAgentsCatalogWhenItsRefreshFails() =
    runBlocking {
      val app = RuntimeEnvironment.getApplication()
      val securePrefs =
        app.getSharedPreferences(
          "openclaw.node.session.catalog.test.${UUID.randomUUID()}",
          Context.MODE_PRIVATE,
        )
      val runtime = NodeRuntime(app, SecurePrefs(app, securePrefsOverride = securePrefs))
      val mainProgressId = CompletableDeferred<String>()
      val releaseMain = CompletableDeferred<Unit>()
      val workStarted = CompletableDeferred<Unit>()
      val releaseWork = CompletableDeferred<Unit>()
      val progressHandled = CompletableDeferred<Unit>()
      var progressThread: Thread? = null
      try {
        ReflectionHelpers.setField(runtime, "connectedEndpoint", GatewayEndpoint.manual("127.0.0.1", 18789))
        ReflectionHelpers.setField(runtime, "operatorConnected", true)
        ReflectionHelpers.getField<MutableStateFlow<Boolean>>(runtime, "_sessionCatalogAvailable").value = true
        runtime.gatewayDataRequestOverrideForTests = { _, method, params ->
          check(method == "sessions.catalog.list")
          val request = Json.parseToJsonElement(requireNotNull(params)).jsonObject
          when (request["agentId"]?.jsonPrimitive?.content) {
            "main" -> {
              mainProgressId.complete(requireNotNull(request["progressId"]).jsonPrimitive.content)
              releaseMain.await()
              """{"catalogs":[]}"""
            }

            "work" -> {
              workStarted.complete(Unit)
              releaseWork.await()
              error("Work catalog unavailable")
            }

            else -> {
              error("Unexpected catalog request")
            }
          }
        }

        val mainRefresh =
          async(start = CoroutineStart.UNDISPATCHED) {
            invokeRefreshSessionCatalogFromGateway(runtime, "main")
          }
        val progressId = withTimeout(2_000) { mainProgressId.await() }
        val progress =
          """{"progressId":"$progressId","agentId":"main","catalog":{"id":"codex","label":"Main catalog","hosts":[{"hostId":"desktop","label":"Desktop","kind":"node","connected":true,"sessions":[{"threadId":"main-thread","status":"idle","canContinue":true}]}]}}"""
        val eventHandler =
          NodeRuntime::class.java
            .getDeclaredMethod("handleGatewayEvent", String::class.java, String::class.java)
            .apply { isAccessible = true }
        eventHandler.invoke(runtime, "sessions.catalog.host", progress)
        assertEquals(
          "Main catalog",
          runtime.sessionCatalogState.value.catalogs
            .single()
            .label,
        )

        val delayedProgress =
          Thread {
            try {
              eventHandler.invoke(runtime, "sessions.catalog.host", progress)
              progressHandled.complete(Unit)
            } catch (err: Throwable) {
              progressHandled.completeExceptionally(err)
            }
          }
        progressThread = delayedProgress
        val dataLock = ReflectionHelpers.getField<Any>(runtime, "gatewayDataScopeLock")
        val workRefresh =
          synchronized(dataLock) {
            delayedProgress.start()
            val deadline = System.nanoTime() + 2_000_000_000L
            while (delayedProgress.state != Thread.State.BLOCKED && System.nanoTime() < deadline) {
              Thread.yield()
            }
            assertEquals("Progress must wait at the held publication lock", Thread.State.BLOCKED, delayedProgress.state)
            val refresh =
              async(start = CoroutineStart.UNDISPATCHED) {
                invokeRefreshSessionCatalogFromGateway(runtime, "work")
              }
            assertTrue("Replacement refresh must reach its request before progress resumes", workStarted.isCompleted)
            refresh
          }
        withTimeout(2_000) { progressHandled.await() }
        releaseWork.complete(Unit)
        withTimeout(2_000) { workRefresh.await() }
        releaseMain.complete(Unit)
        withTimeout(2_000) { mainRefresh.await() }

        val state = runtime.sessionCatalogState.value
        assertEquals("work", state.agentId)
        assertFalse(state.loading)
        assertTrue(!state.errorText.isNullOrBlank())
        assertTrue("Late main progress must not survive the work agent's failed refresh", state.catalogs.isEmpty())
      } finally {
        releaseMain.complete(Unit)
        releaseWork.complete(Unit)
        progressThread?.join(2_000)
        closeNodeRuntimeTestFixture(runtime)
      }
    }

  @Test
  fun loadMoreDuringRefreshIsIgnoredAndRetryKeepsTheAppendedPage() =
    runBlocking {
      val app = RuntimeEnvironment.getApplication()
      val securePrefs =
        app.getSharedPreferences(
          "openclaw.node.session.catalog.test.${UUID.randomUUID()}",
          Context.MODE_PRIVATE,
        )
      val runtime = NodeRuntime(app, SecurePrefs(app, securePrefsOverride = securePrefs))
      val refreshStarted = CompletableDeferred<Unit>()
      val releaseRefresh = CompletableDeferred<Unit>()
      val loadMoreStarted = CompletableDeferred<Unit>()
      var failExpandedRefresh = false
      try {
        ReflectionHelpers.setField(runtime, "connectedEndpoint", GatewayEndpoint.manual("127.0.0.1", 18789))
        ReflectionHelpers.setField(runtime, "operatorConnected", true)
        ReflectionHelpers.getField<MutableStateFlow<Boolean>>(runtime, "_sessionCatalogAvailable").value = true
        ReflectionHelpers.getField<MutableStateFlow<SessionCatalogState>>(runtime, "_sessionCatalogState").value =
          SessionCatalogState(
            agentId = "main",
            catalogs =
              listOf(
                SessionCatalog(
                  id = "codex",
                  label = "Codex",
                  hosts =
                    listOf(
                      SessionCatalogHost(
                        catalogId = "codex",
                        hostId = "desktop",
                        label = "Desktop",
                        kind = "node",
                        connected = true,
                        sessions = emptyList(),
                        nextCursor = "cursor-2",
                      ),
                    ),
                ),
              ),
          )
        runtime.gatewayDataRequestOverrideForTests = { _, method, params ->
          check(method == "sessions.catalog.list")
          val request = Json.parseToJsonElement(requireNotNull(params)).jsonObject
          if ("cursors" in request) {
            loadMoreStarted.complete(Unit)
            if (failExpandedRefresh) error("Synthetic catalog page failure")
            """{"catalogs":[{"id":"codex","label":"Codex","hosts":[{"hostId":"desktop","label":"Desktop","kind":"node","connected":true,"sessions":[{"threadId":"page-2","status":"idle","canContinue":true}]}]}]}"""
          } else {
            refreshStarted.complete(Unit)
            releaseRefresh.await()
            """{"catalogs":[{"id":"codex","label":"Codex","hosts":[{"hostId":"desktop","label":"Desktop","kind":"node","connected":true,"nextCursor":"cursor-2","sessions":[{"threadId":"first","status":"idle","canContinue":true}]}]}]}"""
          }
        }

        runtime.refreshSessionCatalog("main")
        withTimeout(2_000) { refreshStarted.await() }
        val ignoredRefresh =
          async(start = CoroutineStart.UNDISPATCHED) {
            invokeRefreshSessionCatalogFromGateway(runtime, "main")
          }
        withTimeout(2_000) { ignoredRefresh.await() }
        val ignoredLoadMore =
          async(start = CoroutineStart.UNDISPATCHED) {
            invokeLoadMoreSessionCatalogFromGateway(runtime, "codex")
          }
        withTimeout(2_000) { ignoredLoadMore.await() }
        assertFalse(loadMoreStarted.isCompleted)

        releaseRefresh.complete(Unit)
        withTimeout(2_000) {
          while (runtime.sessionCatalogState.value.loading) delay(10)
        }

        val retriedLoadMore =
          async(start = CoroutineStart.UNDISPATCHED) {
            invokeLoadMoreSessionCatalogFromGateway(runtime, "codex")
          }
        withTimeout(2_000) { loadMoreStarted.await() }
        withTimeout(2_000) { retriedLoadMore.await() }

        val state = runtime.sessionCatalogState.value
        assertEquals(
          listOf("first", "page-2"),
          state.catalogs
            .single()
            .hosts
            .single()
            .sessions
            .map(SessionCatalogEntry::threadId),
        )
        assertEquals(1, state.loadedPageDepthsByHost[sessionCatalogHostKey("codex", "desktop")])

        failExpandedRefresh = true
        withTimeout(2_000) { invokeRefreshSessionCatalogFromGateway(runtime, "main") }

        val failedRefresh = runtime.sessionCatalogState.value
        assertFalse(failedRefresh.loading)
        assertEquals(state.catalogs, failedRefresh.catalogs)
        assertEquals(state.loadedPageDepthsByHost, failedRefresh.loadedPageDepthsByHost)
        assertTrue("A failed expanded-page refresh must remain visible", !failedRefresh.errorText.isNullOrBlank())
      } finally {
        releaseRefresh.complete(Unit)
        closeNodeRuntimeTestFixture(runtime)
      }
    }

  @Test
  fun paginationCannotLeaveLoadingStateAfterAnotherAgentsRefresh() =
    runBlocking {
      val app = RuntimeEnvironment.getApplication()
      val securePrefs =
        app.getSharedPreferences(
          "openclaw.node.session.catalog.test.${UUID.randomUUID()}",
          Context.MODE_PRIVATE,
        )
      val runtime = NodeRuntime(app, SecurePrefs(app, securePrefsOverride = securePrefs))
      val paginationFinished = CompletableDeferred<Unit>()
      var paginationThread: Thread? = null
      try {
        ReflectionHelpers.setField(runtime, "connectedEndpoint", GatewayEndpoint.manual("127.0.0.1", 18789))
        ReflectionHelpers.setField(runtime, "operatorConnected", true)
        ReflectionHelpers.getField<MutableStateFlow<Boolean>>(runtime, "_sessionCatalogAvailable").value = true
        runtime.gatewayDataRequestOverrideForTests = { _, method, params ->
          check(method == "sessions.catalog.list")
          val request = Json.parseToJsonElement(requireNotNull(params)).jsonObject
          val agentId = requireNotNull(request["agentId"]).jsonPrimitive.content
          val threadId = if ("cursors" in request) "$agentId-next" else "$agentId-first"
          """{"catalogs":[{"id":"codex","label":"Catalog","hosts":[{"hostId":"desktop","label":"Desktop","kind":"node","connected":true,"nextCursor":"cursor-2","sessions":[{"threadId":"$threadId","status":"idle","canContinue":true}]}]}]}"""
        }
        invokeRefreshSessionCatalogFromGateway(runtime, "main")
        assertEquals("main", runtime.sessionCatalogState.value.agentId)
        assertFalse(runtime.sessionCatalogState.value.loading)

        val delayedPagination =
          Thread {
            try {
              runBlocking { invokeLoadMoreSessionCatalogFromGateway(runtime, "codex") }
              paginationFinished.complete(Unit)
            } catch (err: Throwable) {
              paginationFinished.completeExceptionally(err)
            }
          }
        paginationThread = delayedPagination
        val dataLock = ReflectionHelpers.getField<Any>(runtime, "gatewayDataScopeLock")
        synchronized(dataLock) {
          delayedPagination.start()
          val deadline = System.nanoTime() + 2_000_000_000L
          while (delayedPagination.state != Thread.State.BLOCKED && System.nanoTime() < deadline) {
            Thread.yield()
          }
          assertEquals("Pagination must wait at the held data lock", Thread.State.BLOCKED, delayedPagination.state)
          val replacement =
            async(start = CoroutineStart.UNDISPATCHED) {
              invokeRefreshSessionCatalogFromGateway(runtime, "work")
            }
          assertTrue("The replacement refresh must finish before pagination resumes", replacement.isCompleted)
          assertEquals("work", runtime.sessionCatalogState.value.agentId)
          assertFalse(runtime.sessionCatalogState.value.loading)
        }
        withTimeout(2_000) { paginationFinished.await() }

        val state = runtime.sessionCatalogState.value
        assertEquals("work", state.agentId)
        assertTrue(
          "Retired pagination must not leave the replacement catalog loading more",
          state.loadingMoreCatalogIds.isEmpty(),
        )
        assertTrue(
          state.catalogs
            .single()
            .hosts
            .single()
            .sessions
            .all { it.agentId == "work" },
        )
      } finally {
        paginationThread?.join(2_000)
        closeNodeRuntimeTestFixture(runtime)
      }
    }

  @Test
  fun newerAgentRefreshPublishesWithoutWaitingForTheOlderNetworkCall() =
    runBlocking {
      val app = RuntimeEnvironment.getApplication()
      val securePrefs =
        app.getSharedPreferences(
          "openclaw.node.session.catalog.test.${UUID.randomUUID()}",
          Context.MODE_PRIVATE,
        )
      val runtime = NodeRuntime(app, SecurePrefs(app, securePrefsOverride = securePrefs))
      val mainStarted = CompletableDeferred<Unit>()
      val releaseMain = CompletableDeferred<Unit>()
      val workStarted = CompletableDeferred<Unit>()
      try {
        ReflectionHelpers.setField(runtime, "connectedEndpoint", GatewayEndpoint.manual("127.0.0.1", 18789))
        ReflectionHelpers.setField(runtime, "operatorConnected", true)
        ReflectionHelpers.getField<MutableStateFlow<Boolean>>(runtime, "_sessionCatalogAvailable").value = true
        runtime.gatewayDataRequestOverrideForTests = { _, method, params ->
          check(method == "sessions.catalog.list")
          val agentId =
            Json
              .parseToJsonElement(requireNotNull(params))
              .jsonObject["agentId"]
              ?.jsonPrimitive
              ?.content
          when (agentId) {
            "main" -> {
              mainStarted.complete(Unit)
              releaseMain.await()
              """{"catalogs":[{"id":"codex","label":"Main catalog","hosts":[]}]}"""
            }

            "work" -> {
              workStarted.complete(Unit)
              """{"catalogs":[{"id":"codex","label":"Work catalog","hosts":[]}]}"""
            }

            else -> {
              error("Unexpected agent: $agentId")
            }
          }
        }

        val mainRefresh =
          async(start = CoroutineStart.UNDISPATCHED) {
            invokeRefreshSessionCatalogFromGateway(runtime, "main")
          }
        withTimeout(2_000) { mainStarted.await() }

        val workRefresh =
          async(start = CoroutineStart.UNDISPATCHED) {
            invokeRefreshSessionCatalogFromGateway(runtime, "work")
          }
        withTimeout(2_000) { workStarted.await() }
        withTimeout(2_000) { workRefresh.await() }

        assertEquals("work", runtime.sessionCatalogState.value.agentId)
        assertEquals(
          "Work catalog",
          runtime.sessionCatalogState.value.catalogs
            .single()
            .label,
        )
        assertFalse(runtime.sessionCatalogState.value.loading)

        releaseMain.complete(Unit)
        withTimeout(2_000) { mainRefresh.await() }

        assertEquals("work", runtime.sessionCatalogState.value.agentId)
        assertEquals(
          "Work catalog",
          runtime.sessionCatalogState.value.catalogs
            .single()
            .label,
        )
      } finally {
        releaseMain.complete(Unit)
        closeNodeRuntimeTestFixture(runtime)
      }
    }

  @Test
  fun completedRefreshRetiresProgressOwner() {
    val app = RuntimeEnvironment.getApplication()
    val securePrefs =
      app.getSharedPreferences(
        "openclaw.node.session.catalog.test.${UUID.randomUUID()}",
        Context.MODE_PRIVATE,
      )
    val runtime = NodeRuntime(app, SecurePrefs(app, securePrefsOverride = securePrefs))
    try {
      ReflectionHelpers.setField(runtime, "connectedEndpoint", GatewayEndpoint.manual("127.0.0.1", 18789))
      ReflectionHelpers.setField(runtime, "operatorConnected", true)
      ReflectionHelpers.getField<MutableStateFlow<Boolean>>(runtime, "_sessionCatalogAvailable").value = true
      val requestParams = CompletableDeferred<String>()
      runtime.gatewayDataRequestOverrideForTests = { _, method, params ->
        check(method == "sessions.catalog.list")
        requestParams.complete(requireNotNull(params))
        """{"catalogs":[]}"""
      }

      runtime.refreshSessionCatalog("main")

      runBlocking {
        val params = withTimeout(2_000) { requestParams.await() }
        val progressId =
          Json
            .parseToJsonElement(params)
            .jsonObject["progressId"]
            ?.jsonPrimitive
            ?.content
        assertTrue(!progressId.isNullOrBlank())
        withTimeout(2_000) {
          while (runtime.sessionCatalogState.value.loading) delay(10)
        }
      }
      val owner =
        ReflectionHelpers.getField<AtomicReference<Any?>>(runtime, "sessionCatalogProgressOwner")
      assertNull(owner.get())
    } finally {
      closeNodeRuntimeTestFixture(runtime)
    }
  }

  private suspend fun invokeRefreshSessionCatalogFromGateway(
    runtime: NodeRuntime,
    agentId: String,
  ) = suspendCoroutineUninterceptedOrReturn<Unit> { continuation ->
    NodeRuntime::class.java
      .getDeclaredMethod("refreshSessionCatalogFromGateway", String::class.java, Continuation::class.java)
      .apply { isAccessible = true }
      .invoke(runtime, agentId, continuation)
  }

  private suspend fun invokeLoadMoreSessionCatalogFromGateway(
    runtime: NodeRuntime,
    catalogId: String,
  ) = suspendCoroutineUninterceptedOrReturn<Unit> { continuation ->
    NodeRuntime::class.java
      .getDeclaredMethod("loadMoreSessionCatalogFromGateway", String::class.java, Continuation::class.java)
      .apply { isAccessible = true }
      .invoke(runtime, catalogId, continuation)
  }
}
