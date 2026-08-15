package ai.openclaw.app.node

import android.content.Context
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.int
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class PhotosHandlerTest : NodeHandlerRobolectricTest() {
  @Test
  fun handlePhotosLatest_requiresPermission() {
    val handler = PhotosHandler.forTesting(appContext(), FakePhotosDataSource(hasPermission = false))

    val result = handler.handlePhotosLatest(null)

    assertFalse(result.ok)
    assertEquals("PHOTOS_PERMISSION_REQUIRED", result.error?.code)
  }

  @Test
  fun handlePhotosLatest_rejectsInvalidJson() {
    val handler = PhotosHandler.forTesting(appContext(), FakePhotosDataSource(hasPermission = true))

    val result = handler.handlePhotosLatest("[]")

    assertFalse(result.ok)
    assertEquals("INVALID_REQUEST", result.error?.code)
  }

  @Test
  fun handlePhotosLatest_returnsPayload() {
    val source =
      FakePhotosDataSource(
        hasPermission = true,
        latest =
          listOf(
            EncodedPhotoPayload(
              format = "jpeg",
              base64 = "abc123",
              width = 640,
              height = 480,
              createdAt = "2026-02-28T00:00:00Z",
            ),
          ),
      )
    val handler = PhotosHandler.forTesting(appContext(), source)

    val result = handler.handlePhotosLatest("""{"limit":1}""")

    assertTrue(result.ok)
    val payload = Json.parseToJsonElement(result.payloadJson ?: error("missing payload")).jsonObject
    val photos = payload.getValue("photos").jsonArray
    assertEquals(1, photos.size)
    val first = photos.first().jsonObject
    assertEquals("jpeg", first.getValue("format").jsonPrimitive.content)
    assertEquals(640, first.getValue("width").jsonPrimitive.int)
  }
}

private class FakePhotosDataSource(
  private val hasPermission: Boolean,
  private val latest: List<EncodedPhotoPayload> = emptyList(),
) : PhotosDataSource {
  override fun hasPermission(context: Context): Boolean = hasPermission

  override fun latest(
    context: Context,
    request: PhotosLatestRequest,
  ): List<EncodedPhotoPayload> = latest
}
