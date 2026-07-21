package ai.openclaw.app.node

import ai.openclaw.app.LocationMode
import ai.openclaw.app.SecurePrefs
import ai.openclaw.app.gateway.GatewayEndpoint
import ai.openclaw.app.gateway.isLocalCleartextGatewayHost
import ai.openclaw.app.gateway.isLoopbackGatewayHost
import ai.openclaw.app.protocol.OpenClawCallLogCommand
import ai.openclaw.app.protocol.OpenClawCameraCommand
import ai.openclaw.app.protocol.OpenClawCapability
import ai.openclaw.app.protocol.OpenClawDeviceCommand
import ai.openclaw.app.protocol.OpenClawLocationCommand
import ai.openclaw.app.protocol.OpenClawMotionCommand
import ai.openclaw.app.protocol.OpenClawPhotosCommand
import ai.openclaw.app.protocol.OpenClawSmsCommand
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment

@RunWith(RobolectricTestRunner::class)
class ConnectionManagerTest {
  @Test
  fun resolveTlsParamsForEndpoint_prefersStoredPinOverAdvertisedFingerprint() {
    val endpoint =
      GatewayEndpoint(
        stableId = "_openclaw-gw._tcp.|local.|Test",
        name = "Test",
        host = "10.0.0.2",
        port = 18789,
        tlsEnabled = true,
        tlsFingerprintSha256 = "attacker",
      )

    val params =
      ConnectionManager.resolveTlsParamsForEndpoint(
        endpoint,
        storedFingerprint = "legit",
        manualTlsEnabled = false,
      )

    assertEquals("legit", params?.expectedFingerprint)
    assertEquals(false, params?.allowTOFU)
  }

  @Test
  fun resolveTlsParamsForEndpoint_doesNotTrustAdvertisedFingerprintWhenNoStoredPin() {
    val endpoint =
      GatewayEndpoint(
        stableId = "_openclaw-gw._tcp.|local.|Test",
        name = "Test",
        host = "10.0.0.2",
        port = 18789,
        tlsEnabled = true,
        tlsFingerprintSha256 = "attacker",
      )

    val params =
      ConnectionManager.resolveTlsParamsForEndpoint(
        endpoint,
        storedFingerprint = null,
        manualTlsEnabled = false,
      )

    assertNull(params?.expectedFingerprint)
    assertEquals(false, params?.allowTOFU)
  }

  @Test
  fun resolveTlsParamsForEndpoint_manualRespectsManualTlsToggle() {
    val endpoint = GatewayEndpoint.manual(host = "127.0.0.1", port = 443)

    val off =
      ConnectionManager.resolveTlsParamsForEndpoint(
        endpoint,
        storedFingerprint = null,
        manualTlsEnabled = false,
      )
    assertNull(off)

    val on =
      ConnectionManager.resolveTlsParamsForEndpoint(
        endpoint,
        storedFingerprint = null,
        manualTlsEnabled = true,
      )
    assertNull(on?.expectedFingerprint)
    assertEquals(false, on?.allowTOFU)
  }

  @Test
  fun resolveTlsParamsForEndpoint_manualNonLoopbackForcesTlsWhenToggleIsOff() {
    val endpoint = GatewayEndpoint.manual(host = "example.com", port = 443)

    val params =
      ConnectionManager.resolveTlsParamsForEndpoint(
        endpoint,
        storedFingerprint = null,
        manualTlsEnabled = false,
      )

    assertEquals(true, params?.required)
    assertNull(params?.expectedFingerprint)
    assertEquals(false, params?.allowTOFU)
  }

  @Test
  fun resolveTlsParamsForEndpoint_manualPrivateLanRespectsManualTlsToggle() {
    val endpoint = GatewayEndpoint.manual(host = "192.168.1.20", port = 18789)

    val params =
      ConnectionManager.resolveTlsParamsForEndpoint(
        endpoint,
        storedFingerprint = null,
        manualTlsEnabled = false,
      )

    assertNull(params)
  }

  @Test
  fun resolveTlsParamsForEndpoint_manualMdnsRespectsManualTlsToggle() {
    val endpoint = GatewayEndpoint.manual(host = "gateway.local", port = 18789)

    val params =
      ConnectionManager.resolveTlsParamsForEndpoint(
        endpoint,
        storedFingerprint = null,
        manualTlsEnabled = false,
      )

    assertNull(params)
  }

  @Test
  fun resolveTlsParamsForEndpoint_manualPrivateLanCleartextCanOverrideStoredPin() {
    val endpoint = GatewayEndpoint.manual(host = "192.168.1.20", port = 18789)

    val params =
      ConnectionManager.resolveTlsParamsForEndpoint(
        endpoint,
        storedFingerprint = "pinned",
        manualTlsEnabled = false,
      )

    assertNull(params)
  }

  @Test
  fun resolveTlsParamsForEndpoint_discoveryTailnetWithoutHintsStillRequiresTls() {
    val endpoint =
      GatewayEndpoint(
        stableId = "_openclaw-gw._tcp.|local.|Test",
        name = "Test",
        host = "100.64.0.9",
        port = 18789,
        tlsEnabled = false,
        tlsFingerprintSha256 = null,
      )

    val params =
      ConnectionManager.resolveTlsParamsForEndpoint(
        endpoint,
        storedFingerprint = null,
        manualTlsEnabled = false,
      )

    assertEquals(true, params?.required)
    assertNull(params?.expectedFingerprint)
    assertEquals(false, params?.allowTOFU)
  }

  @Test
  fun resolveTlsParamsForEndpoint_discoveryPrivateLanWithoutHintsStillRequiresTls() {
    val endpoint =
      GatewayEndpoint(
        stableId = "_openclaw-gw._tcp.|local.|Test",
        name = "Test",
        host = "192.168.1.20",
        port = 18789,
        tlsEnabled = false,
        tlsFingerprintSha256 = null,
      )

    val params =
      ConnectionManager.resolveTlsParamsForEndpoint(
        endpoint,
        storedFingerprint = null,
        manualTlsEnabled = false,
      )

    assertEquals(true, params?.required)
    assertNull(params?.expectedFingerprint)
    assertEquals(false, params?.allowTOFU)
  }

  @Test
  fun resolveTlsParamsForEndpoint_discoveryMdnsWithoutHintsStillRequiresTls() {
    val endpoint =
      GatewayEndpoint(
        stableId = "_openclaw-gw._tcp.|local.|Test",
        name = "Test",
        host = "gateway.local",
        port = 18789,
        tlsEnabled = false,
        tlsFingerprintSha256 = null,
      )

    val params =
      ConnectionManager.resolveTlsParamsForEndpoint(
        endpoint,
        storedFingerprint = null,
        manualTlsEnabled = false,
      )

    assertEquals(true, params?.required)
    assertNull(params?.expectedFingerprint)
    assertEquals(false, params?.allowTOFU)
  }

  @Test
  fun resolveTlsParamsForEndpoint_discoveryLoopbackWithoutHintsCanStayCleartext() {
    val endpoint =
      GatewayEndpoint(
        stableId = "_openclaw-gw._tcp.|local.|Test",
        name = "Test",
        host = "127.0.0.1",
        port = 18789,
        tlsEnabled = false,
        tlsFingerprintSha256 = null,
      )

    val params =
      ConnectionManager.resolveTlsParamsForEndpoint(
        endpoint,
        storedFingerprint = null,
        manualTlsEnabled = false,
      )

    assertNull(params)
  }

  @Test
  fun resolveTlsParamsForEndpoint_discoveryLocalhostWithoutHintsCanStayCleartext() {
    val endpoint =
      GatewayEndpoint(
        stableId = "_openclaw-gw._tcp.|local.|Test",
        name = "Test",
        host = "localhost",
        port = 18789,
        tlsEnabled = false,
        tlsFingerprintSha256 = null,
      )

    val params =
      ConnectionManager.resolveTlsParamsForEndpoint(
        endpoint,
        storedFingerprint = null,
        manualTlsEnabled = false,
      )

    assertNull(params)
  }

  @Test
  fun resolveTlsParamsForEndpoint_discoveryAndroidEmulatorWithoutHintsCanStayCleartext() {
    val endpoint =
      GatewayEndpoint(
        stableId = "_openclaw-gw._tcp.|local.|Test",
        name = "Test",
        host = "10.0.2.2",
        port = 18789,
        tlsEnabled = false,
        tlsFingerprintSha256 = null,
      )

    val params =
      ConnectionManager.resolveTlsParamsForEndpoint(
        endpoint,
        storedFingerprint = null,
        manualTlsEnabled = false,
      )

    assertNull(params)
  }

  @Test
  fun isLoopbackGatewayHost_onlyTreatsEmulatorBridgeAsLocalWhenAllowed() {
    assertTrue(isLoopbackGatewayHost("10.0.2.2", allowEmulatorBridgeAlias = true))
    assertFalse(isLoopbackGatewayHost("10.0.2.2", allowEmulatorBridgeAlias = false))
  }

  @Test
  fun isLocalCleartextGatewayHost_acceptsLanIpsAndMdnsButRejectsRemoteHosts() {
    assertTrue(isLocalCleartextGatewayHost("192.168.1.20"))
    assertTrue(isLocalCleartextGatewayHost("gateway.local"))
    assertTrue(isLocalCleartextGatewayHost("GATEWAY.LOCAL."))
    assertFalse(isLocalCleartextGatewayHost("gateway.local.evil.com"))
    assertFalse(isLocalCleartextGatewayHost("gatewaylocal"))
    assertFalse(isLocalCleartextGatewayHost("local"))
    assertFalse(isLocalCleartextGatewayHost(".local"))
    assertFalse(isLocalCleartextGatewayHost("gateway..local"))
    assertFalse(isLocalCleartextGatewayHost("gateway.local%25wlan0"))
    assertFalse(isLocalCleartextGatewayHost("100.64.0.9"))
    assertFalse(isLocalCleartextGatewayHost("gateway.tailnet.ts.net"))
  }

  @Test
  fun resolveTlsParamsForEndpoint_discoveryIpv6LoopbackWithoutHintsCanStayCleartext() {
    val endpoint =
      GatewayEndpoint(
        stableId = "_openclaw-gw._tcp.|local.|Test",
        name = "Test",
        host = "::1",
        port = 18789,
        tlsEnabled = false,
        tlsFingerprintSha256 = null,
      )

    val params =
      ConnectionManager.resolveTlsParamsForEndpoint(
        endpoint,
        storedFingerprint = null,
        manualTlsEnabled = false,
      )

    assertNull(params)
  }

  @Test
  fun resolveTlsParamsForEndpoint_discoveryMappedIpv4LoopbackWithoutHintsCanStayCleartext() {
    val endpoint =
      GatewayEndpoint(
        stableId = "_openclaw-gw._tcp.|local.|Test",
        name = "Test",
        host = "::ffff:127.0.0.1",
        port = 18789,
        tlsEnabled = false,
        tlsFingerprintSha256 = null,
      )

    val params =
      ConnectionManager.resolveTlsParamsForEndpoint(
        endpoint,
        storedFingerprint = null,
        manualTlsEnabled = false,
      )

    assertNull(params)
  }

  @Test
  fun resolveTlsParamsForEndpoint_discoveryNonLoopbackIpv6WithoutHintsRequiresTls() {
    val endpoint =
      GatewayEndpoint(
        stableId = "_openclaw-gw._tcp.|local.|Test",
        name = "Test",
        host = "2001:db8::1",
        port = 18789,
        tlsEnabled = false,
        tlsFingerprintSha256 = null,
      )

    val params =
      ConnectionManager.resolveTlsParamsForEndpoint(
        endpoint,
        storedFingerprint = null,
        manualTlsEnabled = false,
      )

    assertEquals(true, params?.required)
    assertNull(params?.expectedFingerprint)
    assertEquals(false, params?.allowTOFU)
  }

  @Test
  fun resolveTlsParamsForEndpoint_discoveryUnspecifiedIpv4WithoutHintsRequiresTls() {
    val endpoint =
      GatewayEndpoint(
        stableId = "_openclaw-gw._tcp.|local.|Test",
        name = "Test",
        host = "0.0.0.0",
        port = 18789,
        tlsEnabled = false,
        tlsFingerprintSha256 = null,
      )

    val params =
      ConnectionManager.resolveTlsParamsForEndpoint(
        endpoint,
        storedFingerprint = null,
        manualTlsEnabled = false,
      )

    assertEquals(true, params?.required)
    assertNull(params?.expectedFingerprint)
    assertEquals(false, params?.allowTOFU)
  }

  @Test
  fun resolveTlsParamsForEndpoint_discoveryUnspecifiedIpv6WithoutHintsRequiresTls() {
    val endpoint =
      GatewayEndpoint(
        stableId = "_openclaw-gw._tcp.|local.|Test",
        name = "Test",
        host = "::",
        port = 18789,
        tlsEnabled = false,
        tlsFingerprintSha256 = null,
      )

    val params =
      ConnectionManager.resolveTlsParamsForEndpoint(
        endpoint,
        storedFingerprint = null,
        manualTlsEnabled = false,
      )

    assertEquals(true, params?.required)
    assertNull(params?.expectedFingerprint)
    assertEquals(false, params?.allowTOFU)
  }

  @Test
  fun buildOperatorConnectOptions_requestsNativeClientOperatorScopes() {
    val options = newManager().buildOperatorConnectOptions()

    assertEquals(
      listOf(
        "operator.admin",
        "operator.approvals",
        "operator.questions",
        "operator.read",
        "operator.talk.secrets",
        "operator.write",
      ),
      options.scopes,
    )
    assertEquals(
      listOf(
        ConnectionManager.AGENT_KIND_CLIENT_CAPABILITY,
        ConnectionManager.INLINE_WIDGETS_CLIENT_CAPABILITY,
      ),
      options.caps,
    )
  }

  @Test
  fun buildOperatorConnectOptions_omitsInlineWidgetsWithoutIsolatedWebViews() {
    val options = newManager(inlineWidgetsAvailable = false).buildOperatorConnectOptions()

    assertEquals(listOf(ConnectionManager.AGENT_KIND_CLIENT_CAPABILITY), options.caps)
  }

  @Test
  fun operatorScopesForStoredDeviceToken_preservesRecordedScopes() {
    assertEquals(
      listOf("operator.read", "operator.write"),
      ConnectionManager.operatorScopesForStoredDeviceToken(
        listOf("operator.read", "operator.write", "operator.read", " "),
      ),
    )
  }

  @Test
  fun operatorScopesForStoredDeviceToken_fallsBackToLegacyScopesWhenMetadataMissing() {
    assertEquals(
      ConnectionManager.legacyOperatorScopes,
      ConnectionManager.operatorScopesForStoredDeviceToken(emptyList()),
    )
  }

  @Test
  fun buildNodeConnectOptions_advertisesRequestableSmsSearchWithoutSmsCapability() {
    val options =
      newManager(
        sendSmsAvailable = false,
        readSmsAvailable = false,
        smsSearchPossible = true,
      ).buildNodeConnectOptions()

    assertTrue(options.commands.contains(OpenClawSmsCommand.Search.rawValue))
    assertFalse(options.commands.contains(OpenClawSmsCommand.Send.rawValue))
    assertFalse(options.caps.contains(OpenClawCapability.Sms.rawValue))
  }

  @Test
  fun buildNodeConnectOptions_doesNotAdvertiseSmsWhenSearchIsImpossible() {
    val options =
      newManager(
        sendSmsAvailable = false,
        readSmsAvailable = false,
        smsSearchPossible = false,
      ).buildNodeConnectOptions()

    assertFalse(options.commands.contains(OpenClawSmsCommand.Search.rawValue))
    assertFalse(options.commands.contains(OpenClawSmsCommand.Send.rawValue))
    assertFalse(options.caps.contains(OpenClawCapability.Sms.rawValue))
  }

  @Test
  fun buildNodeConnectOptions_advertisesSmsCapabilityWhenReadSmsIsAvailable() {
    val options =
      newManager(
        sendSmsAvailable = false,
        readSmsAvailable = true,
        smsSearchPossible = true,
      ).buildNodeConnectOptions()

    assertTrue(options.commands.contains(OpenClawSmsCommand.Search.rawValue))
    assertTrue(options.caps.contains(OpenClawCapability.Sms.rawValue))
  }

  @Test
  fun buildNodeConnectOptions_advertisesSmsSendWithoutSearchWhenOnlySendIsAvailable() {
    val options =
      newManager(
        sendSmsAvailable = true,
        readSmsAvailable = false,
        smsSearchPossible = false,
      ).buildNodeConnectOptions()

    assertTrue(options.commands.contains(OpenClawSmsCommand.Send.rawValue))
    assertFalse(options.commands.contains(OpenClawSmsCommand.Search.rawValue))
    assertTrue(options.caps.contains(OpenClawCapability.Sms.rawValue))
  }

  @Test
  fun buildNodeConnectOptions_advertisesAvailableNonSmsCommandsAndCapabilities() {
    val options =
      newManager(
        cameraEnabled = true,
        locationMode = LocationMode.WhileUsing,
        motionActivityAvailable = true,
        callLogAvailable = true,
        photosAvailable = true,
      ).buildNodeConnectOptions()

    assertTrue(options.commands.contains(OpenClawCameraCommand.List.rawValue))
    assertTrue(options.commands.contains(OpenClawLocationCommand.Get.rawValue))
    assertTrue(options.commands.contains(OpenClawMotionCommand.Activity.rawValue))
    assertTrue(options.commands.contains(OpenClawCallLogCommand.Search.rawValue))
    assertTrue(options.commands.contains(OpenClawPhotosCommand.Latest.rawValue))
    assertTrue(options.caps.contains(OpenClawCapability.Camera.rawValue))
    assertTrue(options.caps.contains(OpenClawCapability.Location.rawValue))
    assertTrue(options.caps.contains(OpenClawCapability.Motion.rawValue))
    assertTrue(options.caps.contains(OpenClawCapability.CallLog.rawValue))
    assertTrue(options.caps.contains(OpenClawCapability.Photos.rawValue))
    assertFalse(options.caps.contains("voiceWake"))
  }

  @Test
  fun buildNodeConnectOptions_advertisesVoiceWakeOnlyWhenEnabledAndAvailable() {
    val disabled = newManager(voiceWakeEnabled = false).buildNodeConnectOptions()
    val unavailable = newManager(voiceWakeEnabled = true, voiceWakeAvailable = false).buildNodeConnectOptions()
    val enabled = newManager(voiceWakeEnabled = true).buildNodeConnectOptions()

    assertFalse(disabled.caps.contains(OpenClawCapability.VoiceWake.rawValue))
    assertFalse(unavailable.caps.contains(OpenClawCapability.VoiceWake.rawValue))
    assertTrue(enabled.caps.contains(OpenClawCapability.VoiceWake.rawValue))
  }

  @Test
  fun buildNodeConnectOptions_advertisesDeviceAppsOnlyWhenUserOptedIn() {
    val disabled = newManager(installedAppsSharingEnabled = false).buildNodeConnectOptions()
    val enabled = newManager(installedAppsSharingEnabled = true).buildNodeConnectOptions()

    assertFalse(disabled.commands.contains(OpenClawDeviceCommand.Apps.rawValue))
    assertTrue(enabled.commands.contains(OpenClawDeviceCommand.Apps.rawValue))
  }

  @Test
  fun buildNodeConnectOptions_omitsUnavailableCameraLocationCallLogAndPhotosSurfaces() {
    val options =
      newManager(
        cameraEnabled = false,
        locationMode = LocationMode.Off,
        callLogAvailable = false,
        photosAvailable = false,
      ).buildNodeConnectOptions()

    assertFalse(options.commands.contains(OpenClawCameraCommand.List.rawValue))
    assertFalse(options.commands.contains(OpenClawCameraCommand.Snap.rawValue))
    assertFalse(options.commands.contains(OpenClawCameraCommand.Clip.rawValue))
    assertFalse(options.commands.contains(OpenClawLocationCommand.Get.rawValue))
    assertFalse(options.commands.contains(OpenClawCallLogCommand.Search.rawValue))
    assertFalse(options.commands.contains(OpenClawPhotosCommand.Latest.rawValue))
    assertFalse(options.caps.contains(OpenClawCapability.Camera.rawValue))
    assertFalse(options.caps.contains(OpenClawCapability.Location.rawValue))
    assertFalse(options.caps.contains(OpenClawCapability.CallLog.rawValue))
    assertFalse(options.caps.contains(OpenClawCapability.Photos.rawValue))
  }

  @Test
  fun buildNodeConnectOptions_advertisesOnlyAvailableMotionCommand() {
    val options =
      newManager(
        motionActivityAvailable = false,
        motionPedometerAvailable = true,
      ).buildNodeConnectOptions()

    assertFalse(options.commands.contains(OpenClawMotionCommand.Activity.rawValue))
    assertTrue(options.commands.contains(OpenClawMotionCommand.Pedometer.rawValue))
    assertTrue(options.caps.contains(OpenClawCapability.Motion.rawValue))
  }

  @Test
  fun buildNodeConnectOptions_omitsMotionSurfaceWhenMotionApisUnavailable() {
    val options =
      newManager(
        motionActivityAvailable = false,
        motionPedometerAvailable = false,
      ).buildNodeConnectOptions()

    assertFalse(options.commands.contains(OpenClawMotionCommand.Activity.rawValue))
    assertFalse(options.commands.contains(OpenClawMotionCommand.Pedometer.rawValue))
    assertFalse(options.caps.contains(OpenClawCapability.Motion.rawValue))
  }

  private fun newManager(
    cameraEnabled: Boolean = false,
    locationMode: LocationMode = LocationMode.Off,
    motionActivityAvailable: Boolean = false,
    motionPedometerAvailable: Boolean = false,
    sendSmsAvailable: Boolean = false,
    readSmsAvailable: Boolean = false,
    smsSearchPossible: Boolean = false,
    callLogAvailable: Boolean = false,
    photosAvailable: Boolean = false,
    installedAppsSharingEnabled: Boolean = false,
    voiceWakeEnabled: Boolean = false,
    voiceWakeAvailable: Boolean = true,
    inlineWidgetsAvailable: Boolean = true,
  ): ConnectionManager {
    val context = RuntimeEnvironment.getApplication()
    context
      .getSharedPreferences("openclaw.node", android.content.Context.MODE_PRIVATE)
      .edit()
      .clear()
      .commit()
    val prefs =
      SecurePrefs(
        context,
        securePrefsOverride = context.getSharedPreferences("connection-manager-test", android.content.Context.MODE_PRIVATE),
      )
    prefs.setVoiceWakeEnabled(voiceWakeEnabled)

    return ConnectionManager(
      prefs = prefs,
      cameraEnabled = { cameraEnabled },
      locationMode = { locationMode },
      motionActivityAvailable = { motionActivityAvailable },
      motionPedometerAvailable = { motionPedometerAvailable },
      sendSmsAvailable = { sendSmsAvailable },
      readSmsAvailable = { readSmsAvailable },
      smsSearchPossible = { smsSearchPossible },
      callLogAvailable = { callLogAvailable },
      photosAvailable = { photosAvailable },
      installedAppsSharingEnabled = { installedAppsSharingEnabled },
      voiceWakeAvailable = { voiceWakeAvailable },
      inlineWidgetsAvailable = { inlineWidgetsAvailable },
      manualTls = { false },
    )
  }
}
