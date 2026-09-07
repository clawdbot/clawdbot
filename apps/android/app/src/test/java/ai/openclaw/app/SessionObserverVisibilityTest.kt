package ai.openclaw.app

import ai.openclaw.app.gateway.GatewayMethod
import ai.openclaw.app.gateway.GatewaySession
import kotlinx.coroutines.runBlocking
import org.junit.Assert.assertEquals
import org.junit.Test

class SessionObserverVisibilityTest {
  @Test
  fun foregroundTransitionsDeclareActualVisibilityOncePerSocket() =
    runBlocking {
      var visible = true
      var firstSocketIsCurrent = true
      var secondSocketIsCurrent = false
      val requests = mutableListOf<Pair<String, String?>>()
      val firstLease =
        GatewaySession.RequestLease(
          endpointStableId = "gateway",
          isCurrentImpl = { firstSocketIsCurrent },
        ) { method, params, _, withEnqueue ->
          withEnqueue {}
          requests.add(method to params)
          ""
        }
      val secondLease =
        GatewaySession.RequestLease(
          endpointStableId = "gateway",
          isCurrentImpl = { secondSocketIsCurrent },
        ) { method, params, _, withEnqueue ->
          withEnqueue {}
          requests.add(method to params)
          ""
        }
      var activeLease: GatewaySession.RequestLease? = firstLease
      val observer =
        SessionObserverVisibility(
          isVisible = { visible },
          captureLease = { activeLease },
        )

      observer.sync()
      observer.sync()
      visible = false
      observer.sync()
      observer.sync()
      visible = true
      observer.sync()
      firstSocketIsCurrent = false
      secondSocketIsCurrent = true
      activeLease = secondLease
      observer.sync()
      observer.sync()

      assertEquals(
        listOf(
          GatewayMethod.SessionsObserverVisibility.rawValue to """{"visible":true}""",
          GatewayMethod.SessionsObserverVisibility.rawValue to """{"visible":false}""",
          GatewayMethod.SessionsObserverVisibility.rawValue to """{"visible":true}""",
          GatewayMethod.SessionsObserverVisibility.rawValue to """{"visible":true}""",
        ),
        requests,
      )
    }

  @Test
  fun disconnectedObserverNeverCreatesARequestOrConnection() =
    runBlocking {
      var captureAttempts = 0
      var visibilityReads = 0
      val observer =
        SessionObserverVisibility(
          isVisible = {
            visibilityReads += 1
            true
          },
          captureLease = {
            captureAttempts += 1
            null
          },
        )

      observer.sync()

      assertEquals(1, captureAttempts)
      assertEquals(0, visibilityReads)
    }

  @Test
  fun lostBackgroundReplyCannotSuppressForegroundRecovery() =
    runBlocking {
      var visible = true
      var loseBackgroundReply = true
      val requests = mutableListOf<Pair<String, String?>>()
      val lease =
        GatewaySession.RequestLease(endpointStableId = "gateway") { method, params, _, withEnqueue ->
          withEnqueue {}
          requests.add(method to params)
          if (params == """{"visible":false}""" && loseBackgroundReply) {
            loseBackgroundReply = false
            throw IllegalStateException("visibility reply lost")
          }
          ""
        }
      val observer =
        SessionObserverVisibility(
          isVisible = { visible },
          captureLease = { lease },
        )

      observer.sync()
      visible = false
      try {
        observer.sync()
        throw AssertionError("The lost background reply must be reported")
      } catch (error: IllegalStateException) {
        assertEquals("visibility reply lost", error.message)
      }
      visible = true
      observer.sync()
      observer.sync()

      assertEquals(
        listOf(
          GatewayMethod.SessionsObserverVisibility.rawValue to """{"visible":true}""",
          GatewayMethod.SessionsObserverVisibility.rawValue to """{"visible":false}""",
          GatewayMethod.SessionsObserverVisibility.rawValue to """{"visible":true}""",
        ),
        requests,
      )
    }
}
