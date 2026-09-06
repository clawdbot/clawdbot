package ai.openclaw.app.gateway

import kotlinx.coroutines.runBlocking
import okhttp3.OkHttpClient
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class GatewayRealtimeOfferTest {
  @Test
  fun exchangesBoundedSdpUsingOnlyTheOfferCapability() =
    runBlocking {
      MockWebServer().use { server ->
        server.enqueue(MockResponse().setBody("v=0\r\nanswer"))
        val route = GatewayRealtimeOffer(server.url("/offer").toString(), OkHttpClient(), emptyMap()) { true }
        assertEquals("v=0\r\nanswer", route.exchange("synthetic-offer-capability", emptyMap(), "v=0\r\noffer"))
        val request = server.takeRequest()
        assertEquals("Bearer synthetic-offer-capability", request.getHeader("Authorization"))
        assertEquals("application/sdp; charset=utf-8", request.getHeader("Content-Type"))
        assertEquals("v=0\r\noffer", request.body.readUtf8())
      }
    }

  @Test
  fun rejectsRedirectsAndOversizedAnswersWithoutEchoingBodies() =
    runBlocking {
      for (response in listOf(
        MockResponse().setResponseCode(302).setHeader("Location", "https://example.invalid/offer"),
        MockResponse().setBody("v=0" + "x".repeat(262_144)),
        MockResponse().setResponseCode(401).setBody("synthetic-sensitive-provider-detail"),
      )) {
        MockWebServer().use { server ->
          server.enqueue(response)
          val route = GatewayRealtimeOffer(server.url("/offer").toString(), OkHttpClient(), emptyMap()) { true }
          val failure = runCatching { route.exchange("synthetic-offer-capability", emptyMap(), "v=0") }.exceptionOrNull()
          assertTrue(failure != null)
          assertFalse(failure?.message.orEmpty().contains("synthetic-sensitive"))
          assertEquals(1, server.requestCount)
        }
      }
    }

  @Test
  fun rejectsRetiredConnectionBeforeSendingAnOffer() =
    runBlocking {
      MockWebServer().use { server ->
        val route = GatewayRealtimeOffer(server.url("/offer").toString(), OkHttpClient(), emptyMap()) { false }
        assertTrue(runCatching { route.exchange("synthetic-offer-capability", emptyMap(), "v=0") }.isFailure)
        assertEquals(0, server.requestCount)
      }
    }
}
