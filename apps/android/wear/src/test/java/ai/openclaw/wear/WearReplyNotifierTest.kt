package ai.openclaw.wear

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class WearReplyNotifierTest {
  @Test
  fun visibilityTracksOverlappingActivityLifecycles() {
    val tracker = VisibleActivityTracker()

    tracker.onStarted()
    tracker.onStarted()
    tracker.onStopped()
    assertTrue(tracker.isVisible())
    tracker.onStopped()
    assertTrue(!tracker.isVisible())
  }

  @Test
  fun pendingIntentIdentityDoesNotUseCollidingStringHashCodes() {
    check("Aa".hashCode() == "BB".hashCode())

    val first = replyPendingIntentAction("Aa", "notification-1")
    val second = replyPendingIntentAction("BB", "notification-1")

    assertNotEquals(first, second)
    assertTrue(first.startsWith("ai.openclaw.wear.REPLY."))
  }

  @Test
  fun distinctFinalMessagesUseDistinctNotificationAndReplyIdentities() {
    val firstMessage = WearChatMessage(id = "m1", role = "assistant", text = "first", timestamp = 1)
    val secondMessage = WearChatMessage(id = "m2", role = "assistant", text = "second", timestamp = 2)

    val firstTag = replyNotificationTag("session", firstMessage, "run-1")
    val secondTag = replyNotificationTag("session", secondMessage, "run-2")

    assertNotEquals(firstTag, secondTag)
    assertNotEquals(
      replyPendingIntentAction("session", firstTag),
      replyPendingIntentAction("session", secondTag),
    )
  }

  @Test
  fun missingMessageIdentityUsesStableEventFallback() {
    val message = WearChatMessage(id = null, role = "assistant", text = "same", timestamp = null)

    val first = replyNotificationTag("session", message, "run-1")
    val retry = replyNotificationTag("session", message, "run-1")
    val distinct = replyNotificationTag("session", message, "run-2")

    assertEquals(first, retry)
    assertNotEquals(first, distinct)
  }

  @Test
  fun fallbackIdentitySeparatesPhoneProcessEpochs() {
    val message = WearChatMessage(id = null, role = "assistant", text = "same", timestamp = null)

    val first = replyNotificationTag("session", message, "source:phone\u0000stream:epoch-1\u0000sequence:1")
    val restarted = replyNotificationTag("session", message, "source:phone\u0000stream:epoch-2\u0000sequence:1")

    assertNotEquals(first, restarted)
  }

  @Test
  fun notificationRetryIdentityIsStableForTheSameLogicalReply() {
    val first = notificationReplyIdempotencyKey("session", "notification", "reply")
    val retry = notificationReplyIdempotencyKey("session", "notification", "reply")
    val edited = notificationReplyIdempotencyKey("session", "notification", "edited")

    assertEquals(first, retry)
    assertNotEquals(first, edited)
  }

  @Test
  fun preferredPhoneChangeRequiresAppRecoveryInsteadOfAStaleRetry() {
    assertEquals(
      NotificationReplyFailureAction.OpenApp,
      notificationReplyFailureAction(WearProxyException("phone_changed", "preferred phone changed")),
    )
    assertEquals(
      NotificationReplyFailureAction.RetrySamePhone,
      notificationReplyFailureAction(WearProxyException("phone_unavailable", "offline")),
    )
  }
}
