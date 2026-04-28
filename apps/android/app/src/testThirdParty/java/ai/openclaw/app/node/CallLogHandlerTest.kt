package ai.openclaw.app.node

import android.content.Context
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class CallLogHandlerTest : NodeHandlerRobolectricTest() {
  @Test
  fun handleCallLogSearch_requiresPermission() {
    val handler = CallLogHandler.forTesting(appContext(), FakeCallLogDataSource(canRead = false))

    val result = handler.handleCallLogSearch(null)

    assertFalse(result.ok)
    assertEquals("CALL_LOG_PERMISSION_REQUIRED", result.error?.code)
  }

  @Test
  fun handleCallLogSearch_rejectsInvalidJson() {
    val handler = CallLogHandler.forTesting(appContext(), FakeCallLogDataSource(canRead = true))

    val result = handler.handleCallLogSearch("invalid json")

    assertFalse(result.ok)
    assertEquals("INVALID_REQUEST", result.error?.code)
  }

  @Test
  fun handleCallLogSearch_returnsCallLogs() {
    val callLog =
      CallLogRecord(
        number = "+123456",
        cachedName = "lixuankai",
        date = 1709280000000L,
        duration = 60L,
        type = 1,
      )
    val handler =
      CallLogHandler.forTesting(
        appContext(),
        FakeCallLogDataSource(canRead = true, searchResults = listOf(callLog)),
      )

    val result = handler.handleCallLogSearch("""{"limit":1}""")

    assertTrue(result.ok)
    val payload = Json.parseToJsonElement(result.payloadJson ?: error("missing payload")).jsonObject
    val callLogs = payload.getValue("callLogs").jsonArray
    assertEquals(1, callLogs.size)
    assertEquals(
      "+123456",
      callLogs
        .first()
        .jsonObject
        .getValue("number")
        .jsonPrimitive.content,
    )
    assertEquals(
      "lixuankai",
      callLogs
        .first()
        .jsonObject
        .getValue("cachedName")
        .jsonPrimitive.content,
    )
    assertEquals(
      1709280000000L,
      callLogs
        .first()
        .jsonObject
        .getValue("date")
        .jsonPrimitive.content
        .toLong(),
    )
    assertEquals(
      60L,
      callLogs
        .first()
        .jsonObject
        .getValue("duration")
        .jsonPrimitive.content
        .toLong(),
    )
    assertEquals(
      1,
      callLogs
        .first()
        .jsonObject
        .getValue("type")
        .jsonPrimitive.content
        .toInt(),
    )
  }

  @Test
  fun handleCallLogSearch_withFilters() {
    val callLog =
      CallLogRecord(
        number = "+123456",
        cachedName = "lixuankai",
        date = 1709280000000L,
        duration = 120L,
        type = 2,
      )
    val handler =
      CallLogHandler.forTesting(
        appContext(),
        FakeCallLogDataSource(canRead = true, searchResults = listOf(callLog)),
      )

    val result =
      handler.handleCallLogSearch(
        """{"number":"123456","cachedName":"lixuankai","dateStart":1709270000000,"dateEnd":1709290000000,"duration":120,"type":2}""",
      )

    assertTrue(result.ok)
    val payload = Json.parseToJsonElement(result.payloadJson ?: error("missing payload")).jsonObject
    val callLogs = payload.getValue("callLogs").jsonArray
    assertEquals(1, callLogs.size)
    assertEquals(
      "lixuankai",
      callLogs
        .first()
        .jsonObject
        .getValue("cachedName")
        .jsonPrimitive.content,
    )
  }

  @Test
  fun handleCallLogSearch_withPagination() {
    val callLogs =
      listOf(
        CallLogRecord(
          number = "+123456",
          cachedName = "lixuankai",
          date = 1709280000000L,
          duration = 60L,
          type = 1,
        ),
        CallLogRecord(
          number = "+654321",
          cachedName = "lixuankai2",
          date = 1709280001000L,
          duration = 120L,
          type = 2,
        ),
      )
    val handler =
      CallLogHandler.forTesting(
        appContext(),
        FakeCallLogDataSource(canRead = true, searchResults = callLogs),
      )

    val result = handler.handleCallLogSearch("""{"limit":1,"offset":1}""")

    assertTrue(result.ok)
    val payload = Json.parseToJsonElement(result.payloadJson ?: error("missing payload")).jsonObject
    val callLogsResult = payload.getValue("callLogs").jsonArray
    assertEquals(1, callLogsResult.size)
    assertEquals(
      "lixuankai2",
      callLogsResult
        .first()
        .jsonObject
        .getValue("cachedName")
        .jsonPrimitive.content,
    )
  }

  @Test
  fun handleCallLogSearch_withDefaultParams() {
    val callLog =
      CallLogRecord(
        number = "+123456",
        cachedName = "lixuankai",
        date = 1709280000000L,
        duration = 60L,
        type = 1,
      )
    val handler =
      CallLogHandler.forTesting(
        appContext(),
        FakeCallLogDataSource(canRead = true, searchResults = listOf(callLog)),
      )

    val result = handler.handleCallLogSearch(null)

    assertTrue(result.ok)
    val payload = Json.parseToJsonElement(result.payloadJson ?: error("missing payload")).jsonObject
    val callLogs = payload.getValue("callLogs").jsonArray
    assertEquals(1, callLogs.size)
    assertEquals(
      "+123456",
      callLogs
        .first()
        .jsonObject
        .getValue("number")
        .jsonPrimitive.content,
    )
  }

  @Test
  fun handleCallLogSearch_withNullFields() {
    val callLog =
      CallLogRecord(
        number = null,
        cachedName = null,
        date = 1709280000000L,
        duration = 60L,
        type = 1,
      )
    val handler =
      CallLogHandler.forTesting(
        appContext(),
        FakeCallLogDataSource(canRead = true, searchResults = listOf(callLog)),
      )

    val result = handler.handleCallLogSearch("""{"limit":1}""")

    assertTrue(result.ok)
    val payload = Json.parseToJsonElement(result.payloadJson ?: error("missing payload")).jsonObject
    val callLogs = payload.getValue("callLogs").jsonArray
    assertEquals(1, callLogs.size)
    // Verify null values are properly serialized
    val callLogObj = callLogs.first().jsonObject
    assertTrue(callLogObj.containsKey("number"))
    assertTrue(callLogObj.containsKey("cachedName"))
  }

  @Test
  fun handleCallLogSearch_clampsLimitAndOffsetBeforeSearch() {
    val source = FakeCallLogDataSource(canRead = true)
    val handler = CallLogHandler.forTesting(appContext(), source)

    val result = handler.handleCallLogSearch("""{"limit":999,"offset":-5}""")

    assertTrue(result.ok)
    assertEquals(200, source.lastRequest?.limit)
    assertEquals(0, source.lastRequest?.offset)
  }

  @Test
  fun handleCallLogSearch_mapsSearchFailuresToUnavailable() {
    val handler =
      CallLogHandler.forTesting(
        appContext(),
        FakeCallLogDataSource(
          canRead = true,
          failure = IllegalStateException("provider down"),
        ),
      )

    val result = handler.handleCallLogSearch(null)

    assertFalse(result.ok)
    assertEquals("CALL_LOG_UNAVAILABLE", result.error?.code)
    assertEquals("CALL_LOG_UNAVAILABLE: provider down", result.error?.message)
  }
}

private class FakeCallLogDataSource(
  private val canRead: Boolean,
  private val searchResults: List<CallLogRecord> = emptyList(),
  private val failure: Throwable? = null,
) : CallLogDataSource {
  var lastRequest: CallLogSearchRequest? = null

  override fun hasReadPermission(context: Context): Boolean = canRead

  override fun search(
    context: Context,
    request: CallLogSearchRequest,
  ): List<CallLogRecord> {
    lastRequest = request
    failure?.let { throw it }
    val startIndex = request.offset.coerceAtLeast(0)
    val endIndex = (startIndex + request.limit).coerceAtMost(searchResults.size)
    return if (startIndex < searchResults.size) {
      searchResults.subList(startIndex, endIndex)
    } else {
      emptyList()
    }
  }
}
