package ai.openclaw.app

import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class CronJobStatusParsingTest {
  @Test
  fun cronJobLastRunStatusReadsGatewayLastStatus() {
    val state =
      buildJsonObject {
        put("lastStatus", JsonPrimitive(" error "))
        put("lastRunStatus", JsonPrimitive("success"))
      }

    assertEquals("error", cronJobLastRunStatus(state))
  }

  @Test
  fun cronJobLastRunStatusReadsLastRunStatus() {
    val state =
      buildJsonObject {
        put("lastRunStatus", JsonPrimitive("error"))
      }

    assertEquals("error", cronJobLastRunStatus(state))
  }

  @Test
  fun cronJobLastRunStatusIgnoresEmptyStatus() {
    val state =
      buildJsonObject {
        put("lastStatus", JsonPrimitive(" "))
      }

    assertNull(cronJobLastRunStatus(state))
  }
}
