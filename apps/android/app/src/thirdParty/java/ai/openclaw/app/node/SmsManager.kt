package ai.openclaw.app.node

import ai.openclaw.app.PermissionRequester
import android.Manifest
import android.content.Context
import android.content.pm.PackageManager
import android.net.Uri
import android.provider.ContactsContract
import android.provider.Telephony
import androidx.core.content.ContextCompat
import androidx.core.net.toUri
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import kotlinx.serialization.Serializable
import kotlinx.serialization.encodeToString
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.jsonObject
import android.telephony.SmsManager as AndroidSmsManager

/**
 * Sends SMS messages via the Android SMS API.
 * Requires SEND_SMS permission to be granted.
 *
 * Also provides SMS query functionality with READ_SMS permission.
 */
class SmsManager(
  private val context: Context,
) {
  private val json = JsonConfig

  @Volatile private var permissionRequester: PermissionRequester? = null

  data class SendResult(
    val ok: Boolean,
    val to: String,
    val message: String?,
    val error: String? = null,
    val payloadJson: String,
  )

  /**
   * Represents a single SMS message.
   */
  @Serializable
  data class SmsMessage(
    val id: Long,
    val threadId: Long,
    val address: String?,
    val person: String?,
    val date: Long,
    val dateSent: Long,
    val read: Boolean,
    val type: Int,
    val body: String?,
    val status: Int,
    val transportType: String? = null,
  )

  data class SearchResult(
    val ok: Boolean,
    val messages: List<SmsMessage>,
    val error: String? = null,
    val payloadJson: String,
  )

  internal data class QueryMetadata(
    val mmsRequested: Boolean,
    val mmsEligible: Boolean,
    val mmsAttempted: Boolean,
    val mmsIncluded: Boolean,
  )

  internal data class ParsedParams(
    val to: String,
    val message: String,
  )

  internal sealed interface ParseResult {
    data class Ok(
      val params: ParsedParams,
    ) : ParseResult

    data class Error(
      val error: String,
      val to: String = "",
      val message: String? = null,
    ) : ParseResult
  }

  internal data class QueryParams(
    val startTime: Long? = null,
    val endTime: Long? = null,
    val contactName: String? = null,
    val phoneNumber: String? = null,
    val keyword: String? = null,
    val type: Int? = null,
    val isRead: Boolean? = null,
    val includeMms: Boolean = false,
    val conversationReview: Boolean = false,
    val limit: Int = DEFAULT_SMS_LIMIT,
    val offset: Int = 0,
  )

  internal sealed interface QueryParseResult {
    data class Ok(
      val params: QueryParams,
    ) : QueryParseResult

    data class Error(
      val error: String,
    ) : QueryParseResult
  }

  internal data class SendPlan(
    val parts: List<String>,
    val useMultipart: Boolean,
  )

  companion object {
    private const val DEFAULT_SMS_LIMIT = 25
    internal const val MAX_MIXED_BY_PHONE_CANDIDATE_WINDOW = 500
    private const val MMS_SMS_BY_PHONE_BASE = "content://mms-sms/messages/byphone"
    private const val MMS_CONTENT_BASE = "content://mms"
    private const val MMS_PART_URI = "content://mms/part"
    private val PHONE_FORMATTING_REGEX = Regex("""[\s\-()]""")
    internal val JsonConfig = Json { ignoreUnknownKeys = true }

    internal fun parseParams(
      paramsJson: String?,
      json: Json = JsonConfig,
    ): ParseResult {
      val params = paramsJson?.trim().orEmpty()
      if (params.isEmpty()) {
        return ParseResult.Error(error = "INVALID_REQUEST: paramsJSON required")
      }

      val obj =
        try {
          json.parseToJsonElement(params).jsonObject
        } catch (_: Throwable) {
          null
        }

      if (obj == null) {
        return ParseResult.Error(error = "INVALID_REQUEST: expected JSON object")
      }

      val to = (obj["to"] as? JsonPrimitive)?.content?.trim().orEmpty()
      val message = (obj["message"] as? JsonPrimitive)?.content.orEmpty()

      if (to.isEmpty()) {
        return ParseResult.Error(
          error = "INVALID_REQUEST: 'to' phone number required",
          message = message,
        )
      }

      if (message.isEmpty()) {
        return ParseResult.Error(
          error = "INVALID_REQUEST: 'message' text required",
          to = to,
        )
      }

      return ParseResult.Ok(ParsedParams(to = to, message = message))
    }

    internal fun parseQueryParams(
      paramsJson: String?,
      json: Json = JsonConfig,
    ): QueryParseResult {
      val params = paramsJson?.trim().orEmpty()
      if (params.isEmpty()) {
        return QueryParseResult.Ok(QueryParams())
      }

      val obj =
        try {
          json.parseToJsonElement(params).jsonObject
        } catch (_: Throwable) {
          return QueryParseResult.Error("INVALID_REQUEST: expected JSON object")
        }

      val startTime = (obj["startTime"] as? JsonPrimitive)?.content?.toLongOrNull()
      val endTime = (obj["endTime"] as? JsonPrimitive)?.content?.toLongOrNull()
      val contactName = (obj["contactName"] as? JsonPrimitive)?.content?.trim()
      val phoneNumber = (obj["phoneNumber"] as? JsonPrimitive)?.content?.trim()
      val keyword = (obj["keyword"] as? JsonPrimitive)?.content?.trim()
      val type = (obj["type"] as? JsonPrimitive)?.content?.toIntOrNull()
      val isRead = (obj["isRead"] as? JsonPrimitive)?.content?.toBooleanStrictOrNull()
      val includeMms = (obj["includeMms"] as? JsonPrimitive)?.content?.toBooleanStrictOrNull() ?: false
      val conversationReview = (obj["conversationReview"] as? JsonPrimitive)?.content?.toBooleanStrictOrNull() ?: false
      val limit =
        ((obj["limit"] as? JsonPrimitive)?.content?.toIntOrNull() ?: DEFAULT_SMS_LIMIT)
          .coerceIn(1, 200)
      val offset =
        ((obj["offset"] as? JsonPrimitive)?.content?.toIntOrNull() ?: 0)
          .coerceAtLeast(0)

      if (startTime != null && endTime != null && startTime > endTime) {
        return QueryParseResult.Error("INVALID_REQUEST: startTime must be less than or equal to endTime")
      }

      return QueryParseResult.Ok(
        QueryParams(
          startTime = startTime,
          endTime = endTime,
          contactName = contactName,
          phoneNumber = phoneNumber,
          keyword = keyword,
          type = type,
          isRead = isRead,
          includeMms = includeMms,
          conversationReview = conversationReview,
          limit = limit,
          offset = offset,
        ),
      )
    }

    private fun normalizePhoneNumber(phone: String): String = phone.replace(PHONE_FORMATTING_REGEX, "")

    internal fun normalizePhoneNumberOrNull(phone: String?): String? {
      val normalized = phone?.let(::normalizePhoneNumber)?.trim().orEmpty()
      if (normalized.isEmpty()) {
        return null
      }
      val digits = toByPhoneLookupNumber(normalized)
      return normalized.takeIf { digits.isNotEmpty() }
    }

    internal fun sanitizeContactPhoneNumberOrNull(phone: String?): String? {
      val normalized = normalizePhoneNumberOrNull(phone) ?: return null
      return normalized.takeUnless(::hasSqlLikeWildcard)
    }

    internal fun shouldPromptForContactNameSearchPermission(
      contactName: String?,
      phoneNumber: String?,
      hasReadContactsPermission: Boolean,
    ): Boolean = !contactName.isNullOrEmpty() && phoneNumber.isNullOrEmpty() && !hasReadContactsPermission

    internal fun mapMmsMsgBoxToSearchType(msgBox: Int?): Int? =
      when (msgBox) {
        1 -> 1 // inbox
        2 -> 2 // sent
        3 -> 3 // draft
        4 -> 4 // outbox
        5 -> 5 // failed
        6 -> 6 // queued
        else -> null
      }

    internal fun escapeSqlLikeLiteral(value: String): String =
      buildString(value.length) {
        for (ch in value) {
          when (ch) {
            '\\', '%', '_' -> {
              append('\\')
              append(ch)
            }
            else -> append(ch)
          }
        }
      }

    internal fun buildContactNameLikeSelection(): String = "${ContactsContract.CommonDataKinds.Phone.DISPLAY_NAME} LIKE ? ESCAPE '\\'"

    internal fun buildContactNameLikeArg(contactName: String): String = "%${escapeSqlLikeLiteral(contactName)}%"

    internal fun buildKeywordLikeSelection(): String = "${Telephony.Sms.BODY} LIKE ? ESCAPE '\\'"

    internal fun buildKeywordLikeArg(keyword: String): String = "%${escapeSqlLikeLiteral(keyword)}%"

    internal fun buildMixedByPhoneProjection(): Array<String> =
      arrayOf(
        "_id",
        "thread_id",
        "transport_type",
        "address",
        "date",
        "date_sent",
        "read",
        "type",
        "body",
        "status",
      )

    internal fun hasSqlLikeWildcard(value: String): Boolean = value.contains('%') || value.contains('_')

    internal fun isExplicitPhoneInputInvalid(
      rawPhone: String?,
      normalizedPhone: String?,
    ): Boolean {
      if (rawPhone.isNullOrBlank()) {
        return false
      }
      if (normalizedPhone == null) {
        return true
      }
      return hasSqlLikeWildcard(normalizedPhone)
    }

    internal fun resolveMixedByPhoneRowStatus(
      transportType: String?,
      smsStatus: Int?,
    ): Int = if (transportType.equals("mms", ignoreCase = true)) -1 else (smsStatus ?: 0)

    internal fun resolveMixedByPhoneRowAddress(
      providerAddress: String?,
      phoneNumber: String,
      mmsAddress: String? = null,
    ): String? {
      val resolvedMmsAddress = normalizePhoneNumberOrNull(mmsAddress)
      if (resolvedMmsAddress != null) {
        return resolvedMmsAddress
      }

      val resolvedProviderAddress = normalizePhoneNumberOrNull(providerAddress)
      return resolvedProviderAddress ?: phoneNumber
    }

    internal fun selectPreferredMmsAddress(
      addressRows: List<Pair<String?, Int?>>,
      lookupNumber: String,
    ): String? {
      val lookupDigits = toByPhoneLookupNumber(lookupNumber)
      val normalizedRows =
        addressRows.mapNotNull { (address, type) ->
          val normalized = normalizePhoneNumberOrNull(address) ?: return@mapNotNull null
          val digits = toByPhoneLookupNumber(normalized)
          if (digits.isBlank()) return@mapNotNull null
          Triple(normalized, digits, type)
        }

      fun firstPreferred(vararg types: Int): String? =
        normalizedRows
          .firstOrNull { row ->
            (types.isEmpty() || types.contains(row.third ?: -1)) && row.second != lookupDigits
          }?.first

      return firstPreferred(137)
        ?: firstPreferred(151, 130, 129)
        ?: firstPreferred()
        ?: normalizedRows.firstOrNull()?.first
    }

    internal fun shouldUseConversationReviewByPhoneMode(
      params: QueryParams,
      resolvedPhoneNumbers: List<String> = emptyList(),
    ): Boolean {
      val hasExplicitPhoneNumber = !params.phoneNumber.isNullOrEmpty()
      val hasSingleResolvedPhoneNumber = resolvedPhoneNumbers.size == 1
      return params.conversationReview && params.includeMms && (hasExplicitPhoneNumber || hasSingleResolvedPhoneNumber)
    }

    internal fun effectiveSearchParams(
      params: QueryParams,
      resolvedPhoneNumbers: List<String> = emptyList(),
    ): QueryParams {
      if (!shouldUseConversationReviewByPhoneMode(params, resolvedPhoneNumbers)) return params
      val reviewLimit = maxOf(params.limit, 25)
      return params.copy(limit = reviewLimit)
    }

    internal fun resolveSearchParams(
      params: QueryParams,
      normalizedPhoneNumber: String?,
      resolvedPhoneNumbers: List<String> = emptyList(),
    ): QueryParams {
      val effectivePhoneNumber = normalizedPhoneNumber ?: resolvedPhoneNumbers.singleOrNull()
      val normalizedParams = params.copy(phoneNumber = effectivePhoneNumber)
      return effectiveSearchParams(normalizedParams, resolvedPhoneNumbers)
    }

    internal fun toByPhoneLookupNumber(phone: String): String = phone.filter { it.isDigit() }

    internal fun normalizeProviderDateMillis(rawDate: Long): Long = if (rawDate in 1..99_999_999_999L) rawDate * 1000L else rawDate

    internal fun canonicalizeMixedPathPhoneFilters(phoneNumbers: List<String>): List<String> =
      phoneNumbers
        .map(::toByPhoneLookupNumber)
        .filter { it.isNotBlank() }
        .distinct()

    internal fun requestedMixedByPhoneCandidateWindow(params: QueryParams): Long = params.offset.toLong() + params.limit.toLong()

    internal fun exceedsMixedByPhoneCandidateWindow(
      params: QueryParams,
      allPhoneNumbers: List<String>,
    ): Boolean =
      params.includeMms &&
        allPhoneNumbers.size == 1 &&
        requestedMixedByPhoneCandidateWindow(params) > MAX_MIXED_BY_PHONE_CANDIDATE_WINDOW

    internal fun mixedByPhoneWindowError(): String = "INVALID_REQUEST: includeMms offset+limit exceeds supported window ($MAX_MIXED_BY_PHONE_CANDIDATE_WINDOW)"

    internal fun isMmsTransportRow(message: SmsMessage): Boolean = message.transportType.equals("mms", ignoreCase = true)

    internal fun shouldHydrateMmsByPhoneRow(
      transportType: String?,
      body: String?,
      type: Int,
    ): Boolean = transportType.equals("mms", ignoreCase = true) && (body.isNullOrBlank() || type == 0)

    internal fun buildQueryMetadata(
      params: QueryParams,
      allPhoneNumbers: List<String>,
      messages: List<SmsMessage>,
    ): QueryMetadata {
      val mmsRequested = params.includeMms
      val mmsEligible = mmsRequested && allPhoneNumbers.size == 1
      val mmsAttempted = mmsEligible
      val mmsIncluded = mmsAttempted && messages.any(::isMmsTransportRow)
      return QueryMetadata(
        mmsRequested = mmsRequested,
        mmsEligible = mmsEligible,
        mmsAttempted = mmsAttempted,
        mmsIncluded = mmsIncluded,
      )
    }

    internal fun compareByPhoneCandidateOrder(
      left: SmsMessage,
      right: SmsMessage,
    ): Int =
      when {
        left.date != right.date -> right.date.compareTo(left.date)
        left.id != right.id -> right.id.compareTo(left.id)
        else -> 0
      }

    internal fun buildMixedRowIdentity(
      rowId: Long,
      transportType: String?,
    ): String = "${transportType?.ifBlank { "unknown" } ?: "unknown"}:$rowId"

    internal fun upsertTopDateCandidates(
      candidates: MutableList<Pair<String, SmsMessage>>,
      identityKey: String,
      message: SmsMessage,
      maxCandidates: Int,
    ) {
      if (maxCandidates <= 0) {
        return
      }

      candidates.removeAll { existing -> existing.first == identityKey }
      candidates.add(identityKey to message)
      candidates.sortWith { left, right -> compareByPhoneCandidateOrder(left.second, right.second) }

      while (candidates.size > maxCandidates) {
        candidates.removeAt(candidates.lastIndex)
      }
    }

    internal fun materializeByPhoneCandidate(
      candidates: MutableMap<String, SmsMessage>,
      identityKey: String,
      message: SmsMessage,
    ) {
      candidates[identityKey] = message
    }

    internal fun collectMixedByPhoneCandidate(
      topCandidates: MutableList<Pair<String, SmsMessage>>,
      materializedCandidates: MutableMap<String, SmsMessage>,
      identityKey: String,
      message: SmsMessage,
      maxCandidates: Int,
      reviewMode: Boolean,
    ) {
      if (reviewMode) {
        materializeByPhoneCandidate(materializedCandidates, identityKey, message)
      } else {
        upsertTopDateCandidates(topCandidates, identityKey, message, maxCandidates)
      }
    }

    internal fun pageMixedByPhoneCandidates(
      topCandidates: Collection<Pair<String, SmsMessage>>,
      materializedCandidates: Map<String, SmsMessage>,
      params: QueryParams,
      reviewMode: Boolean,
    ): List<SmsMessage> =
      if (reviewMode) {
        pageByPhoneCandidates(materializedCandidates.values, params)
      } else {
        pageByPhoneCandidates(topCandidates.map { it.second }, params)
      }

    internal fun pageByPhoneCandidates(
      candidates: Collection<SmsMessage>,
      params: QueryParams,
    ): List<SmsMessage> =
      candidates
        .sortedWith(::compareByPhoneCandidateOrder)
        .drop(params.offset)
        .take(params.limit)

    internal fun buildSendPlan(
      message: String,
      divider: (String) -> List<String>,
    ): SendPlan {
      val parts = divider(message).ifEmpty { listOf(message) }
      return SendPlan(parts = parts, useMultipart = parts.size > 1)
    }

    internal fun buildPayloadJson(
      json: Json = JsonConfig,
      ok: Boolean,
      to: String,
      error: String?,
    ): String {
      val payload =
        mutableMapOf<String, JsonElement>(
          "ok" to JsonPrimitive(ok),
          "to" to JsonPrimitive(to),
        )
      if (!ok) {
        payload["error"] = JsonPrimitive(error ?: "SMS_SEND_FAILED")
      }
      return json.encodeToString(JsonObject.serializer(), JsonObject(payload))
    }

    internal fun buildQueryPayloadJson(
      json: Json = JsonConfig,
      ok: Boolean,
      messages: List<SmsMessage>,
      error: String? = null,
      queryMetadata: QueryMetadata? = null,
    ): String {
      val messagesArray = json.encodeToString(messages)
      val messagesElement = json.parseToJsonElement(messagesArray)
      val payload =
        mutableMapOf<String, JsonElement>(
          "ok" to JsonPrimitive(ok),
          "count" to JsonPrimitive(messages.size),
          "messages" to messagesElement,
        )
      queryMetadata?.let {
        payload["mmsRequested"] = JsonPrimitive(it.mmsRequested)
        payload["mmsEligible"] = JsonPrimitive(it.mmsEligible)
        payload["mmsAttempted"] = JsonPrimitive(it.mmsAttempted)
        payload["mmsIncluded"] = JsonPrimitive(it.mmsIncluded)
      }
      if (!ok && error != null) {
        payload["error"] = JsonPrimitive(error)
      }
      return json.encodeToString(JsonObject.serializer(), JsonObject(payload))
    }
  }

  fun hasSmsPermission(): Boolean =
    ContextCompat.checkSelfPermission(
      context,
      Manifest.permission.SEND_SMS,
    ) == PackageManager.PERMISSION_GRANTED

  fun hasReadSmsPermission(): Boolean =
    ContextCompat.checkSelfPermission(
      context,
      Manifest.permission.READ_SMS,
    ) == PackageManager.PERMISSION_GRANTED

  fun hasReadContactsPermission(): Boolean =
    ContextCompat.checkSelfPermission(
      context,
      Manifest.permission.READ_CONTACTS,
    ) == PackageManager.PERMISSION_GRANTED

  fun canSendSms(): Boolean = hasSmsPermission() && hasTelephonyFeature()

  fun canSearchSms(): Boolean = hasReadSmsPermission() && hasTelephonyFeature()

  fun canReadSms(): Boolean = canSearchSms()

  fun hasTelephonyFeature(): Boolean = context.packageManager?.hasSystemFeature(PackageManager.FEATURE_TELEPHONY) == true

  fun attachPermissionRequester(requester: PermissionRequester) {
    permissionRequester = requester
  }

  /**
   * Send an SMS message.
   *
   * @param paramsJson JSON with "to" (phone number) and "message" (text) fields
   * @return SendResult indicating success or failure
   */
  suspend fun send(paramsJson: String?): SendResult {
    if (!hasTelephonyFeature()) {
      return errorResult(
        error = "SMS_UNAVAILABLE: telephony not available",
      )
    }

    if (!ensureSmsPermission()) {
      return errorResult(
        error = "SMS_PERMISSION_REQUIRED: grant SMS permission",
      )
    }

    val parseResult = parseParams(paramsJson, json)
    if (parseResult is ParseResult.Error) {
      return errorResult(
        error = parseResult.error,
        to = parseResult.to,
        message = parseResult.message,
      )
    }
    val params = (parseResult as ParseResult.Ok).params

    return try {
      val smsManager =
        context.getSystemService(AndroidSmsManager::class.java)
          ?: throw IllegalStateException("SMS_UNAVAILABLE: SmsManager not available")

      val plan = buildSendPlan(params.message) { smsManager.divideMessage(it) }
      if (plan.useMultipart) {
        smsManager.sendMultipartTextMessage(
          params.to,
          null,
          ArrayList(plan.parts),
          null,
          null,
        )
      } else {
        smsManager.sendTextMessage(
          params.to,
          null,
          params.message,
          null,
          null,
        )
      }

      okResult(to = params.to, message = params.message)
    } catch (e: SecurityException) {
      errorResult(
        error = "SMS_PERMISSION_REQUIRED: ${e.message}",
        to = params.to,
        message = params.message,
      )
    } catch (e: Throwable) {
      errorResult(
        error = "SMS_SEND_FAILED: ${e.message ?: "unknown error"}",
        to = params.to,
        message = params.message,
      )
    }
  }

  /**
   * Search SMS messages with the specified parameters.
   */
  suspend fun search(paramsJson: String?): SearchResult =
    withContext(Dispatchers.IO) {
      if (!hasTelephonyFeature()) {
        return@withContext queryError("SMS_UNAVAILABLE: telephony not available")
      }

      if (!ensureReadSmsPermission()) {
        return@withContext queryError("SMS_PERMISSION_REQUIRED: grant READ_SMS permission")
      }

      val parseResult = parseQueryParams(paramsJson, json)
      if (parseResult is QueryParseResult.Error) {
        return@withContext queryError(parseResult.error)
      }
      val parsedParams = (parseResult as QueryParseResult.Ok).params
      val normalizedPhoneNumber = normalizePhoneNumberOrNull(parsedParams.phoneNumber)
      if (isExplicitPhoneInputInvalid(parsedParams.phoneNumber, normalizedPhoneNumber)) {
        val error =
          if (!parsedParams.phoneNumber.isNullOrBlank() &&
            normalizedPhoneNumber != null &&
            hasSqlLikeWildcard(normalizedPhoneNumber)
          ) {
            "INVALID_REQUEST: phoneNumber must not contain SQL LIKE wildcard characters"
          } else {
            "INVALID_REQUEST: phoneNumber must contain at least one digit"
          }
        return@withContext queryError(error)
      }
      val normalizedParams = resolveSearchParams(parsedParams, normalizedPhoneNumber)

      return@withContext try {
        val contactsPermissionGranted = hasReadContactsPermission()
        val shouldPromptForContactsPermission =
          shouldPromptForContactNameSearchPermission(
            contactName = normalizedParams.contactName,
            phoneNumber = normalizedParams.phoneNumber,
            hasReadContactsPermission = contactsPermissionGranted,
          )
        val phoneNumbers =
          if (!normalizedParams.contactName.isNullOrEmpty()) {
            if (contactsPermissionGranted || (shouldPromptForContactsPermission && ensureReadContactsPermission())) {
              getPhoneNumbersFromContactName(normalizedParams.contactName)
            } else if (shouldPromptForContactsPermission) {
              return@withContext queryError("CONTACTS_PERMISSION_REQUIRED: grant READ_CONTACTS permission")
            } else {
              emptyList()
            }
          } else {
            emptyList()
          }
        val params = resolveSearchParams(parsedParams, normalizedPhoneNumber, phoneNumbers)

        val mixedPathPhoneFilters =
          if (!params.phoneNumber.isNullOrEmpty()) {
            canonicalizeMixedPathPhoneFilters(phoneNumbers + params.phoneNumber)
          } else {
            canonicalizeMixedPathPhoneFilters(phoneNumbers)
          }

        if (exceedsMixedByPhoneCandidateWindow(params, mixedPathPhoneFilters)) {
          val error = mixedByPhoneWindowError()
          return@withContext queryError(error)
        }

        if (!params.contactName.isNullOrEmpty() && phoneNumbers.isEmpty() && params.phoneNumber.isNullOrEmpty()) {
          val queryMetadata = buildQueryMetadata(params, mixedPathPhoneFilters, emptyList())
          return@withContext queryOk(emptyList(), queryMetadata)
        }

        val messages = querySmsMessages(params, phoneNumbers)
        val queryMetadata = buildQueryMetadata(params, mixedPathPhoneFilters, messages)
        queryOk(messages, queryMetadata)
      } catch (e: SecurityException) {
        queryError("SMS_PERMISSION_REQUIRED: ${e.message}")
      } catch (e: Throwable) {
        queryError("SMS_QUERY_FAILED: ${e.message ?: "unknown error"}")
      }
    }

  private suspend fun ensureSmsPermission(): Boolean {
    if (hasSmsPermission()) return true
    val requester = permissionRequester ?: return false
    val results = requester.requestIfMissing(listOf(Manifest.permission.SEND_SMS))
    return results[Manifest.permission.SEND_SMS] == true
  }

  private suspend fun ensureReadSmsPermission(): Boolean {
    if (hasReadSmsPermission()) return true
    val requester = permissionRequester ?: return false
    val results = requester.requestIfMissing(listOf(Manifest.permission.READ_SMS))
    return results[Manifest.permission.READ_SMS] == true
  }

  private suspend fun ensureReadContactsPermission(): Boolean {
    if (hasReadContactsPermission()) return true
    val requester = permissionRequester ?: return false
    val results = requester.requestIfMissing(listOf(Manifest.permission.READ_CONTACTS))
    return results[Manifest.permission.READ_CONTACTS] == true
  }

  private fun okResult(
    to: String,
    message: String,
  ): SendResult =
    SendResult(
      ok = true,
      to = to,
      message = message,
      error = null,
      payloadJson = buildPayloadJson(json = json, ok = true, to = to, error = null),
    )

  private fun errorResult(
    error: String,
    to: String = "",
    message: String? = null,
  ): SendResult =
    SendResult(
      ok = false,
      to = to,
      message = message,
      error = error,
      payloadJson = buildPayloadJson(json = json, ok = false, to = to, error = error),
    )

  private fun queryOk(
    messages: List<SmsMessage>,
    queryMetadata: QueryMetadata? = null,
  ): SearchResult =
    SearchResult(
      ok = true,
      messages = messages,
      error = null,
      payloadJson = buildQueryPayloadJson(json, ok = true, messages = messages, queryMetadata = queryMetadata),
    )

  private fun queryError(error: String): SearchResult =
    SearchResult(
      ok = false,
      messages = emptyList(),
      error = error,
      payloadJson = buildQueryPayloadJson(json, ok = false, messages = emptyList(), error = error),
    )

  private fun getPhoneNumbersFromContactName(contactName: String): List<String> {
    val phoneNumbers = mutableListOf<String>()
    val selection = buildContactNameLikeSelection()
    val selectionArgs = arrayOf(buildContactNameLikeArg(contactName))

    val cursor =
      context.contentResolver.query(
        ContactsContract.CommonDataKinds.Phone.CONTENT_URI,
        arrayOf(ContactsContract.CommonDataKinds.Phone.NUMBER),
        selection,
        selectionArgs,
        null,
      )

    cursor?.use {
      val numberIndex = it.getColumnIndex(ContactsContract.CommonDataKinds.Phone.NUMBER)
      while (it.moveToNext()) {
        val number = it.getString(numberIndex)
        sanitizeContactPhoneNumberOrNull(number)?.let(phoneNumbers::add)
      }
    }

    return phoneNumbers
  }

  private fun querySmsMessages(
    params: QueryParams,
    phoneNumbers: List<String>,
  ): List<SmsMessage> {
    val messages = mutableListOf<SmsMessage>()

    val selections = mutableListOf<String>()
    val selectionArgs = mutableListOf<String>()

    if (params.startTime != null) {
      selections.add("${Telephony.Sms.DATE} >= ?")
      selectionArgs.add(params.startTime.toString())
    }
    if (params.endTime != null) {
      selections.add("${Telephony.Sms.DATE} <= ?")
      selectionArgs.add(params.endTime.toString())
    }

    val allPhoneNumbers =
      if (!params.phoneNumber.isNullOrEmpty()) {
        (phoneNumbers + normalizePhoneNumber(params.phoneNumber)).distinct()
      } else {
        phoneNumbers.distinct()
      }
    val mixedPathPhoneFilters = canonicalizeMixedPathPhoneFilters(allPhoneNumbers)

    // Unified SMS+MMS query path is opt-in to keep sms.search semantics
    // stable by default. Use includeMms=true for by-phone provider behavior.
    if (params.includeMms && mixedPathPhoneFilters.size == 1) {
      return querySmsMmsMessagesByPhone(mixedPathPhoneFilters.first(), params)
    }

    if (allPhoneNumbers.isNotEmpty()) {
      val addressSelection =
        allPhoneNumbers.joinToString(" OR ") {
          "${Telephony.Sms.ADDRESS} LIKE ?"
        }
      selections.add("($addressSelection)")
      allPhoneNumbers.forEach {
        selectionArgs.add("%$it%")
      }
    }

    if (!params.keyword.isNullOrEmpty()) {
      selections.add(buildKeywordLikeSelection())
      selectionArgs.add(buildKeywordLikeArg(params.keyword))
    }

    if (params.type != null) {
      selections.add("${Telephony.Sms.TYPE} = ?")
      selectionArgs.add(params.type.toString())
    }

    if (params.isRead != null) {
      selections.add("${Telephony.Sms.READ} = ?")
      selectionArgs.add(if (params.isRead) "1" else "0")
    }

    val selection =
      if (selections.isNotEmpty()) {
        selections.joinToString(" AND ")
      } else {
        null
      }

    val selectionArgsArray =
      if (selectionArgs.isNotEmpty()) {
        selectionArgs.toTypedArray()
      } else {
        null
      }

    // Android SMS providers still honor LIMIT/OFFSET through sortOrder on this path.
    // Keep the bounded interpolation here because parseQueryParams already clamps both values.
    val sortOrder = "${Telephony.Sms.DATE} DESC LIMIT ${params.limit} OFFSET ${params.offset}"
    val cursor =
      context.contentResolver.query(
        Telephony.Sms.CONTENT_URI,
        arrayOf(
          Telephony.Sms._ID,
          Telephony.Sms.THREAD_ID,
          Telephony.Sms.ADDRESS,
          Telephony.Sms.PERSON,
          Telephony.Sms.DATE,
          Telephony.Sms.DATE_SENT,
          Telephony.Sms.READ,
          Telephony.Sms.TYPE,
          Telephony.Sms.BODY,
          Telephony.Sms.STATUS,
        ),
        selection,
        selectionArgsArray,
        sortOrder,
      )

    cursor?.use {
      val idIndex = it.getColumnIndex(Telephony.Sms._ID)
      val threadIdIndex = it.getColumnIndex(Telephony.Sms.THREAD_ID)
      val addressIndex = it.getColumnIndex(Telephony.Sms.ADDRESS)
      val personIndex = it.getColumnIndex(Telephony.Sms.PERSON)
      val dateIndex = it.getColumnIndex(Telephony.Sms.DATE)
      val dateSentIndex = it.getColumnIndex(Telephony.Sms.DATE_SENT)
      val readIndex = it.getColumnIndex(Telephony.Sms.READ)
      val typeIndex = it.getColumnIndex(Telephony.Sms.TYPE)
      val bodyIndex = it.getColumnIndex(Telephony.Sms.BODY)
      val statusIndex = it.getColumnIndex(Telephony.Sms.STATUS)

      var count = 0
      while (it.moveToNext() && count < params.limit) {
        val message =
          SmsMessage(
            id = it.getLong(idIndex),
            threadId = it.getLong(threadIdIndex),
            address = it.getString(addressIndex),
            person = it.getString(personIndex),
            date = it.getLong(dateIndex),
            dateSent = it.getLong(dateSentIndex),
            read = it.getInt(readIndex) == 1,
            type = it.getInt(typeIndex),
            body = it.getString(bodyIndex),
            status = it.getInt(statusIndex),
          )
        messages.add(message)
        count++
      }
    }

    return messages
  }

  private fun querySmsMmsMessagesByPhone(
    phoneNumber: String,
    params: QueryParams,
  ): List<SmsMessage> {
    val lookupNumber = toByPhoneLookupNumber(phoneNumber)
    if (lookupNumber.isBlank()) {
      return emptyList()
    }

    val uri = "$MMS_SMS_BY_PHONE_BASE/${Uri.encode(lookupNumber)}".toUri()
    val projection = buildMixedByPhoneProjection()

    val maxCandidates = params.offset + params.limit
    if (maxCandidates <= 0) {
      return emptyList()
    }

    val reviewMode = shouldUseConversationReviewByPhoneMode(params)
    val topCandidates = mutableListOf<Pair<String, SmsMessage>>()
    val materializedCandidates = linkedMapOf<String, SmsMessage>()
    val cursor = context.contentResolver.query(uri, projection, null, null, "date DESC")
    cursor?.use {
      val idIndex = it.getColumnIndex("_id")
      val threadIdIndex = it.getColumnIndex("thread_id")
      val transportTypeIndex = it.getColumnIndex("transport_type")
      val addressIndex = it.getColumnIndex("address")
      val dateIndex = it.getColumnIndex("date")
      val dateSentIndex = it.getColumnIndex("date_sent")
      val readIndex = it.getColumnIndex("read")
      val typeIndex = it.getColumnIndex("type")
      val bodyIndex = it.getColumnIndex("body")
      val statusIndex = it.getColumnIndex("status")

      while (it.moveToNext()) {
        val id = if (idIndex >= 0 && !it.isNull(idIndex)) it.getLong(idIndex) else continue
        val rawDate = if (dateIndex >= 0 && !it.isNull(dateIndex)) it.getLong(dateIndex) else 0L
        val dateMs = normalizeProviderDateMillis(rawDate)

        if (params.startTime != null && dateMs < params.startTime) continue
        if (params.endTime != null && dateMs > params.endTime) continue

        val threadId = if (threadIdIndex >= 0 && !it.isNull(threadIdIndex)) it.getLong(threadIdIndex) else 0L
        val transportType =
          if (transportTypeIndex >= 0 &&
            !it.isNull(transportTypeIndex)
          ) {
            it.getString(transportTypeIndex)
          } else {
            null
          }
        val providerAddress = if (addressIndex >= 0 && !it.isNull(addressIndex)) it.getString(addressIndex) else null
        val mmsAddress = if (transportType.equals("mms", ignoreCase = true)) getMmsAddress(id, phoneNumber) else null
        val address = resolveMixedByPhoneRowAddress(providerAddress, phoneNumber, mmsAddress)
        var read = if (readIndex >= 0 && !it.isNull(readIndex)) it.getInt(readIndex) == 1 else true
        var type = if (typeIndex >= 0 && !it.isNull(typeIndex)) it.getInt(typeIndex) else 0
        var body = if (bodyIndex >= 0 && !it.isNull(bodyIndex)) it.getString(bodyIndex) else null
        val smsStatus = if (statusIndex >= 0 && !it.isNull(statusIndex)) it.getInt(statusIndex) else null

        // Only MMS transport rows are allowed to hydrate from MMS storage.
        if (shouldHydrateMmsByPhoneRow(transportType, body, type)) {
          body = body?.takeIf { msg -> msg.isNotBlank() } ?: getMmsTextBody(id)
          val mmsMeta = getMmsMeta(id)
          if (type == 0) {
            type = mmsMeta.first ?: type
          }
          if (readIndex < 0 || it.isNull(readIndex)) {
            read = mmsMeta.second ?: read
          }
        }

        val dateSentRaw = if (dateSentIndex >= 0 && !it.isNull(dateSentIndex)) it.getLong(dateSentIndex) else 0L
        val dateSentMs = normalizeProviderDateMillis(dateSentRaw)

        if (!params.keyword.isNullOrEmpty()) {
          val keyword = params.keyword
          if (body.isNullOrEmpty() || !body.contains(keyword, ignoreCase = true)) {
            continue
          }
        }
        if (params.type != null && type != params.type) continue
        if (params.isRead != null && read != params.isRead) continue

        val message =
          SmsMessage(
            id = id,
            threadId = threadId,
            address = address,
            person = null,
            date = dateMs,
            dateSent = dateSentMs,
            read = read,
            type = type,
            body = body,
            status = resolveMixedByPhoneRowStatus(transportType, smsStatus),
            transportType = transportType,
          )
        val identityKey = buildMixedRowIdentity(id, transportType)
        collectMixedByPhoneCandidate(
          topCandidates = topCandidates,
          materializedCandidates = materializedCandidates,
          identityKey = identityKey,
          message = message,
          maxCandidates = maxCandidates,
          reviewMode = reviewMode,
        )
      }
    }

    return pageMixedByPhoneCandidates(
      topCandidates = topCandidates,
      materializedCandidates = materializedCandidates,
      params = params,
      reviewMode = reviewMode,
    )
  }

  private fun getMmsTextBody(messageId: Long): String? {
    val cursor =
      context.contentResolver.query(
        MMS_PART_URI.toUri(),
        arrayOf("text", "ct"),
        "mid=?",
        arrayOf(messageId.toString()),
        null,
      )

    cursor?.use {
      val textIndex = it.getColumnIndex("text")
      val ctIndex = it.getColumnIndex("ct")
      while (it.moveToNext()) {
        val contentType = if (ctIndex >= 0 && !it.isNull(ctIndex)) it.getString(ctIndex) else null
        if (contentType != null && contentType != "text/plain") continue
        val text = if (textIndex >= 0 && !it.isNull(textIndex)) it.getString(textIndex) else null
        if (!text.isNullOrBlank()) return text
      }
    }

    return null
  }

  private fun getMmsMeta(messageId: Long): Pair<Int?, Boolean?> {
    val cursor =
      context.contentResolver.query(
        "$MMS_CONTENT_BASE/$messageId".toUri(),
        arrayOf("msg_box", "read"),
        null,
        null,
        null,
      )

    cursor?.use {
      if (it.moveToFirst()) {
        val msgBoxIndex = it.getColumnIndex("msg_box")
        val readIndex = it.getColumnIndex("read")
        val msgBox = if (msgBoxIndex >= 0 && !it.isNull(msgBoxIndex)) it.getInt(msgBoxIndex) else null
        val mappedType = mapMmsMsgBoxToSearchType(msgBox)
        val read = if (readIndex >= 0 && !it.isNull(readIndex)) it.getInt(readIndex) == 1 else null
        return mappedType to read
      }
    }

    return null to null
  }

  private fun getMmsAddress(
    messageId: Long,
    phoneNumber: String,
  ): String? {
    val lookupNumber = toByPhoneLookupNumber(phoneNumber)
    if (lookupNumber.isBlank()) {
      return null
    }

    val cursor =
      context.contentResolver.query(
        "$MMS_CONTENT_BASE/$messageId/addr".toUri(),
        arrayOf("address", "type"),
        null,
        null,
        null,
      )

    cursor?.use {
      val addressIndex = it.getColumnIndex("address")
      val typeIndex = it.getColumnIndex("type")
      val addressRows = mutableListOf<Pair<String?, Int?>>()
      while (it.moveToNext()) {
        val address = if (addressIndex >= 0 && !it.isNull(addressIndex)) it.getString(addressIndex) else null
        val type = if (typeIndex >= 0 && !it.isNull(typeIndex)) it.getInt(typeIndex) else null
        addressRows.add(address to type)
      }
      return selectPreferredMmsAddress(addressRows, lookupNumber)
    }

    return null
  }
}
