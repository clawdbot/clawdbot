package ai.openclaw.app.ui.chat

import ai.openclaw.app.chat.ChatMessage
import ai.openclaw.app.chat.ChatMessageContent
import ai.openclaw.app.gateway.GatewayLoadedImage
import android.os.Looper
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import org.junit.Assert.assertEquals
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.Robolectric
import org.robolectric.RobolectricTestRunner
import org.robolectric.Shadows.shadowOf
import java.util.Base64

@RunWith(RobolectricTestRunner::class)
class ChatMessageViewsTest {
  @Test
  fun managedImageCompositionRequestsItsArtifact() {
    val artifactId = "artifact_managed_image_11111111-1111-4111-8111-111111111111"
    val requested = mutableListOf<String>()
    val png =
      Base64
        .getDecoder()
        .decode("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9Zl1sAAAAASUVORK5CYII=")
    val controller = Robolectric.buildActivity(ComponentActivity::class.java).setup()

    try {
      controller.get().setContent {
        ChatMessageBubble(
          message =
            ChatMessage(
              id = "managed-image",
              role = "assistant",
              content =
                listOf(
                  ChatMessageContent(
                    type = "image",
                    mimeType = "image/png",
                    artifactId = artifactId,
                    alt = "Managed image",
                  ),
                ),
              timestampMs = 1,
            ),
          imageResolverReady = true,
          loadImageArtifact = { requestedArtifactId ->
            requested += requestedArtifactId
            GatewayLoadedImage(bytes = png, mimeType = "image/png")
          },
        )
      }
      shadowOf(Looper.getMainLooper()).idle()

      assertEquals(listOf(artifactId), requested)
    } finally {
      controller.pause().stop().destroy()
      shadowOf(Looper.getMainLooper()).idle()
    }
  }
}
