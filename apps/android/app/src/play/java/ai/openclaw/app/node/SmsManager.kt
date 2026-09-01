package ai.openclaw.app.node

import ai.openclaw.app.PermissionRequester
import android.content.Context

class SmsManager(
  @Suppress("unused") private val context: Context,
) {
  data class SendResult(
    val ok: Boolean,
    val to: String,
    val message: String?,
    val error: String? = null,
    val payloadJson: String,
  )

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

  fun attachPermissionRequester(
    @Suppress("unused") requester: PermissionRequester,
  ) {
  }

  fun canSendSms(): Boolean = false

  fun canSearchSms(): Boolean = false

  fun canReadSms(): Boolean = false

  fun hasTelephonyFeature(): Boolean = false

  suspend fun send(paramsJson: String?): SendResult =
    SendResult(
      ok = false,
      to = "",
      message = null,
      error = "SMS_PERMISSION_REQUIRED: grant SMS permission",
      payloadJson = unavailablePayload(paramsJson),
    )

  suspend fun search(paramsJson: String?): SearchResult =
    SearchResult(
      ok = false,
      messages = emptyList(),
      error = "SMS_PERMISSION_REQUIRED: grant READ_SMS permission",
      payloadJson = unavailablePayload(paramsJson),
    )

  private fun unavailablePayload(paramsJson: String?): String = """{"ok":false,"error":"SMS_UNAVAILABLE","paramsProvided":${!paramsJson.isNullOrBlank()}}"""
}
