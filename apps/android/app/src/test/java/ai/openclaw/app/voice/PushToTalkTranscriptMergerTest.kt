package ai.openclaw.app.voice

import org.junit.Assert.assertEquals
import org.junit.Test

class PushToTalkTranscriptMergerTest {
  @Test
  fun joinsMultipleFinalSegmentsInOrder() {
    assertEquals(
      "first thought. second thought. third thought",
      PushToTalkTranscriptMerger.merge(
        finalSegments = listOf("first thought", "second thought", "third thought"),
        livePartial = null,
      ),
    )
  }

  @Test
  fun preservesTerminalPunctuationWithoutDoublingIt() {
    assertEquals(
      "ready? yes! \"done.\" next",
      PushToTalkTranscriptMerger.merge(
        finalSegments = listOf("ready?", "yes!", "\"done.\"", "next"),
        livePartial = null,
      ),
    )
  }

  @Test
  fun preservesLocalePunctuationWithoutInjectingAsciiSeparators() {
    assertEquals(
      "你好。 世界",
      PushToTalkTranscriptMerger.merge(
        finalSegments = listOf("你好。", "世界"),
        livePartial = null,
      ),
    )
    assertEquals(
      "هل أنت جاهز؟ نعم",
      PushToTalkTranscriptMerger.merge(
        finalSegments = listOf("هل أنت جاهز؟", "نعم"),
        livePartial = null,
      ),
    )
  }

  @Test
  fun omitsTrailingPartialThatDuplicatesLastFinal() {
    assertEquals(
      "first. SAME words",
      PushToTalkTranscriptMerger.merge(
        finalSegments = listOf("first", "SAME words"),
        livePartial = "  same   WORDS  ",
      ),
    )
  }

  @Test
  fun appendsDistinctTrailingPartial() {
    assertEquals(
      "first final. trailing words",
      PushToTalkTranscriptMerger.merge(
        finalSegments = listOf("first final"),
        livePartial = "trailing words",
      ),
    )
  }

  @Test
  fun returnsPartialForPartialOnlyHold() {
    assertEquals(
      "unfinished thought",
      PushToTalkTranscriptMerger.merge(
        finalSegments = emptyList(),
        livePartial = " unfinished thought ",
      ),
    )
  }

  @Test
  fun returnsEmptyForEmptyResults() {
    assertEquals(
      "",
      PushToTalkTranscriptMerger.merge(
        finalSegments = listOf("", "   "),
        livePartial = "  ",
      ),
    )
  }
}
