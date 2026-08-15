package ai.openclaw.app.node

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class NodeUtilsTest {
  private val json = Json { ignoreUnknownKeys = true }

  @Test
  fun parseJsonBooleanFlag_acceptsCommonStringAliases() {
    val cases =
      linkedMapOf(
        """{"enabled":"true"}""" to true,
        """{"enabled":"false"}""" to false,
        """{"enabled":"yes"}""" to true,
        """{"enabled":"no"}""" to false,
        """{"enabled":"1"}""" to true,
        """{"enabled":"0"}""" to false,
        """{"enabled":" YES "}""" to true,
      )
    for ((source, expected) in cases) {
      val params = json.parseToJsonElement(source) as JsonObject
      assertEquals(source, expected, parseJsonBooleanFlag(params, "enabled"))
    }
  }

  @Test
  fun parseJsonBooleanFlag_acceptsJsonBooleanLiterals() {
    val params =
      buildJsonObject {
        put("enabled", true)
        put("disabled", false)
      }

    assertEquals(true, parseJsonBooleanFlag(params, "enabled"))
    assertEquals(false, parseJsonBooleanFlag(params, "disabled"))
  }

  @Test
  fun parseJsonBooleanFlag_returnsNullForUnknownValues() {
    val params = json.parseToJsonElement("""{"enabled":"maybe"}""") as JsonObject

    assertNull(parseJsonBooleanFlag(params, "enabled"))
    assertNull(parseJsonBooleanFlag(params, "missing"))
  }

  @Test
  fun parseJsonBooleanFlag_parsesIncludeAudioAliasesForCameraClip() {
    val cases =
      linkedMapOf(
        """{"includeAudio":"no"}""" to false,
        """{"includeAudio":"0"}""" to false,
        """{"includeAudio":"yes"}""" to true,
      )
    for ((source, expected) in cases) {
      val params = json.parseToJsonElement(source) as JsonObject
      assertEquals(source, expected, parseJsonBooleanFlag(params, "includeAudio"))
    }
  }
}
