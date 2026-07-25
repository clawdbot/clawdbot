package ai.openclaw.app

import ai.openclaw.app.i18n.resolveNativeText
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class CronJobDetailTest {
  @Test
  fun parsesFullGatewayCronJob() {
    val detail = parseGatewayCronJobDetail(parseJob())

    requireNotNull(detail)
    assertEquals("job-1", detail.id)
    assertEquals("Daily report", detail.name)
    assertEquals("sha256:fixture", detail.configRevision)
    assertEquals("cron", detail.scheduleKind)
    assertEquals("0 9 * * *", detail.scheduleLabel.resolveNativeText())
    assertEquals("0 9 * * * · Europe/Vienna · Stagger Every 5m", detail.scheduleDetail.resolveNativeText())
    assertEquals("0 9 * * *", detail.scheduleCronExpr)
    assertEquals("Europe/Vienna", detail.scheduleTimezone)
    assertEquals(300000L, detail.scheduleStaggerMs)
    assertEquals("Agent turn · openai/gpt-5.5 · Thinking high", detail.payloadLabel.resolveNativeText())
    assertEquals("Summarize the day", detail.payloadText)
    assertEquals("openai/gpt-5.5", detail.payloadModel)
    assertEquals("high", detail.payloadThinking)
    assertEquals("Announce · telegram · chat-42 · Account primary", detail.deliveryLabel.resolveNativeText())
    assertEquals("After 3 · Announce · telegram · ops · Cooldown Every 1h", detail.failureAlertLabel.resolveNativeText())
    assertEquals(2L, detail.consecutiveErrors)
    assertEquals("error", detail.lastRunStatus)
  }

  @Test
  fun commandDetailsDoNotExposeEnvironmentValues() {
    val job =
      parseJob(
        payload =
          """{"kind":"command","argv":["printf","done"],"env":{"API_TOKEN":"secret-value"}}""",
      )

    val detail = parseGatewayCronJobDetail(job)

    requireNotNull(detail)
    assertEquals("printf done", detail.payloadText)
    assertEquals(listOf("printf", "done"), detail.payloadCommandArgv)
    assertFalse(detail.payloadText.orEmpty().contains("secret-value"))
  }

  @Test
  fun parsesScriptPayloadAsReadOnlyDetail() {
    val script = "const result = await agent('check status')"
    val detail =
      parseGatewayCronJobDetail(
        parseJob(
          payload =
            """{"kind":"script","script":"$script","timeoutSeconds":90,"toolBudget":4}""",
        ),
      )

    requireNotNull(detail)
    assertEquals("script", detail.payloadKind)
    assertEquals(script, detail.payloadText)
    assertEquals("Script · Timeout 90s · 4 tools", detail.payloadLabel.resolveNativeText())
    assertNull(detail.payloadCommandArgv)
  }

  @Test
  fun rejectsIncompleteGatewayCronJob() {
    val incomplete = Json.parseToJsonElement("""{"id":"job-1","name":"Missing fields"}""").jsonObject

    assertNull(parseGatewayCronJobDetail(incomplete))
  }

  @Test
  fun encodesCronGetIdAsJson() {
    val encoded = Json.parseToJsonElement(cronJobGetParams("job-\"quoted\\path")).jsonObject

    assertEquals("job-\"quoted\\path", encoded.getValue("id").jsonPrimitive.content)
  }

  @Test
  fun requestGuardRejectsOlderSelectionAndCancellation() {
    val guard = CronJobDetailRequestGuard()
    val first = requireNotNull(guard.begin(" job-1 "))
    val second = requireNotNull(guard.begin("job-2"))
    var published = "none"

    assertEquals("job-1", first.id)
    assertFalse(guard.publishIfCurrent(first) { published = first.id })
    assertTrue(guard.publishIfCurrent(second) { published = second.id })
    assertEquals("job-2", published)

    guard.cancel()
    assertFalse(guard.publishIfCurrent(second) { published = "stale" })
    assertEquals("job-2", published)
    assertNull(guard.begin("   "))
  }

  @Test
  fun requestGuardConditionsReloadAndCancellationOnCurrentSelection() {
    val guard = CronJobDetailRequestGuard()
    requireNotNull(guard.begin("job-a"))
    requireNotNull(guard.begin("job-b"))
    var loadingId = "none"
    var cancelled = false

    assertNull(guard.beginIfCurrent("job-a") { loadingId = it.id })
    val reload = guard.beginIfCurrent("job-b") { loadingId = it.id }
    assertEquals("job-b", reload?.id)
    assertEquals("job-b", loadingId)
    assertFalse(guard.cancelIfCurrent("job-a") { cancelled = true })
    assertFalse(cancelled)
    assertTrue(guard.cancelIfCurrent("job-b") { cancelled = true })
    assertTrue(cancelled)
  }

  private fun parseJob(
    payload: String =
      """{"kind":"agentTurn","message":"Summarize the day","model":"openai/gpt-5.5","thinking":"high"}""",
  ): JsonObject =
    Json
      .parseToJsonElement(
        """
        {
          "id": "job-1",
          "name": "Daily report",
          "description": "Daily digest",
          "enabled": true,
          "deleteAfterRun": false,
          "createdAtMs": 1000,
          "updatedAtMs": 2000,
          "configRevision": "sha256:fixture",
          "schedule": {"kind":"cron","expr":"0 9 * * *","tz":"Europe/Vienna","staggerMs":300000},
          "sessionTarget": "isolated",
          "wakeMode": "now",
          "payload": $payload,
          "delivery": {"mode":"announce","channel":"telegram","to":"chat-42","accountId":"primary"},
          "failureAlert": {"after":3,"mode":"announce","channel":"telegram","to":"ops","cooldownMs":3600000},
          "state": {
            "nextRunAtMs": 3000,
            "lastRunAtMs": 2500,
            "lastRunStatus": "error",
            "lastError": "boom",
            "lastDurationMs": 500,
            "consecutiveErrors": 2,
            "consecutiveSkipped": 1,
            "lastDeliveryStatus": "not-delivered",
            "lastDeliveryError": "offline"
          }
        }
        """.trimIndent(),
      ).jsonObject
}
