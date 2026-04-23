package ai.openclaw.app.ui

import java.util.Base64
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner

@RunWith(RobolectricTestRunner::class)
class GatewayConfigResolverTest {
  @Test
  fun parseGatewayEndpointUsesDefaultTlsPortForBareWssUrls() {
    val parsed = parseGatewayEndpoint("wss://gateway.example")

    assertEquals(
      GatewayEndpointConfig(
        host = "gateway.example",
        port = 443,
        tls = true,
        displayUrl = "https://gateway.example",
      ),
      parsed,
    )
  }

  @Test
  fun parseGatewayEndpointRejectsNonLoopbackCleartextWsUrls() {
    val parsed = parseGatewayEndpoint("ws://gateway.example")

    assertNull(parsed)
  }

  @Test
  fun parseGatewayEndpointRejectsTailnetCleartextWsUrls() {
    val parsed = parseGatewayEndpoint("ws://100.64.0.9:18789")

    assertNull(parsed)
  }

  @Test
  fun parseGatewayEndpointOmitsExplicitDefaultTlsPortFromDisplayUrl() {
    val parsed = parseGatewayEndpoint("https://gateway.example:443")

    assertEquals(
      GatewayEndpointConfig(
        host = "gateway.example",
        port = 443,
        tls = true,
        displayUrl = "https://gateway.example",
      ),
      parsed,
    )
  }

  @Test
  fun parseGatewayEndpointAllowsLoopbackCleartextWsUrls() {
    val parsed = parseGatewayEndpoint("ws://127.0.0.1")

    assertEquals(
      GatewayEndpointConfig(
        host = "127.0.0.1",
        port = 18789,
        tls = false,
        displayUrl = "http://127.0.0.1:18789",
      ),
      parsed,
    )
  }

  @Test
  fun parseGatewayEndpointAllowsLocalhostCleartextWsUrls() {
    val parsed = parseGatewayEndpoint("ws://localhost:18789")

    assertEquals(
      GatewayEndpointConfig(
        host = "localhost",
        port = 18789,
        tls = false,
        displayUrl = "http://localhost:18789",
      ),
      parsed,
    )
  }

  @Test
  fun parseGatewayEndpointAllowsAndroidEmulatorCleartextWsUrls() {
    val parsed = parseGatewayEndpoint("ws://10.0.2.2:18789")

    assertEquals(
      GatewayEndpointConfig(
        host = "10.0.2.2",
        port = 18789,
        tls = false,
        displayUrl = "http://10.0.2.2:18789",
      ),
      parsed,
    )
  }

  @Test
  fun parseGatewayEndpointRejectsPrivateLanCleartextWsUrls() {
    val parsed = parseGatewayEndpoint("ws://192.168.1.20:18789")
    assertNull(parsed)
  }

  @Test
  fun parseGatewayEndpointRejectsMdnsCleartextWsUrls() {
    val parsed = parseGatewayEndpoint("ws://gateway.local:18789")

    assertNull(parsed)
  }

  @Test
  fun parseGatewayEndpointAllowsIpv6LoopbackCleartextWsUrls() {
    val parsed = parseGatewayEndpoint("ws://[::1]")

    assertEquals("::1", parsed?.host)
    assertEquals(18789, parsed?.port)
    assertEquals(false, parsed?.tls)
    assertEquals("http://[::1]:18789", parsed?.displayUrl)
  }

  @Test
  fun parseGatewayEndpointAllowsIpv4MappedIpv6LoopbackCleartextWsUrls() {
    val parsed = parseGatewayEndpoint("ws://[::ffff:127.0.0.1]")

    assertEquals("::ffff:127.0.0.1", parsed?.host)
    assertEquals(18789, parsed?.port)
    assertEquals(false, parsed?.tls)
    assertEquals("http://[::ffff:127.0.0.1]:18789", parsed?.displayUrl)
  }

  @Test
  fun parseGatewayEndpointRejectsCleartextLoopbackPrefixBypassHost() {
    val parsed = parseGatewayEndpoint("http://127.attacker.example:80")

    assertNull(parsed)
  }

  @Test
  fun parseGatewayEndpointRejectsNonLoopbackIpv6CleartextWsUrls() {
    val parsed = parseGatewayEndpoint("ws://[2001:db8::1]")

    assertNull(parsed)
  }

  @Test
  fun parseGatewayEndpointRejectsLinkLocalIpv6ZoneCleartextWsUrls() {
    val parsed = parseGatewayEndpoint("ws://[fe80::1%25eth0]")
    assertNull(parsed)
  }

  @Test
  fun parseGatewayEndpointAllowsSecureIpv6ZoneUrls() {
    val parsed = parseGatewayEndpoint("wss://[fe80::1%25wlan0]:443")

    assertEquals("fe80::1%25wlan0", parsed?.host)
    assertEquals(443, parsed?.port)
    assertEquals(true, parsed?.tls)
    assertEquals("https://[fe80::1%25wlan0]", parsed?.displayUrl)
  }

  @Test
  fun parseGatewayEndpointRejectsUnspecifiedIpv4CleartextHttpUrls() {
    val parsed = parseGatewayEndpoint("http://0.0.0.0:80")

    assertNull(parsed)
  }

  @Test
  fun parseGatewayEndpointRejectsUnspecifiedIpv6CleartextWsUrls() {
    val parsed = parseGatewayEndpoint("ws://[::]")

    assertNull(parsed)
  }

  @Test
  fun parseGatewayEndpointAllowsLoopbackCleartextHttpUrls() {
    val parsed = parseGatewayEndpoint("http://localhost:80")

    assertEquals(
      GatewayEndpointConfig(
        host = "localhost",
        port = 80,
        tls = false,
        displayUrl = "http://localhost:80",
      ),
      parsed,
    )
  }

  @Test
  fun resolveScannedSetupCodeAcceptsRawSetupCode() {
    val setupCode =
      encodeSetupCode("""{"url":"wss://gateway.example:18789","bootstrapToken":"bootstrap-1"}""")

    val resolved = resolveScannedSetupCode(setupCode)

    assertEquals(setupCode, resolved)
  }

  @Test
  fun resolveScannedSetupCodeAcceptsQrJsonPayload() {
    val setupCode =
      encodeSetupCode("""{"url":"wss://gateway.example:18789","bootstrapToken":"bootstrap-1"}""")
    val qrJson =
      """
      {
        "setupCode": "$setupCode",
        "gatewayUrl": "wss://gateway.example:18789",
        "auth": "password",
        "urlSource": "gateway.remote.url"
      }
      """.trimIndent()

    val resolved = resolveScannedSetupCode(qrJson)

    assertEquals(setupCode, resolved)
  }

  @Test
  fun resolveScannedSetupCodeRejectsInvalidInput() {
    val resolved = resolveScannedSetupCode("not-a-valid-setup-code")
    assertNull(resolved)
  }

  @Test
  fun resolveScannedSetupCodeRejectsJsonWithInvalidSetupCode() {
    val qrJson = """{"setupCode":"invalid"}"""
    val resolved = resolveScannedSetupCode(qrJson)
    assertNull(resolved)
  }

  @Test
  fun resolveScannedSetupCodeRejectsJsonWithNonStringSetupCode() {
    val qrJson = """{"setupCode":{"nested":"value"}}"""
    val resolved = resolveScannedSetupCode(qrJson)
    assertNull(resolved)
  }

  @Test
  fun resolveScannedSetupCodeRejectsNonLoopbackCleartextGateway() {
    val setupCode =
      encodeSetupCode("""{"url":"ws://attacker.example:18789","bootstrapToken":"bootstrap-1"}""")

    val resolved = resolveScannedSetupCode(setupCode)

    assertNull(resolved)
  }

  @Test
  fun resolveScannedSetupCodeResultFlagsInsecureRemoteGateway() {
    val setupCode =
      encodeSetupCode("""{"url":"ws://attacker.example:18789","bootstrapToken":"bootstrap-1"}""")

    val resolved = resolveScannedSetupCodeResult(setupCode)

    assertNull(resolved.setupCode)
    assertEquals(GatewayEndpointValidationError.INSECURE_REMOTE_URL, resolved.error)
  }

  @Test
  fun parseGatewayEndpointResultFlagsInsecureRemoteGateway() {
    val parsed = parseGatewayEndpointResult("ws://gateway.example:18789")

    assertNull(parsed.config)
    assertEquals(GatewayEndpointValidationError.INSECURE_REMOTE_URL, parsed.error)
  }

  @Test
  fun parseGatewayEndpointResultFlagsInsecureLanCleartextGateway() {
    val parsed = parseGatewayEndpointResult("ws://192.168.1.20:18789")
    assertNull(parsed.config)
    assertEquals(GatewayEndpointValidationError.INSECURE_REMOTE_URL, parsed.error)
  }

  @Test
  fun decodeGatewaySetupCodeParsesBootstrapToken() {
    val setupCode =
      encodeSetupCode("""{"url":"wss://gateway.example:18789","bootstrapToken":"bootstrap-1"}""")

    val decoded = decodeGatewaySetupCode(setupCode)

    assertEquals("wss://gateway.example:18789", decoded?.url)
    assertEquals("bootstrap-1", decoded?.bootstrapToken)
    assertNull(decoded?.token)
    assertNull(decoded?.password)
  }

  @Test
  fun resolveGatewayConnectConfigPrefersBootstrapTokenFromSetupCode() {
    val setupCode =
      encodeSetupCode("""{"url":"wss://gateway.example:18789","bootstrapToken":"bootstrap-1"}""")

    val resolved =
      resolveGatewayConnectConfig(
        useSetupCode = true,
        setupCode = setupCode,
        savedManualHost = "",
        savedManualPort = "",
        savedManualTls = true,
        manualHostInput = "",
        manualPortInput = "",
        manualTlsInput = true,
        fallbackBootstrapToken = "",
        fallbackToken = "shared-token",
        fallbackPassword = "shared-password",
      )

    assertEquals("gateway.example", resolved?.host)
    assertEquals(18789, resolved?.port)
    assertEquals(true, resolved?.tls)
    assertEquals("bootstrap-1", resolved?.bootstrapToken)
    assertNull(resolved?.token?.takeIf { it.isNotEmpty() })
    assertNull(resolved?.password?.takeIf { it.isNotEmpty() })
  }

  @Test
  fun resolveGatewayConnectConfigDefaultsPortlessWssSetupCodeTo443() {
    val setupCode =
      encodeSetupCode("""{"url":"wss://gateway.example","bootstrapToken":"bootstrap-1"}""")

    val resolved =
      resolveGatewayConnectConfig(
        useSetupCode = true,
        setupCode = setupCode,
        savedManualHost = "",
        savedManualPort = "",
        savedManualTls = true,
        manualHostInput = "",
        manualPortInput = "",
        manualTlsInput = true,
        fallbackBootstrapToken = "",
        fallbackToken = "shared-token",
        fallbackPassword = "shared-password",
      )

    assertEquals("gateway.example", resolved?.host)
    assertEquals(443, resolved?.port)
    assertEquals(true, resolved?.tls)
    assertEquals("bootstrap-1", resolved?.bootstrapToken)
    assertNull(resolved?.token?.takeIf { it.isNotEmpty() })
    assertNull(resolved?.password?.takeIf { it.isNotEmpty() })
  }

  @Test
  fun resolveGatewayConnectConfigManualPreservesBootstrapTokenWhenNoReplacementAuthExists() {
    val resolved =
      resolveGatewayConnectConfig(
        useSetupCode = false,
        setupCode = "",
        savedManualHost = "127.0.0.1",
        savedManualPort = "18789",
        savedManualTls = false,
        manualHostInput = "127.0.0.1",
        manualPortInput = "18789",
        manualTlsInput = false,
        fallbackBootstrapToken = "bootstrap-1",
        fallbackToken = "",
        fallbackPassword = "",
      )

    assertEquals("127.0.0.1", resolved?.host)
    assertEquals(18789, resolved?.port)
    assertEquals(false, resolved?.tls)
    assertEquals("bootstrap-1", resolved?.bootstrapToken)
    assertEquals("", resolved?.token)
    assertEquals("", resolved?.password)
  }

  @Test
  fun resolveGatewayConnectConfigManualDropsBootstrapTokenWhenReplacementPasswordExists() {
    val resolved =
      resolveGatewayConnectConfig(
        useSetupCode = false,
        setupCode = "",
        savedManualHost = "127.0.0.1",
        savedManualPort = "18789",
        savedManualTls = false,
        manualHostInput = "127.0.0.1",
        manualPortInput = "18789",
        manualTlsInput = false,
        fallbackBootstrapToken = "bootstrap-1",
        fallbackToken = "",
        fallbackPassword = "password-1",
      )

    assertEquals("", resolved?.bootstrapToken)
    assertEquals("", resolved?.token)
    assertEquals("password-1", resolved?.password)
  }

  @Test
  fun resolveGatewayConnectConfigManualDropsBootstrapTokenWhenEndpointChanges() {
    val resolved =
      resolveGatewayConnectConfig(
        useSetupCode = false,
        setupCode = "",
        savedManualHost = "127.0.0.1",
        savedManualPort = "18789",
        savedManualTls = false,
        manualHostInput = "127.0.0.2",
        manualPortInput = "18789",
        manualTlsInput = false,
        fallbackBootstrapToken = "bootstrap-1",
        fallbackToken = "",
        fallbackPassword = "",
      )

    assertEquals("", resolved?.bootstrapToken)
    assertEquals("127.0.0.2", resolved?.host)
  }

  @Test
  fun resolveGatewayConnectConfigRejectsPrivateLanManualCleartextEndpoint() {
    val resolved =
      resolveGatewayConnectConfig(
        useSetupCode = false,
        setupCode = "",
        savedManualHost = "",
        savedManualPort = "",
        savedManualTls = false,
        manualHostInput = "192.168.31.100",
        manualPortInput = "18789",
        manualTlsInput = false,
        fallbackBootstrapToken = "bootstrap-1",
        fallbackToken = "",
        fallbackPassword = "",
      )

    assertNull(resolved)
  }

  @Test
  fun composeGatewayManualUrlDefaultsPortTo443WhenTlsAndPortBlank() {
    val url = composeGatewayManualUrl("mydevice.tail1234.ts.net", "", tls = true)

    assertEquals("https://mydevice.tail1234.ts.net:443", url)
  }

  @Test
  fun composeGatewayManualUrlRejectsBlankPortWhenTlsIsOff() {
    val url = composeGatewayManualUrl("127.0.0.1", "", tls = false)

    assertNull(url)
  }

  @Test
  fun resolveGatewayConnectConfigManualAcceptsTailscaleHostWithoutPort() {
    val resolved =
      resolveGatewayConnectConfig(
        useSetupCode = false,
        setupCode = "",
        savedManualHost = "",
        savedManualPort = "",
        savedManualTls = true,
        manualHostInput = "mydevice.tail1234.ts.net",
        manualPortInput = "",
        manualTlsInput = true,
        fallbackBootstrapToken = "",
        fallbackToken = "",
        fallbackPassword = "",
      )

    assertEquals("mydevice.tail1234.ts.net", resolved?.host)
    assertEquals(443, resolved?.port)
    assertEquals(true, resolved?.tls)
  }

  private fun encodeSetupCode(payloadJson: String): String {
    return Base64.getUrlEncoder().withoutPadding().encodeToString(payloadJson.toByteArray(Charsets.UTF_8))
  }
}
