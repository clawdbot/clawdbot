package ai.openclaw.app

import android.content.ClipData
import android.content.Intent
import android.net.Uri
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.async
import kotlinx.coroutines.runBlocking
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34])
class ShareLaunchTest {
  @Test
  fun composesDistinctSubjectAndTextForReview() {
    val parsed =
      parseShareLaunchIntent(
        Intent(Intent.ACTION_SEND)
          .setType("text/plain")
          .putExtra(Intent.EXTRA_SUBJECT, "Article title")
          .putExtra(Intent.EXTRA_TEXT, "https://example.com/article"),
      )

    requireNotNull(parsed)
    assertEquals("Article title\n\nhttps://example.com/article", parsed.text)
    assertEquals(emptyList<Uri>(), parsed.imageUris)
  }

  @Test
  fun keepsCaptionAndProviderBackedImage() {
    val image = Uri.parse("content://photos/shared/1")
    val parsed =
      parseShareLaunchIntent(
        Intent(Intent.ACTION_SEND)
          .setType("image/png")
          .putExtra(Intent.EXTRA_TEXT, "What is in this image?")
          .putExtra(Intent.EXTRA_STREAM, image),
      )

    requireNotNull(parsed)
    assertEquals("What is in this image?", parsed.text)
    assertEquals(listOf(image), parsed.imageUris)
  }

  @Test
  fun readsProviderBackedImageFromClipData() {
    val image = Uri.parse("content://photos/shared/clip")
    val parsed =
      parseShareLaunchIntent(
        Intent(Intent.ACTION_SEND)
          .setType("IMAGE/PNG")
          .apply {
            clipData = ClipData("shared", arrayOf("image/png"), ClipData.Item(image))
          },
      )

    requireNotNull(parsed)
    assertEquals(listOf(image), parsed.imageUris)
  }

  @Test
  fun deduplicatesAndBoundsMultipleImagesAcrossExtrasAndClipData() {
    val images = (1..10).map { index -> Uri.parse("content://photos/shared/$index") }
    val parsed =
      parseShareLaunchIntent(
        Intent(Intent.ACTION_SEND_MULTIPLE)
          .setType("image/jpeg")
          .putParcelableArrayListExtra(Intent.EXTRA_STREAM, ArrayList(images))
          .apply {
            clipData = ClipData("shared", arrayOf("image/jpeg"), ClipData.Item(images.first()))
          },
      )

    requireNotNull(parsed)
    assertEquals(images.take(8), parsed.imageUris)
    assertEquals(2, parsed.droppedImageCount)
  }

  @Test
  fun rejectsFileUrisAndEmptyOrUnrelatedIntents() {
    assertNull(
      parseShareLaunchIntent(
        Intent(Intent.ACTION_SEND)
          .setType("image/jpeg")
          .putExtra(Intent.EXTRA_STREAM, Uri.parse("file:///data/data/ai.openclaw.app/private.jpg")),
      ),
    )
    assertNull(parseShareLaunchIntent(Intent(Intent.ACTION_SEND).setType("text/plain")))
    assertNull(parseShareLaunchIntent(Intent(Intent.ACTION_VIEW)))
  }

  @Test
  fun rapidSharesKeepStableHeadUntilMatchingAcknowledgement() {
    val queue = ChatShareDraftQueue(capacity = 2)
    val owner = composerOwner("main", "agent:main:device")
    val first = ChatShareDraft(id = 1, text = "first", imageUris = emptyList(), droppedImageCount = 0)
    val second = ChatShareDraft(id = 2, text = "second", imageUris = emptyList(), droppedImageCount = 0)

    assertTrue(queue.enqueue(first, owner))
    assertTrue(queue.enqueue(second, owner))
    assertEquals(first, queue.head.value)
    assertFalse(queue.acknowledgeHead(second.id, owner))
    assertEquals(first, queue.head.value)

    runBlocking { assertTrue(queue.withHeadLease(first.id, owner) {}) }
    assertTrue(queue.acknowledgeHead(first.id, owner))
    assertEquals(second, queue.head.value)
    runBlocking { assertTrue(queue.withHeadLease(second.id, owner) {}) }
    assertTrue(queue.acknowledgeHead(second.id, owner))
    assertNull(queue.head.value)
  }

  @Test
  fun pendingShareQueueIsBoundedWithoutReplacingItsHead() {
    val queue = ChatShareDraftQueue(capacity = 1)
    val owner = composerOwner("main", "agent:main:device")
    val first = ChatShareDraft(id = 1, text = "first", imageUris = emptyList(), droppedImageCount = 0)
    val overflow = ChatShareDraft(id = 2, text = "overflow", imageUris = emptyList(), droppedImageCount = 0)

    assertTrue(queue.enqueue(first, owner))
    assertFalse(queue.enqueue(overflow, owner))
    assertEquals(1, queue.size())
    assertEquals(first, queue.head.value)
  }

  @Test
  fun anotherOwnersShareCanAdvanceWithoutRetargetingTheGlobalHead() =
    runBlocking {
      val queue = ChatShareDraftQueue(capacity = 2)
      val ownerA = composerOwner("agent-a", "session-a")
      val ownerB = composerOwner("agent-b", "session-b")
      val first = ChatShareDraft(id = 1, text = "first", imageUris = emptyList(), droppedImageCount = 0)
      val second = ChatShareDraft(id = 2, text = "second", imageUris = emptyList(), droppedImageCount = 0)
      queue.enqueue(first, ownerA)
      queue.enqueue(second, ownerB)

      assertEquals(first, queue.head.value)
      assertTrue(queue.withHeadLease(second.id, ownerB) {})
      assertTrue(queue.acknowledgeHead(second.id, ownerB))
      assertEquals(first, queue.head.value)
      assertTrue(queue.withHeadLease(first.id, ownerA) {})
    }

  @Test
  fun overlappingActivityLoadersCannotCommitTheSameHead() =
    runBlocking {
      val queue = ChatShareDraftQueue(capacity = 2)
      val first = ChatShareDraft(id = 1, text = "first", imageUris = emptyList(), droppedImageCount = 0)
      val next = ChatShareDraft(id = 2, text = "second", imageUris = emptyList(), droppedImageCount = 0)
      val owner = composerOwner("main", "agent:main:device")
      queue.enqueue(first, owner)
      queue.enqueue(next, owner)
      val entered = CompletableDeferred<Unit>()
      val release = CompletableDeferred<Unit>()

      val firstLoader =
        async {
          queue.withHeadLease(first.id, owner) {
            entered.complete(Unit)
            release.await()
            assertTrue(queue.acknowledgeHead(first.id, owner))
          }
        }
      entered.await()
      var staleLoaderRan = false
      val staleLoader =
        async {
          queue.withHeadLease(first.id, owner) {
            staleLoaderRan = true
          }
        }
      release.complete(Unit)

      assertTrue(firstLoader.await())
      assertFalse(staleLoader.await())
      assertFalse(staleLoaderRan)
      assertEquals(next, queue.head.value)
    }

  @Test
  fun claimedShareCannotRetargetAcrossComposerNavigation() =
    runBlocking {
      val queue = ChatShareDraftQueue(capacity = 1)
      val share = ChatShareDraft(id = 1, text = "private", imageUris = emptyList(), droppedImageCount = 0)
      val ownerA = composerOwner("agent-a", "session-a")
      val ownerB = composerOwner("agent-b", "session-b")
      val resolvedA = ownerA.copy(sessionKey = "agent:agent-a:device")
      queue.enqueue(share, ownerA)

      assertTrue(queue.withHeadLease(share.id, ownerA) {})
      assertFalse(queue.withHeadLease(share.id, ownerB) {})
      assertFalse(queue.acknowledgeHead(share.id, ownerB))

      queue.migrateOwner(ownerA, resolvedA)
      assertTrue(queue.withHeadLease(share.id, resolvedA) {})
      assertTrue(queue.acknowledgeHead(share.id, resolvedA))
    }

  @Test
  fun shareOwnerIsCapturedBeforeAnyLoaderRuns() =
    runBlocking {
      val queue = ChatShareDraftQueue(capacity = 1)
      val share = ChatShareDraft(id = 1, text = "private", imageUris = emptyList(), droppedImageCount = 0)
      val ownerA = composerOwner("agent-a", "session-a")
      val ownerB = composerOwner("agent-b", "session-b")

      assertTrue(queue.enqueue(share, ownerA))
      assertEquals(ownerA, queue.ownerOf(share.id))
      assertFalse(queue.withHeadLease(share.id, ownerB) {})
      assertTrue(queue.withHeadLease(share.id, ownerA) {})
    }

  @Test
  fun removingGatewaySharesKeepsOtherGatewayOwners() =
    runBlocking {
      val queue = ChatShareDraftQueue(capacity = 2)
      val ownerA = composerOwner("agent-a", "session-a", gatewayStableId = "gateway-a")
      val ownerB = composerOwner("agent-b", "session-b", gatewayStableId = "gateway-b")
      val first = ChatShareDraft(id = 1, text = "private a", imageUris = emptyList(), droppedImageCount = 0)
      val second = ChatShareDraft(id = 2, text = "private b", imageUris = emptyList(), droppedImageCount = 0)
      queue.enqueue(first, ownerA)
      queue.enqueue(second, ownerB)

      queue.removeOwners { it.gatewayStableId == "gateway-a" }

      assertEquals(listOf(second), queue.queued.value)
      assertNull(queue.ownerOf(first.id))
      assertEquals(ownerB, queue.ownerOf(second.id))
    }

  private fun composerOwner(
    agentId: String,
    sessionKey: String,
    gatewayStableId: String = "gateway",
  ): ai.openclaw.app.chat.ChatComposerOwner =
    ai.openclaw.app.chat.ChatComposerOwner(
      gatewayStableId = gatewayStableId,
      agentId = agentId,
      sessionKey = sessionKey,
    )
}
