package ai.openclaw.app

import android.content.Context
import org.junit.Assert.assertEquals
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import org.robolectric.annotation.Config
import java.util.UUID

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34])
class NodeRuntimeAgentSelectionTest {
  @Test
  fun selectingAgentRebindsCanonicalMainSession() {
    val app = RuntimeEnvironment.getApplication()
    val securePrefs =
      app.getSharedPreferences(
        "openclaw.node.secure.test.${UUID.randomUUID()}",
        Context.MODE_PRIVATE,
      )
    val runtime = NodeRuntime(app, SecurePrefs(app, securePrefsOverride = securePrefs))

    runtime.selectChatAgent(" scout ")

    assertEquals("scout", resolveAgentIdFromMainSessionKey(runtime.mainSessionKey.value))
    assertEquals(runtime.mainSessionKey.value, runtime.chatSessionKey.value)
  }
}
