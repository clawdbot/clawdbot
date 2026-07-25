package ai.openclaw.app.ui

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import java.util.Base64

@RunWith(RobolectricTestRunner::class)
class GatewayConfigResolverTest {
  @Test
  fun insecureRemoteGuidanceRetainsTheCompleteSecurityRuleAndFix() {
    val message =
      gatewayEndpointValidationMessage(
        GatewayEndpointValidationError.INSECURE_REMOTE_URL,
        GatewayEndpointInputSource.MANUAL,
      )

    assertEquals(
      "Public gateways require wss:// or Tailscale Serve. ws:// is allowed for localhost, .local hosts, the Android emulator, and private LAN IPs. " +
        "Use a private LAN IP for local setup, or enable Tailscale Serve / expose a wss:// gateway URL for remote access.",
      message,
    )
  }

  @Test
  fun manualTransportForcesSecureConnectionForRemoteHosts() {
    val presentation =
      gatewayManualTransportPresentation(
        hostInput = "gateway.example.com",
        requestedTls = false,
      )

    assertEquals(true, presentation.requiresTls)
    assertEquals(true, presentation.effectiveTls)
    assertEquals("Secure connection is required for this host.", presentation.helperText)
  }

  @Test
  fun manualTransportAllowsUnencryptedPrivateLanConnections() {
    val presentation =
      gatewayManualTransportPresentation(
        hostInput = "192.168.1.20",
        requestedTls = false,
      )

    assertEquals(false, presentation.requiresTls)
    assertEquals(false, presentation.effectiveTls)
    assertEquals("Use only on a trusted private network.", presentation.helperText)
  }

  @Test
  fun manualTransportDoesNotRepeatSelectedPrivateLanTlsState() {
    val presentation =
      gatewayManualTransportPresentation(
        hostInput = "192.168.1.20",
        requestedTls = true,
      )

    assertEquals(false, presentation.requiresTls)
    assertEquals(true, presentation.effectiveTls)
    assertNull(presentation.helperText)
  }

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
  fun parseGatewayEndpointAllowsPrivateLanCleartextWsUrls() {
    val parsed = parseGatewayEndpoint("ws://192.168.1.20:18789")

    assertEquals(
      GatewayEndpointConfig(
        host = "192.168.1.20",
        port = 18789,
        tls = false,
        displayUrl = "http://192.168.1.20:18789",
      ),
      parsed,
    )
  }

  @Test
  fun parseGatewayEndpointAllowsMdnsCleartextWsUrls() {
    val parsed = parseGatewayEndpoint("ws://gateway.local:18789")

    assertEquals(
      GatewayEndpointConfig(
        host = "gateway.local",
        port = 18789,
        tls = false,
        displayUrl = "http://gateway.local:18789",
      ),
      parsed,
    )
  }

  @Test
  fun parseGatewayEndpointAllowsNormalizedMdnsCleartextWsUrls() {
    val parsed = parseGatewayEndpoint("ws://GATEWAY.LOCAL.:18789")

    assertEquals("GATEWAY.LOCAL.", parsed?.host)
    assertEquals(18789, parsed?.port)
    assertEquals(false, parsed?.tls)
  }

  @Test
  fun parseGatewayEndpointRejectsMdnsSuffixAndLabelBypasses() {
    val rejected =
      listOf(
        "ws://gateway.local.evil.com:18789",
        "ws://gatewaylocal:18789",
        "ws://local:18789",
        "ws://.local:18789",
        "ws://gateway..local:18789",
        "ws://gateway.local%25wlan0:18789",
      )

    for (url in rejected) {
      assertNull(url, parseGatewayEndpoint(url))
    }
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
  fun parseGatewayEndpointReportsUnsupportedIpv6ZoneIds() {
    listOf(
      "ws://[fe80::1%25eth0]",
      "wss://[fe80::1%25wlan0]:443",
    ).forEach { url ->
      val parsed = parseGatewayEndpointResult(url)
      assertNull(url, parsed.config)
      assertEquals(url, GatewayEndpointValidationError.IPV6_ZONE_ID_UNSUPPORTED, parsed.error)
    }
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
  fun resolveScannedSetupCodeResultAcceptsRawSetupCode() {
    val setupCode =
      encodeSetupCode("""{"url":"wss://gateway.example:18789","bootstrapToken":"bootstrap-1"}""")

    val resolved = resolveScannedSetupCodeResult(setupCode)

    assertEquals(setupCode, resolved.setupCode)
    assertNull(resolved.error)
  }

  @Test
  fun resolveScannedSetupCodeResultAcceptsEmulatorSetupCode() {
    val setupCode =
      encodeSetupCode("""{"url":"ws://10.0.2.2:18789","bootstrapToken":"bootstrap-1"}""")

    val resolved = resolveScannedSetupCodeResult(setupCode)

    assertEquals(setupCode, resolved.setupCode)
    assertNull(resolved.error)
  }

  @Test
  fun resolveScannedSetupCodeResultAcceptsQrJsonPayload() {
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

    val resolved = resolveScannedSetupCodeResult(qrJson)

    assertEquals(setupCode, resolved.setupCode)
    assertNull(resolved.error)
  }

  @Test
  fun resolveScannedSetupCodeResultRejectsInvalidInput() {
    val resolved = resolveScannedSetupCodeResult("not-a-valid-setup-code")
    assertNull(resolved.setupCode)
    assertEquals(GatewayEndpointValidationError.INVALID_URL, resolved.error)
  }

  @Test
  fun resolveScannedSetupCodeResultRejectsJsonWithInvalidSetupCode() {
    val qrJson = """{"setupCode":"invalid"}"""
    val resolved = resolveScannedSetupCodeResult(qrJson)
    assertNull(resolved.setupCode)
    assertEquals(GatewayEndpointValidationError.INVALID_URL, resolved.error)
  }

  @Test
  fun resolveScannedSetupCodeResultRejectsJsonWithNonStringSetupCode() {
    val qrJson = """{"setupCode":{"nested":"value"}}"""
    val resolved = resolveScannedSetupCodeResult(qrJson)
    assertNull(resolved.setupCode)
    assertEquals(GatewayEndpointValidationError.INVALID_URL, resolved.error)
  }

  @Test
  fun resolveScannedSetupCodeResultRejectsNonLoopbackCleartextGateway() {
    val setupCode =
      encodeSetupCode("""{"url":"ws://attacker.example:18789","bootstrapToken":"bootstrap-1"}""")

    val resolved = resolveScannedSetupCodeResult(setupCode)

    assertNull(resolved.setupCode)
    assertEquals(GatewayEndpointValidationError.INSECURE_REMOTE_URL, resolved.error)
  }

  @Test
  fun resolveScannedSetupCodeResultAcceptsPrivateLanCleartextGateway() {
    val setupCode =
      encodeSetupCode("""{"url":"ws://192.168.31.100:18789","bootstrapToken":"bootstrap-1"}""")

    val resolved = resolveScannedSetupCodeResult(setupCode)

    assertEquals(setupCode, resolved.setupCode)
    assertNull(resolved.error)
  }

  @Test
  fun resolveScannedSetupCodeResultAcceptsMdnsCleartextGateway() {
    val setupCode =
      encodeSetupCode("""{"url":"ws://gateway.local:18789","bootstrapToken":"bootstrap-1"}""")

    val resolved = resolveScannedSetupCodeResult(setupCode)

    assertEquals(setupCode, resolved.setupCode)
    assertNull(resolved.error)
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
  fun resolveScannedSetupCodeResultPreservesIpv6ZoneError() {
    val setupCode =
      encodeSetupCode("""{"url":"wss://[fe80::1%25wlan0]:443","bootstrapToken":"bootstrap-1"}""")

    val resolved = resolveScannedSetupCodeResult(setupCode)

    assertNull(resolved.setupCode)
    assertEquals(GatewayEndpointValidationError.IPV6_ZONE_ID_UNSUPPORTED, resolved.error)
  }

  @Test
  fun gatewayEndpointValidationMessageExplainsIpv6ZoneReplacement() {
    val error = GatewayEndpointValidationError.IPV6_ZONE_ID_UNSUPPORTED

    assertEquals(
      "IPv6 zone IDs are not supported. Use an unscoped IPv6 address or a LAN hostname.",
      gatewayEndpointValidationMessage(error, GatewayEndpointInputSource.MANUAL),
    )
    assertEquals(
      "Setup code uses an IPv6 zone ID. Use an unscoped IPv6 address or a LAN hostname.",
      gatewayEndpointValidationMessage(error, GatewayEndpointInputSource.SETUP_CODE),
    )
    assertEquals(
      "QR code uses an IPv6 zone ID. Use an unscoped IPv6 address or a LAN hostname.",
      gatewayEndpointValidationMessage(error, GatewayEndpointInputSource.QR_SCAN),
    )
  }

  @Test
  fun parseGatewayEndpointResultFlagsInsecureRemoteGateway() {
    val parsed = parseGatewayEndpointResult("ws://gateway.example:18789")

    assertNull(parsed.config)
    assertEquals(GatewayEndpointValidationError.INSECURE_REMOTE_URL, parsed.error)
  }

  @Test
  fun parseGatewayEndpointResultRejectsUnsupportedSchemes() {
    val parsed = parseGatewayEndpointResult("ftp://gateway.example:21")

    assertNull(parsed.config)
    assertEquals(GatewayEndpointValidationError.INVALID_URL, parsed.error)
  }

  @Test
  fun parseGatewayEndpointResultRejectsInvalidExplicitPort() {
    val parsed = parseGatewayEndpointResult("wss://gateway.example:70000")

    assertNull(parsed.config)
    assertEquals(GatewayEndpointValidationError.INVALID_URL, parsed.error)
  }

  @Test
  fun parseGatewayEndpointResultAllowsPrivateLanCleartextGateway() {
    val parsed = parseGatewayEndpointResult("ws://192.168.1.20:18789")

    assertEquals(
      GatewayEndpointConfig(
        host = "192.168.1.20",
        port = 18789,
        tls = false,
        displayUrl = "http://192.168.1.20:18789",
      ),
      parsed.config,
    )
    assertNull(parsed.error)
  }

  @Test
  fun parseGatewayEndpointResultAllowsMdnsCleartextGateway() {
    val parsed = parseGatewayEndpointResult("ws://gateway.local:18789")

    assertEquals(
      GatewayEndpointConfig(
        host = "gateway.local",
        port = 18789,
        tls = false,
        displayUrl = "http://gateway.local:18789",
      ),
      parsed.config,
    )
    assertNull(parsed.error)
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
  fun manualTokenDetectsSetupCodePayloads() {
    val setupCode =
      encodeSetupCode("""{"url":"ws://10.0.2.2:18789","bootstrapToken":"bootstrap-1"}""")
    val qrPayload = """{"setupCode":"$setupCode"}"""

    assertEquals(true, manualTokenLooksLikeSetupCode(setupCode))
    assertEquals(true, manualTokenLooksLikeSetupCode(qrPayload))
    assertEquals(false, manualTokenLooksLikeSetupCode("local-mobile-test"))
    assertEquals(false, manualTokenLooksLikeSetupCode(""))
  }

  @Test
  fun resolveGatewayConnectConfigPrefersBootstrapTokenFromSetupCode() {
    val setupCode =
      encodeSetupCode(
        """{"url":"wss://gateway.example:18789","bootstrapToken":"bootstrap-1"}""",
      )

    val resolved =
      resolveGatewayConnectConfig(
        useSetupCode = true,
        setupCode = setupCode,
        manualHostInput = "",
        manualPortInput = "",
        manualTlsInput = false,
        bootstrapTokenInput = "",
        tokenInput = "shared-token",
        passwordInput = "shared-password",
      )

    assertEquals("gateway.example", resolved?.host)
    assertEquals(18789, resolved?.port)
    assertEquals(true, resolved?.tls)
    assertEquals("bootstrap-1", resolved?.bootstrapToken)
    assertEquals("", resolved?.token)
    assertEquals("", resolved?.password)
  }

  @Test
  fun resolveGatewayConnectConfigAcceptsQrJsonSetupCodePayload() {
    val setupCode =
      encodeSetupCode("""{"url":"wss://gateway.example:18789","bootstrapToken":"bootstrap-1"}""")
    val qrPayload = """{"setupCode":"$setupCode"}"""

    val resolved =
      resolveGatewayConnectConfig(
        useSetupCode = true,
        setupCode = qrPayload,
        manualHostInput = "",
        manualPortInput = "",
        manualTlsInput = false,
        bootstrapTokenInput = "",
        tokenInput = "shared-token",
        passwordInput = "shared-password",
      )

    assertEquals("gateway.example", resolved?.host)
    assertEquals(18789, resolved?.port)
    assertEquals(true, resolved?.tls)
    assertEquals("bootstrap-1", resolved?.bootstrapToken)
    assertEquals("", resolved?.token)
    assertEquals("", resolved?.password)
  }

  @Test
  fun resolveGatewayConnectConfigDefaultsPortlessWssSetupCodeTo443() {
    val setupCode =
      encodeSetupCode(
        """{"url":"wss://gateway.example","bootstrapToken":"bootstrap-1"}""",
      )

    val resolved =
      resolveGatewayConnectConfig(
        useSetupCode = true,
        setupCode = setupCode,
        manualHostInput = "",
        manualPortInput = "",
        manualTlsInput = false,
        bootstrapTokenInput = "",
        tokenInput = "",
        passwordInput = "",
      )

    assertEquals("gateway.example", resolved?.host)
    assertEquals(443, resolved?.port)
    assertEquals(true, resolved?.tls)
  }

  @Test
  fun resolveGatewayConnectConfigAllowsMdnsCleartextSetupCode() {
    val setupCode =
      encodeSetupCode(
        """{"url":"ws://gateway.local:18789","bootstrapToken":"bootstrap-1"}""",
      )

    val resolved =
      resolveGatewayConnectConfig(
        useSetupCode = true,
        setupCode = setupCode,
        manualHostInput = "",
        manualPortInput = "",
        manualTlsInput = false,
        bootstrapTokenInput = "",
        tokenInput = "",
        passwordInput = "",
      )

    assertEquals("gateway.local", resolved?.host)
    assertEquals(18789, resolved?.port)
    assertEquals(false, resolved?.tls)
  }

  @Test
  fun resolveGatewayConnectPlanPreservesRuntimeOwnedAuthForUnchangedEndpoint() {
    val plan =
      resolveGatewayConnectPlan(
        useSetupCode = false,
        setupCode = "",
        savedManualHost = "127.0.0.1",
        savedManualPort = "18789",
        savedManualTls = false,
        manualHostInput = "127.0.0.1",
        manualPortInput = "18789",
        manualTlsInput = false,
        bootstrapTokenInput = "",
        tokenInput = "",
        passwordInput = "",
      )

    assertEquals(GatewaySavedAuthAction.PRESERVE, plan?.savedAuthAction)
    assertEquals("", plan?.config?.bootstrapToken)
    assertEquals("", plan?.config?.token)
    assertEquals("", plan?.config?.password)
  }

  @Test
  fun resolveGatewayConnectPlanReplacesAuthWhenEndpointChanges() {
    val plan =
      resolveGatewayConnectPlan(
        useSetupCode = false,
        setupCode = "",
        savedManualHost = "127.0.0.1",
        savedManualPort = "18789",
        savedManualTls = false,
        manualHostInput = "127.0.0.2",
        manualPortInput = "18789",
        manualTlsInput = false,
        bootstrapTokenInput = "",
        tokenInput = "",
        passwordInput = "",
      )

    assertEquals(GatewaySavedAuthAction.REPLACE_ENDPOINT, plan?.savedAuthAction)
    assertEquals("127.0.0.2", plan?.config?.host)
  }

  @Test
  fun resolveGatewayConnectPlanTreatsMissingSavedEndpointAsReplacement() {
    val plan =
      resolveGatewayConnectPlan(
        useSetupCode = false,
        setupCode = "",
        savedManualHost = "",
        savedManualPort = "",
        savedManualTls = false,
        manualHostInput = "127.0.0.1",
        manualPortInput = "18789",
        manualTlsInput = false,
        bootstrapTokenInput = "",
        tokenInput = "",
        passwordInput = "",
      )

    assertEquals(GatewaySavedAuthAction.REPLACE_ENDPOINT, plan?.savedAuthAction)
  }

  @Test
  fun resolveGatewayConnectPlanMarksSetupCodeAsExplicitReplacement() {
    val setupCode =
      encodeSetupCode(
        """{"url":"wss://gateway.example:18789","bootstrapToken":"bootstrap-1"}""",
      )

    val plan =
      resolveGatewayConnectPlan(
        useSetupCode = true,
        setupCode = setupCode,
        savedManualHost = "127.0.0.1",
        savedManualPort = "18789",
        savedManualTls = false,
        manualHostInput = "127.0.0.1",
        manualPortInput = "18789",
        manualTlsInput = false,
        bootstrapTokenInput = "",
        tokenInput = "",
        passwordInput = "",
      )

    assertEquals(GatewaySavedAuthAction.REPLACE_SETUP, plan?.savedAuthAction)
    assertEquals("bootstrap-1", plan?.config?.bootstrapToken)
    assertEquals("", plan?.config?.token)
  }

  @Test
  fun resolveGatewayConnectPlanUsesOneExplicitCredentialFamily() {
    val plan =
      resolveGatewayConnectPlan(
        useSetupCode = false,
        setupCode = "",
        savedManualHost = "127.0.0.1",
        savedManualPort = "18789",
        savedManualTls = false,
        manualHostInput = "127.0.0.1",
        manualPortInput = "18789",
        manualTlsInput = false,
        bootstrapTokenInput = "bootstrap",
        tokenInput = "token",
        passwordInput = "password",
      )

    assertEquals("token", plan?.config?.token)
    assertEquals("", plan?.config?.bootstrapToken)
    assertEquals("", plan?.config?.password)
    assertEquals(GatewaySavedAuthAction.REPLACE_CREDENTIALS, plan?.savedAuthAction)
  }

  @Test
  fun resolveGatewayConnectPlanReplacesStalePairingForExplicitBootstrapAuth() {
    val plan =
      resolveGatewayConnectPlan(
        useSetupCode = false,
        setupCode = "",
        savedManualHost = "gateway.local",
        savedManualPort = "18789",
        savedManualTls = false,
        manualHostInput = "gateway.local",
        manualPortInput = "18789",
        manualTlsInput = false,
        bootstrapTokenInput = "replacement-bootstrap",
        tokenInput = "",
        passwordInput = "",
      )

    assertEquals(GatewaySavedAuthAction.REPLACE_SETUP, plan?.savedAuthAction)
    assertEquals("replacement-bootstrap", plan?.config?.bootstrapToken)
  }

  @Test
  fun resolveGatewayConnectPlanPreservesAuthForHostnameCaseOnlyEdit() {
    val plan =
      resolveGatewayConnectPlan(
        useSetupCode = false,
        setupCode = "",
        savedManualHost = "Gateway.Local",
        savedManualPort = "18789",
        savedManualTls = false,
        manualHostInput = "gateway.local",
        manualPortInput = "18789",
        manualTlsInput = false,
        bootstrapTokenInput = "",
        tokenInput = "",
        passwordInput = "",
      )

    assertEquals(GatewaySavedAuthAction.PRESERVE, plan?.savedAuthAction)
  }

  @Test
  fun resolveGatewayConnectConfigAllowsPrivateLanManualCleartextEndpoint() {
    val resolved =
      resolveGatewayConnectConfig(
        useSetupCode = false,
        setupCode = "",
        manualHostInput = "192.168.31.100",
        manualPortInput = "18789",
        manualTlsInput = false,
        bootstrapTokenInput = "bootstrap-1",
        tokenInput = "",
        passwordInput = "",
      )

    assertEquals("192.168.31.100", resolved?.host)
    assertEquals(18789, resolved?.port)
    assertEquals(false, resolved?.tls)
  }

  @Test
  fun resolveGatewayConnectConfigAllowsMdnsManualCleartextEndpoint() {
    val resolved =
      resolveGatewayConnectConfig(
        useSetupCode = false,
        setupCode = "",
        manualHostInput = "gateway.local",
        manualPortInput = "18789",
        manualTlsInput = false,
        bootstrapTokenInput = "bootstrap-1",
        tokenInput = "",
        passwordInput = "",
      )

    assertEquals("gateway.local", resolved?.host)
    assertEquals(18789, resolved?.port)
    assertEquals(false, resolved?.tls)
  }

  @Test
  fun composeGatewayManualUrlRejectsBareScheme() {
    assertNull(composeGatewayManualUrl("ws://", "18789", tls = false))
  }

  @Test
  fun composeGatewayManualUrlPreservesCompleteEndpoint() {
    val cleartextUrl = composeGatewayManualUrl("ws://192.168.178.57:18790", "18789", tls = true)
    val tlsUrl = composeGatewayManualUrl("wss://gateway.example:443", "18789", tls = false)

    assertEquals("ws://192.168.178.57:18790", cleartextUrl)
    assertEquals("wss://gateway.example:443", tlsUrl)
    assertEquals("http://192.168.178.57:18790", parseGatewayEndpoint(cleartextUrl!!)?.displayUrl)
    assertEquals("https://gateway.example", parseGatewayEndpoint(tlsUrl!!)?.displayUrl)
  }

  @Test
  fun composeGatewayManualUrlPreservesCompleteEndpointValidationError() {
    val url = composeGatewayManualUrl("ws://gateway.example:18789", "18789", tls = false)

    assertEquals(GatewayEndpointValidationError.INSECURE_REMOTE_URL, parseGatewayEndpointResult(url!!).error)
  }

  @Test
  fun resolveGatewayConnectConfigManualAcceptsCompleteLanEndpoint() {
    val resolved =
      resolveGatewayConnectConfig(
        useSetupCode = false,
        setupCode = "",
        manualHostInput = "ws://192.168.178.57:18790",
        manualPortInput = "18789",
        manualTlsInput = true,
        bootstrapTokenInput = "",
        tokenInput = "",
        passwordInput = "",
      )

    assertEquals("192.168.178.57", resolved?.host)
    assertEquals(18790, resolved?.port)
    assertEquals(false, resolved?.tls)
  }

  @Test
  fun composeGatewayManualUrlPreservesIpv6Hosts() {
    for (hostInput in listOf("::1", "[::1]")) {
      assertEquals("http://[::1]:18789", composeGatewayManualUrl(hostInput, "18789", tls = false))
    }
  }

  @Test
  fun composeGatewayManualUrlTrimsTrailingSlashFromBareHost() {
    assertEquals(
      "http://192.168.1.20:20000",
      composeGatewayManualUrl("192.168.1.20/", "20000", tls = false),
    )
  }

  @Test
  fun composeGatewayManualUrlDefaultsPortTo443WhenTlsAndPortBlank() {
    val url = composeGatewayManualUrl("mydevice.tail1234.ts.net", "", tls = true)

    assertEquals("https://mydevice.tail1234.ts.net:443", url)
  }

  @Test
  fun composeGatewayManualUrlDefaultsPortTo18789ForNonTailnetTlsHostsWhenPortBlank() {
    val url = composeGatewayManualUrl("gateway.example.com", "", tls = true)

    assertEquals("https://gateway.example.com:18789", url)
  }

  @Test
  fun composeGatewayManualUrlDefaultsPortTo443ForTailnetHostWithTrailingDotWhenPortBlank() {
    val url = composeGatewayManualUrl("device.sample.ts.net.", "", tls = true)

    assertEquals("https://device.sample.ts.net.:443", url)
  }

  @Test
  fun composeGatewayManualUrlDoesNotTreatLookalikeTailnetSuffixAsTailnet() {
    val url = composeGatewayManualUrl("gateway.ts.net.evil.com", "", tls = true)

    assertEquals("https://gateway.ts.net.evil.com:18789", url)
  }

  @Test
  fun composeGatewayManualUrlDefaultsBlankCleartextPortTo18789() {
    val url = composeGatewayManualUrl("127.0.0.1", "", tls = false)

    assertEquals("http://127.0.0.1:18789", url)
  }

  @Test
  fun composeGatewayManualUrl_bracketsIpv6ForEndpointParsing() {
    for (hostInput in listOf("::1", "[::1]")) {
      val url = composeGatewayManualUrl(hostInput, "18789", tls = false)

      assertEquals("http://[::1]:18789", url)
      assertEquals(
        GatewayEndpointConfig(
          host = "::1",
          port = 18789,
          tls = false,
          displayUrl = "http://[::1]:18789",
        ),
        parseGatewayEndpoint(url!!),
      )
    }
  }

  @Test
  fun resolveGatewayConnectConfigManualAcceptsTailscaleHostWithoutPort() {
    val resolved =
      resolveGatewayConnectConfig(
        useSetupCode = false,
        setupCode = "",
        manualHostInput = "mydevice.tail1234.ts.net",
        manualPortInput = "",
        manualTlsInput = true,
        bootstrapTokenInput = "",
        tokenInput = "",
        passwordInput = "",
      )

    assertEquals("mydevice.tail1234.ts.net", resolved?.host)
    assertEquals(443, resolved?.port)
    assertEquals(true, resolved?.tls)
  }

  private fun encodeSetupCode(payloadJson: String): String = Base64.getUrlEncoder().withoutPadding().encodeToString(payloadJson.toByteArray(Charsets.UTF_8))
}
