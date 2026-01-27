package bot.molt.android.voice

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class TalkDirectiveParserTest {
  @Test
  fun parsesDirectiveAndStripsHeader() {
    val input = """
      {"voice":"voice-123","once":true}
      Hello from talk mode.
    """.trimIndent()
    val result = TalkDirectiveParser.parse(input)
    assertEquals("voice-123", result.directive?.voiceId)
    assertEquals(true, result.directive?.once)
    assertEquals("Hello from talk mode.", result.stripped.trim())
  }

  @Test
  fun ignoresUnknownKeysButReportsThem() {
    val input = """
      {"voice":"abc","foo":1,"bar":"baz"}
      Hi there.
    """.trimIndent()
    val result = TalkDirectiveParser.parse(input)
    assertEquals("abc", result.directive?.voiceId)
    assertTrue(result.unknownKeys.containsAll(listOf("bar", "foo")))
  }

  @Test
  fun parsesAlternateKeys() {
    val input = """
      {"model_id":"eleven_v3","similarity_boost":0.4,"no_speaker_boost":true,"rate":200}
      Speak.
    """.trimIndent()
    val result = TalkDirectiveParser.parse(input)
    assertEquals("eleven_v3", result.directive?.modelId)
    assertEquals(0.4, result.directive?.similarity)
    assertEquals(false, result.directive?.speakerBoost)
    assertEquals(200, result.directive?.rateWpm)
  }

  @Test
  fun returnsNullWhenNoDirectivePresent() {
    val input = """
      {}
      Hello.
    """.trimIndent()
    val result = TalkDirectiveParser.parse(input)
    assertNull(result.directive)
    assertEquals(input, result.stripped)
  }
}
