package ai.openclaw.app.ui

import ai.openclaw.app.GatewayConnectionProblem
import ai.openclaw.app.GatewayNodeCapabilityApproval
import ai.openclaw.app.LocationMode
import ai.openclaw.app.gateway.GatewayEndpoint
import ai.openclaw.app.i18n.nativeText
import ai.openclaw.app.i18n.resolveNativeText
import ai.openclaw.app.ui.design.MascotMood
import android.Manifest
import androidx.compose.runtime.saveable.SaverScope
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.launch
import kotlinx.coroutines.test.runTest
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class OnboardingFlowLogicTest {
  @Test
  fun mascotMoodTracksVisibleOnboardingState() {
    assertEqualsCases(
      MascotMood.Idle to onboardingMascotMood(OnboardingStep.Welcome),
      MascotMood.Curious to onboardingMascotMood(OnboardingStep.Permissions),
      MascotMood.Thinking to onboardingMascotMood(OnboardingStep.NodeApproval),
      MascotMood.Working to onboardingMascotMood(OnboardingStep.Recovery, GatewayRecoveryUiState.Finishing),
      MascotMood.Working to onboardingMascotMood(OnboardingStep.Recovery, GatewayRecoveryUiState.TakingLonger),
      MascotMood.Celebrating to onboardingMascotMood(OnboardingStep.Recovery, GatewayRecoveryUiState.Connected),
      MascotMood.Sad to onboardingMascotMood(OnboardingStep.Recovery, GatewayRecoveryUiState.Failed),
      MascotMood.Sad to
        onboardingMascotMood(
          step = OnboardingStep.EnterSetupCode,
          setupErrorCode = OnboardingErrorCode.SetupCodeRejected,
        ),
      MascotMood.Sad to
        onboardingMascotMood(
          step = OnboardingStep.SetupCode,
          setupScanErrorCode = OnboardingErrorCode.InvalidSetupQr,
        ),
    )
  }

  @Test
  fun onboardingBackDestinationsMatchTheVisibleFlow() {
    assertEqualsCases(
      null to onboardingBackDestination(OnboardingStep.Welcome),
      OnboardingBackDestination(OnboardingStep.Welcome) to onboardingBackDestination(OnboardingStep.Gateway),
      OnboardingBackDestination(OnboardingStep.Gateway) to onboardingBackDestination(OnboardingStep.SetupCode),
      OnboardingBackDestination(OnboardingStep.SetupCode) to onboardingBackDestination(OnboardingStep.EnterSetupCode),
      OnboardingBackDestination(OnboardingStep.Gateway) to onboardingBackDestination(OnboardingStep.Manual),
      OnboardingBackDestination(OnboardingStep.Recovery) to onboardingBackDestination(OnboardingStep.NodeApproval),
      OnboardingBackDestination(OnboardingStep.NodeApproval) to onboardingBackDestination(OnboardingStep.Permissions),
    )
  }

  @Test
  fun directPermissionsBackReturnsToRecovery() {
    assertEquals(
      OnboardingBackDestination(OnboardingStep.Recovery),
      onboardingBackDestination(
        step = OnboardingStep.Permissions,
        accessStage = OnboardingAccessStage.DirectPermissions,
      ),
    )
    assertEquals(
      OnboardingBackState(step = OnboardingStep.Recovery),
      onboardingBackStateAfterBack(
        step = OnboardingStep.Permissions,
        accessStage = OnboardingAccessStage.DirectPermissions,
      ),
    )
  }

  @Test
  fun permissionReapprovalBackReturnsThroughPermissionsToRecovery() {
    assertEquals(
      OnboardingBackDestination(OnboardingStep.Permissions),
      onboardingBackDestination(
        step = OnboardingStep.NodeApproval,
        accessStage = OnboardingAccessStage.PermissionReapproval,
      ),
    )
    assertEquals(
      OnboardingBackState(step = OnboardingStep.Permissions),
      onboardingBackStateAfterBack(
        step = OnboardingStep.NodeApproval,
        accessStage = OnboardingAccessStage.PermissionReapproval,
      ),
    )
    assertEquals(
      OnboardingBackState(step = OnboardingStep.Recovery),
      onboardingBackStateAfterBack(
        step = OnboardingStep.Permissions,
        accessStage = OnboardingAccessStage.PermissionReapproval,
      ),
    )
  }

  @Test
  fun nodeApprovalSuccessUsesTheAccessStage() {
    assertEquals(
      OnboardingNodeApprovalSuccess.ShowPermissions,
      OnboardingAccessStage.InitialApproval.nodeApprovalSuccess,
    )
    assertEquals(
      OnboardingNodeApprovalSuccess.CompleteOnboarding,
      OnboardingAccessStage.PermissionReapproval.nodeApprovalSuccess,
    )
  }

  @Test
  fun setupCodeEntryBackRestoresInlineScannerOnlyWhenOpenedFromScanner() {
    assertEquals(
      OnboardingBackState(step = OnboardingStep.SetupCode, inlineQrScannerActive = true),
      onboardingBackStateAfterBack(
        step = OnboardingStep.EnterSetupCode,
        setupCodeEntryOpenedFromScanner = true,
      ),
    )
    assertEquals(
      OnboardingBackState(step = OnboardingStep.SetupCode, inlineQrScannerActive = false),
      onboardingBackStateAfterBack(
        step = OnboardingStep.EnterSetupCode,
        setupCodeEntryOpenedFromScanner = false,
      ),
    )
  }

  @Test
  fun onboardingBackStateClearsScannerOriginAfterBack() {
    assertEquals(
      OnboardingBackState(step = OnboardingStep.SetupCode, inlineQrScannerActive = true, setupCodeEntryOpenedFromScanner = false),
      onboardingBackStateAfterBack(
        step = OnboardingStep.EnterSetupCode,
        setupCodeEntryOpenedFromScanner = true,
      ),
    )
  }

  @Test
  fun recoveryBackRestoresInlineScannerOnlyForScannerConnections() {
    assertEquals(
      OnboardingBackDestination(OnboardingStep.SetupCode, inlineQrScannerActive = true),
      onboardingBackDestination(OnboardingStep.Recovery, lastGatewayInputSource = OnboardingGatewayInputSource.SetupScanner),
    )
    assertEquals(
      OnboardingBackDestination(OnboardingStep.SetupCode, inlineQrScannerActive = false),
      onboardingBackDestination(OnboardingStep.Recovery, lastGatewayInputSource = OnboardingGatewayInputSource.SetupGallery),
    )
    assertEquals(
      OnboardingBackDestination(OnboardingStep.SetupCode, inlineQrScannerActive = false),
      onboardingBackDestination(OnboardingStep.Recovery, lastGatewayInputSource = OnboardingGatewayInputSource.SetupEntry),
    )
  }

  @Test
  fun recoveryBackReturnsToManualFormAfterManualConnection() {
    assertEquals(
      OnboardingBackDestination(OnboardingStep.Manual),
      onboardingBackDestination(OnboardingStep.Recovery, lastGatewayInputSource = OnboardingGatewayInputSource.Manual),
    )
  }

  @Test
  fun standardPortraitWidthKeepsOnboardingFieldsInline() {
    assertFalse(onboardingFormUsesStackedLayout(availableWidthDp = 342f, fontScale = 1f))
  }

  @Test
  fun narrowWidthStacksOnboardingFields() {
    assertTrue(onboardingFormUsesStackedLayout(availableWidthDp = 320f, fontScale = 1f))
  }

  @Test
  fun largeFontScaleStacksOnboardingFields() {
    assertTrue(onboardingFormUsesStackedLayout(availableWidthDp = 600f, fontScale = 1.3f))
  }

  @Test
  fun deviceCapabilityStartsOffEvenWhenAndroidPermissionWasGranted() {
    assertBooleanCases(
      false to initialDeviceCapabilityEnabled(savedCapabilityEnabled = false, androidPermissionGranted = false),
      false to initialDeviceCapabilityEnabled(savedCapabilityEnabled = false, androidPermissionGranted = true),
      false to initialDeviceCapabilityEnabled(savedCapabilityEnabled = true, androidPermissionGranted = false),
      true to initialDeviceCapabilityEnabled(savedCapabilityEnabled = true, androidPermissionGranted = true),
    )
  }

  @Test
  fun locationCapabilityRequiresBothTheSavedModeAndAndroidPermission() {
    listOf(
      Triple(LocationMode.Off, false, false),
      Triple(LocationMode.Off, true, false),
      Triple(LocationMode.WhileUsing, false, false),
      Triple(LocationMode.WhileUsing, true, true),
      Triple(LocationMode.Always, false, false),
      Triple(LocationMode.Always, true, true),
    ).forEach { (savedMode, androidPermissionGranted, expected) ->
      assertEquals(
        "savedMode=$savedMode androidPermissionGranted=$androidPermissionGranted",
        expected,
        initialDeviceCapabilityEnabled(
          savedCapabilityEnabled = savedMode != LocationMode.Off,
          androidPermissionGranted = androidPermissionGranted,
        ),
      )
    }
  }

  @Test
  fun deviceCapabilityRowDistinguishesAndroidPermissionFromCapabilityOptIn() {
    assertEqualsCases(
      "Not allowed" to deviceCapabilityRowStatusText(capabilityEnabled = false, androidPermissionGranted = false).resolveNativeText(),
      "Off" to deviceCapabilityRowStatusText(capabilityEnabled = false, androidPermissionGranted = true).resolveNativeText(),
      "Enabled" to deviceCapabilityRowStatusText(capabilityEnabled = true, androidPermissionGranted = true).resolveNativeText(),
    )
  }

  @Test
  fun onboardingErrorCodeSaverRoundTripsTypedState() {
    val saved = with(OnboardingErrorCodeSaver) { SaverScope { true }.save(OnboardingErrorCode.ManualInvalidUrl) }

    assertEquals("ManualInvalidUrl", saved)
    assertEquals(OnboardingErrorCode.ManualInvalidUrl, OnboardingErrorCodeSaver.restore(requireNotNull(saved)))
  }

  @Test
  fun deviceCapabilityRowTogglesOnlyWhenAndroidPermissionAlreadyGranted() {
    assertNull(deviceCapabilityAfterRowTap(currentCapabilityEnabled = false, androidPermissionGranted = false))
    assertTrue(deviceCapabilityAfterRowTap(currentCapabilityEnabled = false, androidPermissionGranted = true)!!)
    assertFalse(deviceCapabilityAfterRowTap(currentCapabilityEnabled = true, androidPermissionGranted = true)!!)
  }

  @Test
  fun permissionChangesRequireNodeApprovalWhenAdvertisedSurfaceChanges() {
    listOf(
      PermissionApprovalCase(expected = true, requestedCameraEnabled = true),
      PermissionApprovalCase(expected = true, requestedLocationMode = LocationMode.WhileUsing),
      PermissionApprovalCase(expected = true, currentSmsGranted = false),
      PermissionApprovalCase(expected = true, requestedSmsGranted = false),
      PermissionApprovalCase(expected = false),
      PermissionApprovalCase(
        expected = false,
        currentCameraEnabled = true,
        requestedCameraEnabled = true,
        currentLocationMode = LocationMode.WhileUsing,
        requestedLocationMode = LocationMode.WhileUsing,
      ),
      PermissionApprovalCase(
        expected = false,
        currentLocationMode = LocationMode.Always,
        requestedLocationMode = LocationMode.Always,
      ),
      PermissionApprovalCase(
        expected = true,
        currentLocationMode = LocationMode.Always,
        requestedLocationMode = LocationMode.WhileUsing,
      ),
      PermissionApprovalCase(
        expected = true,
        currentLocationMode = LocationMode.Always,
        requestedLocationMode = LocationMode.Off,
      ),
      PermissionApprovalCase(
        expected = true,
        currentLocationMode = LocationMode.WhileUsing,
        requestedLocationMode = LocationMode.Always,
      ),
      PermissionApprovalCase(
        expected = true,
        currentLocationMode = LocationMode.Off,
        requestedLocationMode = LocationMode.Always,
      ),
    ).forEach { case ->
      assertBoolean(
        case.expected,
        permissionChangesRequireNodeApproval(
          currentCameraEnabled = case.currentCameraEnabled,
          requestedCameraEnabled = case.requestedCameraEnabled,
          currentLocationMode = case.currentLocationMode,
          requestedLocationMode = case.requestedLocationMode,
          currentSmsGranted = case.currentSmsGranted,
          requestedSmsGranted = case.requestedSmsGranted,
        ),
      )
    }
  }

  @Test
  fun nearbyGatewayManualPortUsesResolvedDiscoveryEndpointPort() {
    val endpoint =
      GatewayEndpoint(
        stableId = "_openclaw-gw._tcp.|local.|Home",
        name = "Home",
        host = "192.168.1.12",
        port = 53122,
        gatewayPort = 18789,
      )

    assertEquals("53122", nearbyGatewayManualPort(endpoint))
  }

  @Test
  fun nearbyGatewayManualTlsPreservesDiscoverySecurityPolicy() {
    assertBooleanCases(
      false to nearbyGatewayManualTls(gatewayEndpoint(name = "Lan", host = "192.168.1.12")),
      true to nearbyGatewayManualTls(gatewayEndpoint(name = "Tls", host = "192.168.1.12", tlsEnabled = true)),
      true to nearbyGatewayManualTls(gatewayEndpoint(name = "Pinned", host = "127.0.0.1", tlsFingerprintSha256 = "abc123")),
      true to nearbyGatewayManualTls(gatewayEndpoint(name = "Remote", host = "gateway.example.com", port = 443)),
      false to nearbyGatewayManualTls(gatewayEndpoint(name = "Loopback", host = "127.0.0.1")),
    )
  }

  @Test
  fun blocksFinishWhenGatewayHasNotReportedNodeConnected() {
    assertFalse(canFinishOnboarding(isConnected = true, isNodeConnected = false, nodeCapabilityApproval = GatewayNodeCapabilityApproval.Approved))
  }

  @Test
  fun blocksFinishWhenDisconnected() {
    assertFalse(canFinishOnboarding(isConnected = false, isNodeConnected = false, nodeCapabilityApproval = GatewayNodeCapabilityApproval.Approved))
  }

  @Test
  fun blocksFinishWhenOnlyNodeIsConnected() {
    assertFalse(canFinishOnboarding(isConnected = false, isNodeConnected = true, nodeCapabilityApproval = GatewayNodeCapabilityApproval.Approved))
  }

  @Test
  fun blocksFinishWhenNodeCapabilityApprovalIsPending() {
    listOf(
      GatewayNodeCapabilityApproval.PendingApproval(null),
      GatewayNodeCapabilityApproval.PendingReapproval(null),
      GatewayNodeCapabilityApproval.Unapproved,
    ).forEach { approval ->
      assertFalse(canFinishOnboarding(isConnected = true, isNodeConnected = true, nodeCapabilityApproval = approval))
    }
  }

  @Test
  fun allowsFinishWhenOperatorNodeAndCapabilityApprovalAreReady() {
    assertTrue(canFinishOnboarding(isConnected = true, isNodeConnected = true, nodeCapabilityApproval = GatewayNodeCapabilityApproval.Approved))
  }

  @Test
  fun blocksFinishWhileDelayedNodeListResolvesPendingApproval() =
    runTest {
      val delayedNodeList = CompletableDeferred<GatewayNodeCapabilityApproval>()
      var approvalState: GatewayNodeCapabilityApproval = GatewayNodeCapabilityApproval.Loading
      val refresh = launch { approvalState = delayedNodeList.await() }

      assertFalse(canFinishOnboarding(isConnected = true, isNodeConnected = true, nodeCapabilityApproval = approvalState))

      delayedNodeList.complete(GatewayNodeCapabilityApproval.PendingApproval(null))
      refresh.join()
      assertFalse(canFinishOnboarding(isConnected = true, isNodeConnected = true, nodeCapabilityApproval = approvalState))
    }

  @Test
  fun allowsFinishWhenSuccessfulLegacyNodeListOmitsApprovalState() {
    assertTrue(canFinishOnboarding(isConnected = true, isNodeConnected = true, nodeCapabilityApproval = GatewayNodeCapabilityApproval.Unsupported))
  }

  @Test
  fun blocksFinishForLegacyNodeListUntilNodeConnects() {
    assertFalse(canFinishOnboarding(isConnected = true, isNodeConnected = false, nodeCapabilityApproval = GatewayNodeCapabilityApproval.Unsupported))
  }

  @Test
  fun splitSmsPermissionCallbacksMergePerPermissionGrantState() {
    val requiredPermissions = listOf(Manifest.permission.SEND_SMS, Manifest.permission.READ_SMS)
    val afterSendOnly =
      mergedRequiredPermissionGrantState(
        permissions = mapOf(Manifest.permission.SEND_SMS to true),
        requiredPermissions = requiredPermissions,
        currentlyGranted = { false },
      )
    assertFalse(afterSendOnly)

    val afterReadOnly =
      mergedRequiredPermissionGrantState(
        permissions = mapOf(Manifest.permission.READ_SMS to true),
        requiredPermissions = requiredPermissions,
        currentlyGranted = { permission -> permission == Manifest.permission.SEND_SMS },
      )
    assertTrue(afterReadOnly)

    val deniedRead =
      mergedRequiredPermissionGrantState(
        permissions = mapOf(Manifest.permission.READ_SMS to false),
        requiredPermissions = requiredPermissions,
        currentlyGranted = { true },
      )
    assertFalse(deniedRead)

    val afterUnrelatedPermission =
      mergedRequiredPermissionGrantState(
        permissions = mapOf(Manifest.permission.RECORD_AUDIO to true),
        requiredPermissions = requiredPermissions,
        currentlyGranted = { true },
      )
    assertTrue(afterUnrelatedPermission)

    val afterUnrelatedPermissionWithSmsDenied =
      mergedRequiredPermissionGrantState(
        permissions = mapOf(Manifest.permission.RECORD_AUDIO to true),
        requiredPermissions = requiredPermissions,
        currentlyGranted = { false },
      )
    assertFalse(afterUnrelatedPermissionWithSmsDenied)
  }

  @Test
  fun contactAndCalendarPermissionGroupsRequireBothGrants() {
    val permissionGroups =
      listOf(
        listOf(Manifest.permission.READ_CONTACTS, Manifest.permission.WRITE_CONTACTS),
        listOf(Manifest.permission.READ_CALENDAR, Manifest.permission.WRITE_CALENDAR),
      )

    for (requiredPermissions in permissionGroups) {
      val readPermission = requiredPermissions.first()
      val writePermission = requiredPermissions.last()
      assertFalse(
        mergedRequiredPermissionGrantState(
          permissions = mapOf(readPermission to true),
          requiredPermissions = requiredPermissions,
          currentlyGranted = { false },
        ),
      )
      assertTrue(
        mergedRequiredPermissionGrantState(
          permissions = mapOf(writePermission to true),
          requiredPermissions = requiredPermissions,
          currentlyGranted = { permission -> permission == readPermission },
        ),
      )
    }
  }

  @Test
  fun recoveryGatewayNamePrefersServerThenAttemptedGateway() {
    assertEqualsCases(
      "Server Gateway" to recoveryGatewayName(serverName = "Server Gateway", attemptedGatewayName = "Discovered Gateway"),
      "Discovered Gateway" to recoveryGatewayName(serverName = null, attemptedGatewayName = "Discovered Gateway"),
      "Home Gateway" to recoveryGatewayName(serverName = " ", attemptedGatewayName = " "),
    )
  }

  @Test
  fun recoveryNodeApprovalCommandUsesRequestIdWhenAvailable() {
    assertEqualsCases(
      "openclaw nodes approve request-1" to recoveryNodeApprovalCommand(" request-1 "),
      "openclaw nodes approve REQUEST_ID" to recoveryNodeApprovalCommand(null),
      "openclaw nodes approve REQUEST_ID" to recoveryNodeApprovalCommand(" "),
    )
  }

  @Test
  fun nodeCapabilityApprovalNeedsUserActionOnlyForPendingStates() {
    assertBooleanCases(
      true to nodeCapabilityApprovalNeedsUserAction(GatewayNodeCapabilityApproval.PendingApproval(null)),
      true to nodeCapabilityApprovalNeedsUserAction(GatewayNodeCapabilityApproval.PendingReapproval(null)),
      true to nodeCapabilityApprovalNeedsUserAction(GatewayNodeCapabilityApproval.Unapproved),
      false to nodeCapabilityApprovalNeedsUserAction(GatewayNodeCapabilityApproval.Approved),
      false to nodeCapabilityApprovalNeedsUserAction(GatewayNodeCapabilityApproval.Loading),
      false to nodeCapabilityApprovalNeedsUserAction(GatewayNodeCapabilityApproval.Unsupported),
    )
  }

  @Test
  fun gatewayPairingContinueOnlyRoutesToNodeApprovalWhenApprovalNeedsUserAction() {
    listOf(
      GatewayContinueCase(OnboardingStep.Permissions, ready = true, approval = GatewayNodeCapabilityApproval.PendingApproval(null)),
      GatewayContinueCase(OnboardingStep.NodeApproval, ready = false, approval = GatewayNodeCapabilityApproval.PendingApproval(null)),
      GatewayContinueCase(OnboardingStep.NodeApproval, ready = false, approval = GatewayNodeCapabilityApproval.PendingReapproval(null)),
      GatewayContinueCase(OnboardingStep.NodeApproval, ready = false, approval = GatewayNodeCapabilityApproval.Unapproved),
      GatewayContinueCase(null, ready = false, approval = GatewayNodeCapabilityApproval.Loading),
      GatewayContinueCase(null, ready = false, approval = GatewayNodeCapabilityApproval.Approved),
      GatewayContinueCase(null, ready = false, approval = GatewayNodeCapabilityApproval.Unsupported),
    ).forEach { case ->
      assertEquals(
        case.expected,
        gatewayPairingContinueDestination(
          ready = case.ready,
          nodeCapabilityApproval = case.approval,
        ),
      )
    }
  }

  @Test
  fun permissionContinueReturnsToNodeApprovalWhenApprovalIsStillPending() {
    listOf(
      PermissionContinueCase(
        expected = true,
        ready = false,
        requiresApproval = false,
        approval = GatewayNodeCapabilityApproval.PendingReapproval(null),
      ),
      PermissionContinueCase(expected = true, ready = false, requiresApproval = true, approval = GatewayNodeCapabilityApproval.Approved),
      PermissionContinueCase(expected = true, ready = true, requiresApproval = true, approval = GatewayNodeCapabilityApproval.Approved),
      PermissionContinueCase(expected = false, ready = true, requiresApproval = true, approval = GatewayNodeCapabilityApproval.Unsupported),
      PermissionContinueCase(expected = false, ready = true, requiresApproval = false, approval = GatewayNodeCapabilityApproval.Approved),
    ).forEach { case ->
      assertBoolean(
        case.expected,
        permissionContinueNeedsNodeApproval(
          ready = case.ready,
          requiresNodeApprovalAfterApply = case.requiresApproval,
          nodeCapabilityApproval = case.approval,
        ),
      )
    }
  }

  @Test
  fun nodeApprovalCheckingOnlyTracksActiveRefresh() {
    listOf(
      ApprovalRefreshCase(expected = true, checkRequested = true, refreshStarted = false, refreshing = false),
      ApprovalRefreshCase(expected = true, checkRequested = true, refreshStarted = true, refreshing = true),
      ApprovalRefreshCase(expected = false, checkRequested = true, refreshStarted = true, refreshing = false),
      ApprovalRefreshCase(expected = false, checkRequested = false, refreshStarted = true, refreshing = true),
    ).forEach { case ->
      assertBoolean(
        case.expected,
        nodeApprovalCheckingInProgress(
          checkRequested = case.checkRequested,
          refreshStarted = case.refreshStarted,
          nodesDevicesRefreshing = case.refreshing,
        ),
      )
    }
  }

  @Test
  fun nodeApprovalCheckClearsUnobservedRefreshOnlyOnApprovalScreen() {
    listOf(
      ApprovalRefreshCase(expected = true, checkRequested = true, refreshStarted = false, refreshing = false),
      ApprovalRefreshCase(expected = false, checkRequested = true, refreshStarted = true, refreshing = false),
      ApprovalRefreshCase(expected = false, checkRequested = true, refreshStarted = false, refreshing = true),
      ApprovalRefreshCase(
        expected = false,
        checkRequested = true,
        refreshStarted = false,
        refreshing = false,
        step = OnboardingStep.Permissions,
      ),
    ).forEach { case ->
      assertBoolean(
        case.expected,
        nodeApprovalCheckShouldClearUnobservedRefresh(
          step = case.step,
          checkRequested = case.checkRequested,
          refreshStarted = case.refreshStarted,
          nodesDevicesRefreshing = case.refreshing,
        ),
      )
    }
  }

  @Test
  fun nodeApprovalCheckContinuesWhenRequestedCheckFindsGatewayReady() {
    listOf(
      ApprovalContinueCase(expected = false, refreshStarted = false, refreshing = false, ready = true),
      ApprovalContinueCase(expected = false, refreshStarted = false, refreshing = true, ready = true),
      ApprovalContinueCase(expected = false, refreshStarted = true, refreshing = true, ready = true),
      ApprovalContinueCase(expected = false, refreshStarted = true, refreshing = false, ready = false),
      ApprovalContinueCase(expected = true, refreshStarted = true, refreshing = false, ready = true),
    ).forEach { case ->
      assertBoolean(
        case.expected,
        nodeApprovalCheckCanContinue(
          checkRequested = true,
          refreshStarted = case.refreshStarted,
          nodesDevicesRefreshing = case.refreshing,
          ready = case.ready,
        ),
      )
    }
  }

  @Test
  fun nodeApprovalAutoContinuesWhenGatewayReportsReady() {
    listOf(
      ApprovalAutoContinueCase(expected = true),
      ApprovalAutoContinueCase(expected = false, approval = GatewayNodeCapabilityApproval.PendingApproval(null)),
      ApprovalAutoContinueCase(expected = false, step = OnboardingStep.Permissions),
      ApprovalAutoContinueCase(expected = false, autoContinueEnabled = false),
    ).forEach { case ->
      assertBoolean(
        case.expected,
        nodeApprovalShouldAutoContinue(
          step = case.step,
          ready = true,
          nodeCapabilityApproval = case.approval,
          autoContinueEnabled = case.autoContinueEnabled,
        ),
      )
    }
  }

  @Test
  fun gatewayPairingStopsAtConnectedEvenWhenNodeApprovalIsStillPending() {
    assertEquals(
      GatewayRecoveryUiState.Connected,
      gatewayPairingUiState(
        gatewayPaired = true,
        gatewayPairingCanContinue = true,
        statusText = "Waiting for node approval",
        connectSettling = false,
        connectTimedOut = true,
      ),
    )
  }

  @Test
  fun gatewayPairingContinueWinsOverStaleNodePairingRequiredProblem() {
    assertEquals(
      GatewayRecoveryUiState.Connected,
      gatewayPairingUiState(
        gatewayPaired = true,
        gatewayPairingCanContinue = true,
        statusText = "Connected (node offline)",
        connectSettling = false,
        gatewayConnectionProblem = pairingRequiredProblem(),
      ),
    )
  }

  @Test
  fun gatewayPairingPrefersManualApprovalErrorOverPartialOperatorConnect() {
    assertEquals(
      GatewayRecoveryUiState.ApprovalRequired,
      gatewayPairingUiState(
        gatewayPaired = true,
        gatewayPairingCanContinue = false,
        statusText = "Connected (node offline)",
        connectSettling = false,
        gatewayConnectionProblem = pairingRequiredProblem(),
      ),
    )
  }

  @Test
  fun gatewayPairingPrefersRetryableApprovalErrorOverPartialOperatorConnect() {
    assertEquals(
      GatewayRecoveryUiState.Pairing,
      gatewayPairingUiState(
        gatewayPaired = true,
        gatewayPairingCanContinue = false,
        statusText = "Connected (node offline)",
        connectSettling = false,
        gatewayConnectionProblem = pairingRequiredProblem(retryable = true),
      ),
    )
  }

  @Test
  fun gatewayPairingWaitsWhenOperatorConnectedButNoContinueDestinationExists() {
    assertEqualsCases(
      GatewayRecoveryUiState.Finishing to gatewayPairingState(gatewayPaired = true, connectTimedOut = false),
      GatewayRecoveryUiState.TakingLonger to gatewayPairingState(gatewayPaired = true, connectTimedOut = true),
    )
  }

  @Test
  fun gatewayPairingShowsSlowConnectionWhenGatewayNeverPairs() {
    assertEqualsCases(
      GatewayRecoveryUiState.Finishing to gatewayPairingState(gatewayPaired = false, connectTimedOut = false),
      GatewayRecoveryUiState.TakingLonger to gatewayPairingState(gatewayPaired = false, connectTimedOut = true),
    )
  }

  @Test
  fun gatewayPairingPreservesExplicitFailureStatusText() {
    val tlsError = "Failed: this host requires wss:// or Tailscale Serve. No TLS endpoint detected."
    assertEqualsCases(
      GatewayRecoveryUiState.Failed to gatewayPairingState(gatewayPaired = false, connectTimedOut = false, statusText = tlsError),
      GatewayRecoveryUiState.Failed to gatewayPairingState(gatewayPaired = false, connectTimedOut = true, statusText = tlsError),
      GatewayRecoveryUiState.Failed to
        gatewayPairingState(
          gatewayPaired = false,
          connectTimedOut = false,
          statusText = "Gateway error: unauthorized: gateway token missing",
        ),
    )
  }

  @Test
  fun recoveryGatewayAuthDetailShowsSpecificAuthRecoveryActions() {
    val cases =
      listOf(
        "AUTH_BOOTSTRAP_TOKEN_INVALID" to "The code may have expired or been generated for another Gateway.",
        "AUTH_DEVICE_TOKEN_MISMATCH" to "Saved authentication is invalid. Re-authenticate or reset this gateway connection.",
        "AUTH_PASSWORD_MISMATCH" to "Gateway password is invalid. Re-enter it or reset this gateway connection.",
        "AUTH_TOKEN_MISSING" to "Gateway token is required. Enter it again or edit this connection.",
        "DEVICE_IDENTITY_REQUIRED" to "Gateway requires this device identity. Re-authenticate or reset this gateway connection.",
      )

    cases.forEach { (code, expected) ->
      assertEquals(
        expected,
        recoveryGatewayAuthDetail(authProblem(code = code, recommendedNextStep = null)),
      )
    }
  }

  @Test
  fun recoveryGatewayAuthDetailPreservesProtocolMismatchGuidance() {
    assertEquals(
      "This app is older than the Gateway. Update OpenClaw on this device, then retry. (app protocol v4, gateway protocol v5).",
      recoveryGatewayAuthDetail(protocolMismatchProblem(clientMin = 4, clientMax = 4, expected = 5)),
    )
  }

  @Test
  fun recoveryGatewayAuthDetailExplainsOlderGatewayProtocolMismatch() {
    assertEquals(
      "The Gateway is older than this app. Update OpenClaw on the Gateway host, then retry. (app protocol v6, gateway protocol v5).",
      recoveryGatewayAuthDetail(protocolMismatchProblem(clientMin = 6, clientMax = 6, expected = 5)),
    )
    assertEquals(
      "openclaw update",
      recoveryGatewayProtocolMismatchCommand(protocolMismatchProblem(clientMin = 6, clientMax = 6, expected = 5)),
    )
  }

  @Test
  fun recoveryGatewayAuthDetailExplainsIncompatibleProtocolMismatch() {
    assertEquals(
      "The app and Gateway use incompatible protocol versions. Update OpenClaw on both, then retry. (app protocols v4-v6).",
      recoveryGatewayAuthDetail(protocolMismatchProblem(clientMin = 4, clientMax = 6, expected = null)),
    )
  }

  @Test
  fun recoveryGatewayAuthDetailUsesRecommendedNextStepFallbacks() {
    assertEquals(
      "Gateway authentication is not configured. Edit this connection and try again.",
      recoveryGatewayAuthDetail(authProblem(code = "UNKNOWN", recommendedNextStep = "update_auth_configuration")),
    )
    assertEquals(
      "gateway says no",
      recoveryGatewayAuthDetail(authProblem(code = "UNKNOWN", message = "gateway says no", recommendedNextStep = null)),
    )
  }

  @Test
  fun recoveryPrimaryActionOnlyAppearsForCompleteFailureOrSlowConnectionStates() {
    assertEqualsCases(
      GatewayRecoveryPrimaryAction.Finish to gatewayRecoveryPrimaryAction(GatewayRecoveryUiState.Connected),
      GatewayRecoveryPrimaryAction.Back to gatewayRecoveryPrimaryAction(GatewayRecoveryUiState.Failed),
      GatewayRecoveryPrimaryAction.Retry to gatewayRecoveryPrimaryAction(GatewayRecoveryUiState.TakingLonger),
      GatewayRecoveryPrimaryAction.Retry to gatewayRecoveryPrimaryAction(GatewayRecoveryUiState.ApprovalRequired),
      null to gatewayRecoveryPrimaryAction(GatewayRecoveryUiState.NodeCapabilityApprovalPending),
      null to gatewayRecoveryPrimaryAction(GatewayRecoveryUiState.Pairing),
      null to gatewayRecoveryPrimaryAction(GatewayRecoveryUiState.Finishing),
    )
  }

  @Test
  fun recoveryDiagnosticActionAppearsForFailuresSlowStatesAndGatewayProblems() {
    assertTrue(gatewayRecoveryShowsDiagnosticAction(GatewayRecoveryUiState.Failed, gatewayConnectionProblem = null))
    assertTrue(gatewayRecoveryShowsDiagnosticAction(GatewayRecoveryUiState.TakingLonger, gatewayConnectionProblem = null))
    assertTrue(
      gatewayRecoveryShowsDiagnosticAction(
        GatewayRecoveryUiState.Pairing,
        gatewayConnectionProblem = pairingRequiredProblem(retryable = true, message = "pairing required"),
      ),
    )
    assertFalse(gatewayRecoveryShowsDiagnosticAction(GatewayRecoveryUiState.Finishing, gatewayConnectionProblem = null))
    assertFalse(gatewayRecoveryShowsDiagnosticAction(GatewayRecoveryUiState.Connected, gatewayConnectionProblem = null))
  }

  @Test
  fun recoveryDiagnosticTextIncludesRecoveryStateWithoutCredentials() {
    val diagnostic =
      gatewayRecoveryDiagnosticText(
        statusText = "Gateway closed: token mismatch",
        gatewayName = "Home Gateway",
        gatewayPaired = false,
        gatewayPairingCanContinue = false,
        gatewayConnectionProblem =
          GatewayConnectionProblem(
            code = "AUTH_TOKEN_MISMATCH",
            message = "token mismatch",
            reason = "bad-token",
            requestId = "request-1",
            recommendedNextStep = "update_auth_credentials",
            pauseReconnect = true,
            retryable = false,
          ),
        localizeLabel = { label -> "[$label]" },
      )

    assertTrue(diagnostic.contains("[OpenClaw Android gateway diagnostic]"))
    assertTrue(diagnostic.contains("[Gateway]: Home Gateway"))
    assertTrue(diagnostic.contains("[Status]: Gateway closed: token mismatch"))
    assertTrue(diagnostic.contains("[Gateway paired]: false"))
    assertTrue(diagnostic.contains("[Ready to continue]: false"))
    assertTrue(diagnostic.contains("[Error code]: AUTH_TOKEN_MISMATCH"))
    assertTrue(diagnostic.contains("[Reason]: bad-token"))
    assertTrue(diagnostic.contains("[Request ID]: request-1"))
    assertTrue(diagnostic.contains("[Next step]: update_auth_credentials"))
    assertFalse(diagnostic.contains("secret"))
  }

  @Test
  fun recoveryDiagnosticDoesNotInventOrTranslateStatusValues() {
    val status = "  gateway status\n"
    val diagnostic =
      gatewayRecoveryDiagnosticText(
        statusText = status,
        gatewayName = "Gateway A",
        gatewayPaired = false,
        gatewayPairingCanContinue = false,
        gatewayConnectionProblem = null,
        localizeLabel = { label -> "[$label]" },
      )

    assertTrue(diagnostic.contains("[Status]: $status"))
    assertFalse(diagnostic.contains("Offline"))
  }

  @Test
  fun recoveryProgressStartsAtGatewayEndpointWhileConnecting() {
    assertEquals(
      listOf(
        GatewayRecoveryProgressItem(nativeText("Opening Gateway connection"), GatewayRecoveryProgressStatus.Current),
        GatewayRecoveryProgressItem(nativeText("Checking pairing access"), GatewayRecoveryProgressStatus.Pending),
        GatewayRecoveryProgressItem(nativeText("Checking node access"), GatewayRecoveryProgressStatus.Pending),
      ),
      gatewayRecoveryProgressItems(
        state = GatewayRecoveryUiState.Finishing,
        statusText = "Connecting…",
        connectSettling = true,
      ),
    )
  }

  @Test
  fun recoveryProgressDoesNotAdvanceToGatewayAccessJustBecauseSettlingEnds() {
    assertEquals(
      listOf(
        GatewayRecoveryProgressItem(nativeText("Opening Gateway connection"), GatewayRecoveryProgressStatus.Current),
        GatewayRecoveryProgressItem(nativeText("Checking pairing access"), GatewayRecoveryProgressStatus.Pending),
        GatewayRecoveryProgressItem(nativeText("Checking node access"), GatewayRecoveryProgressStatus.Pending),
      ),
      gatewayRecoveryProgressItems(
        state = GatewayRecoveryUiState.Finishing,
        statusText = "Connecting…",
        connectSettling = false,
      ),
    )
  }

  @Test
  fun recoveryProgressMovesDownToNodeAccessAfterGatewayConnects() {
    assertEquals(
      listOf(
        GatewayRecoveryProgressItem(nativeText("Opening Gateway connection"), GatewayRecoveryProgressStatus.Complete),
        GatewayRecoveryProgressItem(nativeText("Checking pairing access"), GatewayRecoveryProgressStatus.Complete),
        GatewayRecoveryProgressItem(nativeText("Checking node access"), GatewayRecoveryProgressStatus.Current),
      ),
      gatewayRecoveryProgressItems(
        state = GatewayRecoveryUiState.Finishing,
        statusText = "Connected (node offline)",
      ),
    )
  }

  private data class PermissionApprovalCase(
    val expected: Boolean,
    val currentCameraEnabled: Boolean = false,
    val requestedCameraEnabled: Boolean = false,
    val currentLocationMode: LocationMode = LocationMode.Off,
    val requestedLocationMode: LocationMode = LocationMode.Off,
    val currentSmsGranted: Boolean = true,
    val requestedSmsGranted: Boolean = true,
  )

  private data class GatewayContinueCase(
    val expected: OnboardingStep?,
    val ready: Boolean,
    val approval: GatewayNodeCapabilityApproval,
  )

  private data class PermissionContinueCase(
    val expected: Boolean,
    val ready: Boolean,
    val requiresApproval: Boolean,
    val approval: GatewayNodeCapabilityApproval,
  )

  private data class ApprovalRefreshCase(
    val expected: Boolean,
    val checkRequested: Boolean,
    val refreshStarted: Boolean,
    val refreshing: Boolean,
    val step: OnboardingStep = OnboardingStep.NodeApproval,
  )

  private data class ApprovalContinueCase(
    val expected: Boolean,
    val refreshStarted: Boolean,
    val refreshing: Boolean,
    val ready: Boolean,
  )

  private data class ApprovalAutoContinueCase(
    val expected: Boolean,
    val step: OnboardingStep = OnboardingStep.NodeApproval,
    val approval: GatewayNodeCapabilityApproval = GatewayNodeCapabilityApproval.Approved,
    val autoContinueEnabled: Boolean = true,
  )

  private fun assertBoolean(
    expected: Boolean,
    actual: Boolean,
  ) {
    if (expected) assertTrue(actual) else assertFalse(actual)
  }

  private fun assertBooleanCases(vararg cases: Pair<Boolean, Boolean>) {
    cases.forEach { (expected, actual) -> assertBoolean(expected, actual) }
  }

  private fun <T> assertEqualsCases(vararg cases: Pair<T, T>) {
    cases.forEach { (expected, actual) -> assertEquals(expected, actual) }
  }

  private fun gatewayEndpoint(
    name: String,
    host: String,
    port: Int = 18789,
    tlsEnabled: Boolean = false,
    tlsFingerprintSha256: String? = null,
  ): GatewayEndpoint =
    GatewayEndpoint(
      stableId = "_openclaw-gw._tcp.|local.|$name",
      name = name,
      host = host,
      port = port,
      tlsEnabled = tlsEnabled,
      tlsFingerprintSha256 = tlsFingerprintSha256,
    )

  private fun gatewayPairingState(
    gatewayPaired: Boolean,
    connectTimedOut: Boolean,
    statusText: String = if (gatewayPaired) "Connected (node offline)" else "Connecting…",
  ): GatewayRecoveryUiState =
    gatewayPairingUiState(
      gatewayPaired = gatewayPaired,
      gatewayPairingCanContinue = false,
      statusText = statusText,
      connectSettling = false,
      connectTimedOut = connectTimedOut,
    )

  private fun pairingRequiredProblem(
    retryable: Boolean = false,
    message: String = "pairing required: device approval is required",
  ): GatewayConnectionProblem =
    GatewayConnectionProblem(
      code = "PAIRING_REQUIRED",
      message = message,
      reason = "not-paired",
      requestId = "request-1",
      recommendedNextStep = "wait_then_retry".takeIf { retryable },
      pauseReconnect = !retryable,
      retryable = retryable,
    )

  private fun authProblem(
    code: String = "AUTH_DEVICE_TOKEN_MISMATCH",
    message: String = "authentication needed",
    recommendedNextStep: String? = "update_auth_credentials",
  ): GatewayConnectionProblem =
    GatewayConnectionProblem(
      code = code,
      message = message,
      reason = null,
      requestId = null,
      recommendedNextStep = recommendedNextStep,
      pauseReconnect = true,
      retryable = false,
    )

  private fun protocolMismatchProblem(
    clientMin: Int,
    clientMax: Int,
    expected: Int?,
  ): GatewayConnectionProblem =
    GatewayConnectionProblem(
      code = "PROTOCOL_MISMATCH",
      message = "protocol mismatch",
      reason = null,
      requestId = null,
      recommendedNextStep = null,
      pauseReconnect = true,
      retryable = false,
      clientMinProtocol = clientMin,
      clientMaxProtocol = clientMax,
      expectedProtocol = expected,
    )
}
