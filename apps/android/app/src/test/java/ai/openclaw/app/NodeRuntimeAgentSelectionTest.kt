package ai.openclaw.app

import ai.openclaw.app.chat.AndroidClientDatabases
import ai.openclaw.app.chat.ChatCacheScope
import ai.openclaw.app.chat.ChatController
import ai.openclaw.app.chat.ChatSessionDeletion
import ai.openclaw.app.chat.ChatSessionEntry
import ai.openclaw.app.chat.SESSION_LIST_FETCH_LIMIT
import ai.openclaw.app.chat.selectChatAgentSessionKey
import ai.openclaw.app.gateway.GatewayEndpoint
import ai.openclaw.app.gateway.GatewayRequestRejected
import ai.openclaw.app.gateway.GatewaySession
import android.content.Context
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.async
import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.currentCoroutineContext
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.job
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeout
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
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
import java.util.concurrent.atomic.AtomicInteger
import java.util.concurrent.atomic.AtomicReference

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34])
class NodeRuntimeAgentSelectionTest {
  @Test
  fun publicationsRereadSelectedAgentModelsWithoutDiscovery() =
    runBlocking {
      for (event in listOf("config.changed", "chat.metadata.changed")) {
        val runtime = createConnectedRuntime()
        val catalogRequests = Channel<Pair<JsonObject, Job>>(Channel.UNLIMITED)
        val revision = AtomicInteger(0)
        try {
          runtime.gatewayDataRequestOverrideForTests = { _, method, paramsJson ->
            when (method) {
              "models.list" -> {
                catalogRequests.send(Json.parseToJsonElement(paramsJson.orEmpty()).jsonObject to currentCoroutineContext().job)
                """{"models":[{"id":"model-${revision.get()}","provider":"fixture","name":"Published"}]}"""
              }

              "models.authStatus" -> {
                assertEquals(
                  "beta",
                  Json
                    .parseToJsonElement(paramsJson.orEmpty())
                    .jsonObject["agentId"]
                    ?.jsonPrimitive
                    ?.content,
                )
                """{"providers":[{"provider":"credential-${revision.get()}","status":"ok","profiles":[]}]}"""
              }

              "config.get" -> {
                """{"config":{}}"""
              }

              else -> {
                error("Unexpected publication request: $method")
              }
            }
          }
          runtime.selectChatAgent("beta")
          runtime.refreshModelCatalog()
          runtime.refreshProviderModels()
          withTimeout(2_000) {
            repeat(2) { catalogRequests.receive().second.join() }
          }
          assertEquals(
            "model-0",
            runtime.modelCatalog.value
              .single()
              .id,
          )
          assertEquals(
            "model-0",
            runtime.providerModelCatalog.value
              .single()
              .id,
          )
          assertEquals(
            "credential-0",
            runtime.modelAuthProviders.value
              .single()
              .id,
          )
          revision.set(1)
          ReflectionHelpers.callInstanceMethod<Unit>(
            runtime,
            "handleGatewayEvent",
            ReflectionHelpers.ClassParameter.from(String::class.java, event),
            ReflectionHelpers.ClassParameter.from(String::class.java, "{}"),
          )

          withTimeout(2_000) {
            runtime.modelCatalog.first { it.singleOrNull()?.id == "model-1" }
            runtime.providerModelCatalog.first { it.singleOrNull()?.id == "model-1" }
            runtime.modelAuthProviders.first { it.singleOrNull()?.id == "credential-1" }
            repeat(2) {
              val (params, job) = catalogRequests.receive()
              job.join()
              assertEquals("beta", params["agentId"]?.jsonPrimitive?.content)
              assertFalse(params.containsKey("refresh"))
            }
          }
        } finally {
          closeNodeRuntimeTestFixture(runtime)
          catalogRequests.close()
        }
      }
    }

  @Test
  fun defaultModelReadsKeepTheLegacyGatewayContract() =
    runBlocking {
      val runtime = createConnectedRuntime()
      val catalogJobs = Channel<Job>(Channel.UNLIMITED)
      try {
        runtime.gatewayDataRequestOverrideForTests = { _, method, paramsJson ->
          when (method) {
            "models.list" -> {
              catalogJobs.send(currentCoroutineContext().job)
              if ("agentId" in Json.parseToJsonElement(paramsJson.orEmpty()).jsonObject) {
                throw GatewayRequestRejected(GatewaySession.ErrorShape("INVALID_REQUEST", "Legacy catalog parameters unsupported"))
              }
              """{"models":[{"id":"legacy-model","provider":"fixture","name":"Legacy"}]}"""
            }

            "models.authStatus" -> {
              """{"providers":[{"provider":"legacy-credential","status":"ok","profiles":[]}]}"""
            }

            else -> {
              error("Unexpected model request: $method")
            }
          }
        }
        runtime.refreshModelCatalog()
        runtime.refreshProviderModels()
        withTimeout(2_000) {
          val jobs = listOf(catalogJobs.receive(), catalogJobs.receive())
          jobs.forEach { it.join() }
        }
        assertEquals(listOf("legacy-model"), runtime.modelCatalog.value.map { it.id })
        assertEquals(listOf("legacy-model"), runtime.providerModelCatalog.value.map { it.id })
        assertEquals(listOf("legacy-credential"), runtime.modelAuthProviders.value.map { it.id })
      } finally {
        closeNodeRuntimeTestFixture(runtime)
        catalogJobs.close()
      }
    }

  @Test
  fun modelReadsUseTheSelectedAgent() =
    runBlocking {
      val runtime = createConnectedRuntime()
      try {
        runtime.gatewayDataRequestOverrideForTests = { _, method, paramsJson ->
          val agentId =
            Json
              .parseToJsonElement(paramsJson.orEmpty())
              .jsonObject["agentId"]
              ?.jsonPrimitive
              ?.content ?: "alpha"
          when (method) {
            "models.list" -> """{"models":[{"id":"$agentId-model","provider":"fixture","name":"$agentId"}]}"""
            "models.authStatus" -> """{"providers":[{"provider":"$agentId-credential","status":"ok","profiles":[]}]}"""
            else -> error("Unexpected model request: $method")
          }
        }
        runtime.selectChatAgent("beta")
        runtime.refreshModelCatalog()
        runtime.refreshProviderModels()

        val catalog = withTimeout(2_000) { runtime.modelCatalog.first { it.isNotEmpty() } }
        val providerCatalog = withTimeout(2_000) { runtime.providerModelCatalog.first { it.isNotEmpty() } }
        val providers = withTimeout(2_000) { runtime.modelAuthProviders.first { it.isNotEmpty() } }
        assertEquals("beta-model", catalog.single().id)
        assertEquals("beta-model", providerCatalog.single().id)
        assertEquals("beta-credential", providers.single().id)
      } finally {
        closeNodeRuntimeTestFixture(runtime)
      }
    }

  @Test
  fun switchingAwayAndBackRetiresPendingModelReads() =
    runBlocking {
      val runtime = createConnectedRuntime()
      val phase = AtomicInteger(0)
      val catalogStarted = CompletableDeferred<Job>()
      val providerCatalogStarted = CompletableDeferred<Job>()
      val catalogResponse = CompletableDeferred<String>()
      val providerCatalogResponse = CompletableDeferred<String>()
      val models = """{"models":[{"id":"alpha-model","provider":"fixture","name":"Alpha"}]}"""
      try {
        runtime.gatewayDataRequestOverrideForTests = { _, method, paramsJson ->
          when (method) {
            "models.list" -> {
              if (phase.get() == 1) {
                if (Json
                    .parseToJsonElement(paramsJson.orEmpty())
                    .jsonObject["view"]
                    ?.jsonPrimitive
                    ?.content == "provider-config"
                ) {
                  providerCatalogStarted.complete(currentCoroutineContext().job)
                  providerCatalogResponse.await()
                } else {
                  catalogStarted.complete(currentCoroutineContext().job)
                  catalogResponse.await()
                }
              } else {
                models
              }
            }

            "models.authStatus" -> {
              """{"providers":[{"provider":"alpha-credential","status":"ok","profiles":[]}]}"""
            }

            else -> {
              error("Unexpected model request: $method")
            }
          }
        }
        runtime.selectChatAgent("alpha")
        runtime.refreshModelCatalog()
        runtime.refreshProviderModels()
        withTimeout(2_000) { runtime.modelCatalog.first { it.isNotEmpty() } }
        withTimeout(2_000) { runtime.modelAuthProviders.first { it.isNotEmpty() } }

        phase.set(1)
        runtime.refreshModelCatalog()
        runtime.refreshProviderModels()
        val catalogJob = withTimeout(2_000) { catalogStarted.await() }
        val providerCatalogJob = withTimeout(2_000) { providerCatalogStarted.await() }
        runtime.selectChatAgent("beta")
        runtime.selectChatAgent("alpha")
        assertTrue(runtime.modelCatalog.value.isEmpty())
        assertTrue(runtime.providerModelCatalog.value.isEmpty())
        assertTrue(runtime.modelAuthProviders.value.isEmpty())

        phase.set(2)
        catalogResponse.complete(models)
        providerCatalogResponse.completeExceptionally(IllegalStateException("Retired model read failed"))
        withTimeout(2_000) {
          catalogJob.join()
          providerCatalogJob.join()
        }
        assertTrue(runtime.modelCatalog.value.isEmpty())
        assertTrue(runtime.providerModelCatalog.value.isEmpty())
        assertTrue(runtime.modelAuthProviders.value.isEmpty())
        assertEquals(null, runtime.providerModelCatalogErrorText.value)
        assertFalse(runtime.providerModelCatalogRefreshing.value)

        runtime.refreshModelCatalog()
        runtime.refreshProviderModels()
        assertEquals("alpha-model", withTimeout(2_000) { runtime.modelCatalog.first { it.isNotEmpty() } }.single().id)
        assertEquals("alpha-credential", withTimeout(2_000) { runtime.modelAuthProviders.first { it.isNotEmpty() } }.single().id)
      } finally {
        closeNodeRuntimeTestFixture(runtime)
      }
    }

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
  fun agentSelectionRestoresNewChatAfterSwitchingAway() = assertAgentSelectionRestoresCreatedSession(catalogId = null)

  @Test
  fun agentSelectionRestoresNewCatalogChatAfterSwitchingAway() = assertAgentSelectionRestoresCreatedSession(catalogId = "codex")

  @Test
  fun agentSelectionRestoresNewChatWhileItsInitialHistoryIsPending() = assertAgentSelectionRestoresCreatedSession(catalogId = null, holdCreatedHistory = true)

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
  fun agentSelectionRestoresLastExplicitSessionForThatAgent() = assertOffPageRememberedSessionSelection(RememberedSessionState.Active)

  @Test
  fun agentSelectionRetriesOffPageSessionAfterHistoryLacksIdentity() = assertOffPageRememberedSessionSelection(RememberedSessionState.MissingIdentity)

  @Test
  fun agentSelectionForgetsOffPageArchivedSession() = assertOffPageRememberedSessionSelection(RememberedSessionState.Archived)

  @Test
  fun agentSelectionRetriesOffPageSessionAfterHistoryUnavailable() = assertOffPageRememberedSessionSelection(RememberedSessionState.Unavailable)

  @Test
  fun inactiveOwnerArchiveRetiresRememberedSelectionBeforeReturn() = assertOffPageRememberedSessionSelection(RememberedSessionState.ArchivedEvent)

  @Test
  fun successfulArchiveAckRetiresRememberedSelectionWithoutAnArchiveEvent() = assertOffPageRememberedSessionSelection(RememberedSessionState.ArchivedAck)

  @Test
  fun archiveAckRetiresInactiveOwnerSelectionWithoutNavigating() = assertOffPageRememberedSessionSelection(RememberedSessionState.ArchivedAck, ArchiveAckOrder.AfterAgentSwitch)

  @Test
  fun archiveAckPreservesLaterExplicitSameKeySelection() = assertOffPageRememberedSessionSelection(RememberedSessionState.ArchivedAck, ArchiveAckOrder.AfterSameKeyReselection)

  @Test
  fun archiveAckPreservesHistoryObservedSuccessorAfterAgentSwitch() = assertOffPageRememberedSessionSelection(RememberedSessionState.ArchivedAck, ArchiveAckOrder.AfterNewSessionIdentity)

  @Test
  fun archiveAckCannotAcquireOwnershipOfALaterMatchingSessionIdentity() = assertOffPageRememberedSessionSelection(RememberedSessionState.ArchivedAck, ArchiveAckOrder.AfterDifferentArchivedIdentity)

  @Test
  fun retiredPhysicalLeaseCannotForgetRememberedSelection() = assertOffPageRememberedSessionSelection(RememberedSessionState.ArchivedAck, ArchiveAckOrder.AfterLeaseRetirement)

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

  private enum class RememberedSessionState {
    Active,
    MissingIdentity,
    Archived,
    ArchivedEvent,
    ArchivedAck,
    Unavailable,
  }

  private enum class ArchiveAckOrder {
    Active,
    AfterAgentSwitch,
    AfterSameKeyReselection,
    AfterNewSessionIdentity,
    AfterDifferentArchivedIdentity,
    AfterLeaseRetirement,
  }

  private fun assertOffPageRememberedSessionSelection(
    describedState: RememberedSessionState,
    archiveAckOrder: ArchiveAckOrder = ArchiveAckOrder.Active,
  ) = runBlocking {
    val runtime = createConnectedRuntime()
    val chosenKey = "agent:scout:chosen"
    val chosenSession = ChatSessionEntry(key = chosenKey, updatedAtMs = 10, ownerAgentId = "scout")
    val sessions = AtomicReference(listOf(chosenSession))
    val description = AtomicReference(RememberedSessionState.Active)
    val chosenSessionId = AtomicReference("session-$chosenKey")
    val leaseGeneration = AtomicInteger()
    val archiveRequested = CompletableDeferred<Unit>()
    val releaseArchive = CompletableDeferred<Unit>()
    val lookupStarted = AtomicReference<CompletableDeferred<Job>?>(null)
    val preservesChoice = archiveAckOrder !in setOf(ArchiveAckOrder.Active, ArchiveAckOrder.AfterAgentSwitch)
    val archiveSessionId = if (archiveAckOrder == ArchiveAckOrder.AfterDifferentArchivedIdentity) "replacement-$chosenKey" else "session-$chosenKey"
    var exactLookups = 0

    fun sessionId(key: String): String = if (key == chosenKey) chosenSessionId.get() else "session-$key"
    try {
      drainWithMainLooper {
        ReflectionHelpers.getField<AndroidClientDatabases>(runtime, "clientDatabases").clientStateDatabase()
      }
      val requestGateway: suspend (String, String?) -> String = { method, params ->
        val request = Json.parseToJsonElement(params ?: "{}").jsonObject
        when (method) {
          "sessions.list" -> {
            val limit = request["limit"]?.jsonPrimitive?.content?.toInt() ?: 50
            val rows =
              if (request["agentId"]?.jsonPrimitive?.content == "scout") {
                sessions
                  .get()
                  .filter { row ->
                    row.key != chosenKey || description.get() !in setOf(RememberedSessionState.Archived, RememberedSessionState.ArchivedEvent, RememberedSessionState.ArchivedAck)
                  }.sortedByDescending { it.updatedAtMs }
              } else {
                emptyList()
              }
            val page = rows.take(limit)
            // Bootstrap also lists sessions; only the 200-row selection lookup owns this rendezvous.
            if (limit == SESSION_LIST_FETCH_LIMIT) lookupStarted.get()?.complete(currentCoroutineContext().job)
            page.joinToString(
              prefix = """{"sessions":[""",
              postfix = """],"totalCount":${rows.size},"hasMore":${page.size < rows.size}}""",
            ) { row ->
              """{"key":"${row.key}","sessionId":"${sessionId(row.key)}","agentId":"scout","updatedAt":${row.updatedAtMs},"archived":false}"""
            }
          }

          "sessions.patch" -> {
            check(describedState == RememberedSessionState.ArchivedAck)
            check(request.keys == setOf("key", "agentId", "expectedSessionId", "archived"))
            assertEquals(JsonPrimitive(chosenKey), request["key"])
            assertEquals(JsonPrimitive("scout"), request["agentId"])
            assertEquals(JsonPrimitive(archiveSessionId), request["expectedSessionId"])
            assertEquals(JsonPrimitive(true), request["archived"])
            description.set(RememberedSessionState.ArchivedAck)
            archiveRequested.complete(Unit)
            releaseArchive.await()
            // Return the saved ACK without an event, even if a new selection or
            // physical lease took over while the response was pending.
            """{"ok":true,"key":"$chosenKey","entry":{"sessionId":"$archiveSessionId","updatedAt":200,"archivedAt":200}}"""
          }

          "sessions.describe" -> {
            check(request.keys.all { it in setOf("key", "includeDerivedTitles", "includeLastMessage") })
            val key = request.getValue("key").jsonPrimitive.content
            val agentId = requireNotNull(resolveAgentIdFromMainSessionKey(key))
            """{"session":{"key":"$key","sessionId":"session-$key","agentId":"$agentId","label":"App","archived":false}}"""
          }

          "chat.history" -> {
            val key = request.getValue("sessionKey").jsonPrimitive.content
            if (key == chosenKey && request["limit"] == JsonPrimitive(1)) {
              assertEquals(JsonPrimitive("scout"), request["agentId"])
              exactLookups += 1
              lookupStarted.get()?.complete(currentCoroutineContext().job)
              when (description.get()) {
                RememberedSessionState.MissingIdentity, RememberedSessionState.ArchivedEvent, RememberedSessionState.ArchivedAck -> {
                  // A missing Gateway row still projects default sessionInfo fields.
                  """{"messages":[],"sessionInfo":{"key":"$key","agentId":"scout","archived":false}}"""
                }

                RememberedSessionState.Unavailable -> {
                  error("Session lookup temporarily unavailable")
                }

                else -> {
                  val archived = description.get() == RememberedSessionState.Archived
                  """{"sessionId":"${sessionId(key)}","messages":[],"sessionInfo":{"key":"$key","sessionId":"${sessionId(key)}","agentId":"scout","updatedAt":10,"archived":$archived}}"""
                }
              }
            } else {
              // Identity comes from live history, not a sessionInfo/list-row shortcut.
              """{"sessionId":"${sessionId(key)}","messages":[]}"""
            }
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

          "progressCard.get" -> {
            """{"card":null}"""
          }

          else -> {
            error("Unexpected gateway request: $method")
          }
        }
      }
      installChatGateway(runtime, requestGateway, requestLeaseGeneration = leaseGeneration::get)

      suspend fun selectAgentAndWait(agentId: String) {
        val started = CompletableDeferred<Job>()
        lookupStarted.set(started)
        runtime.selectChatAgent(agentId)
        withTimeout(2_000) {
          started.await().join()
          runtime.chatSessionId.first { it != null }
          runtime.chatHistoryLoading.first { !it }
        }
        lookupStarted.compareAndSet(started, null)
      }

      selectAgentAndWait("scout")
      assertEquals(chosenKey, runtime.chatSessionKey.value)

      runtime.switchChatSession(chosenKey, "scout")
      // More than one full page is newer; absence remains non-authoritative in every outcome.
      val newerSessions =
        (1..201).map { index ->
          ChatSessionEntry(key = "agent:scout:recent-$index", updatedAtMs = 100L + index, ownerAgentId = "scout")
        }
      val newestKey = newerSessions.last().key
      sessions.set(newerSessions + chosenSession)
      if (describedState == RememberedSessionState.ArchivedAck) {
        val chat = ReflectionHelpers.getField<ChatController>(runtime, "chat")
        if (archiveAckOrder == ArchiveAckOrder.AfterDifferentArchivedIdentity) chosenSessionId.set(archiveSessionId)
        val archive =
          async {
            chat.patchSession(
              key = chosenKey,
              ownerAgentId = "scout",
              expectedSessionId = archiveSessionId,
              archived = true,
            )
          }
        withTimeout(2_000) { archiveRequested.await() }
        if (preservesChoice) {
          // The old archive has committed; an intervening restore/recreation is
          // visible without requiring its best-effort notification to arrive.
          description.set(RememberedSessionState.Active)
          when (archiveAckOrder) {
            ArchiveAckOrder.AfterSameKeyReselection -> {
              runtime.switchChatSession(chosenKey, "scout")
            }

            ArchiveAckOrder.AfterNewSessionIdentity, ArchiveAckOrder.AfterDifferentArchivedIdentity -> {
              val selectionGeneration = chat.selectionGeneration.value
              chosenSessionId.set("replacement-$chosenKey")
              chat.refresh()
              withTimeout(2_000) {
                runtime.chatSessionId.first { it == chosenSessionId.get() }
                runtime.chatHistoryLoading.first { !it }
              }
              assertEquals(selectionGeneration, chat.selectionGeneration.value)
            }

            ArchiveAckOrder.AfterLeaseRetirement -> {
              leaseGeneration.incrementAndGet()
            }

            else -> {
              error("Expected a newer selection or a retired lease")
            }
          }
        }
        if (archiveAckOrder != ArchiveAckOrder.Active) selectAgentAndWait("writer")
        val selectedBeforeAck = runtime.chatSessionKey.value
        releaseArchive.complete(Unit)
        assertTrue(withTimeout(2_000) { archive.await() })
        if (archiveAckOrder == ArchiveAckOrder.Active) {
          assertEquals("The acknowledged active archive must navigate away", runtime.mainSessionKey.value, runtime.chatSessionKey.value)
        } else {
          assertEquals("Retiring an old owner's memory must not navigate", selectedBeforeAck, runtime.chatSessionKey.value)
        }
      } else {
        description.set(describedState)
      }
      if (resolveAgentIdFromMainSessionKey(runtime.chatSessionKey.value) != "writer") selectAgentAndWait("writer")
      assertEquals("writer", resolveAgentIdFromMainSessionKey(runtime.chatSessionKey.value))
      if (describedState == RememberedSessionState.ArchivedEvent) {
        val chat = ReflectionHelpers.getField<ChatController>(runtime, "chat")
        chat.handleGatewayEvent(
          "sessions.changed",
          """{"sessionKey":"$chosenKey","agentId":"scout","reason":"archive","sessionId":"session-$chosenKey","archived":true,"archivedAt":200,"permissionMode":null,"permissionModePending":false}""",
        )
      }
      selectAgentAndWait("scout")

      when (describedState) {
        RememberedSessionState.Active -> {
          assertEquals("Explicitly selecting the already-visible chat must be remembered", chosenKey, runtime.chatSessionKey.value)
        }

        RememberedSessionState.Archived, RememberedSessionState.ArchivedEvent -> {
          assertEquals("An archived session must not be restored", newestKey, runtime.chatSessionKey.value)
        }

        RememberedSessionState.ArchivedAck -> {
          val expectedKey = if (preservesChoice) chosenKey else newestKey
          assertEquals("The archive ACK may retire only its own remembered occurrence", expectedKey, runtime.chatSessionKey.value)
          if (preservesChoice) assertEquals(chosenSessionId.get(), runtime.chatSessionId.value)
        }

        RememberedSessionState.MissingIdentity, RememberedSessionState.Unavailable -> {
          assertEquals("An unresolved selection must stay on the agent main chat", runtime.mainSessionKey.value, runtime.chatSessionKey.value)
          assertEquals(
            "An unresolved selection must show an action hint",
            "Could not restore the last chat. Select a chat from the sidebar.",
            runtime.chatError.value,
          )
        }
      }
      if (describedState == RememberedSessionState.ArchivedEvent || (describedState == RememberedSessionState.ArchivedAck && !preservesChoice)) {
        assertEquals("An acknowledged retirement must not depend on another exact lookup", 0, exactLookups)
      }
      if (describedState != RememberedSessionState.Active) {
        description.set(RememberedSessionState.Active)
        selectAgentAndWait("writer")
        selectAgentAndWait("scout")
        if (describedState in setOf(RememberedSessionState.Archived, RememberedSessionState.ArchivedEvent, RememberedSessionState.ArchivedAck) && !preservesChoice) {
          assertEquals("A retired preference must not return when its old session reappears", newestKey, runtime.chatSessionKey.value)
        } else {
          assertEquals("A later agent return must retry the remembered session", chosenKey, runtime.chatSessionKey.value)
        }
      }
    } finally {
      releaseArchive.complete(Unit)
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
        installChatGateway(runtime, requestGateway)
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

  private fun assertAgentSelectionRestoresCreatedSession(
    catalogId: String?,
    holdCreatedHistory: Boolean = false,
  ) = runBlocking {
    val runtime = createConnectedRuntime()
    val lookupJobs = Channel<Job>(capacity = 3)
    val createStarted = CompletableDeferred<Job>()
    val createdHistoryStarted = CompletableDeferred<Unit>()
    val releaseCreatedHistory = CompletableDeferred<Unit>()
    val previousKey = "agent:scout:previous"
    val createdKey = "agent:scout:created"
    val sessions =
      AtomicReference(
        listOf(ChatSessionEntry(key = previousKey, updatedAtMs = 10, ownerAgentId = "scout")),
      )
    try {
      val requestGateway: suspend (String, String?) -> String = { method, params ->
        val request = Json.parseToJsonElement(params ?: "{}").jsonObject
        when (method) {
          "sessions.describe" -> {
            """{"session":{"label":"App"}}"""
          }

          "sessions.create" -> {
            createStarted.complete(currentCoroutineContext().job)
            sessions.set(
              sessions.get() + ChatSessionEntry(key = createdKey, updatedAtMs = 20, ownerAgentId = "scout"),
            )
            """{"ok":true,"key":"$createdKey","sessionId":"session-$createdKey","runStarted":false}"""
          }

          "chat.history" -> {
            val key = request.getValue("sessionKey").jsonPrimitive.content
            if (holdCreatedHistory && key == createdKey) {
              createdHistoryStarted.complete(Unit)
              releaseCreatedHistory.await()
            }
            """{"sessionId":"session-$key","messages":[]}"""
          }

          "sessions.list" -> {
            if (request["limit"] == JsonPrimitive(SESSION_LIST_FETCH_LIMIT)) lookupJobs.send(currentCoroutineContext().job)
            val rows = if (request["agentId"]?.jsonPrimitive?.content == "scout") sessions.get() else emptyList()
            rows.joinToString(prefix = """{"sessions":[""", postfix = "]}") { row ->
              """{"key":"${row.key}","sessionId":"session-${row.key}","agentId":"scout","updatedAt":${row.updatedAtMs},"archived":false}"""
            }
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
      installChatGateway(runtime, requestGateway)

      runtime.selectChatAgent("scout")
      withTimeout(5_000) { lookupJobs.receive().join() }
      runtime.switchChatSession(previousKey, "scout")
      withTimeout(5_000) {
        runtime.chatSessionId.first { it != null }
        runtime.chatHistoryLoading.first { !it }
      }
      assertEquals(previousKey, runtime.chatSessionKey.value)

      val catalogCreation =
        if (catalogId == null) {
          runtime.startNewChat()
          null
        } else {
          async { runtime.createSessionCatalogEntry(catalogId) }
        }
      val createJob = withTimeout(5_000) { createStarted.await() }
      if (holdCreatedHistory) {
        withTimeout(5_000) { createdHistoryStarted.await() }
        assertFalse("Creation must still be waiting for its initial history", createJob.isCompleted)
      } else {
        withTimeout(5_000) { createJob.join() }
        catalogCreation?.let { assertTrue(it.await()) }
      }
      assertEquals(createdKey, runtime.chatSessionKey.value)

      runtime.selectChatAgent("writer")
      withTimeout(5_000) { lookupJobs.receive().join() }
      assertEquals("writer", resolveAgentIdFromMainSessionKey(runtime.chatSessionKey.value))
      runtime.selectChatAgent("scout")
      withTimeout(5_000) { lookupJobs.receive().join() }

      assertEquals("Agent return must restore the newly selected chat", createdKey, runtime.chatSessionKey.value)
      releaseCreatedHistory.complete(Unit)
      withTimeout(5_000) { createJob.join() }
    } finally {
      releaseCreatedHistory.complete(Unit)
      lookupJobs.close()
      closeNodeRuntimeTestFixture(runtime)
    }
  }

  private fun installChatGateway(
    runtime: NodeRuntime,
    requestGateway: suspend (String, String?) -> String,
    requestLeaseGeneration: () -> Int = { 0 },
  ) {
    val requestGatewayForGateway: suspend (String, String, String?) -> String = { _, method, params ->
      requestGateway(method, params)
    }
    val chat = ReflectionHelpers.getField<ChatController>(runtime, "chat")
    ReflectionHelpers.setField(chat, "requestGateway", requestGateway)
    ReflectionHelpers.setField(chat, "requestGatewayForGateway", requestGatewayForGateway)
    val captureLease: (ChatCacheScope?) -> GatewaySession.RequestLease? = { gatewayScope ->
      val generation = requestLeaseGeneration()
      GatewaySession.RequestLease(
        endpointStableId = gatewayScope?.gatewayId.orEmpty(),
        isCurrentImpl = { generation == requestLeaseGeneration() },
      ) { method, paramsJson, _, withEnqueue ->
        withEnqueue {}
        if (gatewayScope == null) {
          requestGateway(method, paramsJson)
        } else {
          requestGatewayForGateway(gatewayScope.gatewayId, method, paramsJson)
        }
      }
    }
    ReflectionHelpers.setField(chat, "captureRequestLease", captureLease)
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
