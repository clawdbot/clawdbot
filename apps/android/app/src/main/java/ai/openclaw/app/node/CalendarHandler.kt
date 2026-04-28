package ai.openclaw.app.node

import ai.openclaw.app.gateway.GatewaySession
import android.Manifest
import android.content.ContentResolver
import android.content.ContentUris
import android.content.ContentValues
import android.content.Context
import android.provider.CalendarContract
import androidx.core.content.ContextCompat
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonArray
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import java.time.Instant
import java.time.temporal.ChronoUnit
import java.util.TimeZone

private const val DEFAULT_CALENDAR_LIMIT = 50

internal data class CalendarEventsRequest(
  val startMs: Long,
  val endMs: Long,
  val limit: Int,
)

internal data class CalendarAddRequest(
  val title: String,
  val startMs: Long,
  val endMs: Long,
  val isAllDay: Boolean,
  val location: String?,
  val notes: String?,
  val calendarId: Long?,
  val calendarTitle: String?,
)

internal data class CalendarEventRecord(
  val identifier: String,
  val title: String,
  val startISO: String,
  val endISO: String,
  val isAllDay: Boolean,
  val location: String?,
  val calendarTitle: String?,
)

internal interface CalendarDataSource {
  fun hasReadPermission(context: Context): Boolean

  fun hasWritePermission(context: Context): Boolean

  fun events(
    context: Context,
    request: CalendarEventsRequest,
  ): List<CalendarEventRecord>

  fun add(
    context: Context,
    request: CalendarAddRequest,
  ): CalendarEventRecord
}

private object SystemCalendarDataSource : CalendarDataSource {
  override fun hasReadPermission(context: Context): Boolean =
    ContextCompat.checkSelfPermission(context, Manifest.permission.READ_CALENDAR) ==
      android.content.pm.PackageManager.PERMISSION_GRANTED

  override fun hasWritePermission(context: Context): Boolean =
    ContextCompat.checkSelfPermission(context, Manifest.permission.WRITE_CALENDAR) ==
      android.content.pm.PackageManager.PERMISSION_GRANTED

  override fun events(
    context: Context,
    request: CalendarEventsRequest,
  ): List<CalendarEventRecord> {
    val resolver = context.contentResolver
    val builder = CalendarContract.Instances.CONTENT_URI.buildUpon()
    ContentUris.appendId(builder, request.startMs)
    ContentUris.appendId(builder, request.endMs)
    val projection =
      arrayOf(
        CalendarContract.Instances.EVENT_ID,
        CalendarContract.Instances.TITLE,
        CalendarContract.Instances.BEGIN,
        CalendarContract.Instances.END,
        CalendarContract.Instances.ALL_DAY,
        CalendarContract.Instances.EVENT_LOCATION,
        CalendarContract.Instances.CALENDAR_DISPLAY_NAME,
      )
    val sortOrder = "${CalendarContract.Instances.BEGIN} ASC LIMIT ${request.limit}"
    resolver.query(builder.build(), projection, null, null, sortOrder).use { cursor ->
      if (cursor == null) return emptyList()
      val out = mutableListOf<CalendarEventRecord>()
      while (cursor.moveToNext() && out.size < request.limit) {
        val id = cursor.getLong(0)
        val title =
          cursor
            .getString(1)
            ?.trim()
            .orEmpty()
            .ifEmpty { "(untitled)" }
        val beginMs = cursor.getLong(2)
        val endMs = cursor.getLong(3)
        val isAllDay = cursor.getInt(4) == 1
        val location = cursor.getString(5)?.trim()?.ifEmpty { null }
        val calendarTitle = cursor.getString(6)?.trim()?.ifEmpty { null }
        out +=
          CalendarEventRecord(
            identifier = id.toString(),
            title = title,
            startISO = Instant.ofEpochMilli(beginMs).toString(),
            endISO = Instant.ofEpochMilli(endMs).toString(),
            isAllDay = isAllDay,
            location = location,
            calendarTitle = calendarTitle,
          )
      }
      return out
    }
  }

  override fun add(
    context: Context,
    request: CalendarAddRequest,
  ): CalendarEventRecord {
    val resolver = context.contentResolver
    val resolvedCalendarId = resolveCalendarId(resolver, request.calendarId, request.calendarTitle)
    val values =
      ContentValues().apply {
        put(CalendarContract.Events.CALENDAR_ID, resolvedCalendarId)
        put(CalendarContract.Events.TITLE, request.title)
        put(CalendarContract.Events.DTSTART, request.startMs)
        put(CalendarContract.Events.DTEND, request.endMs)
        put(CalendarContract.Events.ALL_DAY, if (request.isAllDay) 1 else 0)
        put(CalendarContract.Events.EVENT_TIMEZONE, TimeZone.getDefault().id)
        request.location?.let { put(CalendarContract.Events.EVENT_LOCATION, it) }
        request.notes?.let { put(CalendarContract.Events.DESCRIPTION, it) }
      }
    val uri =
      resolver.insert(CalendarContract.Events.CONTENT_URI, values)
        ?: throw IllegalStateException("calendar insert failed")
    val eventId =
      uri.lastPathSegment?.toLongOrNull()
        ?: throw IllegalStateException("calendar insert failed")
    return loadEventById(resolver, eventId)
      ?: throw IllegalStateException("calendar insert failed")
  }

  private fun resolveCalendarId(
    resolver: ContentResolver,
    calendarId: Long?,
    calendarTitle: String?,
  ): Long {
    if (calendarId != null) {
      if (calendarExists(resolver, calendarId)) return calendarId
      throw IllegalArgumentException("CALENDAR_NOT_FOUND: no calendar id $calendarId")
    }
    if (!calendarTitle.isNullOrEmpty()) {
      findCalendarByTitle(resolver, calendarTitle)?.let { return it }
      throw IllegalArgumentException("CALENDAR_NOT_FOUND: no calendar named $calendarTitle")
    }
    findDefaultCalendarId(resolver)?.let { return it }
    throw IllegalArgumentException("CALENDAR_NOT_FOUND: no default calendar")
  }

  private fun calendarExists(
    resolver: ContentResolver,
    id: Long,
  ): Boolean {
    val projection = arrayOf(CalendarContract.Calendars._ID)
    resolver
      .query(
        CalendarContract.Calendars.CONTENT_URI,
        projection,
        "${CalendarContract.Calendars._ID}=?",
        arrayOf(id.toString()),
        null,
      ).use { cursor ->
        return cursor != null && cursor.moveToFirst()
      }
  }

  private fun findCalendarByTitle(
    resolver: ContentResolver,
    title: String,
  ): Long? {
    val projection = arrayOf(CalendarContract.Calendars._ID)
    resolver
      .query(
        CalendarContract.Calendars.CONTENT_URI,
        projection,
        "${CalendarContract.Calendars.CALENDAR_DISPLAY_NAME}=?",
        arrayOf(title),
        "${CalendarContract.Calendars.IS_PRIMARY} DESC",
      ).use { cursor ->
        if (cursor == null || !cursor.moveToFirst()) return null
        return cursor.getLong(0)
      }
  }

  private fun findDefaultCalendarId(resolver: ContentResolver): Long? {
    val projection = arrayOf(CalendarContract.Calendars._ID)
    resolver
      .query(
        CalendarContract.Calendars.CONTENT_URI,
        projection,
        "${CalendarContract.Calendars.VISIBLE}=1",
        null,
        "${CalendarContract.Calendars.IS_PRIMARY} DESC, ${CalendarContract.Calendars._ID} ASC",
      ).use { cursor ->
        if (cursor == null || !cursor.moveToFirst()) return null
        return cursor.getLong(0)
      }
  }

  private fun loadEventById(
    resolver: ContentResolver,
    eventId: Long,
  ): CalendarEventRecord? {
    val projection =
      arrayOf(
        CalendarContract.Events._ID,
        CalendarContract.Events.TITLE,
        CalendarContract.Events.DTSTART,
        CalendarContract.Events.DTEND,
        CalendarContract.Events.ALL_DAY,
        CalendarContract.Events.EVENT_LOCATION,
        CalendarContract.Events.CALENDAR_DISPLAY_NAME,
      )
    resolver
      .query(
        CalendarContract.Events.CONTENT_URI,
        projection,
        "${CalendarContract.Events._ID}=?",
        arrayOf(eventId.toString()),
        null,
      ).use { cursor ->
        if (cursor == null || !cursor.moveToFirst()) return null
        return CalendarEventRecord(
          identifier = cursor.getLong(0).toString(),
          title =
            cursor
              .getString(1)
              ?.trim()
              .orEmpty()
              .ifEmpty { "(untitled)" },
          startISO = Instant.ofEpochMilli(cursor.getLong(2)).toString(),
          endISO = Instant.ofEpochMilli(cursor.getLong(3)).toString(),
          isAllDay = cursor.getInt(4) == 1,
          location = cursor.getString(5)?.trim()?.ifEmpty { null },
          calendarTitle = cursor.getString(6)?.trim()?.ifEmpty { null },
        )
      }
  }
}

class CalendarHandler private constructor(
  private val appContext: Context,
  private val dataSource: CalendarDataSource,
) {
  constructor(appContext: Context) : this(appContext = appContext, dataSource = SystemCalendarDataSource)

  fun handleCalendarEvents(paramsJson: String?): GatewaySession.InvokeResult {
    if (!dataSource.hasReadPermission(appContext)) {
      return GatewaySession.InvokeResult.error(
        code = "CALENDAR_PERMISSION_REQUIRED",
        message = "CALENDAR_PERMISSION_REQUIRED: grant Calendar permission",
      )
    }
    val request =
      parseEventsRequest(paramsJson)
        ?: return GatewaySession.InvokeResult.error(
          code = "INVALID_REQUEST",
          message = "INVALID_REQUEST: expected JSON object",
        )
    return try {
      val events = dataSource.events(appContext, request)
      GatewaySession.InvokeResult.ok(
        buildJsonObject {
          put(
            "events",
            buildJsonArray { events.forEach { add(eventJson(it)) } },
          )
        }.toString(),
      )
    } catch (err: Throwable) {
      GatewaySession.InvokeResult.error(
        code = "CALENDAR_UNAVAILABLE",
        message = "CALENDAR_UNAVAILABLE: ${err.message ?: "calendar query failed"}",
      )
    }
  }

  fun handleCalendarAdd(paramsJson: String?): GatewaySession.InvokeResult {
    if (!dataSource.hasWritePermission(appContext)) {
      return GatewaySession.InvokeResult.error(
        code = "CALENDAR_PERMISSION_REQUIRED",
        message = "CALENDAR_PERMISSION_REQUIRED: grant Calendar permission",
      )
    }
    val request =
      parseAddRequest(paramsJson)
        ?: return GatewaySession.InvokeResult.error(
          code = "INVALID_REQUEST",
          message = "INVALID_REQUEST: expected JSON object",
        )
    if (request.title.isEmpty()) {
      return GatewaySession.InvokeResult.error(
        code = "CALENDAR_INVALID",
        message = "CALENDAR_INVALID: title required",
      )
    }
    if (request.endMs <= request.startMs) {
      return GatewaySession.InvokeResult.error(
        code = "CALENDAR_INVALID",
        message = "CALENDAR_INVALID: endISO must be after startISO",
      )
    }
    return try {
      val event = dataSource.add(appContext, request)
      GatewaySession.InvokeResult.ok(
        buildJsonObject {
          put("event", eventJson(event))
        }.toString(),
      )
    } catch (err: IllegalArgumentException) {
      val msg = err.message ?: "CALENDAR_INVALID: invalid request"
      val code = if (msg.startsWith("CALENDAR_NOT_FOUND")) "CALENDAR_NOT_FOUND" else "CALENDAR_INVALID"
      GatewaySession.InvokeResult.error(code = code, message = msg)
    } catch (err: Throwable) {
      GatewaySession.InvokeResult.error(
        code = "CALENDAR_UNAVAILABLE",
        message = "CALENDAR_UNAVAILABLE: ${err.message ?: "calendar add failed"}",
      )
    }
  }

  private fun parseEventsRequest(paramsJson: String?): CalendarEventsRequest? {
    if (paramsJson.isNullOrBlank()) {
      val start = Instant.now()
      val end = start.plus(7, ChronoUnit.DAYS)
      return CalendarEventsRequest(startMs = start.toEpochMilli(), endMs = end.toEpochMilli(), limit = DEFAULT_CALENDAR_LIMIT)
    }
    val params =
      try {
        Json.parseToJsonElement(paramsJson).asObjectOrNull()
      } catch (_: Throwable) {
        null
      } ?: return null
    val start = parseISO((params["startISO"] as? JsonPrimitive)?.content)
    val end = parseISO((params["endISO"] as? JsonPrimitive)?.content)
    val resolvedStart = start ?: Instant.now()
    val resolvedEnd = end ?: resolvedStart.plus(7, ChronoUnit.DAYS)
    val limit = ((params["limit"] as? JsonPrimitive)?.content?.toIntOrNull() ?: DEFAULT_CALENDAR_LIMIT).coerceIn(1, 500)
    return CalendarEventsRequest(
      startMs = resolvedStart.toEpochMilli(),
      endMs = resolvedEnd.toEpochMilli(),
      limit = limit,
    )
  }

  private fun parseAddRequest(paramsJson: String?): CalendarAddRequest? {
    val params =
      try {
        paramsJson?.let { Json.parseToJsonElement(it).asObjectOrNull() }
      } catch (_: Throwable) {
        null
      } ?: return null
    val start =
      parseISO((params["startISO"] as? JsonPrimitive)?.content)
        ?: return null
    val end =
      parseISO((params["endISO"] as? JsonPrimitive)?.content)
        ?: return null
    return CalendarAddRequest(
      title = (params["title"] as? JsonPrimitive)?.content?.trim().orEmpty(),
      startMs = start.toEpochMilli(),
      endMs = end.toEpochMilli(),
      isAllDay = (params["isAllDay"] as? JsonPrimitive)?.content?.toBooleanStrictOrNull() ?: false,
      location = (params["location"] as? JsonPrimitive)?.content?.trim()?.ifEmpty { null },
      notes = (params["notes"] as? JsonPrimitive)?.content?.trim()?.ifEmpty { null },
      calendarId = (params["calendarId"] as? JsonPrimitive)?.content?.toLongOrNull(),
      calendarTitle = (params["calendarTitle"] as? JsonPrimitive)?.content?.trim()?.ifEmpty { null },
    )
  }

  private fun parseISO(raw: String?): Instant? {
    val value = raw?.trim().orEmpty()
    if (value.isEmpty()) return null
    return try {
      Instant.parse(value)
    } catch (_: Throwable) {
      null
    }
  }

  private fun eventJson(event: CalendarEventRecord): JsonObject =
    buildJsonObject {
      put("identifier", JsonPrimitive(event.identifier))
      put("title", JsonPrimitive(event.title))
      put("startISO", JsonPrimitive(event.startISO))
      put("endISO", JsonPrimitive(event.endISO))
      put("isAllDay", JsonPrimitive(event.isAllDay))
      event.location?.let { put("location", JsonPrimitive(it)) }
      event.calendarTitle?.let { put("calendarTitle", JsonPrimitive(it)) }
    }

  companion object {
    internal fun forTesting(
      appContext: Context,
      dataSource: CalendarDataSource,
    ): CalendarHandler = CalendarHandler(appContext = appContext, dataSource = dataSource)
  }
}
