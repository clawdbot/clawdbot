package ai.openclaw.app.gateway

import android.content.Context
import android.net.Network
import android.os.Build
import java.util.concurrent.Executor

/** API-neutral system DNS seam; API 28 falls through to dnsjava resolution. */
internal interface GatewaySystemDns {
  suspend fun rawQuery(
    network: Network?,
    wireQuery: ByteArray,
  ): ByteArray
}

internal fun createGatewaySystemDns(
  context: Context,
  executor: Executor,
): GatewaySystemDns? =
  if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
    GatewaySystemDnsApi29(context, executor)
  } else {
    null
  }
