package ai.openclaw.app.ui.chat

import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment

@RunWith(RobolectricTestRunner::class)
class ChatMathAssetsTest {
  @Test
  fun rendererReportsMalformedKatexAsFailure() {
    val assets = RuntimeEnvironment.getApplication().assets
    val renderer = assets.open("katex/renderer.js").bufferedReader().use { reader -> reader.readText() }

    assertTrue(Regex("""throwOnError:\s*true""").containsMatchIn(renderer))
    assertFalse(Regex("""throwOnError:\s*false""").containsMatchIn(renderer))
  }
}
