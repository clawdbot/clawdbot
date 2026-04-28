package ai.openclaw.app.voice

import ai.openclaw.app.gateway.GatewayConnectErrorDetails
import ai.openclaw.app.gateway.GatewaySession
import kotlinx.coroutines.test.runTest
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class TalkSpeakClientTest {
  @Test
  fun buildsRequestFromDirective() {
    val request =
      TalkSpeakRequest.from(
        text = "Hello from talk mode.",
        directive =
          TalkDirective(
            voiceId = "voice-123",
            modelId = "model-abc",
            speed = 1.1,
            rateWpm = 190,
            stability = 0.5,
            similarity = 0.7,
            style = 0.2,
            speakerBoost = true,
            seed = 42,
            normalize = "auto",
            language = "en",
            outputFormat = "pcm_24000",
            latencyTier = 3,
            once = true,
          ),
      )

    assertEquals("Hello from talk mode.", request.text)
    assertEquals("voice-123", request.voiceId)
    assertEquals("model-abc", request.modelId)
    assertEquals(1.1, request.speed)
    assertEquals(190, request.rateWpm)
    assertEquals(0.5, request.stability)
    assertEquals(0.7, request.similarity)
    assertEquals(0.2, request.style)
    assertEquals(true, request.speakerBoost)
    assertEquals(42L, request.seed)
    assertEquals("auto", request.normalize)
    assertEquals("en", request.language)
    assertEquals("pcm_24000", request.outputFormat)
    assertEquals(3, request.latencyTier)
  }

  @Test
  fun fallsBackOnlyForUnavailableReasons() =
    runTest {
      val client =
        TalkSpeakClient(
          requestDetailed = { _, _, _ ->
            GatewaySession.RpcResult(
              ok = false,
              payloadJson = null,
              error =
                GatewaySession.ErrorShape(
                  code = "UNAVAILABLE",
                  message = "talk unavailable",
                  details =
                    GatewayConnectErrorDetails(
                      code = null,
                      canRetryWithDeviceToken = false,
                      recommendedNextStep = null,
                      reason = "talk_unconfigured",
                    ),
                ),
            )
          },
        )

      val result = client.synthesize(text = "Hello", directive = null)
      assertTrue(result is TalkSpeakResult.FallbackToLocal)
    }

  @Test
  fun doesNotFallBackForSynthesisFailure() =
    runTest {
      val client =
        TalkSpeakClient(
          requestDetailed = { _, _, _ ->
            GatewaySession.RpcResult(
              ok = false,
              payloadJson = null,
              error =
                GatewaySession.ErrorShape(
                  code = "UNAVAILABLE",
                  message = "provider failed",
                  details =
                    GatewayConnectErrorDetails(
                      code = null,
                      canRetryWithDeviceToken = false,
                      recommendedNextStep = null,
                      reason = "synthesis_failed",
                    ),
                ),
            )
          },
        )

      val result = client.synthesize(text = "Hello", directive = null)
      assertTrue(result is TalkSpeakResult.Failure)
    }

  @Test
  fun fallsBackWhenGatewayOmitsReason() =
    runTest {
      val client =
        TalkSpeakClient(
          requestDetailed = { _, _, _ ->
            GatewaySession.RpcResult(
              ok = false,
              payloadJson = null,
              error =
                GatewaySession.ErrorShape(
                  code = "INVALID_REQUEST",
                  message = "unknown method: talk.speak",
                  details = null,
                ),
            )
          },
        )

      val result = client.synthesize(text = "Hello", directive = null)
      assertTrue(result is TalkSpeakResult.FallbackToLocal)
    }
}
