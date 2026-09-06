package ai.openclaw.app.voice

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class TalkRealtimeToolBatchTest {
  @Test
  fun waitsForAllResultsAndRejectsDuplicateCallsAndResults() {
    val batch = TalkRealtimeToolBatch()
    assertEquals(setOf("first", "second"), batch.admit(listOf("first", "second", "first")))
    assertFalse(batch.complete("second")!!)
    assertTrue(batch.hasPending)
    assertNull(batch.complete("second"))
    assertTrue(batch.admit(listOf("first", "second")).isEmpty())
    assertTrue(batch.complete("first")!!)
    assertFalse(batch.hasPending)
    assertNull(batch.complete("first"))
  }

  @Test
  fun keepsPendingOwnershipAcrossOverlappingResponses() {
    val batch = TalkRealtimeToolBatch()
    batch.admit(listOf("earlier"))
    batch.admit(listOf("later"))
    assertFalse(batch.complete("later")!!)
    assertTrue(batch.complete("earlier")!!)
    assertNull(batch.complete("unadmitted"))
  }

  @Test
  fun rejectsOversizedIdentitiesAtomicallyAndPreservesExactBoundaryDedupe() {
    val atLimit = "é".repeat(1024)
    val distinct = "é".repeat(1023) + "x"
    val batch = TalkRealtimeToolBatch()
    assertEquals(setOf(atLimit, distinct), batch.admit(listOf(atLimit, distinct, atLimit)))
    assertTrue(runCatching { batch.admit(listOf("fresh", atLimit + "x")) }.isFailure)
    assertNull(batch.complete("fresh"))
    assertFalse(batch.complete(atLimit)!!)
    assertTrue(batch.complete(distinct)!!)
    assertTrue(batch.admit(listOf(atLimit, distinct)).isEmpty())
    assertEquals(setOf("fresh"), batch.admit(listOf("fresh")))
  }

  @Test
  fun rejectsOverflowBeforeAdmittingAnyPartOfTheBatch() {
    val batch = TalkRealtimeToolBatch()
    assertTrue(runCatching { batch.admit((0..1024).map(Int::toString)) }.isFailure)
    assertFalse(batch.hasPending)
    assertEquals(setOf("retry"), batch.admit(listOf("retry")))
  }
}
