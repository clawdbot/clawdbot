package ai.openclaw.app.node

import ai.openclaw.app.accessibility.GlobalActionName
import ai.openclaw.app.accessibility.MobileUiAction
import ai.openclaw.app.accessibility.MobileUiNode
import ai.openclaw.app.accessibility.MobileUiSnapshot
import ai.openclaw.app.accessibility.ScrollDirection
import android.graphics.Rect
import kotlinx.coroutines.test.runTest
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.jsonPrimitive
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner

@RunWith(RobolectricTestRunner::class)
class MobileUiHandlerTest {
  @Test
  fun snapshotJsonUsesStableTransportShape() {
    val snapshot =
      MobileUiSnapshot(
        id = "snapshot-1",
        capturedAtMs = 1234,
        packageName = "example.app",
        windowTitle = "Example",
        nodes =
          listOf(
            MobileUiNode(
              ref = "n0",
              parentRef = null,
              role = "button",
              text = "Continue",
              contentDescription = "Continue button",
              viewId = "example.app:id/continue",
              boundsInScreen = Rect(1, 2, 30, 40),
              clickable = true,
              editable = false,
              scrollable = false,
              enabled = true,
              focused = false,
              actions = listOf("activate"),
            ),
          ),
      )

    val payload = Json.parseToJsonElement(mobileUiSnapshotJson(snapshot)) as JsonObject
    val node = (payload["nodes"] as JsonArray).single() as JsonObject

    assertEquals("snapshot-1", payload["snapshotId"]?.jsonPrimitive?.content)
    assertEquals("example.app", payload["package"]?.jsonPrimitive?.content)
    assertEquals(listOf("1", "2", "30", "40"), (node["bounds"] as JsonArray).map { it.jsonPrimitive.content })
    assertEquals("true", ((node["flags"] as JsonObject)["clickable"])?.jsonPrimitive?.content)
    assertEquals("activate", (node["actions"] as JsonArray).single().jsonPrimitive.content)
  }

  @Test
  fun actParserMapsEverySupportedAction() {
    assertEquals(MobileUiAction.Activate("n1"), parse(action("activate", "\"ref\":\"n1\"")))
    assertEquals(
      MobileUiAction.SetText("n2", "hello"),
      parse(action("set_text", "\"ref\":\"n2\",\"text\":\"hello\"")),
    )
    assertEquals(
      MobileUiAction.Scroll("n3", ScrollDirection.Backward),
      parse(action("scroll", "\"ref\":\"n3\",\"direction\":\"backward\"")),
    )
    assertEquals(MobileUiAction.Tap(10, 20), parse(action("tap", "\"x\":10,\"y\":20")))
    assertEquals(
      MobileUiAction.Swipe(1, 2, 3, 4, 500),
      parse(action("swipe", "\"x1\":1,\"y1\":2,\"x2\":3,\"y2\":4,\"durationMs\":500")),
    )
    assertEquals(
      MobileUiAction.GlobalAction(GlobalActionName.Notifications),
      parse(action("global_action", "\"name\":\"notifications\"")),
    )
    assertEquals(MobileUiAction.Wait(250), parse(action("wait", "\"ms\":250")))
  }

  @Test
  fun actParserRejectsMalformedRequests() {
    assertNull(parseMobileUiActRequest(null))
    assertNull(parseMobileUiActRequest("{}"))
    assertNull(parseMobileUiActRequest(action("scroll", "\"ref\":\"n1\",\"direction\":\"sideways\"")))
  }

  @Test
  fun observeMapsDisconnectedServiceToStructuredError() =
    runTest {
      val result = MobileUiHandler().handleObserve(null)

      assertEquals(false, result.ok)
      assertEquals("SERVICE_DISABLED", result.error?.code)
    }

  private fun parse(raw: String): MobileUiAction? = parseMobileUiActRequest(raw)?.action

  private fun action(
    type: String,
    fields: String,
  ): String = """{"snapshotId":"snapshot-1","action":{"type":"$type",$fields}}"""
}
