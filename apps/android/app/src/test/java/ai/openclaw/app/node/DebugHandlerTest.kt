package ai.openclaw.app.node

import ai.openclaw.app.gateway.DeviceIdentityStore
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File

class DebugHandlerTest : NodeHandlerRobolectricTest() {
  @Test
  fun handleLogs_preservesUtf16BoundariesInCameraLog() {
    val splitPairPrefix = "x".repeat(3_999)
    assertEquals(splitPairPrefix, cameraLogFromResponse("${splitPairPrefix}\uD83D\uDE00tail"))

    val completePairPrefix = "x".repeat(3_998)
    assertEquals(
      "${completePairPrefix}\uD83D\uDE00",
      cameraLogFromResponse("${completePairPrefix}\uD83D\uDE00tail"),
    )
  }

  private fun cameraLogFromResponse(raw: String): String {
    val context = appContext()
    File(context.cacheDir, "camera_debug.log").writeText(raw)

    val result = DebugHandler(context, DeviceIdentityStore(context)).handleLogs()

    assertTrue(result.ok)
    val logs =
      Json
        .parseToJsonElement(result.payloadJson ?: error("missing payload"))
        .jsonObject
        .getValue("logs")
        .jsonPrimitive
        .content
    return logs.substringAfter("\n--- camera_debug.log ---\n")
  }
}
