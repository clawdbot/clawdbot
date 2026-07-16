package ai.openclaw.app

import ai.openclaw.app.gateway.GatewayEndpoint
import android.Manifest
import android.content.Context
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeout
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import org.robolectric.Shadows.shadowOf
import java.util.UUID

@RunWith(RobolectricTestRunner::class)
class VoiceWakeRuntimeTest {
  @Test
  fun disconnectedSaveDoesNotCreateLocalOverride() {
    val runtime = createTestRuntime()

    runtime.setVoiceWakeWords(listOf("hey claw"))

    assertEquals(listOf("openclaw", "claude", "computer"), runtime.voiceWakeWords.value)
    assertEquals("Connect to a Gateway to save wake words", runtime.voiceWakeWordsNoticeText.value)
    assertFalse(runtime.voiceWakeWordsSaving.value)
  }

  @Test
  fun successfulSaveCommitsGatewayCanonicalWords() =
    runBlocking {
      val runtime = createTestRuntime()
      seedConnectedRuntime(runtime)
      runtime.gatewayDataRequestOverrideForTests = { _, method, _ ->
        assertEquals("voicewake.set", method)
        """{"triggers":[" gateway claw "]}"""
      }

      runtime.setVoiceWakeWords(listOf("local draft"))
      withTimeout(5_000) {
        while (runtime.voiceWakeWordsSaving.value) delay(10)
      }

      assertEquals(listOf("gateway claw"), runtime.voiceWakeWords.value)
      assertEquals("Wake words saved", runtime.voiceWakeWordsNoticeText.value)
    }

  @Test
  fun failedGatewaySaveKeepsAuthoritativeWords() =
    runBlocking {
      val runtime = createTestRuntime()
      seedConnectedRuntime(runtime)
      runtime.gatewayDataRequestOverrideForTests = { _, _, _ -> error("write rejected") }

      runtime.setVoiceWakeWords(listOf("local draft"))
      withTimeout(5_000) {
        while (runtime.voiceWakeWordsSaving.value) delay(10)
      }

      assertEquals(listOf("openclaw", "claude", "computer"), runtime.voiceWakeWords.value)
      assertEquals("Could not save wake words", runtime.voiceWakeWordsNoticeText.value)
    }

  @Test
  fun responseFromRetiredGatewayDoesNotPublish() =
    runBlocking {
      val runtime = createTestRuntime()
      seedConnectedRuntime(runtime)
      val response = CompletableDeferred<String>()
      runtime.gatewayDataRequestOverrideForTests = { _, _, _ -> response.await() }

      runtime.setVoiceWakeWords(listOf("stale words"))
      withTimeout(5_000) {
        while (!runtime.voiceWakeWordsSaving.value) delay(10)
      }
      writeField(runtime, "gatewayDataGeneration", 1L)
      response.complete("""{"triggers":["stale words"]}""")
      withTimeout(5_000) {
        while (runtime.voiceWakeWordsSaving.value) delay(10)
      }

      assertEquals(listOf("openclaw", "claude", "computer"), runtime.voiceWakeWords.value)
      assertEquals(null, runtime.voiceWakeWordsNoticeText.value)
    }

  @Test
  fun delayedSaveResponseCannotOverwriteNewerGatewayEvent() =
    runBlocking {
      val runtime = createTestRuntime()
      val endpoint = seedConnectedRuntime(runtime)
      val response = CompletableDeferred<String>()
      runtime.gatewayDataRequestOverrideForTests = { _, _, _ -> response.await() }

      runtime.setVoiceWakeWords(listOf("local draft"))
      withTimeout(5_000) {
        while (!runtime.voiceWakeWordsSaving.value) delay(10)
      }
      runtime.applyNodeVoiceWakeWords(
        endpointStableId = endpoint.stableId,
        payloadJson = """{"triggers":["newer gateway words"]}""",
        isCurrentConnection = { true },
      )
      response.complete("""{"triggers":["local draft"]}""")
      withTimeout(5_000) {
        while (runtime.voiceWakeWordsSaving.value) delay(10)
      }

      assertEquals(listOf("newer gateway words"), runtime.voiceWakeWords.value)
    }

  @Test
  fun nodeOnlyVoiceWakeEventPublishesForCurrentGateway() {
    val runtime = createTestRuntime()
    val endpoint = seedConnectedRuntime(runtime)

    runtime.applyNodeVoiceWakeWords(
      endpointStableId = endpoint.stableId,
      payloadJson = """{"triggers":[" node claw "]}""",
      isCurrentConnection = { true },
    )

    assertEquals(listOf("node claw"), runtime.voiceWakeWords.value)
  }

  @Test
  fun nodeOnlyVoiceWakeEventIgnoresRetiredConnection() {
    val runtime = createTestRuntime()
    val endpoint = seedConnectedRuntime(runtime)

    runtime.applyNodeVoiceWakeWords(
      endpointStableId = endpoint.stableId,
      payloadJson = """{"triggers":[" stale claw "]}""",
      isCurrentConnection = { false },
    )

    assertEquals(listOf("openclaw", "claude", "computer"), runtime.voiceWakeWords.value)
  }

  @Test
  fun gatewaySwitchClearsWordsAndBlocksSaveUntilRefresh() {
    val runtime = createTestRuntime()
    val firstEndpoint = seedConnectedRuntime(runtime)
    runtime.applyNodeVoiceWakeWords(
      endpointStableId = firstEndpoint.stableId,
      payloadJson = """{"triggers":["gateway a"]}""",
      isCurrentConnection = { true },
    )
    assertEquals(listOf("gateway a"), runtime.voiceWakeWords.value)

    val secondEndpoint = GatewayEndpoint.manual("127.0.0.2", 18789)
    writeField(runtime, "connectedEndpoint", secondEndpoint)
    invokeNoArg(runtime, "invalidateVoiceWakeWordsForGateway")
    runtime.setVoiceWakeWords(listOf("stale overwrite"))

    assertEquals(listOf("openclaw", "claude", "computer"), runtime.voiceWakeWords.value)
    assertEquals("Connect to a Gateway to save wake words", runtime.voiceWakeWordsNoticeText.value)
  }

  @Test
  fun capabilityRefreshTracksGatewayWakeWordReadiness() {
    val app = RuntimeEnvironment.getApplication()
    shadowOf(app).grantPermissions(Manifest.permission.RECORD_AUDIO)
    val securePrefs =
      app.getSharedPreferences(
        "openclaw.node.voicewake.runtime.test.${UUID.randomUUID()}",
        Context.MODE_PRIVATE,
      )
    val prefs = SecurePrefs(app, securePrefsOverride = securePrefs)
    prefs.setVoiceWakeEnabled(true)
    val runtime = NodeRuntime(app, prefs, mode = NodeRuntimeMode.ScreenshotFixture)
    val endpoint = GatewayEndpoint.manual("127.0.0.1", 18789)
    writeField(runtime, "connectedEndpoint", endpoint)

    assertFalse(readField<Boolean>(runtime, "lastVoiceWakeCapabilityEnabled"))
    writeField(runtime, "voiceWakeWordsGatewayStableId", endpoint.stableId)
    readField<CoroutineScope>(runtime, "scope").coroutineContext[Job]?.cancel()
    invokeNoArg(runtime, "refreshVoiceWakeCapabilitySurfaceIfChanged")

    assertTrue(readField<Boolean>(runtime, "lastVoiceWakeCapabilityEnabled"))
  }

  @Test
  fun cameraAudioOwnershipBlocksVoiceNoteUntilRelease() {
    val runtime = createTestRuntime()

    assertEquals(true, runtime.setCameraAudioCaptureActive(true))
    assertFalse(runtime.tryAcquireVoiceNoteMic())

    assertEquals(true, runtime.setCameraAudioCaptureActive(false))
    assertEquals(true, runtime.tryAcquireVoiceNoteMic())
    runtime.releaseVoiceNoteMic()
  }

  private fun createTestRuntime(): NodeRuntime {
    val app = RuntimeEnvironment.getApplication()
    val securePrefs =
      app.getSharedPreferences(
        "openclaw.node.voicewake.runtime.test.${UUID.randomUUID()}",
        Context.MODE_PRIVATE,
      )
    return NodeRuntime(app, SecurePrefs(app, securePrefsOverride = securePrefs))
  }

  private fun seedConnectedRuntime(runtime: NodeRuntime): GatewayEndpoint {
    val endpoint = GatewayEndpoint.manual("127.0.0.1", 18789)
    writeField(runtime, "connectedEndpoint", endpoint)
    runtime.applyNodeVoiceWakeWords(
      endpointStableId = endpoint.stableId,
      payloadJson = """{"triggers":["openclaw","claude","computer"]}""",
      isCurrentConnection = { true },
    )
    return endpoint
  }

  private fun invokeNoArg(
    target: Any,
    name: String,
  ) {
    val method = target.javaClass.getDeclaredMethod(name)
    method.isAccessible = true
    method.invoke(target)
  }

  private fun writeField(
    target: Any,
    name: String,
    value: Any?,
  ) {
    var type: Class<*>? = target.javaClass
    while (type != null) {
      val field = runCatching { type.getDeclaredField(name) }.getOrNull()
      if (field != null) {
        field.isAccessible = true
        field.set(target, value)
        return
      }
      type = type.superclass
    }
    error("missing field $name")
  }

  @Suppress("UNCHECKED_CAST")
  private fun <T> readField(
    target: Any,
    name: String,
  ): T {
    var type: Class<*>? = target.javaClass
    while (type != null) {
      val field = runCatching { type.getDeclaredField(name) }.getOrNull()
      if (field != null) {
        field.isAccessible = true
        return field.get(target) as T
      }
      type = type.superclass
    }
    error("missing field $name")
  }
}
