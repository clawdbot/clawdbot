package ai.openclaw.app

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.jsonObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class GatewayAgentSummaryTest {
  @Test
  fun parsesAvatarAndResolvedAvatarUrlFromAgentsListRow() {
    val agent =
      parse(
        """{"id":"main","name":" Main ","identity":{"emoji":" 🦞 ","avatar":" raw ","avatarUrl":" resolved "},"workspaceGit":true}""",
      )

    assertEquals("main", agent?.id)
    assertEquals("Main", agent?.name)
    assertEquals("🦞", agent?.emoji)
    assertEquals("raw", agent?.avatar)
    assertEquals("resolved", agent?.avatarUrl)
    assertTrue(agent?.workspaceGit == true)
  }

  @Test
  fun parsesKindAndExcludesSystemRowsFromSelectableAgents() {
    val agents =
      parseGatewayAgentSummaries(
        Json
          .parseToJsonElement(
            """{"agents":[{"id":"main","kind":"agent"},{"id":"ordinary-looking-id","kind":"system"},{"id":"legacy"}]}""",
          ).jsonObject,
      )

    assertEquals("system", agents[1].kind)
    assertEquals(listOf("main", "legacy"), agents.selectableAgents().map(GatewayAgentSummary::id))
  }

  @Test
  fun normalizesMissingAndBlankIdentityValues() {
    val missing = parse("""{"id":"main"}""")
    val blank =
      parse(
        """{"id":"blank","identity":{"emoji":" ","avatar":"\n","avatarUrl":"\t"},"workspaceGit":false}""",
      )

    assertNull(missing?.name)
    assertNull(missing?.avatar)
    assertNull(missing?.avatarUrl)
    assertFalse(missing?.workspaceGit == true)
    assertNull(blank?.emoji)
    assertNull(blank?.avatar)
    assertNull(blank?.avatarUrl)
  }

  @Test
  fun ignoresMalformedIdentityShapesAndRowsWithoutIds() {
    val malformedIdentity = parse("""{"id":"main","identity":["not-an-object"]}""")
    val malformedAvatarFields =
      parse(
        """{"id":"main","identity":{"avatar":{"data":"x"},"avatarUrl":["x"]}}""",
      )

    assertNull(malformedIdentity?.avatar)
    assertNull(malformedIdentity?.avatarUrl)
    assertNull(malformedAvatarFields?.avatar)
    assertNull(malformedAvatarFields?.avatarUrl)
    assertNull(parse("""{"name":"missing id"}"""))
    assertNull(parse("""{"id":" "}"""))
    assertNull(parse("[]"))
  }

  private fun parse(value: String): GatewayAgentSummary? =
    parseGatewayAgentSummaries(
      Json.parseToJsonElement("""{"agents":[$value]}""").jsonObject,
    ).singleOrNull()
}
