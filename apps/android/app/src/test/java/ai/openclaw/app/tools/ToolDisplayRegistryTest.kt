package ai.openclaw.app.tools

import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
class ToolDisplayRegistryTest {
  @Test
  @Config(sdk = [34])
  fun resolvePreservesUtf16BoundariesAtDetailPreviewLimit() {
    val context = RuntimeEnvironment.getApplication()

    val splitPairPrefix = "a".repeat(156)
    val splitSummary =
      ToolDisplayRegistry.resolve(
        context = context,
        name = "bash",
        args = JsonObject(mapOf("command" to JsonPrimitive("$splitPairPrefix😀tail"))),
      )
    assertEquals("$splitPairPrefix…", splitSummary.detail)
    assertFalse(Character.isHighSurrogate(splitSummary.detail!!.last()))

    val completePairPrefix = "a".repeat(155)
    val completeSummary =
      ToolDisplayRegistry.resolve(
        context = context,
        name = "bash",
        args = JsonObject(mapOf("command" to JsonPrimitive("$completePairPrefix😀tail"))),
      )
    assertEquals("$completePairPrefix😀…", completeSummary.detail)
    assertTrue(completeSummary.detail!!.contains("😀"))
  }
}
