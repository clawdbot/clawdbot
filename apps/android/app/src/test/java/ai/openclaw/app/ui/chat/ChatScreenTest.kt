package ai.openclaw.app.ui.chat

import ai.openclaw.app.GatewayAgentSummary
import ai.openclaw.app.PendingAssistantAutoSend
import ai.openclaw.app.chat.ChatComposerOwner
import ai.openclaw.app.chat.ChatMessageContent
import ai.openclaw.app.chat.ChatSessionEntry
import ai.openclaw.app.chat.SessionBranch
import ai.openclaw.app.ui.agentPickerLabel
import androidx.compose.ui.unit.dp
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class ChatScreenTest {
  @Test
  fun jumpToLatestReservesItsTouchTargetBelowMessages() {
    assertEquals(0.dp, chatReaderListBottomInset(showJumpToLatest = false))
    assertEquals(56.dp, chatReaderListBottomInset(showJumpToLatest = true))
  }

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
  fun composerPrimaryActionKeepsRunStopSeparateFromLiveTalk() {
    assertEquals(
      ChatComposerPrimaryAction.Stop,
      resolveChatComposerPrimaryAction(talkActive = true, runActive = true, sendEnabled = true),
    )
    assertEquals(
      ChatComposerPrimaryAction.None,
      resolveChatComposerPrimaryAction(talkActive = true, runActive = false, sendEnabled = true),
    )
    assertEquals(
      ChatComposerPrimaryAction.Stop,
      resolveChatComposerPrimaryAction(talkActive = false, runActive = true, sendEnabled = true),
    )
    assertEquals(
      ChatComposerPrimaryAction.Send,
      resolveChatComposerPrimaryAction(talkActive = false, runActive = false, sendEnabled = true),
    )
    assertEquals(
      ChatComposerPrimaryAction.StartTalk,
      resolveChatComposerPrimaryAction(talkActive = false, runActive = false, sendEnabled = false),
    )
  }

  @Test
  fun sessionPickerUsesTheSharedDashboardTitlePrecedence() {
    val dashboardKey = "agent:main:dashboard:fresh"

    assertEquals(
      "New chat",
      chatSessionChipText(
        entry = ChatSessionEntry(key = dashboardKey, updatedAtMs = 1),
        mainSessionKey = "agent:main:node-phone",
      ),
    )
    assertEquals(
      "Manual bee research",
      chatSessionChipText(
        entry =
          ChatSessionEntry(
            key = dashboardKey,
            updatedAtMs = 1,
            label = "Manual bee research",
            displayName = "Honeybee flower-location communication",
          ),
        mainSessionKey = "agent:main:node-phone",
      ),
    )
  }

  @Test
  fun sessionPickerKeepsTheActiveSessionAndSignalsAdditionalChoices() {
    val now = 1_700_000_000_000L
    val sessions =
      listOf(
        ChatSessionEntry(key = "main", updatedAtMs = now),
        ChatSessionEntry(key = "active", updatedAtMs = now - 1),
        ChatSessionEntry(key = "recent-1", updatedAtMs = now - 2),
        ChatSessionEntry(key = "recent-2", updatedAtMs = now - 3),
        ChatSessionEntry(key = "recent-3", updatedAtMs = now - 4),
        ChatSessionEntry(key = "recent-4", updatedAtMs = now - 5),
      )

    val state =
      chatSessionPickerState(
        sessionKey = "active",
        sessions = sessions,
        mainSessionKey = "main",
        nowMs = now,
      )

    assertEquals("active", state.selected?.key)
    assertEquals(listOf("main", "active", "recent-1", "recent-2", "recent-3"), state.choices.map { it.key })
    assertTrue(state.hasMore)
  }

  @Test
  fun agentSelectorUsesCanonicalMainSession() {
    assertEquals("scout", selectedChatAgentId("agent:scout:node-phone", "main"))
    assertEquals("main", selectedChatAgentId("main", "main"))
  }

  @Test
  fun agentSelectorDoesNotReplaceMissingActiveAgentWithRosterFallback() {
    val state =
      chatAgentPickerState(
        activeAgentId = "missing",
        agents =
          listOf(
            GatewayAgentSummary(id = "main", name = "main", emoji = null, kind = null),
            GatewayAgentSummary(id = "ops", name = "ops", emoji = null, kind = null),
          ),
      )

    assertNull(state.selected)
    assertEquals("missing", state.selectedAgentId)
    assertEquals("missing", agentPickerLabel(state))
    assertTrue(shouldShowChatAgentPicker(state))
    assertEquals(
      listOf("main", "ops"),
      state.agents.map(GatewayAgentSummary::id),
    )
  }

  @Test
  fun agentSelectorKeepsUnknownSelectionSwitchableWithOneAvailableAgent() {
    val state =
      chatAgentPickerState(
        activeAgentId = "missing",
        agents = listOf(GatewayAgentSummary(id = "main", name = "main", emoji = null, kind = null)),
      )

    assertTrue(shouldShowChatAgentPicker(state))
    assertEquals("missing", agentPickerLabel(state))
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
