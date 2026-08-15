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
import java.time.Instant
import java.util.TimeZone

class CalendarHandlerTest : NodeHandlerRobolectricTest() {
  @Test
  fun handleCalendarEvents_requiresPermission() {
    val handler = CalendarHandler.forTesting(appContext(), FakeCalendarDataSource(canRead = false))

    val result = handler.handleCalendarEvents(null)

    assertFalse(result.ok)
    assertEquals("CALENDAR_PERMISSION_REQUIRED", result.error?.code)
  }

  @Test
  fun handleCalendarAdd_rejectsEndBeforeStart() {
    val handler = CalendarHandler.forTesting(appContext(), FakeCalendarDataSource(canRead = true, canWrite = true))

    val result =
      handler.handleCalendarAdd(
        """{"title":"Standup","startISO":"2026-02-28T10:00:00Z","endISO":"2026-02-28T09:00:00Z"}""",
      )

    assertFalse(result.ok)
    assertEquals("CALENDAR_INVALID", result.error?.code)
  }

  @Test
  fun handleCalendarEvents_returnsEvents() {
    val event =
      CalendarEventRecord(
        identifier = "101",
        title = "Sprint Planning",
        startISO = "2026-02-28T10:00:00Z",
        endISO = "2026-02-28T11:00:00Z",
        isAllDay = false,
        location = "Room 1",
        calendarTitle = "Work",
      )
    val handler =
      CalendarHandler.forTesting(
        appContext(),
        FakeCalendarDataSource(canRead = true, events = listOf(event)),
      )

    val result = handler.handleCalendarEvents("""{"limit":1}""")

    assertTrue(result.ok)
    val payload = Json.parseToJsonElement(result.payloadJson ?: error("missing payload")).jsonObject
    val events = payload.getValue("events").jsonArray
    assertEquals(1, events.size)
    assertEquals(
      "Sprint Planning",
      events
        .first()
        .jsonObject
        .getValue("title")
        .jsonPrimitive.content,
    )
  }

  @Test
  fun handleCalendarAdd_mapsNotFoundErrorCode() {
    val source =
      FakeCalendarDataSource(
        canRead = true,
        canWrite = true,
        addError = IllegalArgumentException("CALENDAR_NOT_FOUND: no default calendar"),
      )
    val handler = CalendarHandler.forTesting(appContext(), source)

    val result =
      handler.handleCalendarAdd(
        """{"title":"Call","startISO":"2026-02-28T10:00:00Z","endISO":"2026-02-28T11:00:00Z"}""",
      )

    assertFalse(result.ok)
    assertEquals("CALENDAR_NOT_FOUND", result.error?.code)
  }

  @Test
  fun handleCalendarAdd_normalizesAllDayEventForAndroidProvider() {
    val source = FakeCalendarDataSource(canRead = true, canWrite = true)
    val handler = CalendarHandler.forTesting(appContext(), source)

    val result =
      handler.handleCalendarAdd(
        """{"title":"Holiday","startISO":"2026-07-05T09:00:00Z","endISO":"2026-07-06T09:00:00Z","isAllDay":true}""",
      )

    assertTrue(result.ok)
    val request = source.addedRequest ?: error("missing add request")
    assertTrue(request.isAllDay)
    assertEquals("UTC", request.timeZoneId)
    assertEquals(Instant.parse("2026-07-05T00:00:00Z").toEpochMilli(), request.startMs)
    assertEquals(Instant.parse("2026-07-06T00:00:00Z").toEpochMilli(), request.endMs)
  }

  @Test
  fun handleCalendarAdd_expandsSameDayAllDayRangeToOneDay() {
    val source = FakeCalendarDataSource(canRead = true, canWrite = true)
    val handler = CalendarHandler.forTesting(appContext(), source)

    val result =
      handler.handleCalendarAdd(
        """{"title":"Holiday","startISO":"2026-07-05T09:00:00Z","endISO":"2026-07-05T17:00:00Z","isAllDay":true}""",
      )

    assertTrue(result.ok)
    val request = source.addedRequest ?: error("missing add request")
    assertEquals(Instant.parse("2026-07-05T00:00:00Z").toEpochMilli(), request.startMs)
    assertEquals(Instant.parse("2026-07-06T00:00:00Z").toEpochMilli(), request.endMs)
  }

  @Test
  fun handleCalendarAdd_preservesTimedInstantsAndDeviceTimezone() {
    val source = FakeCalendarDataSource(canRead = true, canWrite = true)
    val handler = CalendarHandler.forTesting(appContext(), source)

    val result =
      handler.handleCalendarAdd(
        """{"title":"Call","startISO":"2026-07-05T09:15:00Z","endISO":"2026-07-05T10:45:00Z"}""",
      )

    assertTrue(result.ok)
    val request = source.addedRequest ?: error("missing add request")
    assertFalse(request.isAllDay)
    assertEquals(TimeZone.getDefault().id, request.timeZoneId)
    assertEquals(Instant.parse("2026-07-05T09:15:00Z").toEpochMilli(), request.startMs)
    assertEquals(Instant.parse("2026-07-05T10:45:00Z").toEpochMilli(), request.endMs)
  }
}

private class FakeCalendarDataSource(
  private val canRead: Boolean,
  private val canWrite: Boolean = false,
  private val events: List<CalendarEventRecord> = emptyList(),
  private val addResult: CalendarEventRecord =
    CalendarEventRecord(
      identifier = "0",
      title = "Default",
      startISO = "2026-01-01T00:00:00Z",
      endISO = "2026-01-01T01:00:00Z",
      isAllDay = false,
      location = null,
      calendarTitle = null,
    ),
  private val addError: Throwable? = null,
) : CalendarDataSource {
  var addedRequest: CalendarAddRequest? = null
    private set

  override fun hasReadPermission(context: Context): Boolean = canRead

  override fun hasWritePermission(context: Context): Boolean = canWrite

  override fun events(
    context: Context,
    request: CalendarEventsRequest,
  ): List<CalendarEventRecord> = events

  override fun add(
    context: Context,
    request: CalendarAddRequest,
  ): CalendarEventRecord {
    addError?.let { throw it }
    addedRequest = request
    return addResult
  }
}
