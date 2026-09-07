package ai.openclaw.app.chat

import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class ChatSwarmProgressTest {
  @Test
  fun activityNotesDecorateChildrenInObservationOrder() {
    val groupId = "swarm:agent:main:parent:turn-1"
    val tracker = ChatSwarmActivityTracker()

    assertTrue(
      tracker.observe(
        buildJsonObject {
          put("sessionKey", JsonPrimitive("agent:main:parent"))
          put("reason", JsonPrimitive("swarm-note"))
          put("swarmGroupId", JsonPrimitive(groupId))
          put("kind", JsonPrimitive("phase"))
          put("text", JsonPrimitive("Research"))
        },
      ),
    )
    assertTrue(
      tracker.observe(
        buildJsonObject {
          put("sessionKey", JsonPrimitive("agent:main:child"))
          put("reason", JsonPrimitive("create"))
          put("swarmGroupId", JsonPrimitive(groupId))
        },
      ),
    )
    assertTrue(
      tracker.observe(
        buildJsonObject {
          put("sessionKey", JsonPrimitive("agent:main:parent"))
          put("reason", JsonPrimitive("swarm-note"))
          put("swarmGroupId", JsonPrimitive(groupId))
          put("kind", JsonPrimitive("log"))
          put("text", JsonPrimitive("Comparing sources"))
        },
      ),
    )

    val row = tracker.decorate(listOf(session("agent:main:child", "running", groupId))).single()
    assertEquals("Research", row.swarmPhase)
    assertEquals(0, row.swarmPhaseRank)
    assertEquals("Comparing sources", row.swarmLog)
  }

  @Test
  fun nestedActivityNotesDecorateChildren() {
    val groupId = "swarm:agent:main:parent:turn-1"
    val tracker = ChatSwarmActivityTracker()

    assertTrue(
      tracker.observe(
        buildJsonObject {
          put(
            "session",
            buildJsonObject {
              put("sessionKey", JsonPrimitive("agent:main:parent"))
              put("swarmGroupId", JsonPrimitive(groupId))
              put("kind", JsonPrimitive("phase"))
              put("text", JsonPrimitive("Research"))
            },
          )
        },
      ),
    )
    assertTrue(
      tracker.observe(
        buildJsonObject {
          put("reason", JsonPrimitive("create"))
          put(
            "session",
            buildJsonObject {
              put("key", JsonPrimitive("agent:main:child"))
              put("swarmGroupId", JsonPrimitive(groupId))
            },
          )
        },
      ),
    )

    val row = tracker.decorate(listOf(session("agent:main:child", "running", groupId))).single()
    assertEquals("Research", row.swarmPhase)
  }

  @Test
  fun projectionMapsStatesAndHidesTerminalGroups() {
    val active = "swarm:agent:main:parent:active"
    val finished = "swarm:agent:main:parent:finished"
    val groups =
      buildChatSwarmGroups(
        sessions =
          listOf(
            session("queued", "queued", active, hasActiveRun = true),
            session("running", "running", active),
            session("done", "done", active),
            session("failed", "timeout", active),
            session("finished", "done", finished),
          ),
        matchesParent = { it == "agent:main:parent" },
      )

    assertEquals(1, groups.size)
    assertEquals(active, groups.single().groupId)
    assertEquals(1, groups.single().running)
    assertEquals(1, groups.single().done)
    assertEquals(1, groups.single().failed)
    assertEquals(
      listOf(ChatSwarmDotStatus.Queued, ChatSwarmDotStatus.Running, ChatSwarmDotStatus.Done, ChatSwarmDotStatus.Failed),
      groups
        .single()
        .phases
        .single()
        .dots
        .map(ChatSwarmDot::status),
    )
  }

  @Test
  fun childPagerRepeatsFromZeroWhenRowsMoveAcrossOffsets() =
    kotlinx.coroutines.test.runTest {
      val groupId = "swarm:agent:main:parent:paged"
      val pages =
        listOf(
          listOf(session("zero", "running", groupId), session("one", "running", groupId)),
          listOf(session("one", "running", groupId), session("two", "running", groupId)),
          listOf(session("zero", "running", groupId), session("one", "done", groupId)),
          listOf(session("three", "running", groupId), session("two", "running", groupId)),
        )
      var call = 0

      val rows =
        collectChatSwarmChildSessions { offset ->
          val page = pages[call++]
          ChatSwarmSessionPage(
            sessions = page,
            totalCount = 4,
            nextOffset = if (offset == 0) 2 else null,
            hasMore = offset == 0,
          )
        }

      assertEquals(setOf("zero", "one", "two", "three"), rows.map(ChatSessionEntry::key).toSet())
      assertEquals("done", rows.first { it.key == "one" }.status)
      assertEquals(4, call)
    }

  @Test
  fun childPagerUsesTotalCountWhenHasMoreIsAbsent() =
    kotlinx.coroutines.test.runTest {
      var call = 0
      val rows =
        collectChatSwarmChildSessions { offset ->
          call += 1
          ChatSwarmSessionPage(
            sessions = listOf(session("child-$offset", "running", "swarm:agent:main:parent:paged")),
            totalCount = 2,
            nextOffset = if (offset == 0) 1 else null,
            hasMore = null,
          )
        }

      assertEquals(listOf("child-0", "child-1"), rows.map(ChatSessionEntry::key))
      assertEquals(2, call)
    }

  @Test
  fun childPagerBoundsAdvancingMalformedPagination() =
    kotlinx.coroutines.test.runTest {
      var call = 0
      val rows =
        collectChatSwarmChildSessions { offset ->
          call += 1
          ChatSwarmSessionPage(
            sessions = listOf(session("child", "running", "swarm:agent:main:parent:paged")),
            totalCount = Int.MAX_VALUE,
            nextOffset = offset + 1,
            hasMore = true,
          )
        }

      assertEquals(listOf("child"), rows.map(ChatSessionEntry::key))
      assertEquals(100, call)
    }

  @Test
  fun swarmEventsIgnoreOtherParents() {
    val current = "agent:main:parent"
    val other = "agent:main:other"
    val ownChild =
      buildJsonObject {
        put("sessionKey", JsonPrimitive("agent:main:child"))
        put("parentSessionKey", JsonPrimitive(current))
        put("reason", JsonPrimitive("create"))
        put("swarmGroupId", JsonPrimitive("custom-group"))
      }
    val otherPhase =
      buildJsonObject {
        put("sessionKey", JsonPrimitive(other))
        put("reason", JsonPrimitive("swarm-note"))
        put("swarmGroupId", JsonPrimitive("swarm:$other:turn"))
        put("kind", JsonPrimitive("phase"))
        put("text", JsonPrimitive("Research"))
      }

    assertTrue(chatSwarmEventBelongsToParent(ownChild) { it == current })
    assertTrue(!chatSwarmEventBelongsToParent(otherPhase) { it == current })
  }

  @Test
  fun projectionCapsHistoryAndKeepsActiveWorker() {
    val groupId = "swarm:agent:main:parent:large"
    val sessions =
      (0 until 300).map { session("done-$it", "done", groupId) } +
        session("running", "running", groupId)

    val phase = buildChatSwarmGroups(sessions) { it == "agent:main:parent" }.single().phases.single()
    assertEquals(256, phase.dots.size)
    assertEquals(45, phase.hidden)
    assertTrue(phase.dots.any { it.status == ChatSwarmDotStatus.Running })
  }

  @Test
  fun swarmSnapshotRequiresEnabledMatchingSessionOwner() {
    val group =
      ChatSwarmGroup(
        groupId = "private-group",
        label = "private-label",
        running = 1,
        done = 0,
        failed = 0,
        narrator = null,
        phases = emptyList(),
      )
    val snapshot = ChatSwarmSnapshot(sessionKey = "agent:main:a", enabled = true, groups = listOf(group))

    assertTrue(snapshot.isAvailableFor("agent:main:a"))
    assertFalse(snapshot.isAvailableFor("agent:main:b"))
    assertFalse(snapshot.copy(enabled = false).isAvailableFor("agent:main:a"))
    assertFalse(snapshot.copy(sessionKey = null).isAvailableFor("agent:main:a"))
  }

  private fun session(
    key: String,
    status: String?,
    groupId: String,
    subagentRunState: String? = null,
    hasActiveRun: Boolean? = null,
  ): ChatSessionEntry =
    ChatSessionEntry(
      key = key,
      updatedAtMs = 1,
      displayName = key,
      parentSessionKey = "agent:main:parent",
      subagentRunState = subagentRunState,
      swarmGroupId = groupId,
      status = status,
      hasActiveRun = hasActiveRun,
    )
}
