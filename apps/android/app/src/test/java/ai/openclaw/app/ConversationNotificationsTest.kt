package ai.openclaw.app

import android.app.Notification
import android.app.PendingIntent
import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import androidx.test.core.app.ApplicationProvider
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.Robolectric
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import org.robolectric.Shadows.shadowOf
import org.robolectric.annotation.Config
import org.robolectric.annotation.GraphicsMode
import java.util.UUID

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34])
@GraphicsMode(GraphicsMode.Mode.LEGACY)
class ConversationNotificationsTest {
  private val context = ApplicationProvider.getApplicationContext<Context>()
  private val target =
    ConversationNotificationTarget(
      gatewayStableId = "gateway-a",
      agentId = "main",
      sessionKey = "agent:main:main",
      runId = "run-42",
    )

  @Test
  fun replyReceiverIsNotExported() {
    val packageManager = context.packageManager
    val receiverInfo =
      packageManager.getReceiverInfo(
        ComponentName(context, ConversationReplyReceiver::class.java),
        PackageManager.ComponentInfoFlags.of(0),
      )

    assertFalse(receiverInfo.exported)
  }

  @Test
  fun launchIntentTargetsPrivateTrampolineInsteadOfExportedMainActivity() {
    val intent = conversationNotificationLaunchIntent(context, target)
    val component = requireNotNull(intent.component)

    assertEquals(ConversationNotificationLaunchActivity::class.java.name, component.className)
    assertNotEquals(MainActivity::class.java.name, component.className)
  }

  @Test
  fun launchIntentIdentityDiffersAcrossConversationTargets() {
    val first = conversationNotificationLaunchIntent(context, target)
    val second =
      conversationNotificationLaunchIntent(
        context,
        target.copy(sessionKey = "agent:main:other", runId = "run-43"),
      )

    assertEquals(64, first.data?.lastPathSegment?.length)
    assertFalse(first.filterEquals(second))
  }

  @Test
  fun replyIntentIdentityDiffersAcrossConversationTargets() {
    val first = conversationNotificationReplyIntent(context, target)
    val second =
      conversationNotificationReplyIntent(
        context,
        target.copy(sessionKey = "agent:main:other", runId = "run-43"),
      )

    assertEquals(64, first.data?.lastPathSegment?.length)
    assertFalse(first.filterEquals(second))
  }

  @Test
  fun sameRequestCodeStillProducesDistinctPendingIntentsAcrossTargets() {
    val first =
      PendingIntent.getActivity(
        context,
        0,
        conversationNotificationLaunchIntent(context, target),
        PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
      )
    val second =
      PendingIntent.getActivity(
        context,
        0,
        conversationNotificationLaunchIntent(
          context,
          target.copy(sessionKey = "agent:main:other", runId = "run-43"),
        ),
        PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
      )

    assertNotEquals(first, second)
    first.cancel()
    second.cancel()
  }

  @Test
  fun sameRequestCodeStillProducesDistinctReplyPendingIntentsAcrossTargets() {
    val first =
      PendingIntent.getBroadcast(
        context,
        1,
        conversationNotificationReplyIntent(context, target),
        PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_MUTABLE,
      )
    val second =
      PendingIntent.getBroadcast(
        context,
        1,
        conversationNotificationReplyIntent(
          context,
          target.copy(sessionKey = "agent:main:other", runId = "run-43"),
        ),
        PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_MUTABLE,
      )

    assertNotEquals(first, second)
    first.cancel()
    second.cancel()
  }

  @Test
  fun privateTrampolineRejectsAlteredTargetIdentity() {
    val intent = conversationNotificationLaunchIntent(context, target)
    val forged = Intent(intent).putExtra("ai.openclaw.app.extra.CONVERSATION_RUN_ID", "forged-run")

    assertEquals(target, parseConversationNotificationTrampolineIntent(intent))
    assertNull(parseConversationNotificationTrampolineIntent(forged))
    assertEquals(
      null,
      parseConversationNotificationTrampolineIntent(Intent(intent).setAction(Intent.ACTION_VIEW)),
    )
  }

  @Test
  fun exportedMainActivityRejectsRawConversationTargetExtras() {
    val store = ConversationNotificationLaunchStore()
    val forged =
      Intent(conversationNotificationLaunchIntent(context, target))
        .setClass(context, MainActivity::class.java)

    assertNull(parseConversationNotificationLaunchIntent(forged, store::take))
  }

  @Test
  fun privateTrampolineForwardsOnlyAnOpaqueOneShotHandoff() {
    val app = RuntimeEnvironment.getApplication() as NodeApp
    val controller =
      Robolectric
        .buildActivity(
          ConversationNotificationLaunchActivity::class.java,
          conversationNotificationLaunchIntent(context, target),
        ).create()
    val activity = controller.get()
    val forwarded = requireNotNull(shadowOf(activity).nextStartedActivity)

    assertEquals(MainActivity::class.java.name, forwarded.component?.className)
    assertEquals(target, parseConversationNotificationLaunchIntent(forwarded, app.conversationNotificationLaunchStore::take))
    assertNull(parseConversationNotificationLaunchIntent(forwarded, app.conversationNotificationLaunchStore::take))
    assertTrue(activity.isFinishing)
    controller.destroy()
  }

  @Test
  fun trustedMainActivityHandoffIsExactAndOneShot() {
    val store = ConversationNotificationLaunchStore()
    val launchToken = store.put(target)
    val intent = conversationNotificationMainIntent(context, launchToken)

    assertEquals(target, parseConversationNotificationLaunchIntent(intent, store::take))
    assertNull(parseConversationNotificationLaunchIntent(intent, store::take))
    assertNull(
      parseConversationNotificationLaunchIntent(
        conversationNotificationMainIntent(context, UUID.randomUUID().toString()),
        store::take,
      ),
    )
  }

  @Test
  fun assistantReplyBuildsPrivateConversationNotificationWithRemoteInput() {
    val notification =
      ConversationReplyNotifier(context).buildAssistantReplyNotification(target, "The task is complete.")
    val action = notification.actions.single()

    assertEquals(Notification.CATEGORY_MESSAGE, notification.category)
    assertEquals(Notification.VISIBILITY_PRIVATE, notification.visibility)
    assertEquals(target.shortcutId, notification.shortcutId)
    assertNotNull(notification.publicVersion)
    assertEquals(Notification.VISIBILITY_PUBLIC, notification.publicVersion.visibility)
    assertEquals(1, notification.actions.size)
    assertEquals("Reply", action.title.toString())
    assertEquals(1, action.remoteInputs.size)
  }

  @Test
  fun sendFailureNotificationKeepsRemoteInputForRetry() {
    val notification =
      ConversationReplyNotifier(context).buildSendFailureNotification(target)
    val action = notification.actions.single()

    assertEquals(Notification.CATEGORY_MESSAGE, notification.category)
    assertEquals(Notification.VISIBILITY_PRIVATE, notification.visibility)
    assertEquals(1, notification.actions.size)
    assertEquals("Reply", action.title.toString())
    assertEquals(1, action.remoteInputs.size)
  }
}
