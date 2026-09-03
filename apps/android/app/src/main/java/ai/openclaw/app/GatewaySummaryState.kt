package ai.openclaw.app

import ai.openclaw.app.i18n.NativeText

data class GatewaySummaryState<T>(
  val summary: T,
  val refreshing: Boolean = false,
  val errorText: NativeText? = null,
)
