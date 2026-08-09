package ai.openclaw.app.gateway

import android.content.Context
import android.net.DnsResolver
import android.net.Network
import android.os.Build
import android.os.CancellationSignal
import androidx.annotation.RequiresApi
import kotlinx.coroutines.suspendCancellableCoroutine
import java.util.concurrent.Executor
import kotlin.coroutines.resume
import kotlin.coroutines.resumeWithException

@RequiresApi(Build.VERSION_CODES.Q)
internal class GatewaySystemDnsApi29(
  context: Context,
  private val executor: Executor,
) : GatewaySystemDns {
  private val resolver = createDnsResolver(context)

  override suspend fun rawQuery(
    network: Network?,
    wireQuery: ByteArray,
  ): ByteArray =
    suspendCancellableCoroutine { cont ->
      val signal = CancellationSignal()
      cont.invokeOnCancellation { signal.cancel() }
      resolver.rawQuery(
        network,
        wireQuery,
        DnsResolver.FLAG_EMPTY,
        executor,
        signal,
        object : DnsResolver.Callback<ByteArray> {
          override fun onAnswer(
            answer: ByteArray,
            rcode: Int,
          ) {
            cont.resume(answer)
          }

          override fun onError(error: DnsResolver.DnsException) {
            cont.resumeWithException(error)
          }
        },
      )
    }
}

@RequiresApi(Build.VERSION_CODES.Q)
private fun createDnsResolver(context: Context): DnsResolver =
  if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.CINNAMON_BUN) {
    createContextDnsResolver(context)
  } else {
    createLegacyDnsResolver()
  }

@RequiresApi(Build.VERSION_CODES.CINNAMON_BUN)
private fun createContextDnsResolver(context: Context): DnsResolver = DnsResolver(context, null)

@Suppress("DEPRECATION")
@RequiresApi(Build.VERSION_CODES.Q)
private fun createLegacyDnsResolver(): DnsResolver = DnsResolver.getInstance()
