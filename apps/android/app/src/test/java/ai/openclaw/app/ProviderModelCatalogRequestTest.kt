package ai.openclaw.app

import ai.openclaw.app.gateway.GatewayRequestRejected
import ai.openclaw.app.gateway.GatewaySession
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.jsonArray
import org.junit.Assert.assertEquals
import org.junit.Assert.assertSame
import org.junit.Assert.assertTrue
import org.junit.Test

class ProviderModelCatalogRequestTest {
  @Test
  fun prefersEffectiveContextCapOverNativeWindow() {
    val models =
      parseGatewayModels(
        Json
          .parseToJsonElement(
            """[{"id":"model","name":"Model","provider":"example","contextWindow":128000,"contextTokens":96000}]""",
          ).jsonArray,
      )

    assertEquals(96_000L, models.single().contextTokens)
  }

  @Test
  fun reportsProviderConfigUnsupportedWithoutSubstitutingConfiguredView() =
    runBlocking {
      val requests = mutableListOf<String>()
      var actual: Throwable? = null

      try {
        requestProviderModelConfig { paramsJson ->
          requests += paramsJson
          throw GatewayRequestRejected(GatewaySession.ErrorShape("INVALID_REQUEST", "unsupported view"))
        }
      } catch (err: Throwable) {
        actual = err
      }

      assertTrue(actual is ProviderModelConfigUnsupported)
      assertEquals(listOf("""{"view":"provider-config"}"""), requests)
    }

  @Test
  fun preservesNonCompatibilityGatewayFailures() =
    runBlocking {
      val expected = GatewayRequestRejected(GatewaySession.ErrorShape("UNAVAILABLE", "gateway busy"))
      var actual: Throwable? = null

      try {
        requestProviderModelConfig { throw expected }
      } catch (err: Throwable) {
        actual = err
      }

      assertSame(expected, actual)
    }
}
