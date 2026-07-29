package ai.openclaw.app.chat

import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.async
import kotlinx.coroutines.test.TestScope
import kotlinx.coroutines.test.advanceUntilIdle
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.runTest
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Test

@OptIn(ExperimentalCoroutinesApi::class)
class ChatControllerSessionSearchTest {
  private val json = Json { ignoreUnknownKeys = true }

  private fun TestScope.newController(gateway: ScriptedGateway): ChatController = ChatController(scope = this, json = json, requestGateway = gateway::request)

  private fun sessionRowJson(
    key: String,
    updatedAt: Long,
    displayName: String? = null,
    archived: Boolean = false,
  ) = buildJsonObject {
    put("key", JsonPrimitive(key))
    put("updatedAt", JsonPrimitive(updatedAt))
    if (displayName != null) put("displayName", JsonPrimitive(displayName))
    if (archived) put("archived", JsonPrimitive(true))
  }

  private fun sessionsListJson(vararg rows: kotlinx.serialization.json.JsonObject): String = buildJsonObject { put("sessions", JsonArray(rows.toList())) }.toString()

  private fun paramField(
    paramsJson: String?,
    field: String,
  ): String? =
    paramsJson
      ?.let { json.parseToJsonElement(it).jsonObject[field] }
      ?.jsonPrimitive
      ?.content

  @Test
  fun filterSessionEntriesMatchesDisplayNameLabelAndKey() {
    val sessions =
      listOf(
        ChatSessionEntry(key = "agent:main:topic-a", updatedAtMs = 2, displayName = "Trip planning"),
        ChatSessionEntry(key = "agent:main:topic-b", updatedAtMs = 1, displayName = "Groceries"),
        ChatSessionEntry(key = "agent:main:trip-notes", updatedAtMs = 3, displayName = "Notes"),
      )
    assertEquals(
      listOf("agent:main:topic-a", "agent:main:trip-notes"),
      filterSessionEntries(sessions, "TRIP").map { it.key },
    )
    assertEquals(sessions, filterSessionEntries(sessions, "  "))
  }

  @Test
  fun fetchSessionListSendsSearchAndArchivedParams() =
    runTest {
      val gateway = ScriptedGateway(json)
      gateway.respond("sessions.list") { paramsJson ->
        val params = json.parseToJsonElement(paramsJson.orEmpty()).jsonObject
        if (params["archived"]?.jsonPrimitive?.content == "true") {
          sessionsListJson(sessionRowJson(key = "agent:main:old", updatedAt = 10, archived = true))
        } else {
          sessionsListJson(sessionRowJson(key = "agent:main:topic-a", updatedAt = 100))
        }
      }
      val controller = newController(gateway)

      val archivedRows = controller.fetchSessionList(search = null, archived = true)
      assertEquals(listOf("agent:main:old"), archivedRows.map { it.key })
      assertTrue(archivedRows.single().archived == true)

      controller.fetchSessionList(search = "  trip  ", archived = false)
      val searchCall = gateway.calls.last { it.method == "sessions.list" }
      assertEquals("trip", paramField(searchCall.paramsJson, "search"))
      assertEquals("200", paramField(searchCall.paramsJson, "limit"))
    }

  @Test
  fun fetchSessionListFallsBackToLocalFilterWhenOffline() =
    runTest {
      val gateway = ScriptedGateway(json)
      gateway.respond("sessions.list") { paramsJson ->
        val params = json.parseToJsonElement(paramsJson.orEmpty()).jsonObject
        if ("search" in params || "archived" in params) error("offline")
        sessionsListJson(
          sessionRowJson(key = "agent:main:topic-a", updatedAt = 2, displayName = "Trip planning"),
          sessionRowJson(key = "agent:main:topic-b", updatedAt = 1, displayName = "Groceries"),
        )
      }
      val controller = newController(gateway)
      controller.refreshSessions()
      advanceUntilIdle()

      val filtered = controller.fetchSessionList(search = "trip", archived = false)
      assertEquals(listOf("agent:main:topic-a"), filtered.map { it.key })
      // Archived rows exist only server-side, so offline archived search is empty.
      assertTrue(controller.fetchSessionList(search = null, archived = true).isEmpty())
    }

  @Test
  fun fetchSessionListDoesNotGuessMainWhileDefaultOwnerIsUnknown() =
    runTest {
      val gateway = ScriptedGateway(json)
      val controller =
        ChatController(
          scope = this,
          json = json,
          requestGateway = gateway::request,
          currentDefaultAgentId = { null },
        )

      assertTrue(controller.fetchSessionList(search = "trip", archived = false).isEmpty())
      assertTrue(controller.fetchSessionList(search = null, archived = true).isEmpty())
      assertTrue(gateway.calls.isEmpty())
    }

  @Test
  fun fetchSessionListRethrowsCancellationInsteadOfFallingBack() =
    runTest {
      val gateway = ScriptedGateway(json)
      gateway.respond("sessions.list") { _ -> throw CancellationException("superseded") }
      val controller = newController(gateway)

      try {
        controller.fetchSessionList(search = "trip", archived = false)
        fail("expected CancellationException to propagate")
      } catch (_: CancellationException) {
        // A superseded search must cancel, not repaint stale fallback rows.
      }
    }

  @Test
  fun fetchSessionListDropsAResponseAfterOwnerOrGatewayChanges() =
    runTest {
      var defaultAgentId = "agent-a"
      var defaultAgentRevision = 1L
      var cacheScope = ChatCacheScope(gatewayId = "gateway-a", connectionGeneration = 1)
      val requestStarted = CompletableDeferred<Unit>()
      val releaseResponse = CompletableDeferred<String>()
      val gateway = ScriptedGateway(json)
      gateway.respond("sessions.list") {
        requestStarted.complete(Unit)
        releaseResponse.await()
      }
      val controller =
        ChatController(
          scope = this,
          json = json,
          requestGateway = gateway::request,
          cacheScope = { cacheScope },
          currentDefaultAgentId = { defaultAgentId },
          currentDefaultAgentRevision = { defaultAgentRevision },
        )

      val pending = async { controller.fetchSessionList(search = "trip", archived = false) }
      runCurrent()
      requestStarted.await()
      defaultAgentId = "agent-b"
      defaultAgentRevision += 1
      cacheScope = ChatCacheScope(gatewayId = "gateway-b", connectionGeneration = 2)
      releaseResponse.complete(sessionsListJson(sessionRowJson(key = "agent:agent-a:old", updatedAt = 10)))

      assertTrue(pending.await().isEmpty())
    }
}
