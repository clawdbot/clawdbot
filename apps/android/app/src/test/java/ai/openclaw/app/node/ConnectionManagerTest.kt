package ai.openclaw.app.node

import ai.openclaw.app.BuildConfig
import ai.openclaw.app.LocationMode
import ai.openclaw.app.SecurePrefs
import ai.openclaw.app.gateway.GatewayEndpoint
import ai.openclaw.app.gateway.GatewayTlsParams
import ai.openclaw.app.gateway.isLocalCleartextGatewayHost
import ai.openclaw.app.gateway.isLoopbackGatewayHost
import ai.openclaw.app.protocol.OpenClawCallLogCommand
import ai.openclaw.app.protocol.OpenClawCameraCommand
import ai.openclaw.app.protocol.OpenClawCapability
import ai.openclaw.app.protocol.OpenClawDeviceCommand
import ai.openclaw.app.protocol.OpenClawLocationCommand
import ai.openclaw.app.protocol.OpenClawMobileUiCommand
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
  fun resolveTlsParamsForEndpoint_prefersStoredPinOverAdvertisedFingerprint() =
    assertTls(
      resolveDiscoveredTls(
        host = "10.0.0.2",
        storedFingerprint = "legit",
        tlsEnabled = true,
        advertisedFingerprint = "attacker",
      ),
      expectedFingerprint = "legit",
    )

  @Test
  fun resolveTlsParamsForEndpoint_doesNotTrustAdvertisedFingerprintWhenNoStoredPin() =
    assertTls(
      resolveDiscoveredTls(
        host = "10.0.0.2",
        tlsEnabled = true,
        advertisedFingerprint = "attacker",
      ),
    )

  @Test
  fun resolveTlsParamsForEndpoint_manualRespectsManualTlsToggle() {
    assertNull(resolveManualTls(host = "127.0.0.1", port = 443))
    assertTls(resolveManualTls(host = "127.0.0.1", port = 443, manualTlsEnabled = true))
  }

  @Test
  fun resolveTlsParamsForEndpoint_manualNonLoopbackForcesTlsWhenToggleIsOff() = assertTlsRequired(resolveManualTls(host = "example.com", port = 443))

  @Test
  fun resolveTlsParamsForEndpoint_manualPrivateLanRespectsManualTlsToggle() = assertNull(resolveManualTls("192.168.1.20"))

  @Test
  fun resolveTlsParamsForEndpoint_manualMdnsRespectsManualTlsToggle() = assertNull(resolveManualTls("gateway.local"))

  @Test
  fun resolveTlsParamsForEndpoint_manualPrivateLanCleartextCanOverrideStoredPin() = assertNull(resolveManualTls(host = "192.168.1.20", storedFingerprint = "pinned"))

  @Test
  fun resolveTlsParamsForEndpoint_discoveryTailnetWithoutHintsStillRequiresTls() = assertDiscoveredHostRequiresTls("100.64.0.9")

  @Test
  fun resolveTlsParamsForEndpoint_discoveryPrivateLanWithoutHintsStillRequiresTls() = assertDiscoveredHostRequiresTls("192.168.1.20")

  @Test
  fun resolveTlsParamsForEndpoint_discoveryMdnsWithoutHintsStillRequiresTls() = assertDiscoveredHostRequiresTls("gateway.local")

  @Test
  fun resolveTlsParamsForEndpoint_discoveryLoopbackWithoutHintsCanStayCleartext() = assertDiscoveredHostCanStayCleartext("127.0.0.1")

  @Test
  fun resolveTlsParamsForEndpoint_discoveryLocalhostWithoutHintsCanStayCleartext() = assertDiscoveredHostCanStayCleartext("localhost")

  @Test
  fun resolveTlsParamsForEndpoint_discoveryAndroidEmulatorWithoutHintsCanStayCleartext() = assertDiscoveredHostCanStayCleartext("10.0.2.2")

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
  fun resolveTlsParamsForEndpoint_discoveryIpv6LoopbackWithoutHintsCanStayCleartext() = assertDiscoveredHostCanStayCleartext("::1")

  @Test
  fun resolveTlsParamsForEndpoint_discoveryMappedIpv4LoopbackWithoutHintsCanStayCleartext() = assertDiscoveredHostCanStayCleartext("::ffff:127.0.0.1")

  @Test
  fun resolveTlsParamsForEndpoint_discoveryNonLoopbackIpv6WithoutHintsRequiresTls() = assertDiscoveredHostRequiresTls("2001:db8::1")

  @Test
  fun resolveTlsParamsForEndpoint_discoveryUnspecifiedIpv4WithoutHintsRequiresTls() = assertDiscoveredHostRequiresTls("0.0.0.0")

  @Test
  fun resolveTlsParamsForEndpoint_discoveryUnspecifiedIpv6WithoutHintsRequiresTls() = assertDiscoveredHostRequiresTls("::")

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
        ConnectionManager.USAGE_REFRESHING_CLIENT_CAPABILITY,
      ),
      options.caps,
    )
  }

  @Test
  fun buildOperatorConnectOptions_omitsInlineWidgetsWithoutIsolatedWebViews() {
    val options = newManager(inlineWidgetsAvailable = false).buildOperatorConnectOptions()

    assertEquals(
      listOf(
        ConnectionManager.AGENT_KIND_CLIENT_CAPABILITY,
        ConnectionManager.USAGE_REFRESHING_CLIENT_CAPABILITY,
      ),
      options.caps,
    )
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
  fun buildNodeConnectOptions_advertisesMobileUiOnlyWhileAvailable() {
    val unavailable = newManager(mobileUiAvailable = false).buildNodeConnectOptions()
    val available = newManager(mobileUiAvailable = true).buildNodeConnectOptions()

    assertFalse(unavailable.caps.contains(OpenClawCapability.MobileUI.rawValue))
    assertFalse(unavailable.commands.contains(OpenClawMobileUiCommand.Observe.rawValue))
    assertFalse(unavailable.commands.contains(OpenClawMobileUiCommand.Act.rawValue))
    assertTrue(available.caps.contains(OpenClawCapability.MobileUI.rawValue))
    assertTrue(available.commands.contains(OpenClawMobileUiCommand.Observe.rawValue))
    assertTrue(available.commands.contains(OpenClawMobileUiCommand.Act.rawValue))
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

  @Test
  fun buildNodeConnectOptions_advertisesCurrentPermissionSnapshot() {
    val permissionSnapshot =
      emptyPermissionSnapshot().copy(
        camera = true,
        location = true,
        locationPrecise = false,
        smsSend = true,
      )

    val options = newManager(permissionSnapshot = permissionSnapshot).buildNodeConnectOptions()

    assertEquals(permissionSnapshot.gatewayPermissions(), options.permissions)
  }

  private fun resolveDiscoveredTls(
    host: String,
    storedFingerprint: String? = null,
    tlsEnabled: Boolean = false,
    advertisedFingerprint: String? = null,
  ): GatewayTlsParams? =
    ConnectionManager.resolveTlsParamsForEndpoint(
      GatewayEndpoint(
        stableId = "_openclaw-gw._tcp.|local.|Test",
        name = "Test",
        host = host,
        port = 18789,
        tlsEnabled = tlsEnabled,
        tlsFingerprintSha256 = advertisedFingerprint,
      ),
      storedFingerprint = storedFingerprint,
      manualTlsEnabled = false,
    )

  private fun resolveManualTls(
    host: String,
    port: Int = 18789,
    storedFingerprint: String? = null,
    manualTlsEnabled: Boolean = false,
  ): GatewayTlsParams? =
    ConnectionManager.resolveTlsParamsForEndpoint(
      GatewayEndpoint.manual(host = host, port = port),
      storedFingerprint = storedFingerprint,
      manualTlsEnabled = manualTlsEnabled,
    )

  private fun assertTls(
    params: GatewayTlsParams?,
    expectedFingerprint: String? = null,
  ) {
    assertEquals(expectedFingerprint, params?.expectedFingerprint)
    assertEquals(false, params?.allowTOFU)
  }

  private fun assertTlsRequired(params: GatewayTlsParams?) {
    assertEquals(true, params?.required)
    assertTls(params)
  }

  private fun assertDiscoveredHostRequiresTls(host: String) = assertTlsRequired(resolveDiscoveredTls(host))

  private fun assertDiscoveredHostCanStayCleartext(host: String) = assertNull(resolveDiscoveredTls(host))

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
    mobileUiAvailable: Boolean = false,
    inlineWidgetsAvailable: Boolean = true,
    permissionSnapshot: AndroidPermissionSnapshot = emptyPermissionSnapshot(),
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

    val dispatcher =
      newInvokeDispatcher(
        cameraEnabled = { cameraEnabled },
        locationEnabled = locationMode != LocationMode.Off,
        motionActivityAvailable = motionActivityAvailable,
        motionPedometerAvailable = motionPedometerAvailable,
        sendSmsAvailable = sendSmsAvailable,
        readSmsAvailable = readSmsAvailable,
        smsSearchPossible = { smsSearchPossible },
        callLogAvailable = callLogAvailable,
        photosAvailable = photosAvailable,
        installedAppsSharingEnabled = installedAppsSharingEnabled,
        debugBuild = BuildConfig.DEBUG,
        voiceWakeAvailable = { prefs.voiceWakeEnabled.value && voiceWakeAvailable },
        mobileUiAvailable = mobileUiAvailable,
      )

    return ConnectionManager(
      prefs = prefs,
      advertisedCapabilities = dispatcher::buildCapabilities,
      advertisedCommands = dispatcher::buildInvokeCommands,
      inlineWidgetsAvailable = { inlineWidgetsAvailable },
      permissionSnapshot = { permissionSnapshot },
      manualTls = { false },
    )
  }

  private fun emptyPermissionSnapshot(): AndroidPermissionSnapshot =
    AndroidPermissionSnapshot(
      camera = false,
      microphone = false,
      location = false,
      locationPrecise = false,
      locationBackground = false,
      smsSend = false,
      smsRead = false,
      notificationListener = false,
      notifications = false,
      photos = false,
      contactsRead = false,
      contactsWrite = false,
      calendarRead = false,
      calendarWrite = false,
      callLog = false,
      motion = false,
    )
}
