package ai.openclaw.app.gateway

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class GatewayErrorDetailsTest {
  @Test
  fun readsStructuredMissingScopeWithoutMessageParsing() {
    val error =
      GatewaySession.ErrorShape(
        code = "FORBIDDEN",
        message = "permission denied",
        details =
          GatewayErrorDetails(
            code = "MISSING_SCOPE",
            missingScope = "operator.questions",
            requiredScopes = listOf("operator.read", "operator.questions"),
            canRetryWithDeviceToken = false,
            recommendedNextStep = null,
          ),
      )

    assertEquals("operator.questions", error.missingScope())
    assertEquals(
      GatewayMissingScopeErrorDetails(
        missingScope = "operator.questions",
        requiredScopes = listOf("operator.read", "operator.questions"),
      ),
      error.missingScopeDetails(),
    )
  }

  @Test
  fun legacyFallbackRequiresAnAuthorizationErrorCode() {
    assertEquals(
      "operator.read",
      GatewaySession
        .ErrorShape(
          code = "INVALID_REQUEST",
          message = "missing scope: operator.read",
        ).missingScope(),
    )
    assertNull(
      GatewaySession
        .ErrorShape(
          code = "UNAVAILABLE",
          message = "missing scope: operator.read",
        ).missingScope(),
    )
  }
}
