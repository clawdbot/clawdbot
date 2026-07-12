package ai.openclaw.app.ui.chat

import ai.openclaw.app.ChatDraft
import ai.openclaw.app.ChatDraftPlacement
import ai.openclaw.app.ChatShareDraft
import ai.openclaw.app.chat.VoiceNoteRecorderState
import android.net.Uri
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.runBlocking
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34])
class ChatComposerDraftTest {
  @Test
  fun replyDraftPreservesExistingComposerText() {
    val draft = ChatDraft(text = "> quoted\n\n", placement = ChatDraftPlacement.BeforeExisting)

    assertEquals("> quoted\n\nmy reply", mergeChatDraft(draft, "my reply"))
  }

  @Test
  fun replacementDraftReplacesExistingComposerText() {
    val draft = ChatDraft(text = "repeat this", placement = ChatDraftPlacement.Replace)

    assertEquals("repeat this", mergeChatDraft(draft, "existing text"))
  }

  @Test
  fun sharedTextPreservesExistingComposerText() {
    assertEquals(
      "existing draft\n\nshared link",
      mergeSharedChatText(sharedText = "shared link", currentInput = "existing draft"),
    )
  }

  @Test
  fun queuedSharedTextPreservesArrivalOrder() {
    val first = mergeSharedChatText(sharedText = "first", currentInput = "")

    assertEquals("first\n\nsecond", mergeSharedChatText(sharedText = "second", currentInput = first))
  }

  @Test
  fun imageOnlyShareLeavesExistingComposerTextUntouched() {
    assertEquals(
      "existing draft",
      mergeSharedChatText(sharedText = null, currentInput = "existing draft"),
    )
  }

  @Test
  fun stagedSharePreservesComposerAndReportsDroppedImages() {
    val existing = pendingAttachment("existing")
    val shared = pendingAttachment("shared")
    val staged =
      StagedChatShare(
        text = "shared link",
        attachments = listOf(shared),
        failedImageCount = 0,
        droppedImageCount = 2,
      )

    val merged =
      mergeStagedChatShare(
        staged = staged,
        currentInput = "existing draft",
        currentAttachments = listOf(existing),
      )

    assertEquals("existing draft\n\nshared link", merged.input)
    assertEquals(listOf(existing, shared), merged.attachments)
    assertEquals(0, merged.failedImageCount)
    assertEquals(2, merged.droppedImageCount)
  }

  @Test
  fun unreadableSharedImageDoesNotDiscardOtherStagedContent() =
    runBlocking {
      val readable = Uri.parse("content://photos/readable")
      val unreadable = Uri.parse("content://photos/unreadable")
      val draft =
        ChatShareDraft(
          id = 1,
          text = "caption",
          imageUris = listOf(readable, unreadable),
          droppedImageCount = 0,
        )

      val staged =
        stageChatShareDraft(draft, currentAttachments = emptyList()) { uri ->
          if (uri == unreadable) error("provider read failed")
          pendingAttachment(uri.toString())
        }

      assertEquals("caption", staged.text)
      assertEquals(listOf(readable.toString()), staged.attachments.map { it.id })
      assertEquals(1, staged.failedImageCount)
      assertEquals(0, staged.droppedImageCount)
    }

  @Test
  fun screenDisposalCancellationLeavesShareUnstaged() {
    val draft =
      ChatShareDraft(
        id = 1,
        text = null,
        imageUris = listOf(Uri.parse("content://photos/slow")),
        droppedImageCount = 0,
      )

    assertThrows(CancellationException::class.java) {
      runBlocking {
        stageChatShareDraft(draft, currentAttachments = emptyList()) { throw CancellationException("screen disposed") }
      }
    }
  }

  @Test
  fun repeatedSharesRespectExistingComposerAttachmentLimit() =
    runBlocking {
      val current = (1..7).map { pendingAttachment("existing-$it") }
      val uris = (1..3).map { Uri.parse("content://photos/shared/$it") }
      val draft = ChatShareDraft(id = 1, text = null, imageUris = uris, droppedImageCount = 0)

      val staged =
        stageChatShareDraft(draft, currentAttachments = current) { uri ->
          pendingAttachment(uri.toString())
        }

      assertEquals(listOf(uris.first().toString()), staged.attachments.map { it.id })
      assertEquals(2, staged.droppedImageCount)
      val merged = mergeStagedChatShare(staged, currentInput = "", currentAttachments = current)
      assertEquals(CHAT_COMPOSER_MAX_ATTACHMENTS, merged.attachments.size)
      assertEquals(2, merged.droppedImageCount)
    }

  @Test
  fun mergeRechecksAttachmentBudgetAfterStaging() {
    val staged =
      StagedChatShare(
        text = null,
        attachments = listOf(pendingAttachment("one"), pendingAttachment("two")),
        failedImageCount = 0,
        droppedImageCount = 0,
      )
    val current = (1..7).map { pendingAttachment("existing-$it") }

    val merged = mergeStagedChatShare(staged, currentInput = "", currentAttachments = current)

    assertEquals(CHAT_COMPOSER_MAX_ATTACHMENTS, merged.attachments.size)
    assertEquals(1, merged.droppedImageCount)
  }

  @Test
  fun attachmentAdmissionEnforcesBase64AndDecodedBudgets() {
    val candidates = listOf(pendingAttachment("one", base64 = "AAAA"), pendingAttachment("two", base64 = "AAAA"))

    val base64Bound =
      admitChatAttachments(
        currentAttachments = emptyList(),
        candidates = candidates,
        maxAttachmentCount = 8,
        maxBase64Chars = 4,
        maxDecodedBytes = 100,
      )
    val decodedBound =
      admitChatAttachments(
        currentAttachments = emptyList(),
        candidates = candidates,
        maxAttachmentCount = 8,
        maxBase64Chars = 100,
        maxDecodedBytes = 3,
      )

    assertEquals(listOf(candidates.first()), base64Bound.accepted)
    assertEquals(1, base64Bound.omittedCount)
    assertEquals(listOf(candidates.first()), decodedBound.accepted)
    assertEquals(1, decodedBound.omittedCount)
  }

  @Test
  fun stagedShareCommitsOnlyForMatchingQueueHead() {
    val current = ChatShareDraft(id = 7, text = "current", imageUris = emptyList(), droppedImageCount = 0)
    val replacement = ChatShareDraft(id = 8, text = "replacement", imageUris = emptyList(), droppedImageCount = 0)

    assertTrue(canCommitStagedChatShare(stagedId = current.id, currentHead = current))
    assertFalse(canCommitStagedChatShare(stagedId = current.id, currentHead = replacement))
    assertFalse(canCommitStagedChatShare(stagedId = current.id, currentHead = null))
  }

  @Test
  fun sendIsDisabledWhileShareHeadStages() {
    assertFalse(
      chatComposerSendEnabled(
        voiceNoteState = VoiceNoteRecorderState.Idle,
        pendingRunCount = 0,
        hasContent = true,
        shareStaging = true,
      ),
    )
    assertTrue(
      chatComposerSendEnabled(
        voiceNoteState = VoiceNoteRecorderState.Idle,
        pendingRunCount = 0,
        hasContent = true,
        shareStaging = false,
      ),
    )
  }

  private fun pendingAttachment(
    id: String,
    base64: String = id,
  ): PendingAttachment =
    PendingAttachment(
      id = id,
      fileName = "$id.jpg",
      mimeType = "image/jpeg",
      base64 = base64,
    )
}
