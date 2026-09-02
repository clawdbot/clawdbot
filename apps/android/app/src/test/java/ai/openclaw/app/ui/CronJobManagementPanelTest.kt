package ai.openclaw.app.ui

import ai.openclaw.app.GatewayCronRunSummary
import org.junit.Assert.assertEquals
import org.junit.Test

class CronJobManagementPanelTest {
  @Test
  fun deliveryStatusLabelsCoverClosedCodesAndPreserveFutureCodes() {
    val expected =
      mapOf(
        "delivered" to "Delivered",
        "not-delivered" to "Not delivered",
        "unknown" to "Unknown",
        "not-requested" to "Not requested",
        "future-status" to "future-status",
      )

    expected.forEach { (status, label) ->
      assertEquals(label, cronDeliveryStatusLabel(status))
    }
  }

  @Test
  fun runSubtitleUsesTheDeliveryStatusPresentation() {
    val run =
      GatewayCronRunSummary(
        ts = 0,
        runId = "run-1",
        status = "ok",
        summary = "Complete",
        error = null,
        durationMs = 125,
        deliveryStatus = "not-delivered",
        sessionKey = null,
        model = "openai/gpt-5.6",
      )

    assertEquals(
      "125ms · Not delivered · openai/gpt-5.6 · Complete",
      cronRunSubtitle(run),
    )
    assertEquals(
      "125ms · future-status · openai/gpt-5.6 · Complete",
      cronRunSubtitle(run.copy(deliveryStatus = "future-status")),
    )
  }
}
