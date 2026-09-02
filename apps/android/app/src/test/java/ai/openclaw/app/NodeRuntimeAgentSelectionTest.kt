package ai.openclaw.app

import ai.openclaw.app.chat.ChatCacheScope
import ai.openclaw.app.chat.ChatController
import ai.openclaw.app.chat.ChatSessionDeletion
import ai.openclaw.app.chat.ChatSessionEntry
import ai.openclaw.app.chat.SESSION_LIST_FETCH_LIMIT
import ai.openclaw.app.gateway.GatewayEndpoint
import ai.openclaw.app.gateway.GatewaySession
import android.content.Context
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.async
import kotlinx.coroutines.currentCoroutineContext
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.job
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeout
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import org.robolectric.annotation.Config
import org.robolectric.util.ReflectionHelpers
import java.util.UUID
import java.util.concurrent.atomic.AtomicReference

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34])
class NodeRuntimeAgentSelectionTest {
  @Test
  fun selectingAgentRebindsCanonicalMainSession() {
    val app = RuntimeEnvironment.getApplication()
    val securePrefs =
      app.getSharedPreferences(
        "openclaw.node.secure.test.${UUID.randomUUID()}",
        Context.MODE_PRIVATE,
      )
    val runtime = NodeRuntime(app, SecurePrefs(app, securePrefsOverride = securePrefs))

    try {
      runtime.selectChatAgent(" scout ")

      assertEquals("scout", resolveAgentIdFromMainSessionKey(runtime.mainSessionKey.value))
      assertEquals(runtime.mainSessionKey.value, runtime.chatSessionKey.value)
    } finally {
      closeNodeRuntimeTestFixture(runtime)
    }
  }

  @Test
  fun currentChatHydrationPreservesSelectionPublishedWhileItWaits() =
    runBlocking {
      val runtime = createConnectedRuntime()
      val loaded = CompletableDeferred<Unit>()
      val loader =
        Thread {
          try {
            runtime.loadCurrentChat()
            loaded.complete(Unit)
          } catch (err: Throwable) {
            loaded.completeExceptionally(err)
          }
        }
      try {
        val chat = ReflectionHelpers.getField<ChatController>(runtime, "chat")
        val publicationLock = ReflectionHelpers.getField<Any>(chat, "gatewayScopeApplyLock")
        synchronized(publicationLock) {
          loader.start()
          val deadline = System.nanoTime() + 2_000_000_000L
          while (loader.state != Thread.State.BLOCKED && !loaded.isCompleted && System.nanoTime() < deadline) {
            Thread.yield()
          }
          assertEquals("Hydration must wait for the selection owner", Thread.State.BLOCKED, loader.state)
          // New publishes through the controller, independently of the runtime navigation lock.
          chat.switchSession("selected-after-mount", "scout")
        }
        withTimeout(2_000) { loaded.await() }

        assertEquals("selected-after-mount", runtime.chatSessionKey.value)
        assertEquals("scout", runtime.chatSessionOwnerAgentId.value)
      } finally {
        loader.join(2_000)
        closeNodeRuntimeTestFixture(runtime)
      }
    }

  @Test
  fun manualSessionSelectionWinsOverLateCatalogContinuation() =
    runBlocking {
      val runtime = createConnectedRuntime()
      try {
        val requestStarted = CompletableDeferred<Unit>()
        val releaseResponse = CompletableDeferred<Unit>()
        runtime.gatewayDataRequestOverrideForTests = { _, method, _ ->
          check(method == "sessions.catalog.continue")
          requestStarted.complete(Unit)
          releaseResponse.await()
          """{"sessionKey":"agent:main:catalog"}"""
        }
        val entry =
          SessionCatalogEntry(
            catalogId = "codex",
            hostId = "desktop",
            threadId = "thread-1",
            agentId = "main",
            status = "idle",
            archived = false,
            canContinue = true,
          )

        val continuation = async { runtime.continueSessionCatalogEntry(entry) }
        withTimeout(2_000) { requestStarted.await() }
        runtime.switchChatSession("agent:main:user")
        assertEquals(null, runtime.sessionCatalogState.value.continuingEntryId)
        releaseResponse.complete(Unit)

        assertFalse(withTimeout(2_000) { continuation.await() })
        assertEquals("agent:main:user", runtime.chatSessionKey.value)
      } finally {
        closeNodeRuntimeTestFixture(runtime)
      }
    }

  @Test
  fun agentSessionSelectionRestoresRememberedThenFallsBackToNewestNonMain() {
    val candidates =
      listOf(
        ChatSessionEntry(
          key = "agent:scout:main",
          updatedAtMs = 500,
          ownerAgentId = "scout",
          isMain = true,
        ),
        ChatSessionEntry(
          key = "agent:scout:remembered",
          updatedAtMs = 10,
          ownerAgentId = "scout",
        ),
        ChatSessionEntry(
          key = "agent:scout:newest",
          updatedAtMs = 20,
          ownerAgentId = "scout",
        ),
        ChatSessionEntry(
          key = "agent:scout:archived",
          updatedAtMs = 30,
          ownerAgentId = "scout",
          archived = true,
        ),
        ChatSessionEntry(
          key = "agent:other:wrong-owner",
          updatedAtMs = 40,
          ownerAgentId = "other",
        ),
      )

    assertEquals(
      "agent:scout:remembered",
      selectChatAgentSessionKey(candidates, "scout", "agent:scout:remembered", "agent:scout:main"),
    )
    assertEquals(
      "agent:scout:newest",
      selectChatAgentSessionKey(candidates, "scout", "agent:scout:missing", "agent:scout:main"),
    )
    assertEquals(
      "agent:scout:main",
      selectChatAgentSessionKey(candidates.take(1), "scout", null, "agent:scout:main"),
    )
  }

  @Test
  fun explicitSessionSelectionWinsOverLateAgentSessionLookup() =
    runBlocking {
      val runtime = createConnectedRuntime()
      try {
        val requestStarted = CompletableDeferred<Job>()
        val releaseResponse = CompletableDeferred<Unit>()
        stubAgentSessionLookup(runtime) {
          requestStarted.complete(currentCoroutineContext().job)
          releaseResponse.await()
          """{"sessions":[{"key":"agent:scout:late","updatedAt":20}]}"""
        }

        runtime.selectChatAgent("scout")
        val lookupJob = withTimeout(2_000) { requestStarted.await() }
        runtime.switchChatSession("agent:scout:chosen")
        releaseResponse.complete(Unit)
        withTimeout(2_000) { lookupJob.join() }

        assertEquals("agent:scout:chosen", runtime.chatSessionKey.value)
      } finally {
        closeNodeRuntimeTestFixture(runtime)
      }
    }

  @Test
  fun currentSessionSelectionWinsAfterAgentLookupValidation() = assertCurrentSessionSelectionWinsAtPublication(catalogContinuation = false)

  @Test
  fun currentSessionSelectionWinsAfterCatalogContinuationValidation() = assertCurrentSessionSelectionWinsAtPublication(catalogContinuation = true)

  @Test
  fun newSessionWinsWhenAgentLookupReturnsBeforeCreation() = assertNewSessionWinsOverAgentLookup(catalogId = null, lookupBeforeCreation = true)

  @Test
  fun newSessionWinsWhenAgentLookupReturnsAfterCreation() = assertNewSessionWinsOverAgentLookup(catalogId = null, lookupBeforeCreation = false)

  @Test
  fun newCatalogSessionWinsWhenAgentLookupReturnsBeforeCreation() = assertNewSessionWinsOverAgentLookup(catalogId = "codex", lookupBeforeCreation = true)

  @Test
  fun newCatalogSessionWinsWhenAgentLookupReturnsAfterCreation() = assertNewSessionWinsOverAgentLookup(catalogId = "codex", lookupBeforeCreation = false)

  @Test
  fun pendingCatalogContinuationRetiresLateAgentSessionLookup() =
    runBlocking {
      val runtime = createConnectedRuntime()
      val lookupStarted = CompletableDeferred<Job>()
      val releaseLookup = CompletableDeferred<Unit>()
      val continueStarted = CompletableDeferred<Unit>()
      val releaseContinue = CompletableDeferred<Unit>()
      try {
        stubAgentSessionLookup(runtime) {
          lookupStarted.complete(currentCoroutineContext().job)
          releaseLookup.await()
          """{"sessions":[{"key":"agent:scout:old","updatedAt":20}]}"""
        }
        runtime.gatewayDataRequestOverrideForTests = { _, method, _ ->
          check(method == "sessions.catalog.continue")
          continueStarted.complete(Unit)
          releaseContinue.await()
          """{"sessionKey":"agent:scout:catalog"}"""
        }
        runtime.selectChatAgent("scout")
        val lookupJob = withTimeout(2_000) { lookupStarted.await() }
        val mainSessionKey = runtime.chatSessionKey.value
        val entry =
          SessionCatalogEntry(
            catalogId = "codex",
            hostId = "desktop",
            threadId = "remote-thread",
            agentId = "scout",
            status = "idle",
            archived = false,
            canContinue = true,
          )

        val continuation = async { runtime.continueSessionCatalogEntry(entry) }
        withTimeout(2_000) { continueStarted.await() }
        releaseLookup.complete(Unit)
        withTimeout(2_000) { lookupJob.join() }
        assertEquals(mainSessionKey, runtime.chatSessionKey.value)

        releaseContinue.complete(Unit)
        assertTrue(withTimeout(2_000) { continuation.await() })
        assertEquals("agent:scout:catalog", runtime.chatSessionKey.value)
      } finally {
        releaseLookup.complete(Unit)
        releaseContinue.complete(Unit)
        closeNodeRuntimeTestFixture(runtime)
      }
    }

  @Test
  fun newerAgentSelectionWinsOverLatePreviousAgentLookup() =
    runBlocking {
      val runtime = createConnectedRuntime()
      try {
        val scoutStarted = CompletableDeferred<Job>()
        val releaseScout = CompletableDeferred<Unit>()
        stubAgentSessionLookup(runtime) { agentId ->
          if (agentId == "scout") {
            scoutStarted.complete(currentCoroutineContext().job)
            releaseScout.await()
            """{"sessions":[{"key":"agent:scout:late","updatedAt":20}]}"""
          } else {
            """{"sessions":[]}"""
          }
        }

        runtime.selectChatAgent("scout")
        val lookupJob = withTimeout(2_000) { scoutStarted.await() }
        runtime.selectChatAgent("writer")
        val writerMain = runtime.mainSessionKey.value
        releaseScout.complete(Unit)
        withTimeout(2_000) { lookupJob.join() }

        assertEquals("writer", resolveAgentIdFromMainSessionKey(writerMain))
        assertEquals(writerMain, runtime.chatSessionKey.value)
      } finally {
        closeNodeRuntimeTestFixture(runtime)
      }
    }

  @Test
  fun agentSelectionRestoresLastExplicitSessionForThatAgent() =
    runBlocking {
      val runtime = createConnectedRuntime()
      try {
        stubAgentSessionLookup(runtime) { agentId ->
          when (agentId) {
            "scout" -> """{"sessions":[{"key":"agent:scout:chosen","updatedAt":10},{"key":"agent:scout:newest","updatedAt":20}]}"""
            else -> """{"sessions":[]}"""
          }
        }
        runtime.switchChatSession("agent:scout:chosen")
        runtime.selectChatAgent("writer")
        runtime.selectChatAgent("scout")

        withTimeout(2_000) {
          while (runtime.chatSessionKey.value != "agent:scout:chosen") delay(10)
        }
        assertEquals("agent:scout:chosen", runtime.chatSessionKey.value)
      } finally {
        closeNodeRuntimeTestFixture(runtime)
      }
    }

  @Test
  fun sessionDeletionInvalidatesLateAgentSessionLookup() =
    runBlocking {
      val runtime = createConnectedRuntime()
      try {
        val requestStarted = CompletableDeferred<Job>()
        val releaseResponse = CompletableDeferred<Unit>()
        stubAgentSessionLookup(runtime) {
          requestStarted.complete(currentCoroutineContext().job)
          releaseResponse.await()
          """{"sessions":[{"key":"agent:scout:deleted","updatedAt":20}]}"""
        }

        runtime.selectChatAgent("scout")
        val lookupJob = withTimeout(2_000) { requestStarted.await() }
        val scoutMain = runtime.mainSessionKey.value
        ReflectionHelpers.callInstanceMethod<Unit>(
          runtime,
          "publishChatSessionDeletion",
          ReflectionHelpers.ClassParameter.from(
            ChatSessionDeletion::class.java,
            ChatSessionDeletion(
              gatewayId = GatewayEndpoint.manual("127.0.0.1", 18789).stableId,
              agentId = "scout",
              sessionKey = "agent:scout:deleted",
              mainSessionKey = scoutMain,
            ),
          ),
        )
        releaseResponse.complete(Unit)
        withTimeout(2_000) { lookupJob.join() }

        assertEquals(scoutMain, runtime.chatSessionKey.value)
      } finally {
        closeNodeRuntimeTestFixture(runtime)
      }
    }

  private fun assertCurrentSessionSelectionWinsAtPublication(catalogContinuation: Boolean) =
    runBlocking {
      val runtime = createConnectedRuntime()
      val requestStarted = CompletableDeferred<Job>()
      val releaseResponse = CompletableDeferred<Unit>()
      val destinationThread = AtomicReference<Thread?>()
      val selectionFinished = CompletableDeferred<Unit>()
      var selectionThread: Thread? = null
      try {
        if (catalogContinuation) {
          runtime.gatewayDataRequestOverrideForTests = { _, method, _ ->
            check(method == "sessions.catalog.continue")
            requestStarted.complete(currentCoroutineContext().job)
            releaseResponse.await()
            destinationThread.set(Thread.currentThread())
            """{"sessionKey":"agent:main:old-destination"}"""
          }
          async(Dispatchers.Default) {
            runtime.continueSessionCatalogEntry(
              SessionCatalogEntry(
                catalogId = "codex",
                hostId = "desktop",
                threadId = "remote-thread",
                agentId = "main",
                status = "idle",
                archived = false,
                canContinue = true,
              ),
            )
          }
        } else {
          stubAgentSessionLookup(runtime) {
            requestStarted.complete(currentCoroutineContext().job)
            releaseResponse.await()
            destinationThread.set(Thread.currentThread())
            """{"sessions":[{"key":"agent:main:old-destination","updatedAt":20}]}"""
          }
          runtime.selectChatAgent("main")
        }
        val destinationJob = withTimeout(2_000) { requestStarted.await() }
        val selectedKey = runtime.chatSessionKey.value
        val chat = ReflectionHelpers.getField<ChatController>(runtime, "chat")
        val publicationLock = ReflectionHelpers.getField<Any>(chat, "gatewayScopeApplyLock")
        val newerSelection =
          Thread {
            try {
              runtime.switchChatSession(selectedKey, "main")
              selectionFinished.complete(Unit)
            } catch (err: Throwable) {
              selectionFinished.completeExceptionally(err)
            }
          }
        selectionThread = newerSelection
        synchronized(publicationLock) {
          releaseResponse.complete(Unit)
          val destinationDeadline = System.nanoTime() + 2_000_000_000L
          while (destinationThread.get()?.state != Thread.State.BLOCKED && System.nanoTime() < destinationDeadline) {
            Thread.yield()
          }
          assertEquals(
            "The older destination must wait at the chat publication lock",
            Thread.State.BLOCKED,
            destinationThread.get()?.state,
          )
          // Selecting the current session still retires older intent, even without a new history load.
          newerSelection.start()
          val selectionDeadline = System.nanoTime() + 2_000_000_000L
          while (!selectionFinished.isCompleted && newerSelection.state != Thread.State.BLOCKED && System.nanoTime() < selectionDeadline) {
            Thread.yield()
          }
          // A serialized owner may defer the newer selection until the older commit completes.
          assertTrue(
            "The newer selection must finish or wait for the in-flight destination commit",
            selectionFinished.isCompleted || newerSelection.state == Thread.State.BLOCKED,
          )
        }
        withTimeout(2_000) { destinationJob.join() }
        withTimeout(2_000) { selectionFinished.await() }

        assertEquals("The newer explicit session selection must win", selectedKey, runtime.chatSessionKey.value)
      } finally {
        releaseResponse.complete(Unit)
        selectionThread?.join(2_000)
        closeNodeRuntimeTestFixture(runtime)
      }
    }

  private fun assertNewSessionWinsOverAgentLookup(
    catalogId: String?,
    lookupBeforeCreation: Boolean,
  ): Unit =
    runBlocking {
      val runtime = createConnectedRuntime()
      val lookupStarted = CompletableDeferred<Job>()
      val releaseLookup = CompletableDeferred<Unit>()
      val createStarted = CompletableDeferred<Job>()
      val releaseCreate = CompletableDeferred<Unit>()
      val createdKey = "agent:scout:created"
      try {
        val requestGateway: suspend (String, String?) -> String = { method, _ ->
          when (method) {
            "sessions.describe" -> {
              """{"session":{"label":"App"}}"""
            }

            "sessions.create" -> {
              createStarted.complete(currentCoroutineContext().job)
              releaseCreate.await()
              """{"ok":true,"key":"$createdKey"}"""
            }

            "chat.history" -> {
              """{"sessionId":"test-session","messages":[]}"""
            }

            "sessions.list" -> {
              """{"sessions":[]}"""
            }

            "health" -> {
              """{"ok":true}"""
            }

            "chat.metadata" -> {
              "{}"
            }

            "question.list" -> {
              """{"questions":[]}"""
            }

            else -> {
              error("Unexpected gateway request: $method")
            }
          }
        }
        val requestGatewayForGateway: suspend (String, String, String?) -> String = { _, method, params ->
          requestGateway(method, params)
        }
        val chat = ReflectionHelpers.getField<ChatController>(runtime, "chat")
        ReflectionHelpers.setField(chat, "requestGateway", requestGateway)
        ReflectionHelpers.setField(chat, "requestGatewayForGateway", requestGatewayForGateway)
        val captureLease: (ChatCacheScope?) -> GatewaySession.RequestLease? = { gatewayScope ->
          GatewaySession.RequestLease(endpointStableId = gatewayScope?.gatewayId.orEmpty()) { method, paramsJson, _, withEnqueue ->
            withEnqueue {}
            if (gatewayScope == null) {
              requestGateway(method, paramsJson)
            } else {
              requestGatewayForGateway(gatewayScope.gatewayId, method, paramsJson)
            }
          }
        }
        ReflectionHelpers.setField(chat, "captureRequestLease", captureLease)
        stubAgentSessionLookup(runtime) {
          lookupStarted.complete(currentCoroutineContext().job)
          releaseLookup.await()
          """{"sessions":[{"key":"agent:scout:old","updatedAt":20}]}"""
        }

        runtime.selectChatAgent("scout")
        val lookupJob = withTimeout(5_000) { lookupStarted.await() }
        withTimeout(5_000) {
          runtime.chatSessionId.first { it != null }
          runtime.chatHistoryLoading.first { !it }
        }
        val catalogCreation =
          if (catalogId == null) {
            runtime.startNewChat()
            null
          } else {
            async { runtime.createSessionCatalogEntry(catalogId) }
          }
        val createJob = withTimeout(5_000) { createStarted.await() }

        if (lookupBeforeCreation) {
          releaseLookup.complete(Unit)
          withTimeout(5_000) { lookupJob.join() }
          releaseCreate.complete(Unit)
          withTimeout(5_000) { createJob.join() }
        } else {
          releaseCreate.complete(Unit)
          withTimeout(5_000) { createJob.join() }
          assertEquals(createdKey, runtime.chatSessionKey.value)
          releaseLookup.complete(Unit)
          withTimeout(5_000) { lookupJob.join() }
        }

        assertEquals(createdKey, runtime.chatSessionKey.value)
        catalogCreation?.let { assertTrue(it.await()) }
      } finally {
        releaseLookup.complete(Unit)
        releaseCreate.complete(Unit)
        closeNodeRuntimeTestFixture(runtime)
      }
    }

  private fun stubAgentSessionLookup(
    runtime: NodeRuntime,
    onLookup: suspend (String) -> String,
  ) {
    val chat = ReflectionHelpers.getField<ChatController>(runtime, "chat")
    val requestGatewayForGateway =
      ReflectionHelpers.getField<suspend (String, String, String?) -> String>(chat, "requestGatewayForGateway")
    val request: suspend (String, String, String?) -> String = { gatewayId, method, paramsJson ->
      val params = if (method == "sessions.list") Json.parseToJsonElement(paramsJson.orEmpty()) as JsonObject else null
      // Hold the candidate lookup, not the smaller bootstrap list needed by session creation.
      if (params != null && params["limit"] == JsonPrimitive(SESSION_LIST_FETCH_LIMIT)) {
        onLookup((params["agentId"] as JsonPrimitive).content)
      } else {
        requestGatewayForGateway(gatewayId, method, paramsJson)
      }
    }
    ReflectionHelpers.setField(chat, "requestGatewayForGateway", request)
  }

  private fun createConnectedRuntime(): NodeRuntime {
    val app = RuntimeEnvironment.getApplication()
    val securePrefs =
      app.getSharedPreferences(
        "openclaw.node.session.selection.test.${UUID.randomUUID()}",
        Context.MODE_PRIVATE,
      )
    return NodeRuntime(app, SecurePrefs(app, securePrefsOverride = securePrefs)).also { runtime ->
      ReflectionHelpers.setField(runtime, "connectedEndpoint", GatewayEndpoint.manual("127.0.0.1", 18789))
      ReflectionHelpers.setField(runtime, "operatorConnected", true)
    }
  }
}
