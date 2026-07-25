package ai.openclaw.app.chat

import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import org.junit.Assert.assertEquals
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
  fun projectionMapsStatesAndHidesTerminalGroups() {
    val active = "swarm:agent:main:parent:active"
    val finished = "swarm:agent:main:parent:finished"
    val groups =
      buildChatSwarmGroups(
        sessions =
          listOf(
            session("queued", null, active, subagentRunState = "active"),
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
      listOf(ChatSwarmDotStatus.Running, ChatSwarmDotStatus.Queued, ChatSwarmDotStatus.Failed, ChatSwarmDotStatus.Done),
      groups
        .single()
        .phases
        .single()
        .dots
        .map(ChatSwarmDot::status),
    )
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

  private fun session(
    key: String,
    status: String?,
    groupId: String,
    subagentRunState: String? = null,
  ): ChatSessionEntry =
    ChatSessionEntry(
      key = key,
      updatedAtMs = 1,
      displayName = key,
      parentSessionKey = "agent:main:parent",
      subagentRunState = subagentRunState,
      swarmGroupId = groupId,
      status = status,
    )
}
