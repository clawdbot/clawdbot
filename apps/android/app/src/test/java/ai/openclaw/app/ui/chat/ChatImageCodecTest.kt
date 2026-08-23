package ai.openclaw.app.ui.chat

import ai.openclaw.app.chat.CHAT_IMAGE_MAX_BASE64_CHARS
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class ChatImageCodecTest {
  @Test
  fun computeInSampleSizeCapsLongestEdge() {
    assertEquals(4, computeInSampleSize(width = 4032, height = 3024, maxDimension = 1600))
    assertEquals(1, computeInSampleSize(width = 800, height = 600, maxDimension = 1600))
  }

  @Test
  fun normalizeAttachmentFileNameForcesJpegExtension() {
    assertEquals("photo.jpg", normalizeAttachmentFileName("photo.png"))
    assertEquals("image.jpg", normalizeAttachmentFileName(""))
  }

  @Test
  fun decodeBase64BitmapRejectsOversizedInputBeforeDecode() {
    assertNull(decodeBase64Bitmap("A".repeat(CHAT_IMAGE_MAX_BASE64_CHARS + 1)))
  }
}
