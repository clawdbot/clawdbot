package ai.openclaw.app.node

import ai.openclaw.app.gateway.GatewaySession
import android.Manifest
import android.content.Context
import android.provider.CallLog
import androidx.core.content.ContextCompat
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonArray
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put

private const val DEFAULT_CALL_LOG_LIMIT = 25

internal data class CallLogRecord(
  val number: String?,
  val cachedName: String?,
  val date: Long,
  val duration: Long,
  val type: Int,
)

internal data class CallLogSearchRequest(
  val limit: Int, // Number of records to return
  val offset: Int, // Offset value
  val cachedName: String?, // Search by contact name
  val number: String?, // Search by phone number
  val date: Long?, // Search by time (timestamp, deprecated, use dateStart/dateEnd)
  val dateStart: Long?, // Query start time (timestamp)
  val dateEnd: Long?, // Query end time (timestamp)
  val duration: Long?, // Search by duration (seconds)
  val type: Int?, // Search by call log type
)

internal interface CallLogDataSource {
  fun hasReadPermission(context: Context): Boolean

  fun search(
    context: Context,
    request: CallLogSearchRequest,
  ): List<CallLogRecord>
}

private object SystemCallLogDataSource : CallLogDataSource {
  override fun hasReadPermission(context: Context): Boolean =
    ContextCompat.checkSelfPermission(
      context,
      Manifest.permission.READ_CALL_LOG,
    ) == android.content.pm.PackageManager.PERMISSION_GRANTED

  override fun search(
    context: Context,
    request: CallLogSearchRequest,
  ): List<CallLogRecord> {
    val resolver = context.contentResolver
    val projection =
      arrayOf(
        CallLog.Calls.NUMBER,
        CallLog.Calls.CACHED_NAME,
        CallLog.Calls.DATE,
        CallLog.Calls.DURATION,
        CallLog.Calls.TYPE,
      )

    // Build selection and selectionArgs for filtering
    val selections = mutableListOf<String>()
    val selectionArgs = mutableListOf<String>()

    request.cachedName?.let {
      selections.add("${CallLog.Calls.CACHED_NAME} LIKE ?")
      selectionArgs.add("%$it%")
    }

    request.number?.let {
      selections.add("${CallLog.Calls.NUMBER} LIKE ?")
      selectionArgs.add("%$it%")
    }

    // Support time range query
    if (request.dateStart != null && request.dateEnd != null) {
      selections.add("${CallLog.Calls.DATE} >= ? AND ${CallLog.Calls.DATE} <= ?")
      selectionArgs.add(request.dateStart.toString())
      selectionArgs.add(request.dateEnd.toString())
    } else if (request.dateStart != null) {
      selections.add("${CallLog.Calls.DATE} >= ?")
      selectionArgs.add(request.dateStart.toString())
    } else if (request.dateEnd != null) {
      selections.add("${CallLog.Calls.DATE} <= ?")
      selectionArgs.add(request.dateEnd.toString())
    } else if (request.date != null) {
      // Compatible with the old date parameter (exact match)
      selections.add("${CallLog.Calls.DATE} = ?")
      selectionArgs.add(request.date.toString())
    }

    request.duration?.let {
      selections.add("${CallLog.Calls.DURATION} = ?")
      selectionArgs.add(it.toString())
    }

    request.type?.let {
      selections.add("${CallLog.Calls.TYPE} = ?")
      selectionArgs.add(it.toString())
    }

    val selection = if (selections.isNotEmpty()) selections.joinToString(" AND ") else null
    val selectionArgsArray = if (selectionArgs.isNotEmpty()) selectionArgs.toTypedArray() else null

    val sortOrder = "${CallLog.Calls.DATE} DESC"

    resolver
      .query(
        CallLog.Calls.CONTENT_URI,
        projection,
        selection,
        selectionArgsArray,
        sortOrder,
      ).use { cursor ->
        if (cursor == null) return emptyList()

        val numberIndex = cursor.getColumnIndex(CallLog.Calls.NUMBER)
        val cachedNameIndex = cursor.getColumnIndex(CallLog.Calls.CACHED_NAME)
        val dateIndex = cursor.getColumnIndex(CallLog.Calls.DATE)
        val durationIndex = cursor.getColumnIndex(CallLog.Calls.DURATION)
        val typeIndex = cursor.getColumnIndex(CallLog.Calls.TYPE)

        // Skip offset rows
        if (request.offset > 0 && cursor.moveToPosition(request.offset - 1)) {
          // Successfully moved to offset position
        }

        val out = mutableListOf<CallLogRecord>()
        var count = 0
        while (cursor.moveToNext() && count < request.limit) {
          out +=
            CallLogRecord(
              number = cursor.getString(numberIndex),
              cachedName = cursor.getString(cachedNameIndex),
              date = cursor.getLong(dateIndex),
              duration = cursor.getLong(durationIndex),
              type = cursor.getInt(typeIndex),
            )
          count++
        }
        return out
      }
  }
}

class CallLogHandler private constructor(
  private val appContext: Context,
  private val dataSource: CallLogDataSource,
) {
  constructor(appContext: Context) : this(appContext = appContext, dataSource = SystemCallLogDataSource)

  fun handleCallLogSearch(paramsJson: String?): GatewaySession.InvokeResult {
    if (!dataSource.hasReadPermission(appContext)) {
      return GatewaySession.InvokeResult.error(
        code = "CALL_LOG_PERMISSION_REQUIRED",
        message = "CALL_LOG_PERMISSION_REQUIRED: grant Call Log permission",
      )
    }

    val request =
      parseSearchRequest(paramsJson)
        ?: return GatewaySession.InvokeResult.error(
          code = "INVALID_REQUEST",
          message = "INVALID_REQUEST: expected JSON object",
        )

    return try {
      val callLogs = dataSource.search(appContext, request)
      GatewaySession.InvokeResult.ok(
        buildJsonObject {
          put(
            "callLogs",
            buildJsonArray {
              callLogs.forEach { add(callLogJson(it)) }
            },
          )
        }.toString(),
      )
    } catch (err: Throwable) {
      GatewaySession.InvokeResult.error(
        code = "CALL_LOG_UNAVAILABLE",
        message = "CALL_LOG_UNAVAILABLE: ${err.message ?: "call log query failed"}",
      )
    }
  }

  private fun parseSearchRequest(paramsJson: String?): CallLogSearchRequest? {
    if (paramsJson.isNullOrBlank()) {
      return CallLogSearchRequest(
        limit = DEFAULT_CALL_LOG_LIMIT,
        offset = 0,
        cachedName = null,
        number = null,
        date = null,
        dateStart = null,
        dateEnd = null,
        duration = null,
        type = null,
      )
    }

    val params =
      try {
        Json.parseToJsonElement(paramsJson).asObjectOrNull()
      } catch (_: Throwable) {
        null
      } ?: return null

    val limit =
      ((params["limit"] as? JsonPrimitive)?.content?.toIntOrNull() ?: DEFAULT_CALL_LOG_LIMIT)
        .coerceIn(1, 200)
    val offset =
      ((params["offset"] as? JsonPrimitive)?.content?.toIntOrNull() ?: 0)
        .coerceAtLeast(0)
    val cachedName = (params["cachedName"] as? JsonPrimitive)?.content?.takeIf { it.isNotBlank() }
    val number = (params["number"] as? JsonPrimitive)?.content?.takeIf { it.isNotBlank() }
    val date = (params["date"] as? JsonPrimitive)?.content?.toLongOrNull()
    val dateStart = (params["dateStart"] as? JsonPrimitive)?.content?.toLongOrNull()
    val dateEnd = (params["dateEnd"] as? JsonPrimitive)?.content?.toLongOrNull()
    val duration = (params["duration"] as? JsonPrimitive)?.content?.toLongOrNull()
    val type = (params["type"] as? JsonPrimitive)?.content?.toIntOrNull()

    return CallLogSearchRequest(
      limit = limit,
      offset = offset,
      cachedName = cachedName,
      number = number,
      date = date,
      dateStart = dateStart,
      dateEnd = dateEnd,
      duration = duration,
      type = type,
    )
  }

  private fun callLogJson(callLog: CallLogRecord): JsonObject =
    buildJsonObject {
      put("number", JsonPrimitive(callLog.number))
      put("cachedName", JsonPrimitive(callLog.cachedName))
      put("date", JsonPrimitive(callLog.date))
      put("duration", JsonPrimitive(callLog.duration))
      put("type", JsonPrimitive(callLog.type))
    }

  companion object {
    internal fun forTesting(
      appContext: Context,
      dataSource: CallLogDataSource,
    ): CallLogHandler = CallLogHandler(appContext = appContext, dataSource = dataSource)
  }
}
