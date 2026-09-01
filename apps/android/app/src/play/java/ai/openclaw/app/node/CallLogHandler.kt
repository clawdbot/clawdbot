package ai.openclaw.app.node

import ai.openclaw.app.gateway.GatewaySession
import android.content.Context

internal data class CallLogRecord(
  val number: String?,
  val cachedName: String?,
  val date: Long,
  val duration: Long,
  val type: Int,
)

internal data class CallLogSearchRequest(
  val limit: Int,
  val offset: Int,
  val cachedName: String?,
  val number: String?,
  val date: Long?,
  val dateStart: Long?,
  val dateEnd: Long?,
  val duration: Long?,
  val type: Int?,
)

internal interface CallLogDataSource {
  fun hasReadPermission(context: Context): Boolean

  fun search(
    context: Context,
    request: CallLogSearchRequest,
  ): List<CallLogRecord>
}

class CallLogHandler private constructor() {
  constructor(
    @Suppress("unused") appContext: Context,
  ) : this()

  fun handleCallLogSearch(
    @Suppress("unused") paramsJson: String?,
  ): GatewaySession.InvokeResult =
    GatewaySession.InvokeResult.error(
      code = "CALL_LOG_UNAVAILABLE",
      message = "CALL_LOG_UNAVAILABLE: call log not available on this build",
    )

  companion object {
    internal fun forTesting(
      @Suppress("unused") appContext: Context,
      @Suppress("unused") dataSource: CallLogDataSource,
    ): CallLogHandler = CallLogHandler()
  }
}
