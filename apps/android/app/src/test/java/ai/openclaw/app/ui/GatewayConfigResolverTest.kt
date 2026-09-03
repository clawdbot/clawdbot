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
  fun manualTransportClassifiesTheHostFromPastedAuthorities() {
    val cases =
      listOf(
        "192.168.1.20:18790" to false,
        "gateway.local:18790" to false,
        "GATEWAY.LOCAL.:18790" to false,
        "[::1]:18790" to false,
        "gateway.example:443" to true,
        "gateway.local.evil.com:18790" to true,
        "100.64.0.9:18790" to true,
        "[2001:db8::1]:443" to true,
      )

    for ((hostInput, requiresTls) in cases) {
      val presentation =
        gatewayManualTransportPresentation(
          hostInput = hostInput,
          requestedTls = false,
        )

      assertEquals(hostInput, requiresTls, presentation.requiresTls)
      assertEquals(hostInput, requiresTls, presentation.effectiveTls)
      assertEquals(
        hostInput,
        if (requiresTls) {
          "Secure connection is required for this host."
        } else {
          "Use only on a trusted private network."
        },
        presentation.helperText,
      )
    }
  }

  @Test
  fun parseGatewayEndpointUsesDefaultTlsPortForBareWssUrls() {
    assertParsedEndpoint(
      input = "wss://gateway.example",
      host = "gateway.example",
      port = 443,
      tls = true,
      displayUrl = "https://gateway.example",
    )
  }

  @Test
  fun parseGatewayEndpointPreservesDecodedContextPath() {
    val parsed = parseGatewayEndpoint("wss://gateway.example/openclaw%20gateway")

    assertEquals("/openclaw%20gateway", parsed?.contextPath)
    assertEquals("https://gateway.example/openclaw%20gateway", parsed?.displayUrl)
  }

  @Test
  fun parseGatewayEndpointPreservesEscapedPathDelimiter() {
    val parsed = parseGatewayEndpoint("wss://gateway.example/openclaw%2Fgateway")

    assertEquals("/openclaw%2Fgateway", parsed?.contextPath)
    assertEquals("https://gateway.example/openclaw%2Fgateway", parsed?.displayUrl)
  }

  @Test
  fun parseGatewayEndpointPreservesRepeatedLeadingPathSlashes() {
    val parsed = parseGatewayEndpoint("wss://gateway.example//openclaw")

    assertEquals("//openclaw", parsed?.contextPath)
    assertEquals("https://gateway.example//openclaw", parsed?.displayUrl)
  }

  @Test
  fun parseGatewayEndpointRejectsNonLoopbackCleartextWsUrls() {
    assertEndpointRejected("ws://gateway.example")
  }

  @Test
  fun parseGatewayEndpointRejectsTailnetCleartextWsUrls() {
    assertEndpointRejected("ws://100.64.0.9:18789")
  }

  @Test
  fun parseGatewayEndpointOmitsExplicitDefaultTlsPortFromDisplayUrl() {
    assertParsedEndpoint(
      input = "https://gateway.example:443",
      host = "gateway.example",
      port = 443,
      tls = true,
      displayUrl = "https://gateway.example",
    )
  }

  @Test
  fun parseGatewayEndpointAllowsLoopbackCleartextWsUrls() {
    assertParsedEndpoint(
      input = "ws://127.0.0.1",
      host = "127.0.0.1",
      displayUrl = "http://127.0.0.1:18789",
    )
  }

  @Test
  fun parseGatewayEndpointAllowsLocalhostCleartextWsUrls() {
    assertParsedEndpoint(
      input = "ws://localhost:18789",
      host = "localhost",
      displayUrl = "http://localhost:18789",
    )
  }

  @Test
  fun parseGatewayEndpointAllowsAndroidEmulatorCleartextWsUrls() {
    assertParsedEndpoint(
      input = "ws://10.0.2.2:18789",
      host = "10.0.2.2",
      displayUrl = "http://10.0.2.2:18789",
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
    assertEndpointRejected("http://127.attacker.example:80")
  }

  @Test
  fun parseGatewayEndpointRejectsNonLoopbackIpv6CleartextWsUrls() {
    assertEndpointRejected("ws://[2001:db8::1]")
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
    assertEndpointRejected("http://0.0.0.0:80")
  }

  @Test
  fun parseGatewayEndpointRejectsUnspecifiedIpv6CleartextWsUrls() {
    assertEndpointRejected("ws://[::]")
  }

  @Test
  fun parseGatewayEndpointAllowsLoopbackCleartextHttpUrls() {
    assertParsedEndpoint(
      input = "http://localhost:80",
      host = "localhost",
      port = 80,
      displayUrl = "http://localhost:80",
    )
  }

  @Test
  fun resolveScannedSetupCodeResultAcceptsRawSetupCode() {
    assertScannedSetupCodeAccepted(setupCode("wss://gateway.example:18789"))
  }

  @Test
  fun resolveScannedSetupCodeResultAcceptsEmulatorSetupCode() {
    assertScannedSetupCodeAccepted(setupCode("ws://10.0.2.2:18789"))
  }

  @Test
  fun resolveScannedSetupCodeResultAcceptsQrJsonPayload() {
    val setupCode = setupCode("wss://gateway.example:18789")
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
    assertScannedSetupCodeRejected("not-a-valid-setup-code", GatewayEndpointValidationError.INVALID_URL)
  }

  @Test
  fun resolveScannedSetupCodeResultRejectsJsonWithInvalidSetupCode() {
    assertScannedSetupCodeRejected("""{"setupCode":"invalid"}""", GatewayEndpointValidationError.INVALID_URL)
  }

  @Test
  fun resolveScannedSetupCodeResultRejectsJsonWithNonStringSetupCode() {
    assertScannedSetupCodeRejected("""{"setupCode":{"nested":"value"}}""", GatewayEndpointValidationError.INVALID_URL)
  }

  @Test
  fun resolveScannedSetupCodeResultRejectsNonLoopbackCleartextGateway() {
    assertScannedSetupCodeRejected(
      setupCode("ws://attacker.example:18789"),
      GatewayEndpointValidationError.INSECURE_REMOTE_URL,
    )
  }

  @Test
  fun resolveScannedSetupCodeResultAcceptsPrivateLanCleartextGateway() {
    assertScannedSetupCodeAccepted(setupCode("ws://192.168.31.100:18789"))
  }

  @Test
  fun resolveScannedSetupCodeResultAcceptsMdnsCleartextGateway() {
    assertScannedSetupCodeAccepted(setupCode("ws://gateway.local:18789"))
  }

  @Test
  fun resolveScannedSetupCodeResultPreservesIpv6ZoneError() {
    assertScannedSetupCodeRejected(
      setupCode("wss://[fe80::1%25wlan0]:443"),
      GatewayEndpointValidationError.IPV6_ZONE_ID_UNSUPPORTED,
    )
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
  fun parseGatewayEndpointResultRejectsCredentialsQueriesAndFragments() {
    val urls =
      listOf(
        "wss://user@gateway.example/openclaw-gw",
        "wss://gateway.example/openclaw-gw?mode=setup",
        "wss://gateway.example/openclaw-gw#fragment",
      )

    for (url in urls) {
      val parsed = parseGatewayEndpointResult(url)
      assertNull(url, parsed.config)
      assertEquals(url, GatewayEndpointValidationError.INVALID_URL, parsed.error)
    }
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
  fun decodeGatewaySetupCodeAcceptsPairingUrlWrapper() {
    val setupCode =
      encodeSetupCode("""{"url":"wss://gateway.example:18789","bootstrapToken":"Bootstrap-AbC123"}""")

    val decoded = decodeGatewaySetupCode("oc-pair://$setupCode")

    assertEquals("wss://gateway.example:18789", decoded?.url)
    assertEquals("Bootstrap-AbC123", decoded?.bootstrapToken)
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
    val resolved =
      resolveConnectConfigFixture(
        useSetupCode = true,
        setupCode = setupCode("wss://gateway.example:18789"),
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
  fun resolveGatewayConnectConfigPreservesSetupContextPath() {
    val resolved =
      resolveConnectConfigFixture(
        useSetupCode = true,
        setupCode = setupCode("wss://gateway.example/openclaw-gw"),
      )

    assertEquals("gateway.example", resolved?.host)
    assertEquals(443, resolved?.port)
    assertEquals(true, resolved?.tls)
    assertEquals("/openclaw-gw", resolved?.contextPath)
  }

  @Test
  fun resolveGatewayConnectConfigAcceptsQrJsonSetupCodePayload() {
    val setupCode = setupCode("wss://gateway.example:18789")
    val qrPayload = """{"setupCode":"$setupCode"}"""

    val resolved =
      resolveConnectConfigFixture(
        useSetupCode = true,
        setupCode = qrPayload,
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
    val resolved =
      resolveConnectConfigFixture(
        useSetupCode = true,
        setupCode = setupCode("wss://gateway.example"),
      )

    assertEquals("gateway.example", resolved?.host)
    assertEquals(443, resolved?.port)
    assertEquals(true, resolved?.tls)
  }

  @Test
  fun resolveGatewayConnectConfigAllowsMdnsCleartextSetupCode() {
    val resolved =
      resolveConnectConfigFixture(
        useSetupCode = true,
        setupCode = setupCode("ws://gateway.local:18789"),
      )

    assertEquals("gateway.local", resolved?.host)
    assertEquals(18789, resolved?.port)
    assertEquals(false, resolved?.tls)
  }

  @Test
  fun resolveGatewayConnectPlanPreservesRuntimeOwnedAuthForUnchangedEndpoint() {
    val plan = resolveConnectPlanFixture()

    assertEquals(GatewaySavedAuthAction.PRESERVE, plan?.savedAuthAction)
    assertEquals("", plan?.config?.bootstrapToken)
    assertEquals("", plan?.config?.token)
    assertEquals("", plan?.config?.password)
  }

  @Test
  fun resolveGatewayConnectPlanReplacesAuthWhenEndpointChanges() {
    val plan =
      resolveConnectPlanFixture(
        manualHostInput = "127.0.0.2",
        tokenInput = "replacement-token",
      )

    assertEquals(GatewaySavedAuthAction.REPLACE_ENDPOINT, plan?.savedAuthAction)
    assertEquals("127.0.0.2", plan?.config?.host)
    assertEquals("replacement-token", plan?.config?.token)
  }

  @Test
  fun resolveGatewayConnectPlanTreatsMissingSavedEndpointAsReplacement() {
    val plan =
      resolveConnectPlanFixture(
        savedManualHost = "",
        savedManualPort = "",
      )

    assertEquals(GatewaySavedAuthAction.REPLACE_ENDPOINT, plan?.savedAuthAction)
  }

  @Test
  fun resolveGatewayConnectPlanMarksSetupCodeAsExplicitReplacement() {
    val scanned = resolveScannedSetupCodeResult(setupCode("ws://10.0.2.2:18789"))
    val plan =
      resolveConnectPlanFixture(
        useSetupCode = true,
        setupCode = requireNotNull(scanned.setupCode),
        tokenInput = "stale-shared-token",
        passwordInput = "stale-shared-password",
      )

    assertEquals(GatewaySavedAuthAction.REPLACE_SETUP, plan?.savedAuthAction)
    assertEquals("10.0.2.2", plan?.config?.host)
    assertEquals(18789, plan?.config?.port)
    assertEquals(false, plan?.config?.tls)
    assertEquals("bootstrap-1", plan?.config?.bootstrapToken)
    assertEquals("", plan?.config?.token)
    assertEquals("", plan?.config?.password)
    assertNull(scanned.error)
  }

  @Test
  fun resolveGatewayConnectPlanUsesOneExplicitCredentialFamily() {
    val plan =
      resolveConnectPlanFixture(
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
      resolveConnectPlanFixture(
        savedManualHost = "gateway.local",
        manualHostInput = "gateway.local",
        bootstrapTokenInput = "replacement-bootstrap",
      )

    assertEquals(GatewaySavedAuthAction.REPLACE_SETUP, plan?.savedAuthAction)
    assertEquals("replacement-bootstrap", plan?.config?.bootstrapToken)
  }

  @Test
  fun resolveGatewayConnectPlanPreservesAuthForHostnameCaseOnlyEdit() {
    val plan =
      resolveConnectPlanFixture(
        savedManualHost = "Gateway.Local",
        manualHostInput = "gateway.local",
      )

    assertEquals(GatewaySavedAuthAction.PRESERVE, plan?.savedAuthAction)
  }

  @Test
  fun resolveGatewayConnectConfigAllowsPrivateLanManualCleartextEndpoint() {
    val resolved =
      resolveConnectConfigFixture(
        manualHostInput = "192.168.31.100",
        manualPortInput = "18789",
        bootstrapTokenInput = "bootstrap-1",
      )

    assertEquals("192.168.31.100", resolved?.host)
    assertEquals(18789, resolved?.port)
    assertEquals(false, resolved?.tls)
  }

  @Test
  fun resolveGatewayConnectConfigAllowsMdnsManualCleartextEndpoint() {
    val resolved =
      resolveConnectConfigFixture(
        manualHostInput = "gateway.local",
        manualPortInput = "18789",
        bootstrapTokenInput = "bootstrap-1",
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
  fun composeGatewayManualUrlPreservesAllCompleteEndpointSchemes() {
    val cases =
      listOf(
        "ws://gateway.local:18790" to true,
        "http://192.168.1.20:18790/gateway" to true,
        "wss://gateway.example:8443" to false,
        "https://gateway.example/gateway" to false,
        "HTTPS://gateway.example:443" to false,
        "WS://GATEWAY.LOCAL.:18790" to true,
        "ws://[::1]:18790" to true,
        "wss://[2001:db8::1]:443" to false,
      )

    for ((hostInput, staleTls) in cases) {
      assertEquals(
        hostInput,
        hostInput,
        composeGatewayManualUrl(hostInput, "not-a-port", tls = staleTls),
      )
    }
  }

  @Test
  fun composeGatewayManualUrlPreservesCompleteEndpointValidationError() {
    val url = composeGatewayManualUrl("ws://gateway.example:18789", "18789", tls = false)

    assertEquals(GatewayEndpointValidationError.INSECURE_REMOTE_URL, parseGatewayEndpointResult(url!!).error)
  }

  @Test
  fun resolveGatewayConnectConfigManualAcceptsCompleteLanEndpoint() {
    val resolved =
      resolveConnectConfigFixture(
        manualHostInput = "ws://192.168.178.57:18790",
        manualPortInput = "18789",
        manualTlsInput = true,
      )

    assertEquals("192.168.178.57", resolved?.host)
    assertEquals(18790, resolved?.port)
    assertEquals(false, resolved?.tls)
  }

  @Test
  fun composeGatewayManualUrlPreservesPastedManualAuthorities() {
    for (case in pastedManualAuthorityCases) {
      val url = composeGatewayManualUrl(case.hostInput, case.portInput, case.tls)

      assertEquals(case.hostInput, case.expectedUrl, url)
      assertEquals(case.hostInput, case.expectedEndpoint, url?.let(::parseGatewayEndpoint))
    }
  }

  @Test
  fun resolveGatewayConnectConfigPreservesPastedManualAuthorities() {
    for (case in pastedManualAuthorityCases) {
      val resolved =
        resolveConnectConfigFixture(
          manualHostInput = case.hostInput,
          manualPortInput = case.portInput,
          manualTlsInput = case.tls,
        )

      assertEquals(
        case.hostInput,
        GatewayConnectConfig(
          host = case.expectedHost,
          port = case.expectedPort,
          tls = case.tls,
          bootstrapToken = "",
          token = "",
          password = "",
        ),
        resolved,
      )
    }
  }

  @Test
  fun resolveGatewayConnectPlanPreservesSavedAuthForPastedManualAuthorities() {
    for (case in pastedManualAuthorityCases) {
      val plan =
        resolveConnectPlanFixture(
          savedManualHost = case.expectedHost,
          savedManualPort = case.expectedPort.toString(),
          savedManualTls = case.tls,
          manualHostInput = case.hostInput,
          manualPortInput = case.portInput,
          manualTlsInput = case.tls,
        )

      assertEquals(case.hostInput, GatewaySavedAuthAction.PRESERVE, plan?.savedAuthAction)
    }
  }

  @Test
  fun composeGatewayManualUrlRejectsInvalidPastedAuthorityPorts() {
    val hosts =
      listOf(
        "192.168.1.20:",
        "192.168.1.20:0",
        "192.168.1.20:-1",
        "192.168.1.20:65536",
        "192.168.1.20:99999999999999999999",
        "gateway.local:",
        "gateway.local:not-a-port",
        "gateway.local:65536",
        "[::1]:",
        "[::1]:0",
        "[::1]:65536",
        "[::1]:99999999999999999999",
        "[::1]:not-a-port",
      )

    for (hostInput in hosts) {
      assertNull(hostInput, composeGatewayManualUrl(hostInput, "18789", tls = false))
      assertNull(
        hostInput,
        resolveConnectConfigFixture(
          manualHostInput = hostInput,
          manualPortInput = "18789",
        ),
      )
    }
  }

  @Test
  fun composeGatewayManualUrlRejectsPastedAuthorityUserInfoQueriesAndFragments() {
    val hosts =
      listOf(
        "gateway.local@evil.example:443",
        "gateway.local:18789@evil.example:443",
        "user:password@gateway.local:18789",
        "gateway.local:18789?redirect=evil.example",
        "gateway.local:18789#evil.example",
        "[::1]:18789?redirect=evil.example",
        "[::1]:18789#evil.example",
        "wss://user@gateway.example/openclaw-gw",
        "wss://gateway.example/openclaw-gw?mode=manual",
        "wss://gateway.example/openclaw-gw#fragment",
      )

    for (hostInput in hosts) {
      assertNull(hostInput, composeGatewayManualUrl(hostInput, "18789", tls = true))
      assertNull(
        hostInput,
        resolveConnectConfigFixture(
          manualHostInput = hostInput,
          manualPortInput = "18789",
          manualTlsInput = true,
        ),
      )
    }
  }

  @Test
  fun composeGatewayManualUrlRejectsInvalidSeparatelyEnteredPorts() {
    for (portInput in listOf("0", "-1", "65536", "99999999999999999999", "not-a-port")) {
      assertNull(portInput, composeGatewayManualUrl("gateway.local", portInput, tls = false))
    }
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
    val cases =
      listOf(
        ManualAuthorityCase(
          hostInput = "::1",
          expectedHost = "::1",
          expectedPort = 18789,
          portInput = "18789",
        ),
        ManualAuthorityCase(
          hostInput = "[::1]",
          expectedHost = "::1",
          expectedPort = 18789,
          portInput = "18789",
        ),
        ManualAuthorityCase(
          hostInput = "::ffff:127.0.0.1",
          expectedHost = "::ffff:127.0.0.1",
          expectedPort = 18789,
          portInput = "18789",
        ),
        ManualAuthorityCase(
          hostInput = "[::ffff:127.0.0.1]",
          expectedHost = "::ffff:127.0.0.1",
          expectedPort = 18789,
          portInput = "18789",
        ),
        ManualAuthorityCase(
          hostInput = "2001:db8::1",
          expectedHost = "2001:db8::1",
          expectedPort = 18789,
          tls = true,
          portInput = "18789",
        ),
        ManualAuthorityCase(
          hostInput = "[2001:db8::1]",
          expectedHost = "2001:db8::1",
          expectedPort = 18789,
          tls = true,
          portInput = "18789",
        ),
      )

    for (case in cases) {
      val url = composeGatewayManualUrl(case.hostInput, case.portInput, case.tls)

      assertEquals(case.hostInput, case.expectedUrl, url)
      assertEquals(case.hostInput, case.expectedEndpoint, url?.let(::parseGatewayEndpoint))
    }
  }

  @Test
  fun composeGatewayManualUrlPreservesIpv6ZoneValidationErrors() {
    val hosts =
      listOf(
        "fe80::1%25eth0",
        "[fe80::1%25eth0]",
        "[fe80::1%25eth0]:18789",
      )

    for (hostInput in hosts) {
      val url = composeGatewayManualUrl(hostInput, "18789", tls = false)

      assertEquals(
        hostInput,
        GatewayEndpointValidationError.IPV6_ZONE_ID_UNSUPPORTED,
        url?.let(::parseGatewayEndpointResult)?.error,
      )
    }
  }

  @Test
  fun resolveGatewayConnectConfigManualAcceptsTailscaleHostWithoutPort() {
    val resolved =
      resolveConnectConfigFixture(
        manualHostInput = "mydevice.tail1234.ts.net",
        manualPortInput = "",
        manualTlsInput = true,
      )

    assertEquals("mydevice.tail1234.ts.net", resolved?.host)
    assertEquals(443, resolved?.port)
    assertEquals(true, resolved?.tls)
  }

  private fun assertParsedEndpoint(
    input: String,
    host: String,
    port: Int = 18789,
    tls: Boolean = false,
    displayUrl: String,
  ) {
    assertEquals(
      GatewayEndpointConfig(
        host = host,
        port = port,
        tls = tls,
        displayUrl = displayUrl,
      ),
      parseGatewayEndpoint(input),
    )
  }

  private fun assertEndpointRejected(input: String) {
    assertNull(parseGatewayEndpoint(input))
  }

  private fun setupCode(url: String): String = encodeSetupCode("""{"url":"$url","bootstrapToken":"bootstrap-1"}""")

  private fun assertScannedSetupCodeAccepted(setupCode: String) {
    val resolved = resolveScannedSetupCodeResult(setupCode)
    assertEquals(setupCode, resolved.setupCode)
    assertNull(resolved.error)
  }

  private fun assertScannedSetupCodeRejected(
    setupCode: String,
    expectedError: GatewayEndpointValidationError,
  ) {
    val resolved = resolveScannedSetupCodeResult(setupCode)
    assertNull(resolved.setupCode)
    assertEquals(expectedError, resolved.error)
  }

  private fun resolveConnectConfigFixture(
    useSetupCode: Boolean = false,
    setupCode: String = "",
    manualHostInput: String = "",
    manualPortInput: String = "",
    manualTlsInput: Boolean = false,
    bootstrapTokenInput: String = "",
    tokenInput: String = "",
    passwordInput: String = "",
  ): GatewayConnectConfig? =
    resolveGatewayConnectConfig(
      useSetupCode = useSetupCode,
      setupCode = setupCode,
      manualHostInput = manualHostInput,
      manualPortInput = manualPortInput,
      manualTlsInput = manualTlsInput,
      bootstrapTokenInput = bootstrapTokenInput,
      tokenInput = tokenInput,
      passwordInput = passwordInput,
    )

  private fun resolveConnectPlanFixture(
    useSetupCode: Boolean = false,
    setupCode: String = "",
    savedManualHost: String = "127.0.0.1",
    savedManualPort: String = "18789",
    savedManualTls: Boolean = false,
    manualHostInput: String = "127.0.0.1",
    manualPortInput: String = "18789",
    manualTlsInput: Boolean = false,
    bootstrapTokenInput: String = "",
    tokenInput: String = "",
    passwordInput: String = "",
  ): GatewayConnectPlan? =
    resolveGatewayConnectPlan(
      useSetupCode = useSetupCode,
      setupCode = setupCode,
      savedManualHost = savedManualHost,
      savedManualPort = savedManualPort,
      savedManualTls = savedManualTls,
      manualHostInput = manualHostInput,
      manualPortInput = manualPortInput,
      manualTlsInput = manualTlsInput,
      bootstrapTokenInput = bootstrapTokenInput,
      tokenInput = tokenInput,
      passwordInput = passwordInput,
    )

  private val pastedManualAuthorityCases =
    listOf(
      ManualAuthorityCase(
        hostInput = "192.168.178.57:18790",
        expectedHost = "192.168.178.57",
        expectedPort = 18790,
      ),
      ManualAuthorityCase(
        hostInput = "192.168.178.57:1",
        expectedHost = "192.168.178.57",
        expectedPort = 1,
      ),
      ManualAuthorityCase(
        hostInput = "gateway.local:18790",
        expectedHost = "gateway.local",
        expectedPort = 18790,
      ),
      ManualAuthorityCase(
        hostInput = "gateway.local:65535",
        expectedHost = "gateway.local",
        expectedPort = 65535,
      ),
      ManualAuthorityCase(
        hostInput = "GATEWAY.LOCAL.:18790",
        expectedHost = "GATEWAY.LOCAL.",
        expectedPort = 18790,
        portInput = "65536",
      ),
      ManualAuthorityCase(
        hostInput = "gateway.example:443",
        expectedHost = "gateway.example",
        expectedPort = 443,
        tls = true,
      ),
      ManualAuthorityCase(
        hostInput = "gateway.example:8443",
        expectedHost = "gateway.example",
        expectedPort = 8443,
        tls = true,
      ),
      ManualAuthorityCase(
        hostInput = "mydevice.tail1234.ts.net:8443",
        expectedHost = "mydevice.tail1234.ts.net",
        expectedPort = 8443,
        tls = true,
        portInput = "",
      ),
      ManualAuthorityCase(
        hostInput = "[::1]:18790",
        expectedHost = "::1",
        expectedPort = 18790,
      ),
      ManualAuthorityCase(
        hostInput = "[2001:db8::1]:8443",
        expectedHost = "2001:db8::1",
        expectedPort = 8443,
        tls = true,
      ),
    )

  private data class ManualAuthorityCase(
    val hostInput: String,
    val expectedHost: String,
    val expectedPort: Int,
    val tls: Boolean = false,
    val portInput: String = "not-a-port",
  ) {
    val expectedUrl: String
      get() {
        val scheme = if (tls) "https" else "http"
        val formattedHost = if (expectedHost.contains(':')) "[$expectedHost]" else expectedHost
        return "$scheme://$formattedHost:$expectedPort"
      }

    val expectedEndpoint: GatewayEndpointConfig
      get() =
        GatewayEndpointConfig(
          host = expectedHost,
          port = expectedPort,
          tls = tls,
          displayUrl = if (tls && expectedPort == 443) expectedUrl.removeSuffix(":443") else expectedUrl,
        )
  }

  private fun encodeSetupCode(payloadJson: String): String = Base64.getUrlEncoder().withoutPadding().encodeToString(payloadJson.toByteArray(Charsets.UTF_8))
}
