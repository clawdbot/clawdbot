package ai.openclaw.app.node

import ai.openclaw.app.gateway.GatewaySession

class SmsHandler(
  private val sms: SmsManager,
) {
  suspend fun handleSmsSend(paramsJson: String?): GatewaySession.InvokeResult {
    val res = sms.send(paramsJson)
    if (res.ok) {
      return GatewaySession.InvokeResult.ok(res.payloadJson)
    }
    return errorResult(res.error, defaultCode = "SMS_SEND_FAILED")
  }

  suspend fun handleSmsSearch(paramsJson: String?): GatewaySession.InvokeResult {
    val res = sms.search(paramsJson)
    if (res.ok) {
      return GatewaySession.InvokeResult.ok(res.payloadJson)
    }
    return errorResult(res.error, defaultCode = "SMS_SEARCH_FAILED")
  }

  private fun errorResult(
    error: String?,
    defaultCode: String,
  ): GatewaySession.InvokeResult {
    val rawMessage = error ?: defaultCode
    val idx = rawMessage.indexOf(':')
    val code = if (idx > 0) rawMessage.substring(0, idx).trim() else defaultCode
    val message =
      if (idx > 0 && code == rawMessage.substring(0, idx).trim()) {
        rawMessage.substring(idx + 1).trim().ifEmpty { rawMessage }
      } else {
        rawMessage
      }
    return GatewaySession.InvokeResult.error(code = code, message = message)
  }
}
