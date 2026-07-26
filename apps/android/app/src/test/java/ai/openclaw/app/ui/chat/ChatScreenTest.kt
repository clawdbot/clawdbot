package ai.openclaw.app.ui.chat

import ai.openclaw.app.GatewayAgentSummary
import ai.openclaw.app.PendingAssistantAutoSend
import ai.openclaw.app.chat.ChatComposerOwner
import ai.openclaw.app.chat.ChatMessageContent
import ai.openclaw.app.chat.SessionBranch
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class ChatScreenTest {
  @Test
  fun branchMessageCountUsesCountNeutralCopy() {
    assertEquals("Messages: 1", branchMessageCountText(1))
    assertEquals("Messages: 2", branchMessageCountText(2))
    assertEquals(
      "Messages: 2",
      branchMetadataText(SessionBranch("leaf", "", 2, updatedAt = null, active = false)),
    )
  }

  @Test
  fun longUserMessagesProduceABoundedPlainTextPreview() {
    assertNull(ChatUserMessageDisclosurePolicy.collapsedPreview("Short prompt"))
    assertNull(ChatUserMessageDisclosurePolicy.collapsedPreview(List(12) { "line" }.joinToString("\n")))
    assertNull(ChatUserMessageDisclosurePolicy.collapsedPreview("a".repeat(700)))
    assertEquals(
      List(12) { "line" }.joinToString("\n") + "…",
      ChatUserMessageDisclosurePolicy.collapsedPreview(List(13) { "line" }.joinToString("\n")),
    )
    assertEquals(
      "a".repeat(700) + "…",
      ChatUserMessageDisclosurePolicy.collapsedPreview("a".repeat(701)),
    )
  }

  @Test
  fun disclosureDoesNotReorderMixedUserContent() {
    val mixedContent =
      listOf(
        ChatMessageContent(type = "text", text = "a".repeat(701)),
        ChatMessageContent(type = "image", fileName = "photo.png", base64 = "AAAA"),
        ChatMessageContent(type = "text", text = "caption"),
      )

    assertFalse(shouldUseUserMessageDisclosure(isUser = true, content = mixedContent))
  }

  @Test
  fun realtimeTalkLaunchRequestsPermissionBeforeSetupOrStart() {
    assertEquals(
      ChatRealtimeTalkLaunch.RequestPermission,
      resolveChatRealtimeTalkLaunch(hasMicPermission = false, requiresSetup = true),
    )
    assertEquals(
      ChatRealtimeTalkLaunch.ShowSetupMessage,
      resolveChatRealtimeTalkLaunch(hasMicPermission = true, requiresSetup = true),
    )
    assertEquals(
      ChatRealtimeTalkLaunch.StartTalk,
      resolveChatRealtimeTalkLaunch(hasMicPermission = true, requiresSetup = false),
    )
  }

  @Test
  fun activeTalkAlwaysKeepsTheStopControlVisible() {
    assertEquals(
      ChatComposerTrailingAction.StopTalk,
      resolveChatComposerTrailingAction(talkActive = true, sendEnabled = true),
    )
    assertEquals(
      ChatComposerTrailingAction.Send,
      resolveChatComposerTrailingAction(talkActive = false, sendEnabled = true),
    )
    assertEquals(
      ChatComposerTrailingAction.StartTalk,
      resolveChatComposerTrailingAction(talkActive = false, sendEnabled = false),
    )
  }

  @Test
  fun agentChipUsesEmojiAndFallsBackToId() {
    assertEquals(
      "🦾 Scout",
      chatAgentChipText(GatewayAgentSummary(id = "scout", name = "Scout", emoji = " 🦾 ")),
    )
    assertEquals(
      "ops",
      chatAgentChipText(GatewayAgentSummary(id = "ops", name = " ", emoji = null)),
    )
  }

  @Test
  fun agentSelectorUsesCanonicalMainSession() {
    assertEquals("scout", selectedChatAgentId("agent:scout:node-phone", "main"))
    assertEquals("main", selectedChatAgentId("main", "main"))
  }

  @Test
  fun resolvesPendingAssistantAutoSendOnlyWhenChatIsReady() {
    val owner = ChatComposerOwner(gatewayStableId = "gateway", agentId = "main", sessionKey = "agent:main:device")
    val pending = PendingAssistantAutoSend(prompt = "  summarize mail  ", owner = owner)
    assertNull(
      resolvePendingAssistantAutoSend(
        pending = pending,
        currentOwner = owner,
        healthOk = false,
        pendingRunCount = 0,
      ),
    )
    assertNull(
      resolvePendingAssistantAutoSend(
        pending = pending,
        currentOwner = owner,
        healthOk = true,
        pendingRunCount = 1,
      ),
    )
    assertNull(
      resolvePendingAssistantAutoSend(
        pending = pending,
        currentOwner = owner.copy(sessionKey = "agent:main:other"),
        healthOk = true,
        pendingRunCount = 0,
      ),
    )
    assertEquals(
      pending,
      resolvePendingAssistantAutoSend(
        pending = pending,
        currentOwner = owner,
        healthOk = true,
        pendingRunCount = 0,
      ),
    )
  }

  @Test
  fun initialChatLoadUsesMainWhenNoSessionIsSelected() {
    assertEquals(
      "agent:ops:device",
      resolveInitialChatLoadSessionKey(
        sessionKey = "main",
        mainSessionKey = "agent:ops:device",
      ),
    )
  }

  @Test
  fun initialChatLoadPreservesSelectedSession() {
    assertNull(
      resolveInitialChatLoadSessionKey(
        sessionKey = "session:history",
        mainSessionKey = "agent:ops:device",
      ),
    )
  }

  @Test
  fun healthyEmptyChatShowsStarterStateInsteadOfLoadingPlaceholder() {
    assertFalse(
      showChatLoadingPlaceholder(
        historyLoading = true,
        healthOk = true,
        gatewayOffline = false,
      ),
    )
    assertTrue(
      showChatLoadingPlaceholder(
        historyLoading = true,
        healthOk = false,
        gatewayOffline = false,
      ),
    )
  }
}
