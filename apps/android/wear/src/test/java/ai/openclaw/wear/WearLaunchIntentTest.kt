package ai.openclaw.wear

import android.content.Intent
import android.os.Looper
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.wear.protolayout.ActionBuilders
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertSame
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.Robolectric
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import org.robolectric.Shadows.shadowOf
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34])
class WearLaunchIntentTest {
  @Test
  fun normalAndUnknownLaunchesStartOnChat() {
    assertEquals(WearLaunchTarget.Chat, parseWearLaunchTarget(Intent(Intent.ACTION_MAIN)))
    assertEquals(
      WearLaunchTarget.Chat,
      parseWearLaunchTarget(Intent().putExtra(extraWearLaunchTarget, "unknown")),
    )
  }

  @Test
  fun tileTalkLaunchStartsOnVoice() {
    val target =
      parseWearLaunchTarget(
        Intent().putExtra(extraWearLaunchTarget, WearLaunchTarget.Voice.rawValue),
      )

    assertEquals(WearLaunchTarget.Voice, target)
    assertEquals(WearHomePage.Voice, target.initialPage)
  }

  @Test
  fun launchTargetsAreConsumedOnce() {
    val intent = Intent().putExtra(extraWearLaunchTarget, WearLaunchTarget.Voice.rawValue)

    val initial = WearLaunchState.initial(intent)

    assertEquals(WearLaunchTarget.Voice, initial.initialTarget)
    assertFalse(intent.hasExtra(extraWearLaunchTarget))
    assertEquals(WearLaunchTarget.Chat, WearLaunchState.initial(intent).initialTarget)
  }

  @Test
  fun warmLaunchesCreateUniquePagerRequestsForTalkOpenAndNotifications() {
    val initial = WearLaunchState.initial(Intent(Intent.ACTION_MAIN))
    val voice =
      initial.next(
        Intent().putExtra(extraWearLaunchTarget, WearLaunchTarget.Voice.rawValue),
      )
    val chat =
      voice.next(
        Intent().putExtra(extraWearLaunchTarget, WearLaunchTarget.Chat.rawValue),
      )
    val notification = chat.next(Intent())

    assertEquals(WearLaunchTarget.Chat, initial.initialTarget)
    assertEquals(WearNavigationRequest(1, WearLaunchTarget.Voice), voice.navigationRequest)
    assertEquals(WearNavigationRequest(2, WearLaunchTarget.Chat), chat.navigationRequest)
    assertEquals(WearNavigationRequest(3, WearLaunchTarget.Chat), notification.navigationRequest)
    assertSame(notification, notification.handled(requestId = 2))
    assertNull(notification.handled(requestId = 3).navigationRequest)
  }

  @Test
  fun activeRealtimeTalkKeepsWarmRoutesOnVoice() {
    assertEquals(
      WearHomePage.Voice,
      wearLaunchPage(WearLaunchTarget.Chat, realtimeActive = true),
    )
    assertEquals(
      WearHomePage.Voice,
      wearLaunchPage(WearLaunchTarget.Voice, realtimeActive = true),
    )
    assertEquals(
      WearHomePage.Chat,
      wearLaunchPage(WearLaunchTarget.Chat, realtimeActive = false),
    )
  }

  @Test
  fun warmPagerRequestsPreservePendingReplyAndRealtimeUiState() {
    val controller = Robolectric.buildActivity(ComponentActivity::class.java).setup()
    var launchState by mutableStateOf(WearLaunchState.initial(Intent(Intent.ACTION_MAIN)))
    var retainedState: WarmLaunchRetentionProbe? = null

    controller.get().setContent {
      WearLaunchContent(launchState) { _, _ ->
        retainedState =
          remember {
            WarmLaunchRetentionProbe(
              awaitingReply = true,
              realtimeStartedAtMillis = 4_200L,
            )
          }
      }
    }
    idleMainLooper()
    val initialRetainedState = retainedState

    launchState =
      launchState.next(
        Intent().putExtra(extraWearLaunchTarget, WearLaunchTarget.Voice.rawValue),
      )
    idleMainLooper()

    assertSame(initialRetainedState, retainedState)
    assertTrue(retainedState?.awaitingReply == true)
    assertEquals(4_200L, retainedState?.realtimeStartedAtMillis)

    launchState =
      launchState.next(
        Intent().putExtra(extraWearLaunchTarget, WearLaunchTarget.Chat.rawValue),
      )
    idleMainLooper()

    assertSame(initialRetainedState, retainedState)
    assertTrue(retainedState?.awaitingReply == true)
    assertEquals(4_200L, retainedState?.realtimeStartedAtMillis)

    controller.pause().stop().destroy()
  }

  @Test
  fun warmDebugLaunchesRecreateForScreenshotEntrySwitchAndExit() {
    val voiceScreenshotIntent =
      Intent(Intent.ACTION_MAIN)
        .putExtra(extraWearScreenshotMode, true)
        .putExtra(extraWearScreenshotScene, WearScreenshotScene.Voice.rawValue)
    val controlsScreenshotIntent =
      Intent(Intent.ACTION_MAIN)
        .putExtra(extraWearScreenshotMode, true)
        .putExtra(extraWearScreenshotScene, WearScreenshotScene.Controls.rawValue)
    val normalIntent = Intent(Intent.ACTION_MAIN)

    assertEquals(
      true,
      shouldRecreateForScreenshotMode(null, voiceScreenshotIntent, screenshotModeEnabled = true),
    )
    assertEquals(
      true,
      shouldRecreateForScreenshotMode(
        WearScreenshotScene.Voice,
        controlsScreenshotIntent,
        screenshotModeEnabled = true,
      ),
    )
    assertEquals(
      true,
      shouldRecreateForScreenshotMode(
        WearScreenshotScene.Controls,
        normalIntent,
        screenshotModeEnabled = true,
      ),
    )
    assertEquals(
      false,
      shouldRecreateForScreenshotMode(
        null,
        Intent(Intent.ACTION_MAIN)
          .putExtra(extraWearLaunchTarget, WearLaunchTarget.Voice.rawValue),
        screenshotModeEnabled = true,
      ),
    )
  }

  @Test
  fun releaseLaunchDoesNotRecreateForScreenshotExtras() {
    val screenshotIntent =
      Intent(Intent.ACTION_MAIN)
        .putExtra(extraWearScreenshotMode, true)
        .putExtra(extraWearScreenshotScene, WearScreenshotScene.Voice.rawValue)

    assertEquals(
      false,
      shouldRecreateForScreenshotMode(null, screenshotIntent, screenshotModeEnabled = false),
    )
  }

  @Test
  fun tileActionsTargetMainActivityWithTheirRequestedPage() {
    val context = RuntimeEnvironment.getApplication()

    WearLaunchTarget.entries.forEach { target ->
      val activity = wearLaunchAction(context, target).androidActivity
      val pageExtra =
        activity?.keyToExtraMapping?.get(extraWearLaunchTarget)
          as? ActionBuilders.AndroidStringExtra

      assertEquals(context.packageName, activity?.packageName)
      assertEquals(MainActivity::class.java.name, activity?.className)
      assertEquals(target.rawValue, pageExtra?.value)
    }
  }

  private fun idleMainLooper() {
    shadowOf(Looper.getMainLooper()).idle()
  }

  private data class WarmLaunchRetentionProbe(
    val awaitingReply: Boolean,
    val realtimeStartedAtMillis: Long,
  )
}
