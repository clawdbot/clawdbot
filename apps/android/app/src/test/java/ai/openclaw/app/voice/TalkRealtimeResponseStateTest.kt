package ai.openclaw.app.voice

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class TalkRealtimeResponseStateTest {
  @Test
  fun deferredToolContinuationIsConsumedOnceAfterAnotherToolBatch() {
    val state = TalkRealtimeResponseState()
    state.created("active")
    assertFalse(state.requestResponse(hasPendingTools = false, eventId = "event-1"))
    assertTrue(state.responsePending)
    state.completed("active")
    assertFalse(state.requestResponse(hasPendingTools = true, eventId = "event-2"))
    assertTrue(state.responsePending)
    assertTrue(state.requestResponse(hasPendingTools = false, eventId = "event-3"))
    assertFalse(state.responsePending)
    assertTrue(state.createInFlight)
    state.created("continuation")
    state.completed("continuation")
    assertFalse(state.responsePending)
  }

  @Test
  fun deferredContinuationDoesNotRaceVadCreationAndCancelClearsIt() {
    val state = TalkRealtimeResponseState()
    state.requesting()
    assertFalse(state.requestResponse(hasPendingTools = false, eventId = "event-4"))
    assertTrue(state.responsePending)
    state.cancel()
    assertFalse(state.responsePending)
    assertEquals("vad", state.created("vad"))
    state.completed("vad")
    assertFalse(state.responsePending)
  }

  @Test
  fun onlyTheCorrelatedCreateErrorClearsInFlightState() {
    val state = TalkRealtimeResponseState()
    assertTrue(state.requestResponse(hasPendingTools = false, eventId = "create-1"))
    assertFalse(state.creationRejected("other"))
    assertTrue(state.createInFlight)
    assertNull(state.cancel())
    assertTrue(state.creationRejected("create-1"))
    assertFalse(state.createInFlight)
    assertTrue(state.requestResponse(hasPendingTools = false, eventId = "create-2"))
    assertNull(state.created("response-2"))
  }

  @Test
  fun queuedContinuationCanStartAfterCreationRejection() {
    val state = TalkRealtimeResponseState()
    assertTrue(state.requestResponse(hasPendingTools = false, eventId = "create-1"))
    assertFalse(state.requestResponse(hasPendingTools = false, eventId = "queued"))
    assertTrue(state.responsePending)
    assertTrue(state.creationRejected("create-1"))
    assertTrue(state.requestResponse(hasPendingTools = false, eventId = "create-2"))
    assertFalse(state.responsePending)
  }

  @Test
  fun cancelBeforeAcknowledgementTargetsTheCreatedResponseOnce() {
    val state = TalkRealtimeResponseState()
    state.requesting()
    assertNull(state.cancel())
    assertNull(state.cancel())
    assertEquals("pending-response", state.created("pending-response"))
    assertNull(state.cancel())
    assertFalse(state.createInFlight)
    state.completed("pending-response")
    state.requesting()
    assertNull(state.created("next-response"))
  }

  @Test
  fun cancellationTargetsActiveResponseAndLateCompletionCannotClearItsReplacement() {
    val state = TalkRealtimeResponseState()
    assertNull(state.created("first"))
    assertEquals("first", state.cancel())
    assertNull(state.cancel())
    assertNull(state.created("replacement"))
    state.completed("first")
    assertEquals("replacement", state.cancel())
    state.completed("replacement")
    assertNull(state.cancel())
  }
}
