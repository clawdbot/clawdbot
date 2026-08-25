package ai.openclaw.app.node

import android.Manifest
import android.app.Application
import android.content.ContentProvider
import android.content.ContentUris
import android.content.ContentValues
import android.content.Context
import android.database.Cursor
import android.database.sqlite.SQLiteDatabase
import android.net.Uri
import android.provider.CalendarContract
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import org.robolectric.Shadows.shadowOf
import org.robolectric.shadows.ShadowContentResolver
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
  fun handleCalendarAdd_omitsExplicitJsonNullFields() {
    val source = FakeCalendarDataSource(canRead = true, canWrite = true)
    val handler = CalendarHandler.forTesting(appContext(), source)

    val result =
      handler.handleCalendarAdd(
        """
        {"title":"Standup","startISO":"2026-02-28T10:00:00Z","endISO":"2026-02-28T11:00:00Z",
         "location":null,"notes":null,"calendarTitle":null,"calendarId":null,"isAllDay":null}
        """.trimIndent(),
      )

    assertTrue(result.ok)
    val request = source.addedRequest ?: error("missing add request")
    assertEquals("Standup", request.title)
    assertNull(request.location)
    assertNull(request.notes)
    assertNull(request.calendarTitle)
    assertNull(request.calendarId)
    assertFalse(request.isAllDay)
  }

  @Test
  fun handleCalendarAdd_rejectsExplicitJsonNullTitle() {
    val source = FakeCalendarDataSource(canRead = true, canWrite = true)
    val handler = CalendarHandler.forTesting(appContext(), source)

    val result =
      handler.handleCalendarAdd(
        """{"title":null,"startISO":"2026-02-28T10:00:00Z","endISO":"2026-02-28T11:00:00Z"}""",
      )

    assertFalse(result.ok)
    assertEquals("CALENDAR_INVALID", result.error?.code)
    assertNull(source.addedRequest)
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
  fun handleCalendarAdd_choosesWritableCalendarOverReadOnlyPrimary() {
    val provider =
      registerCalendarProvider(
        TestCalendar(id = 11, title = "Subscribed", primary = true, access = CalendarContract.Calendars.CAL_ACCESS_READ),
        TestCalendar(id = 22, title = "Writable", primary = false, access = CalendarContract.Calendars.CAL_ACCESS_CONTRIBUTOR),
      )

    val result = CalendarHandler(appContext()).handleCalendarAdd(calendarAddParams())

    assertTrue(result.ok)
    assertEquals(22L, provider.insertedCalendarId)
  }

  @Test
  fun handleCalendarAdd_returnsNotFoundWhenOnlyVisibleCalendarIsReadOnly() {
    val provider =
      registerCalendarProvider(
        TestCalendar(id = 11, title = "Subscribed", primary = true, access = CalendarContract.Calendars.CAL_ACCESS_READ),
      )

    val result = CalendarHandler(appContext()).handleCalendarAdd(calendarAddParams())

    assertFalse(result.ok)
    assertEquals("CALENDAR_NOT_FOUND", result.error?.code)
    assertNull(provider.insertedCalendarId)
  }

  @Test
  fun handleCalendarAdd_preservesWritablePrimaryPreference() {
    val provider =
      registerCalendarProvider(
        TestCalendar(id = 11, title = "Primary", primary = true, access = CalendarContract.Calendars.CAL_ACCESS_OWNER),
        TestCalendar(id = 22, title = "Other", primary = false, access = CalendarContract.Calendars.CAL_ACCESS_CONTRIBUTOR),
      )

    val result = CalendarHandler(appContext()).handleCalendarAdd(calendarAddParams())

    assertTrue(result.ok)
    assertEquals(11L, provider.insertedCalendarId)
  }

  @Test
  fun handleCalendarAdd_preservesExplicitReadOnlyCalendarSelection() {
    val provider =
      registerCalendarProvider(
        TestCalendar(id = 11, title = "Subscribed", primary = true, access = CalendarContract.Calendars.CAL_ACCESS_READ),
        TestCalendar(id = 22, title = "Writable", primary = false, access = CalendarContract.Calendars.CAL_ACCESS_OWNER),
      )

    val byId = CalendarHandler(appContext()).handleCalendarAdd(calendarAddParams("\"calendarId\":11"))
    assertTrue(byId.ok)
    assertEquals(11L, provider.insertedCalendarId)

    val byTitle = CalendarHandler(appContext()).handleCalendarAdd(calendarAddParams("\"calendarTitle\":\"Subscribed\""))
    assertTrue(byTitle.ok)
    assertEquals(11L, provider.insertedCalendarId)
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

  private fun registerCalendarProvider(vararg calendars: TestCalendar): TestCalendarProvider {
    val app = appContext() as Application
    shadowOf(app).grantPermissions(Manifest.permission.READ_CALENDAR, Manifest.permission.WRITE_CALENDAR)
    return TestCalendarProvider(calendars.toList()).also { provider ->
      ShadowContentResolver.registerProviderInternal(CalendarContract.AUTHORITY, provider)
    }
  }

  private fun calendarAddParams(extra: String? = null): String = """{"title":"Meeting","startISO":"2026-07-05T09:00:00Z","endISO":"2026-07-05T10:00:00Z"${extra?.let { ",$it" }.orEmpty()}}"""
}

private data class TestCalendar(
  val id: Long,
  val title: String,
  val primary: Boolean,
  val access: Int,
)

private class TestCalendarProvider(
  calendars: List<TestCalendar>,
) : ContentProvider() {
  private val database =
    SQLiteDatabase.create(null).apply {
      execSQL(
        "CREATE TABLE calendars (_id INTEGER PRIMARY KEY, calendar_displayName TEXT, visible INTEGER, " +
          "isPrimary INTEGER, calendar_access_level INTEGER)",
      )
      execSQL(
        "CREATE TABLE events (_id INTEGER PRIMARY KEY AUTOINCREMENT, calendar_id INTEGER, title TEXT, " +
          "dtstart INTEGER, dtend INTEGER, allDay INTEGER, eventTimezone TEXT, eventLocation TEXT, " +
          "description TEXT, calendar_displayName TEXT)",
      )
      for (calendar in calendars) {
        insert(
          "calendars",
          null,
          ContentValues().apply {
            put(CalendarContract.Calendars._ID, calendar.id)
            put(CalendarContract.Calendars.CALENDAR_DISPLAY_NAME, calendar.title)
            put(CalendarContract.Calendars.VISIBLE, 1)
            put(CalendarContract.Calendars.IS_PRIMARY, if (calendar.primary) 1 else 0)
            put(CalendarContract.Calendars.CALENDAR_ACCESS_LEVEL, calendar.access)
          },
        )
      }
    }

  var insertedCalendarId: Long? = null
    private set

  override fun onCreate(): Boolean = true

  override fun query(
    uri: Uri,
    projection: Array<out String>?,
    selection: String?,
    selectionArgs: Array<out String>?,
    sortOrder: String?,
  ): Cursor = database.query(uri.pathSegments.first(), projection, selection, selectionArgs, null, null, sortOrder)

  override fun insert(
    uri: Uri,
    values: ContentValues?,
  ): Uri {
    val event = ContentValues(requireNotNull(values))
    val calendarId = event.getAsLong(CalendarContract.Events.CALENDAR_ID)
    insertedCalendarId = calendarId
    database
      .query(
        "calendars",
        arrayOf(CalendarContract.Calendars.CALENDAR_DISPLAY_NAME),
        "${CalendarContract.Calendars._ID}=?",
        arrayOf(calendarId.toString()),
        null,
        null,
        null,
      ).use { cursor ->
        if (cursor.moveToFirst()) event.put(CalendarContract.Events.CALENDAR_DISPLAY_NAME, cursor.getString(0))
      }
    val eventId = database.insertOrThrow("events", null, event)
    return ContentUris.withAppendedId(uri, eventId)
  }

  override fun delete(
    uri: Uri,
    selection: String?,
    selectionArgs: Array<out String>?,
  ): Int = 0

  override fun update(
    uri: Uri,
    values: ContentValues?,
    selection: String?,
    selectionArgs: Array<out String>?,
  ): Int = 0

  override fun getType(uri: Uri): String? = null
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
