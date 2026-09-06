package ai.openclaw.app

import android.Manifest
import android.app.Notification
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Parcel
import androidx.test.core.app.ApplicationProvider
import org.junit.After
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
import org.robolectric.annotation.Implementation
import org.robolectric.annotation.Implements
import org.robolectric.annotation.RealObject
import org.robolectric.shadows.ShadowPendingIntent
import java.util.UUID

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34], shadows = [ConversationNotificationPendingIntentShadow::class])
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
  fun replyIntentTargetsPrivateReceiver() {
    val intent = conversationNotificationReplyIntent(context, target)
    val component = requireNotNull(intent.component)

    assertEquals(ConversationReplyReceiver::class.java.name, component.className)
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

  @After
  fun clearConversationNotification() {
    notificationManager()
      .activeNotifications
      .filter { it.tag == target.notificationTag }
      .forEach { notificationManager().cancel(it.tag, it.id) }
  }

  @Test
  fun assistantReplyBuildsPrivateConversationNotificationWithRemoteInput() {
    val notification = postAssistantReply(target, "The task is complete.")
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
  fun oldReplyOutcomeDoesNotReplaceNewerConversationNotification() {
    for (outcome in listOf(ConversationNotificationReplyOutcome.Admitted, ConversationNotificationReplyOutcome.NotAdmitted)) {
      val reply = replyFrom(postAssistantReply(target, "Earlier assistant reply"))
      val newer = postAssistantReply(target.copy(runId = "run-43"), "Newer assistant reply")

      assertFalse(ConversationReplyNotifier(context).completeReply(reply, "Continue", outcome) { true })

      val retained = currentNotification()
      assertEquals(newer.contentIntent, retained.contentIntent)
      assertEquals("Newer assistant reply", retained.extras.getCharSequence(Notification.EXTRA_TEXT).toString())
    }
  }

  @Test
  fun sameRunRepostRetiresEveryOldReplyOutcomeAcrossNotifierInstances() {
    for (outcome in ConversationNotificationReplyOutcome.entries) {
      val oldReply = replyFrom(postAssistantReply(target, "Earlier assistant reply"))
      val newReply = replyFrom(postAssistantReply(target, "Newer assistant reply"))

      assertFalse(ConversationReplyNotifier(context).completeReply(oldReply, "Continue", outcome) { true })
      assertEquals("Newer assistant reply", currentNotification().extras.getCharSequence(Notification.EXTRA_TEXT).toString())
      assertTrue(ConversationReplyNotifier(context).completeReply(newReply, "Continue", ConversationNotificationReplyOutcome.Admitted) { true })
      assertEquals("Reply queued", currentNotification().extras.getCharSequence(Notification.EXTRA_TEXT).toString())
    }
  }

  @Test
  fun replyGenerationSurvivesIntentParcelReconstruction() {
    val notification = postAssistantReply(target, "Synthetic reply")
    val original = shadowOf(notification.actions.single().actionIntent).savedIntent
    val parcel = Parcel.obtain()
    val delivered =
      try {
        original.writeToParcel(parcel, 0)
        parcel.setDataPosition(0)
        Intent.CREATOR.createFromParcel(parcel)
      } finally {
        parcel.recycle()
      }
    val reply = requireNotNull(parseConversationNotificationReplyIntent(delivered))

    assertEquals(target, reply.target)
    assertTrue(ConversationReplyNotifier(context).completeReply(reply, "Continue", ConversationNotificationReplyOutcome.Admitted) { true })
    assertEquals(notification.contentIntent, currentNotification().contentIntent)
    assertEquals("Reply queued", currentNotification().extras.getCharSequence(Notification.EXTRA_TEXT).toString())
  }

  @Test
  fun replyFillInCannotReplaceCreatorTargetOrGeneration() {
    val original = postAssistantReply(target, "Earlier assistant reply")
    val pendingReply = shadowOf(original.actions.single().actionIntent)
    val originalIntent = pendingReply.savedIntent
    val originalReply = requireNotNull(parseConversationNotificationReplyIntent(originalIntent))
    val newer = postAssistantReply(target.copy(runId = "run-43"), "Newer assistant reply")
    val newerIntent = shadowOf(newer.actions.single().actionIntent).savedIntent
    val newerReply = requireNotNull(parseConversationNotificationReplyIntent(newerIntent))
    val delivered =
      Intent(originalIntent).apply {
        fillIn(
          Intent().setData(newerIntent.data).putExtra("ai.openclaw.app.extra.CONVERSATION_PUBLICATION_GENERATION", newerReply.generation),
          pendingReply.flags,
        )
      }
    val reply = requireNotNull(parseConversationNotificationReplyIntent(delivered))

    assertEquals(target, reply.target)
    assertEquals(originalReply.generation, reply.generation)
    assertFalse(ConversationReplyNotifier(context).completeReply(reply, "Continue", ConversationNotificationReplyOutcome.Admitted) { true })
    assertEquals(newer.contentIntent, currentNotification().contentIntent)
  }

  @Test
  fun unknownReplyKeepsPrivateSubmittedTextAndOnlyOffersConversationCheck() {
    val original = postAssistantReply(target, "Synthetic reply")
    val reply = replyFrom(original)

    assertTrue(ConversationReplyNotifier(context).completeReply(reply, "Keep this submitted reply", ConversationNotificationReplyOutcome.Unknown) { true })

    val notification = currentNotification()
    assertEquals(Notification.VISIBILITY_PRIVATE, notification.visibility)
    assertEquals("Reply status is unknown. Open the conversation before sending again.", notification.extras.getCharSequence(Notification.EXTRA_TEXT).toString())
    assertTrue(
      notification.extras
        .getCharSequence(Notification.EXTRA_BIG_TEXT)
        .toString()
        .contains("Keep this submitted reply"),
    )
    assertEquals(original.contentIntent, notification.contentIntent)
    assertEquals(
      "Open conversation",
      notification.actions
        .single()
        .title
        .toString(),
    )
    assertTrue(
      notification.actions
        .single()
        .remoteInputs
        .isNullOrEmpty(),
    )
    assertEquals(Notification.VISIBILITY_PUBLIC, notification.publicVersion.visibility)
    assertEquals(
      "Chat",
      notification.publicVersion.extras
        .getCharSequence(Notification.EXTRA_TEXT)
        .toString(),
    )
    assertNull(notification.publicVersion.extras.getCharSequence(Notification.EXTRA_BIG_TEXT))
  }

  @Test
  fun retiredServiceIntentCannotPublishAnyReplyOutcome() {
    for (outcome in ConversationNotificationReplyOutcome.entries) {
      val original = postAssistantReply(target, "Synthetic reply")
      val reply = replyFrom(original)

      assertFalse(ConversationReplyNotifier(context).completeReply(reply, "Continue", outcome) { false })
      assertEquals("Synthetic reply", currentNotification().extras.getCharSequence(Notification.EXTRA_TEXT).toString())
      assertTrue(ConversationReplyNotifier(context).completeReply(reply, "Continue", ConversationNotificationReplyOutcome.Admitted) { true })
    }
  }

  @Test
  fun deniedNotificationPermissionDoesNotRetireExistingPublication() {
    val reply = replyFrom(postAssistantReply(target, "Synthetic reply"))
    shadowOf(RuntimeEnvironment.getApplication()).denyPermissions(Manifest.permission.POST_NOTIFICATIONS)

    assertFalse(ConversationReplyNotifier(context).show(target.toComposerOwner(), "run-43", "Blocked reply"))
    assertFalse(ConversationReplyNotifier(context).completeReply(reply, "Continue", ConversationNotificationReplyOutcome.Admitted) { true })
    assertEquals("Synthetic reply", currentNotification().extras.getCharSequence(Notification.EXTRA_TEXT).toString())
    shadowOf(RuntimeEnvironment.getApplication()).grantPermissions(Manifest.permission.POST_NOTIFICATIONS)
    assertTrue(ConversationReplyNotifier(context).completeReply(reply, "Continue", ConversationNotificationReplyOutcome.Admitted) { true })
    assertEquals("Reply queued", currentNotification().extras.getCharSequence(Notification.EXTRA_TEXT).toString())
  }

  @Test
  fun replyOutcomeCanRenotifyAfterOriginalNotificationWasDismissed() {
    for (outcome in listOf(ConversationNotificationReplyOutcome.Unknown, ConversationNotificationReplyOutcome.Admitted)) {
      val reply = replyFrom(postAssistantReply(target, "Synthetic reply"))
      val original = notificationManager().activeNotifications.single { it.tag == target.notificationTag }
      notificationManager().cancel(original.tag, original.id)

      assertTrue(ConversationReplyNotifier(context).completeReply(reply, "Keep this submitted reply", outcome) { true })
      val notification = currentNotification()
      assertEquals(
        "Open conversation",
        notification.actions
          .single()
          .title
          .toString(),
      )
      assertNotNull(notification.group)
      assertEquals(0, notification.flags and Notification.FLAG_GROUP_SUMMARY)
      assertEquals(
        if (outcome == ConversationNotificationReplyOutcome.Admitted) Notification.GROUP_ALERT_SUMMARY else Notification.GROUP_ALERT_ALL,
        notification.groupAlertBehavior,
      )
    }
  }

  @Test
  fun missingGenerationKeepsTargetButCannotClaimNotificationEffects() {
    val legacyIntent =
      conversationNotificationReplyIntent(context, target)
        .setData(Uri.parse("openclaw://conversation-notification/reply/${target.intentIdentityDigest}"))
    val legacyReply = requireNotNull(parseConversationNotificationReplyIntent(legacyIntent))
    postAssistantReply(target.copy(runId = "run-43"), "Newer assistant reply")

    assertEquals(target, legacyReply.target)
    assertNull(legacyReply.generation)
    assertFalse(ConversationReplyNotifier(context).completeReply(legacyReply, "Continue", ConversationNotificationReplyOutcome.Unknown) { true })
    assertEquals("Newer assistant reply", currentNotification().extras.getCharSequence(Notification.EXTRA_TEXT).toString())
  }

  @Test
  fun sendFailureNotificationKeepsRemoteInputForRetry() {
    val reply = replyFrom(postAssistantReply(target, "Synthetic reply"))
    assertTrue(ConversationReplyNotifier(context).completeReply(reply, "Retry this reply", ConversationNotificationReplyOutcome.NotAdmitted) { true })
    val notification = currentNotification()
    val action = notification.actions.single()

    assertEquals(Notification.CATEGORY_MESSAGE, notification.category)
    assertEquals(Notification.VISIBILITY_PRIVATE, notification.visibility)
    assertEquals(1, notification.actions.size)
    assertEquals("Reply", action.title.toString())
    assertEquals(1, action.remoteInputs.size)
    assertTrue(
      notification.extras
        .getCharSequence(Notification.EXTRA_BIG_TEXT)
        .toString()
        .contains("Retry this reply"),
    )
  }

  private fun postAssistantReply(
    noticeTarget: ConversationNotificationTarget,
    text: String,
  ): Notification {
    shadowOf(RuntimeEnvironment.getApplication()).grantPermissions(Manifest.permission.POST_NOTIFICATIONS)
    assertTrue(ConversationReplyNotifier(context).show(noticeTarget.toComposerOwner(), noticeTarget.runId, text))
    return currentNotification()
  }

  private fun replyFrom(notification: Notification): ConversationNotificationReply = requireNotNull(parseConversationNotificationReplyIntent(shadowOf(notification.actions.single().actionIntent).savedIntent))

  private fun currentNotification(): Notification = notificationManager().activeNotifications.single { it.tag == target.notificationTag }.notification

  private fun notificationManager(): NotificationManager = context.getSystemService(NotificationManager::class.java)
}

// Robolectric 4.16.1 compares Intent filters; Android compares tokens. Its factory and parcel cache retain token objects.
@Implements(PendingIntent::class)
class ConversationNotificationPendingIntentShadow : ShadowPendingIntent() {
  @RealObject
  private lateinit var token: PendingIntent

  @Implementation
  override fun equals(other: Any?): Boolean = token === other

  @Implementation
  override fun hashCode(): Int = System.identityHashCode(token)
}
