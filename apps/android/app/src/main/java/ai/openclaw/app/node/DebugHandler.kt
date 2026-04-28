package ai.openclaw.app.node

import ai.openclaw.app.BuildConfig
import ai.openclaw.app.gateway.DeviceIdentityStore
import ai.openclaw.app.gateway.GatewaySession
import android.content.Context
import kotlinx.serialization.json.JsonPrimitive

private const val LOGCAT_PATH = "/system/bin/logcat"

class DebugHandler(
  private val appContext: Context,
  private val identityStore: DeviceIdentityStore,
) {
  fun handleEd25519(): GatewaySession.InvokeResult {
    if (!BuildConfig.DEBUG) {
      return GatewaySession.InvokeResult.error(code = "UNAVAILABLE", message = "debug commands are disabled in release builds")
    }
    // Self-test Ed25519 signing and return diagnostic info
    try {
      val identity = identityStore.loadOrCreate()
      val testPayload = "test|${identity.deviceId}|${System.currentTimeMillis()}"
      val results = mutableListOf<String>()
      results.add("deviceId: ${identity.deviceId}")
      results.add("publicKeyRawBase64: ${identity.publicKeyRawBase64.take(20)}...")
      results.add("privateKeyPkcs8Base64: ${identity.privateKeyPkcs8Base64.take(20)}...")

      // Test publicKeyBase64Url
      val pubKeyUrl = identityStore.publicKeyBase64Url(identity)
      results.add("publicKeyBase64Url: ${pubKeyUrl ?: "NULL (FAILED)"}")

      // Test signing
      val signature = identityStore.signPayload(testPayload, identity)
      results.add("signPayload: ${if (signature != null) "${signature.take(20)}... (OK)" else "NULL (FAILED)"}")

      // Test self-verify
      if (signature != null) {
        val verifyOk = identityStore.verifySelfSignature(testPayload, signature, identity)
        results.add("verifySelfSignature: $verifyOk")
      }

      // Check available providers
      val providers = java.security.Security.getProviders()
      val ed25519Providers =
        providers.filter { p ->
          p.services.any { s -> s.algorithm.contains("Ed25519", ignoreCase = true) }
        }
      results.add("Ed25519 providers: ${ed25519Providers.map { "${it.name} v${it.version}" }}")
      results.add("Provider order: ${providers.take(5).map { it.name }}")

      // Test KeyFactory directly
      try {
        val kf = java.security.KeyFactory.getInstance("Ed25519")
        results.add("KeyFactory.Ed25519: ${kf.provider.name} (OK)")
      } catch (e: Throwable) {
        results.add("KeyFactory.Ed25519: FAILED - ${e.javaClass.simpleName}: ${e.message}")
      }

      // Test Signature directly
      try {
        val sig = java.security.Signature.getInstance("Ed25519")
        results.add("Signature.Ed25519: ${sig.provider.name} (OK)")
      } catch (e: Throwable) {
        results.add("Signature.Ed25519: FAILED - ${e.javaClass.simpleName}: ${e.message}")
      }

      val diagnostics = results.joinToString("\n")
      return GatewaySession.InvokeResult.ok("""{"diagnostics":${JsonPrimitive(diagnostics)}}""")
    } catch (e: Throwable) {
      return GatewaySession.InvokeResult.error(
        code = "ED25519_TEST_FAILED",
        message = "${e.javaClass.simpleName}: ${e.message}\n${e.stackTraceToString().take(500)}",
      )
    }
  }

  fun handleLogs(): GatewaySession.InvokeResult {
    if (!BuildConfig.DEBUG) {
      return GatewaySession.InvokeResult.error(code = "UNAVAILABLE", message = "debug commands are disabled in release builds")
    }
    val pid = android.os.Process.myPid()
    val rt = Runtime.getRuntime()
    val info = "v6 pid=$pid thread=${Thread.currentThread().name} free=${rt.freeMemory() / 1024}K total=${rt.totalMemory() / 1024}K max=${rt.maxMemory() / 1024}K uptime=${android.os.SystemClock.elapsedRealtime() / 1000}s sdk=${android.os.Build.VERSION.SDK_INT} device=${android.os.Build.MODEL}\n"
    // Run logcat on current dispatcher thread (no withContext) with file redirect
    val logResult =
      try {
        val tmpFile = java.io.File(appContext.cacheDir, "debug_logs.txt")
        if (tmpFile.exists()) tmpFile.delete()
        val pb = ProcessBuilder(LOGCAT_PATH, "-d", "-t", "200", "--pid=$pid")
        pb.redirectOutput(tmpFile)
        pb.redirectErrorStream(true)
        val proc = pb.start()
        val finished = proc.waitFor(4, java.util.concurrent.TimeUnit.SECONDS)
        if (!finished) proc.destroyForcibly()
        val raw =
          if (tmpFile.exists() && tmpFile.length() > 0) {
            tmpFile.readText().take(128000)
          } else {
            "(no output, finished=$finished, exists=${tmpFile.exists()})"
          }
        tmpFile.delete()
        val spamPatterns =
          listOf(
            "setRequestedFrameRate",
            "I View    :",
            "BLASTBufferQueue",
            "VRI[Pop-Up",
            "InsetsController:",
            "VRI[MainActivity",
            "InsetsSource:",
            "handleResized",
            "ProfileInstaller",
            "I VRI[",
            "onStateChanged: host=",
            "D StrictMode:",
            "E StrictMode:",
            "ImeFocusController",
            "InputTransport",
            "IncorrectContextUseViolation",
          )
        val sb = StringBuilder()
        for (line in raw.lineSequence()) {
          if (line.isBlank()) continue
          if (spamPatterns.any { line.contains(it) }) continue
          if (sb.length + line.length > 16000) {
            sb.append("\n(truncated)")
            break
          }
          if (sb.isNotEmpty()) sb.append('\n')
          sb.append(line)
        }
        sb.toString().ifEmpty { "(all ${raw.lines().size} lines filtered as spam)" }
      } catch (e: Throwable) {
        "(logcat error: ${e::class.java.simpleName}: ${e.message})"
      }
    // Also include camera debug log if it exists
    val camLogFile = java.io.File(appContext.cacheDir, "camera_debug.log")
    val camLog =
      if (camLogFile.exists() && camLogFile.length() > 0) {
        "\n--- camera_debug.log ---\n" + camLogFile.readText().take(4000)
      } else {
        ""
      }
    return GatewaySession.InvokeResult.ok("""{"logs":${JsonPrimitive(info + logResult + camLog)}}""")
  }
}
