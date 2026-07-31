package ai.openclaw.app.ui.design

import ai.openclaw.app.GatewayAgentSummary
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class AgentAvatarTest {
  @Test
  fun prefersResolvedAvatarUrl() {
    val agent = agent(avatar = dataUrl("image/png", "raw"), avatarUrl = dataUrl("image/jpeg", "resolved"))

    assertEquals(
      AgentAvatarSource.Data(mimeType = "image/jpeg", base64 = "resolved"),
      agentAvatarSource(agent),
    )
  }

  @Test
  fun fallsBackToRawAvatarOnlyWhenResolvedAvatarIsMissing() {
    val raw = AgentAvatarSource.Data(mimeType = "image/png", base64 = "raw")

    assertEquals(raw, agentAvatarSource(agent(avatar = dataUrl("image/png", "raw"))))
    assertEquals(raw, agentAvatarSource(agent(avatar = dataUrl("image/png", "raw"), avatarUrl = "  ")))
    assertNull(agentAvatarSource(agent(avatar = dataUrl("image/png", "raw"), avatarUrl = "not an image")))
  }

  @Test
  fun preservesRasterAndSvgMimeTypes() {
    assertEquals(
      AgentAvatarSource.Data(mimeType = "image/png", base64 = "body"),
      agentAvatarSource(agent(avatarUrl = "DATA:IMAGE/PNG;BASE64, body ")),
    )
    assertEquals(
      AgentAvatarSource.Data(mimeType = "image/svg+xml", base64 = "PHN2Zy8+"),
      agentAvatarSource(agent(avatarUrl = dataUrl("image/svg+xml", "PHN2Zy8+"))),
    )
  }

  @Test
  fun recognizesRemoteHttpSources() {
    assertEquals(
      AgentAvatarSource.Remote("https://example.com/avatar.png"),
      agentAvatarSource(agent(avatarUrl = "https://example.com/avatar.png")),
    )
    assertEquals(
      AgentAvatarSource.Remote("HTTP://example.com/avatar.svg"),
      agentAvatarSource(agent(avatarUrl = "HTTP://example.com/avatar.svg")),
    )
  }

  @Test
  fun rejectsMalformedOrUnsupportedAvatarValues() {
    assertNull(agentAvatarSource(agent(avatarUrl = "data:image/png,raw")))
    assertNull(agentAvatarSource(agent(avatarUrl = "data:text/plain;base64,dGV4dA==")))
    assertNull(agentAvatarSource(agent(avatarUrl = "data:image/png;base64,")))
    assertNull(agentAvatarSource(agent(avatar = "avatars/openclaw.png")))
    assertNull(agentAvatarSource(agent(avatar = "🦞")))
  }

  @Test
  fun rejectsMissingAvatarValues() {
    assertNull(agentAvatarSource(agent()))
    assertNull(agentAvatarSource(agent(avatar = " ", avatarUrl = "\n")))
  }

  private fun agent(
    avatar: String? = null,
    avatarUrl: String? = null,
  ) = GatewayAgentSummary(
    id = "main",
    name = "Main",
    emoji = null,
    avatar = avatar,
    avatarUrl = avatarUrl,
  )

  private fun dataUrl(
    mimeType: String,
    body: String,
  ): String = "data:$mimeType;base64,$body"
}
