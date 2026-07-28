package ai.openclaw.app.wear

import ai.openclaw.wear.shared.WearProtocol
import android.content.Intent
import android.content.pm.PackageManager
import android.net.Uri
import com.google.android.gms.wearable.ChannelClient
import com.google.android.gms.wearable.MessageClient
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34])
class WearProxyListenerManifestTest {
  @Test
  fun protocolRequestsResolveToBridgeService() {
    assertTrue(
      resolvesToBridgeService(
        action = MessageClient.ACTION_MESSAGE_RECEIVED,
        path = WearProtocol.REQUEST_PATH,
      ),
    )
  }

  @Test
  fun realtimeAudioChannelsResolveToBridgeService() {
    assertTrue(
      resolvesToBridgeService(
        action = ChannelClient.ACTION_CHANNEL_EVENT,
        path = WearProtocol.REALTIME_AUDIO_CHANNEL_PATH,
      ),
    )
  }

  @Test
  fun responseAndLegacyRequestRoutesDoNotResolveToPhoneBridge() {
    assertFalse(
      resolvesToBridgeService(
        action = MessageClient.ACTION_MESSAGE_RECEIVED,
        path = WearProtocol.RESPONSE_PATH,
      ),
    )
    assertFalse(
      resolvesToBridgeService(
        action = MessageClient.ACTION_REQUEST_RECEIVED,
        path = WearProtocol.REQUEST_PATH,
      ),
    )
    assertFalse(
      resolvesToBridgeService(
        action = MessageClient.ACTION_MESSAGE_RECEIVED,
        path = "/openclaw/v1/conversation",
      ),
    )
  }

  private fun resolvesToBridgeService(
    action: String,
    path: String,
  ): Boolean {
    val intent =
      Intent(
        action,
        Uri.parse("wear://watch-node$path"),
      )
    val services =
      RuntimeEnvironment
        .getApplication()
        .packageManager
        .queryIntentServices(
          intent,
          PackageManager.ResolveInfoFlags.of(PackageManager.MATCH_ALL.toLong()),
        )

    return services.any { resolveInfo ->
      resolveInfo.serviceInfo.name == WearProxyListenerService::class.java.name
    }
  }
}
