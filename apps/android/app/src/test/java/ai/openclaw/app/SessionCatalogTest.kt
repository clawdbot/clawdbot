package ai.openclaw.app

import kotlinx.coroutines.test.runTest
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class SessionCatalogTest {
  private val json = Json { ignoreUnknownKeys = true }

  @Test
  fun parserPreservesCatalogHostSessionPaginationAndErrors() {
    val catalogs =
      parseSessionCatalogs(
        raw =
          """
          {
            "catalogs": [{
              "id": "codex",
              "label": "Codex",
              "error": {"message": "catalog warning"},
              "capabilities": {
                "continueSession": true,
                "archive": false,
                "createSession": {"model": "openai/gpt-5.6-luna"}
              },
              "hosts": [{
                "hostId": "desktop",
                "label": "Desktop",
                "kind": "node",
                "connected": true,
                "nextCursor": "next-page",
                "sessions": [
                  {
                    "threadId": "thread-new",
                    "sourceHomeId": "home-1",
                    "name": "Newer",
                    "cwd": "C:/work/openclaw",
                    "status": "active",
                    "recencyAt": 200,
                    "sessionKey": "agent:main:codex:new",
                    "canContinue": true
                  },
                  {
                    "threadId": "thread-other",
                    "status": "idle",
                    "updatedAt": 100,
                    "archived": false,
                    "canContinue": true
                  }
                ]
              }, {
                "hostId": "offline",
                "label": "Offline host",
                "kind": "node",
                "connected": false,
                "error": {"message": "host unavailable"},
                "sessions": []
              }]
            }]
          }
          """.trimIndent(),
        requestedAgentId = " main ",
        json = json,
      )

    assertEquals(1, catalogs.size)
    val catalog = catalogs.single()
    assertEquals("catalog warning", catalog.errorText)
    assertTrue(catalog.canCreateSession)
    assertEquals(listOf("desktop", "offline"), catalog.hosts.map(SessionCatalogHost::hostId))
    val host = catalog.hosts.first()
    assertTrue(host.connected)
    assertEquals("next-page", host.nextCursor)
    assertEquals("main", host.sessions.first().agentId)
    assertEquals("C:/work/openclaw", host.sessions.first().cwd)
    assertNull(host.sessions.last().cwd)
    assertEquals(100.0, host.sessions.last().recencyAt ?: 0.0, 0.0)
    assertEquals("host unavailable", catalog.hosts.last().errorText)
  }

  @Test
  fun requestBuildersKeepTheExactAgentLocatorAndHostCursors() {
    val list = json.parseToJsonElement(sessionCatalogListParams(" main ", "progress-1")).jsonObject
    assertEquals("main", list.getValue("agentId").jsonPrimitive.content)
    assertEquals("progress-1", list.getValue("progressId").jsonPrimitive.content)
    assertFalse("catalogId" in list)
    assertEquals(
      40,
      list
        .getValue("limitPerHost")
        .jsonPrimitive.content
        .toInt(),
    )

    val page =
      json
        .parseToJsonElement(
          sessionCatalogPageParams("main", "codex", mapOf("desktop" to "cursor-2")),
        ).jsonObject
    assertEquals("codex", page.getValue("catalogId").jsonPrimitive.content)
    assertEquals(
      "cursor-2",
      page
        .getValue("cursors")
        .jsonObject
        .getValue("desktop")
        .jsonPrimitive.content,
    )
    assertFalse("limitPerHost" in page)

    val entry =
      entry(
        threadId = "thread-1",
        sourceHomeId = "home-1",
        agentId = "main",
      )
    val continuation =
      json.parseToJsonElement(sessionCatalogContinueParams(entry)).jsonObject
    assertEquals("codex", continuation.getValue("catalogId").jsonPrimitive.content)
    assertEquals("desktop", continuation.getValue("hostId").jsonPrimitive.content)
    assertEquals("thread-1", continuation.getValue("threadId").jsonPrimitive.content)
    assertEquals("home-1", continuation.getValue("sourceHomeId").jsonPrimitive.content)
    assertEquals("main", continuation.getValue("agentId").jsonPrimitive.content)
  }

  @Test
  fun pageMergeDeduplicatesSessionsAndAdvancesTheHostCursor() {
    val first =
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
              sessions = listOf(entry("thread-1")),
              nextCursor = "cursor-2",
            ),
          ),
      )
    val page =
      first.copy(
        hosts =
          listOf(
            first.hosts.single().copy(
              sessions = listOf(entry("thread-1"), entry("thread-2")),
              nextCursor = null,
            ),
          ),
      )

    val merged =
      mergeSessionCatalogPage(
        current = first,
        page = page,
        cursors = mapOf("desktop" to "cursor-2"),
      ).catalog.hosts.single()

    assertEquals(listOf("thread-1", "thread-2"), merged.sessions.map(SessionCatalogEntry::threadId))
    assertNull(merged.nextCursor)
    assertFalse(merged.sessions.first().archived)
  }

  @Test
  fun pageMergeIgnoresHostsThatWereNotRequested() {
    val requested =
      SessionCatalogHost(
        catalogId = "codex",
        hostId = "requested",
        label = "Requested",
        kind = "node",
        connected = true,
        sessions = listOf(entry("requested-1")),
        nextCursor = "requested-cursor",
      )
    val exhausted =
      requested.copy(
        hostId = "exhausted",
        label = "Exhausted",
        sessions = listOf(entry("exhausted-1")),
        nextCursor = null,
      )
    val current = SessionCatalog(id = "codex", label = "Codex", hosts = listOf(requested, exhausted))
    val page =
      current.copy(
        hosts =
          listOf(
            requested.copy(sessions = listOf(entry("requested-2")), nextCursor = null),
            exhausted.copy(sessions = listOf(entry("exhausted-first-page")), nextCursor = "stale-cursor"),
          ),
      )

    val result =
      mergeSessionCatalogPage(
        current = current,
        page = page,
        cursors = mapOf("requested" to "requested-cursor"),
      )

    assertEquals(setOf("requested"), result.advancedHostIds)
    assertEquals(
      listOf("requested-1", "requested-2"),
      result.catalog.hosts
        .first { it.hostId == "requested" }
        .sessions
        .map(SessionCatalogEntry::threadId),
    )
    assertEquals(exhausted, result.catalog.hosts.first { it.hostId == "exhausted" })
  }

  @Test
  fun pageMergePreservesSessionsAndCursorWhenAHostFails() {
    val currentHost =
      SessionCatalogHost(
        catalogId = "claude-code",
        hostId = "desktop",
        label = "Desktop",
        kind = "node",
        connected = true,
        sessions = listOf(entry("thread-1")),
        nextCursor = "retry-cursor",
      )
    val current = SessionCatalog(id = "claude-code", label = "Claude Code", hosts = listOf(currentHost))
    val page =
      current.copy(
        hosts =
          listOf(
            currentHost.copy(
              sessions = emptyList(),
              nextCursor = null,
              errorText = "Provider unavailable",
            ),
          ),
      )

    val result = mergeSessionCatalogPage(current, page, mapOf("desktop" to "retry-cursor"))
    val mergedHost = result.catalog.hosts.single()

    assertTrue(result.advancedHostIds.isEmpty())
    assertEquals(currentHost.sessions, mergedHost.sessions)
    assertEquals("retry-cursor", mergedHost.nextCursor)
    assertEquals("Provider unavailable", mergedHost.errorText)
  }

  @Test
  fun continueResultRequiresANonBlankSessionKey() {
    assertEquals(
      "agent:main:codex:thread-1",
      parseSessionCatalogContinueResult("""{"sessionKey":"agent:main:codex:thread-1"}""", json),
    )
    assertTrue(runCatching { parseSessionCatalogContinueResult("""{"sessionKey":"  "}""", json) }.isFailure)
  }

  @Test
  fun hostProgressParsesAndReplacesTheMatchingHostOnly() {
    val current =
      listOf(
        SessionCatalog(
          id = "codex",
          label = "Codex",
          hosts = listOf(host("desktop", listOf(entry("old"))), host("other", listOf(entry("keep")))),
        ),
      )
    val progress =
      parseSessionCatalogHostProgress(
        """{"progressId":"progress-1","agentId":"main","catalog":{"id":"codex","label":"Codex","hosts":[{"hostId":"desktop","label":"Desktop","connected":true,"sessions":[{"threadId":"fresh","status":"idle","canContinue":true}]}]}}""",
        json,
      )!!

    val merged = mergeSessionCatalogHostProgress(current, progress)

    assertEquals("progress-1", progress.progressId)
    assertFalse(progress.catalog.canCreateSession)
    assertEquals(
      listOf("fresh"),
      merged
        .single()
        .hosts
        .first()
        .sessions
        .map(SessionCatalogEntry::threadId),
    )
    assertEquals(
      listOf("keep"),
      merged
        .single()
        .hosts
        .last()
        .sessions
        .map(SessionCatalogEntry::threadId),
    )
  }

  @Test
  fun hostProgressKeepsLoadedRowsAndCursor() {
    val previous =
      listOf(
        SessionCatalog(
          id = "codex",
          label = "Codex",
          hosts = listOf(host("desktop", listOf(entry("updated"), entry("page-2")), nextCursor = "page-3")),
        ),
      )
    val fresh =
      listOf(
        SessionCatalog(
          id = "codex",
          label = "Codex",
          hosts = listOf(host("desktop", listOf(entry("updated").copy(name = "Fresh title")), nextCursor = "page-2")),
        ),
      )

    val reconciled =
      mergeSessionCatalogHostProgress(
        current = previous,
        progress = SessionCatalogHostProgress(progressId = "refresh", agentId = "main", catalog = fresh.single()),
        preserveExpandedHostIds = setOf(sessionCatalogHostKey("codex", "desktop")),
      ).single().hosts.single()

    assertEquals(listOf("updated", "page-2"), reconciled.sessions.map(SessionCatalogEntry::threadId))
    assertEquals("Fresh title", reconciled.sessions.first().name)
    assertEquals("page-3", reconciled.nextCursor)
  }

  @Test
  fun refreshRefetchesThePreviouslyLoadedDepthInsteadOfKeepingAStaleTail() =
    runTest {
      val previous =
        listOf(
          SessionCatalog(
            id = "codex",
            label = "Codex",
            hosts =
              listOf(
                host(
                  "desktop",
                  listOf(
                    entry("first"),
                    entry("page-2").copy(name = "Old title"),
                    entry("deleted"),
                  ),
                  nextCursor = "cursor-3",
                ),
              ),
          ),
        )
      val firstPages =
        listOf(
          SessionCatalog(
            id = "codex",
            label = "Codex",
            hosts =
              listOf(
                host(
                  "desktop",
                  listOf(entry("first").copy(name = "Fresh first page")),
                  nextCursor = "cursor-2",
                ),
              ),
          ),
        )
      val requestedCursors = mutableListOf<String>()

      val refreshed =
        refetchLoadedSessionCatalogPages(
          firstPages = firstPages,
          previous = previous,
          loadedPageDepthsByHost =
            mapOf(sessionCatalogHostKey("codex", "desktop") to 1),
          isCurrent = { true },
        ) { catalogId, hostId, cursor ->
          assertEquals("codex", catalogId)
          assertEquals("desktop", hostId)
          requestedCursors += cursor
          host(
            "desktop",
            listOf(entry("page-2").copy(name = "Fresh title")),
            nextCursor = "cursor-3",
          )
        }.single().hosts.single()

      assertEquals(listOf("cursor-2"), requestedCursors)
      assertEquals(listOf("first", "page-2"), refreshed.sessions.map(SessionCatalogEntry::threadId))
      assertEquals("Fresh title", refreshed.sessions.last().name)
      assertEquals("cursor-3", refreshed.nextCursor)
    }

  @Test
  fun successfulPageLoadsIncrementOnlyTheHostsThatAdvanced() {
    val desktopKey = sessionCatalogHostKey("codex", "desktop")
    val depths =
      incrementSessionCatalogPageDepths(
        current = mapOf(desktopKey to 1),
        catalogId = "codex",
        advancedHostIds = setOf("desktop", "laptop"),
      )

    assertEquals(2, depths[desktopKey])
    assertEquals(1, depths[sessionCatalogHostKey("codex", "laptop")])
  }

  private fun host(
    hostId: String,
    sessions: List<SessionCatalogEntry>,
    nextCursor: String? = null,
  ): SessionCatalogHost =
    SessionCatalogHost(
      catalogId = "codex",
      hostId = hostId,
      label = hostId,
      kind = "node",
      connected = true,
      sessions = sessions,
      nextCursor = nextCursor,
    )

  private fun entry(
    threadId: String,
    sourceHomeId: String? = null,
    agentId: String? = "main",
  ): SessionCatalogEntry =
    SessionCatalogEntry(
      catalogId = "codex",
      hostId = "desktop",
      threadId = threadId,
      sourceHomeId = sourceHomeId,
      agentId = agentId,
      status = "idle",
      archived = false,
      canContinue = true,
    )
}
