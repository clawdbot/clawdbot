package ai.openclaw.app

import ai.openclaw.app.chat.ChatQuestionPrompt
import ai.openclaw.app.chat.ChatQuestionStatus
import ai.openclaw.app.gateway.QuestionListResult
import ai.openclaw.app.gateway.QuestionRecord
import android.os.SystemClock
import kotlinx.serialization.json.Json
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config
import org.robolectric.annotation.LooperMode
import org.robolectric.shadows.ShadowSystemClock
import java.time.Duration

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34], instrumentedPackages = ["ai.openclaw.app.AndroidScreenshotFixture"])
@LooperMode(LooperMode.Mode.PAUSED)
class AndroidScreenshotFixtureRuntimeTest {
  @After
  fun restoreScene() {
    AndroidScreenshotFixture.configure(AndroidScreenshotScene.Home)
  }

  @Test
  fun newRuntimeGetsFreshQuestionWhileExistingRequesterKeepsItsRecord() {
    val firstCreatedAtMs = SystemClock.uptimeMillis()
    val firstRequester = newRuntimeRequester()
    val first = question(firstRequester)
    // Instrument only the fixture: its System clock must share Robolectric's virtual time.
    assertEquals("Fixture clock must be controlled before testing expiry", firstCreatedAtMs, first.createdAtMs)
    assertEquals(firstCreatedAtMs + 600_000, first.expiresAtMs)
    assertEquals(ChatQuestionStatus.Pending, ChatQuestionPrompt(first).status(firstCreatedAtMs))

    ShadowSystemClock.advanceBy(Duration.ofSeconds(1))
    assertEquals("Repeated lists must preserve the complete record", first, question(firstRequester))
    AndroidScreenshotFixture.configure(AndroidScreenshotScene.Home)
    AndroidScreenshotFixture.configure(AndroidScreenshotScene.Chat)
    assertEquals("Scene re-entry must not restart a runtime's question", first, question(firstRequester))

    ShadowSystemClock.advanceBy(Duration.ofMinutes(10))
    val secondCreatedAtMs = SystemClock.uptimeMillis()
    assertEquals(ChatQuestionStatus.Expired, ChatQuestionPrompt(first).status(secondCreatedAtMs))
    val secondRequester = newRuntimeRequester()
    val second = question(secondRequester)
    assertEquals("A new runtime must not inherit an expired singleton question", secondCreatedAtMs, second.createdAtMs)
    assertEquals(secondCreatedAtMs + 600_000, second.expiresAtMs)
    assertEquals(ChatQuestionStatus.Pending, ChatQuestionPrompt(second).status(secondCreatedAtMs))

    ShadowSystemClock.advanceBy(Duration.ofSeconds(1))
    AndroidScreenshotFixture.configure(AndroidScreenshotScene.Home)
    assertEquals("A new runtime must not replace an older requester's record", first, question(firstRequester))
    assertEquals("The new runtime must keep its own stable record", second, question(secondRequester))
  }

  private fun newRuntimeRequester(): (String, String?) -> String = AndroidScreenshotFixture.createRequester()

  private fun question(request: (String, String?) -> String): QuestionRecord = Json.decodeFromString<QuestionListResult>(request("question.list", "{}")).questions.single()
}
