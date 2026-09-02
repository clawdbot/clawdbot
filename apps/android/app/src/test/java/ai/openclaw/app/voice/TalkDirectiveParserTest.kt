package ai.openclaw.app.voice

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class TalkDirectiveParserTest {
  @Test
  fun parsesDirectiveAndStripsHeader() {
    val input =
      """
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
    val input =
      """
      {"voice":"abc","foo":1,"bar":"baz"}
      Hi there.
      """.trimIndent()
    val result = TalkDirectiveParser.parse(input)
    assertEquals("abc", result.directive?.voiceId)
    assertTrue(result.unknownKeys.containsAll(listOf("bar", "foo")))
  }

  @Test
  fun parsesAlternateKeys() {
    val input =
      """
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
  fun parsesAliasKeysCaseInsensitively() {
    val input =
      """
      {"Voice":"voice-abc","NoSpeakerBoost":true,"Language_Code":"en"}
      Speak clearly.
      """.trimIndent()
    val result = TalkDirectiveParser.parse(input)
    assertEquals("voice-abc", result.directive?.voiceId)
    assertEquals(false, result.directive?.speakerBoost)
    assertEquals("en", result.directive?.language)
    assertEquals(emptyList<String>(), result.unknownKeys)
  }

  @Test
  fun preservesAliasPriorityNullMaskingAndPrimitiveCoercion() {
    val input =
      """
      {"VOICE":"masked","voice":null,"voice_id":"  selected  ","MODEL":7,"model_id":" model ","speed":"1.25","rate":0,"stability":0,"similarity":"0.4","style":"0.0","speaker_boost":false,"no_speaker_boost":false,"seed":"42","normalize":" ","apply_text_normalization":" auto ","LANG":"masked","lang":null,"language_code":" en ","output_format":" pcm ","latency":"0","once":"yes","z":1,"A":2}
      Speak.
      """.trimIndent()

    val result = TalkDirectiveParser.parse(input)

    assertEquals(
      TalkDirective(
        voiceId = "selected",
        modelId = "model",
        speed = 1.25,
        rateWpm = 0,
        stability = 0.0,
        similarity = 0.4,
        style = 0.0,
        speakerBoost = false,
        seed = 42,
        normalize = "auto",
        language = "en",
        outputFormat = "pcm",
        latencyTier = 0,
        once = true,
      ),
      result.directive,
    )
    assertEquals("Speak.", result.stripped)
    assertEquals(listOf("A", "z"), result.unknownKeys)
  }

  @Test
  fun preservesExactKeyAndCaseCollisionOrdering() {
    val cases =
      listOf(
        "{\"VOICE\":\"first\",\"Voice\":\"second\"}" to "first",
        "{\"VOICE\":\"case-insensitive\",\"voice\":\"exact\"}" to "exact",
        "{\"voice\":\"primary\",\"voice_id\":\"secondary\"}" to "primary",
      )

    for ((json, expected) in cases) {
      val result = TalkDirectiveParser.parse("$json\nSpeak.")
      assertEquals(json, expected, result.directive?.voiceId)
    }
  }

  @Test
  fun preservesRejectedTextAndAcceptedWhitespaceExactly() {
    val rejected = "{\"unknown\":1}\r\nText\r\n"
    assertEquals(
      TalkDirectiveParseResult(directive = null, stripped = rejected, unknownKeys = emptyList()),
      TalkDirectiveParser.parse(rejected),
    )

    val accepted = "\r\n\r\n{\"voice\":\"v\"}\r\n\r\nHello\r\n"
    assertEquals(
      TalkDirectiveParseResult(
        directive = TalkDirective(voiceId = "v"),
        stripped = "\n\nHello\n",
        unknownKeys = emptyList(),
      ),
      TalkDirectiveParser.parse(accepted),
    )
  }

  @Test
  fun returnsNullWhenNoDirectivePresent() {
    val input =
      """
      {}
      Hello.
      """.trimIndent()
    val result = TalkDirectiveParser.parse(input)
    assertNull(result.directive)
    assertEquals(input, result.stripped)
  }
}
