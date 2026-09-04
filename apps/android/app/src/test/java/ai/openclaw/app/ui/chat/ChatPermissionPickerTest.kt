package ai.openclaw.app.ui.chat

import ai.openclaw.app.chat.ChatPermissionMode
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class ChatPermissionPickerTest {
  @Test
  fun optionsRetainIncreasingAccessOrder() {
    val options = chatPermissionOptions()

    assertEquals(
      listOf(null, ChatPermissionMode.ReadOnly, ChatPermissionMode.Guarded, ChatPermissionMode.Workspace, ChatPermissionMode.Full),
      options.map { it.mode },
    )
  }

  @Test
  fun fullAccessRequiresAdminWhileOtherModesRemainSelectable() {
    assertFalse(canSelectChatPermissionMode(ChatPermissionMode.Full, canSelectFull = false))
    assertTrue(canSelectChatPermissionMode(ChatPermissionMode.Full, canSelectFull = true))
    assertTrue(canSelectChatPermissionMode(ChatPermissionMode.Workspace, canSelectFull = false))
    assertTrue(canSelectChatPermissionMode(null, canSelectFull = false))
  }

  @Test
  fun modeLabelsDistinguishPolicyDefault() {
    assertEquals("Policy default", chatPermissionModeLabel(null))
    assertEquals("Full access", chatPermissionModeLabel(ChatPermissionMode.Full))
  }
}
