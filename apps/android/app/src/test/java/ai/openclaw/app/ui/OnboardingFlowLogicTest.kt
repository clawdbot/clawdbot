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
import java.util.Base64

class OnboardingFlowLogicTest {
  @Test
  fun mascotMoodTracksVisibleOnboardingState() {
    assertEquals(MascotMood.Idle, onboardingMascotMood(OnboardingStep.Welcome))
    assertEquals(MascotMood.Curious, onboardingMascotMood(OnboardingStep.Permissions))
    assertEquals(MascotMood.Thinking, onboardingMascotMood(OnboardingStep.NodeApproval))
    assertEquals(
      MascotMood.Working,
      onboardingMascotMood(OnboardingStep.Recovery, GatewayRecoveryUiState.Finishing),
    )
    assertEquals(
      MascotMood.Working,
      onboardingMascotMood(OnboardingStep.Recovery, GatewayRecoveryUiState.TakingLonger),
    )
    assertEquals(
      MascotMood.Celebrating,
      onboardingMascotMood(OnboardingStep.Recovery, GatewayRecoveryUiState.Connected),
    )
    assertEquals(
      MascotMood.Sad,
      onboardingMascotMood(OnboardingStep.Recovery, GatewayRecoveryUiState.Failed),
    )
    assertEquals(
      MascotMood.Sad,
      onboardingMascotMood(
        step = OnboardingStep.EnterSetupCode,
        setupErrorCode = OnboardingErrorCode.SetupCodeRejected,
      ),
    )
    assertEquals(
      MascotMood.Sad,
      onboardingMascotMood(
        step = OnboardingStep.SetupCode,
        setupScanErrorCode = OnboardingErrorCode.InvalidSetupQr,
      ),
    )
  }

  @Test
  fun onboardingBackDestinationsMatchTheVisibleFlow() {
    assertEquals(null, onboardingBackDestination(OnboardingStep.Welcome))
    assertEquals(OnboardingBackDestination(OnboardingStep.Welcome), onboardingBackDestination(OnboardingStep.Gateway))
    assertEquals(OnboardingBackDestination(OnboardingStep.Gateway), onboardingBackDestination(OnboardingStep.SetupCode))
    assertEquals(
      OnboardingBackDestination(OnboardingStep.SetupCode),
      onboardingBackDestination(OnboardingStep.EnterSetupCode),
    )
    assertEquals(OnboardingBackDestination(OnboardingStep.Gateway), onboardingBackDestination(OnboardingStep.Manual))
    assertEquals(OnboardingBackDestination(OnboardingStep.Recovery), onboardingBackDestination(OnboardingStep.NodeApproval))
    assertEquals(OnboardingBackDestination(OnboardingStep.NodeApproval), onboardingBackDestination(OnboardingStep.Permissions))
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
  fun cameraCapabilityStartsOffEvenWhenScannerPermissionWasGranted() {
    assertFalse(initialCameraCapabilityEnabled(savedCapabilityEnabled = false, androidCameraPermissionGranted = false))
    assertFalse(initialCameraCapabilityEnabled(savedCapabilityEnabled = false, androidCameraPermissionGranted = true))
    assertFalse(initialCameraCapabilityEnabled(savedCapabilityEnabled = true, androidCameraPermissionGranted = false))
    assertTrue(initialCameraCapabilityEnabled(savedCapabilityEnabled = true, androidCameraPermissionGranted = true))
  }

  @Test
  fun cameraPermissionRowDistinguishesAndroidPermissionFromCapabilityOptIn() {
    assertEquals("Not allowed", cameraPermissionRowStatusText(capabilityEnabled = false, androidCameraPermissionGranted = false).resolveNativeText())
    assertEquals("Off", cameraPermissionRowStatusText(capabilityEnabled = false, androidCameraPermissionGranted = true).resolveNativeText())
    assertEquals("Enabled", cameraPermissionRowStatusText(capabilityEnabled = true, androidCameraPermissionGranted = true).resolveNativeText())
  }

  @Test
  fun onboardingErrorCodeSaverRoundTripsTypedState() {
    val saved = with(OnboardingErrorCodeSaver) { SaverScope { true }.save(OnboardingErrorCode.ManualInvalidUrl) }

    assertEquals("ManualInvalidUrl", saved)
    assertEquals(OnboardingErrorCode.ManualInvalidUrl, OnboardingErrorCodeSaver.restore(requireNotNull(saved)))
  }

  @Test
  fun cameraPermissionRowTogglesCapabilityWhenAndroidPermissionAlreadyGranted() {
    assertNull(cameraCapabilityAfterRowTap(currentCapabilityEnabled = false, androidCameraPermissionGranted = false))
    assertTrue(cameraCapabilityAfterRowTap(currentCapabilityEnabled = false, androidCameraPermissionGranted = true)!!)
    assertFalse(cameraCapabilityAfterRowTap(currentCapabilityEnabled = true, androidCameraPermissionGranted = true)!!)
  }

  @Test
  fun permissionChangesRequireNodeApprovalWhenAdvertisedSurfaceChanges() {
    assertTrue(
      permissionChangesRequireNodeApproval(
        currentCameraEnabled = false,
        requestedCameraEnabled = true,
        currentLocationMode = LocationMode.Off,
        requestedLocationMode = LocationMode.Off,
        currentSmsGranted = true,
        requestedSmsGranted = true,
      ),
    )
    assertTrue(
      permissionChangesRequireNodeApproval(
        currentCameraEnabled = false,
        requestedCameraEnabled = false,
        currentLocationMode = LocationMode.Off,
        requestedLocationMode = LocationMode.WhileUsing,
        currentSmsGranted = true,
        requestedSmsGranted = true,
      ),
    )
    assertTrue(
      permissionChangesRequireNodeApproval(
        currentCameraEnabled = false,
        requestedCameraEnabled = false,
        currentLocationMode = LocationMode.Off,
        requestedLocationMode = LocationMode.Off,
        currentSmsGranted = false,
        requestedSmsGranted = true,
      ),
    )
    assertFalse(
      permissionChangesRequireNodeApproval(
        currentCameraEnabled = true,
        requestedCameraEnabled = true,
        currentLocationMode = LocationMode.WhileUsing,
        requestedLocationMode = LocationMode.WhileUsing,
        currentSmsGranted = true,
        requestedSmsGranted = true,
      ),
    )
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
    assertFalse(
      nearbyGatewayManualTls(
        GatewayEndpoint(
          stableId = "_openclaw-gw._tcp.|local.|Lan",
          name = "Lan",
          host = "192.168.1.12",
          port = 18789,
        ),
      ),
    )
    assertTrue(
      nearbyGatewayManualTls(
        GatewayEndpoint(
          stableId = "_openclaw-gw._tcp.|local.|Tls",
          name = "Tls",
          host = "192.168.1.12",
          port = 18789,
          tlsEnabled = true,
        ),
      ),
    )
    assertTrue(
      nearbyGatewayManualTls(
        GatewayEndpoint(
          stableId = "_openclaw-gw._tcp.|local.|Pinned",
          name = "Pinned",
          host = "127.0.0.1",
          port = 18789,
          tlsFingerprintSha256 = "abc123",
        ),
      ),
    )
    assertTrue(
      nearbyGatewayManualTls(
        GatewayEndpoint(
          stableId = "_openclaw-gw._tcp.|local.|Remote",
          name = "Remote",
          host = "gateway.example.com",
          port = 443,
        ),
      ),
    )
    assertFalse(
      nearbyGatewayManualTls(
        GatewayEndpoint(
          stableId = "_openclaw-gw._tcp.|local.|Loopback",
          name = "Loopback",
          host = "127.0.0.1",
          port = 18789,
        ),
      ),
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
    assertFalse(canFinishOnboarding(isConnected = true, isNodeConnected = true, nodeCapabilityApproval = GatewayNodeCapabilityApproval.PendingApproval(null)))
    assertFalse(canFinishOnboarding(isConnected = true, isNodeConnected = true, nodeCapabilityApproval = GatewayNodeCapabilityApproval.PendingReapproval(null)))
    assertFalse(canFinishOnboarding(isConnected = true, isNodeConnected = true, nodeCapabilityApproval = GatewayNodeCapabilityApproval.Unapproved))
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
    assertEquals("Server Gateway", recoveryGatewayName(serverName = "Server Gateway", attemptedGatewayName = "Discovered Gateway"))
    assertEquals("Discovered Gateway", recoveryGatewayName(serverName = null, attemptedGatewayName = "Discovered Gateway"))
    assertEquals("Home Gateway", recoveryGatewayName(serverName = " ", attemptedGatewayName = " "))
  }

  @Test
  fun recoveryNodeApprovalCommandUsesRequestIdWhenAvailable() {
    assertEquals("openclaw nodes approve request-1", recoveryNodeApprovalCommand(" request-1 "))
    assertEquals("openclaw nodes approve REQUEST_ID", recoveryNodeApprovalCommand(null))
    assertEquals("openclaw nodes approve REQUEST_ID", recoveryNodeApprovalCommand(" "))
  }

  @Test
  fun nodeCapabilityApprovalNeedsUserActionOnlyForPendingStates() {
    assertTrue(nodeCapabilityApprovalNeedsUserAction(GatewayNodeCapabilityApproval.PendingApproval(null)))
    assertTrue(nodeCapabilityApprovalNeedsUserAction(GatewayNodeCapabilityApproval.PendingReapproval(null)))
    assertTrue(nodeCapabilityApprovalNeedsUserAction(GatewayNodeCapabilityApproval.Unapproved))
    assertFalse(nodeCapabilityApprovalNeedsUserAction(GatewayNodeCapabilityApproval.Approved))
    assertFalse(nodeCapabilityApprovalNeedsUserAction(GatewayNodeCapabilityApproval.Loading))
    assertFalse(nodeCapabilityApprovalNeedsUserAction(GatewayNodeCapabilityApproval.Unsupported))
  }

  @Test
  fun gatewayPairingContinueOnlyRoutesToNodeApprovalWhenApprovalNeedsUserAction() {
    assertEquals(
      OnboardingStep.Permissions,
      gatewayPairingContinueDestination(
        ready = true,
        nodeCapabilityApproval = GatewayNodeCapabilityApproval.PendingApproval(null),
      ),
    )
    assertEquals(
      OnboardingStep.NodeApproval,
      gatewayPairingContinueDestination(
        ready = false,
        nodeCapabilityApproval = GatewayNodeCapabilityApproval.PendingApproval(null),
      ),
    )
    assertEquals(
      OnboardingStep.NodeApproval,
      gatewayPairingContinueDestination(
        ready = false,
        nodeCapabilityApproval = GatewayNodeCapabilityApproval.PendingReapproval(null),
      ),
    )
    assertEquals(
      OnboardingStep.NodeApproval,
      gatewayPairingContinueDestination(
        ready = false,
        nodeCapabilityApproval = GatewayNodeCapabilityApproval.Unapproved,
      ),
    )
    assertNull(
      gatewayPairingContinueDestination(
        ready = false,
        nodeCapabilityApproval = GatewayNodeCapabilityApproval.Loading,
      ),
    )
    assertNull(
      gatewayPairingContinueDestination(
        ready = false,
        nodeCapabilityApproval = GatewayNodeCapabilityApproval.Approved,
      ),
    )
    assertNull(
      gatewayPairingContinueDestination(
        ready = false,
        nodeCapabilityApproval = GatewayNodeCapabilityApproval.Unsupported,
      ),
    )
  }

  @Test
  fun permissionContinueReturnsToNodeApprovalWhenApprovalIsStillPending() {
    assertTrue(
      permissionContinueNeedsNodeApproval(
        ready = false,
        requiresNodeApprovalAfterApply = false,
        nodeCapabilityApproval = GatewayNodeCapabilityApproval.PendingReapproval(null),
      ),
    )
    assertTrue(
      permissionContinueNeedsNodeApproval(
        ready = false,
        requiresNodeApprovalAfterApply = true,
        nodeCapabilityApproval = GatewayNodeCapabilityApproval.Approved,
      ),
    )
    assertTrue(
      permissionContinueNeedsNodeApproval(
        ready = true,
        requiresNodeApprovalAfterApply = true,
        nodeCapabilityApproval = GatewayNodeCapabilityApproval.Approved,
      ),
    )
    assertFalse(
      permissionContinueNeedsNodeApproval(
        ready = true,
        requiresNodeApprovalAfterApply = true,
        nodeCapabilityApproval = GatewayNodeCapabilityApproval.Unsupported,
      ),
    )
    assertFalse(
      permissionContinueNeedsNodeApproval(
        ready = true,
        requiresNodeApprovalAfterApply = false,
        nodeCapabilityApproval = GatewayNodeCapabilityApproval.Approved,
      ),
    )
  }

  @Test
  fun nodeApprovalCheckingOnlyTracksActiveRefresh() {
    assertTrue(
      nodeApprovalCheckingInProgress(
        checkRequested = true,
        refreshStarted = false,
        nodesDevicesRefreshing = false,
      ),
    )
    assertTrue(
      nodeApprovalCheckingInProgress(
        checkRequested = true,
        refreshStarted = true,
        nodesDevicesRefreshing = true,
      ),
    )
    assertFalse(
      nodeApprovalCheckingInProgress(
        checkRequested = true,
        refreshStarted = true,
        nodesDevicesRefreshing = false,
      ),
    )
    assertFalse(
      nodeApprovalCheckingInProgress(
        checkRequested = false,
        refreshStarted = true,
        nodesDevicesRefreshing = true,
      ),
    )
  }

  @Test
  fun nodeApprovalCheckClearsUnobservedRefreshOnlyOnApprovalScreen() {
    assertTrue(
      nodeApprovalCheckShouldClearUnobservedRefresh(
        step = OnboardingStep.NodeApproval,
        checkRequested = true,
        refreshStarted = false,
        nodesDevicesRefreshing = false,
      ),
    )
    assertFalse(
      nodeApprovalCheckShouldClearUnobservedRefresh(
        step = OnboardingStep.NodeApproval,
        checkRequested = true,
        refreshStarted = true,
        nodesDevicesRefreshing = false,
      ),
    )
    assertFalse(
      nodeApprovalCheckShouldClearUnobservedRefresh(
        step = OnboardingStep.NodeApproval,
        checkRequested = true,
        refreshStarted = false,
        nodesDevicesRefreshing = true,
      ),
    )
    assertFalse(
      nodeApprovalCheckShouldClearUnobservedRefresh(
        step = OnboardingStep.Permissions,
        checkRequested = true,
        refreshStarted = false,
        nodesDevicesRefreshing = false,
      ),
    )
  }

  @Test
  fun nodeApprovalCheckContinuesWhenRequestedCheckFindsGatewayReady() {
    assertFalse(
      nodeApprovalCheckCanContinue(
        checkRequested = true,
        refreshStarted = false,
        nodesDevicesRefreshing = false,
        ready = true,
      ),
    )
    assertFalse(
      nodeApprovalCheckCanContinue(
        checkRequested = true,
        refreshStarted = false,
        nodesDevicesRefreshing = true,
        ready = true,
      ),
    )
    assertFalse(
      nodeApprovalCheckCanContinue(
        checkRequested = true,
        refreshStarted = true,
        nodesDevicesRefreshing = true,
        ready = true,
      ),
    )
    assertFalse(
      nodeApprovalCheckCanContinue(
        checkRequested = true,
        refreshStarted = true,
        nodesDevicesRefreshing = false,
        ready = false,
      ),
    )
    assertTrue(
      nodeApprovalCheckCanContinue(
        checkRequested = true,
        refreshStarted = true,
        nodesDevicesRefreshing = false,
        ready = true,
      ),
    )
  }

  @Test
  fun nodeApprovalAutoContinuesWhenGatewayReportsReady() {
    assertTrue(
      nodeApprovalShouldAutoContinue(
        step = OnboardingStep.NodeApproval,
        ready = true,
        nodeCapabilityApproval = GatewayNodeCapabilityApproval.Approved,
        autoContinueEnabled = true,
      ),
    )
    assertFalse(
      nodeApprovalShouldAutoContinue(
        step = OnboardingStep.NodeApproval,
        ready = true,
        nodeCapabilityApproval = GatewayNodeCapabilityApproval.PendingApproval(null),
        autoContinueEnabled = true,
      ),
    )
    assertFalse(
      nodeApprovalShouldAutoContinue(
        step = OnboardingStep.Permissions,
        ready = true,
        nodeCapabilityApproval = GatewayNodeCapabilityApproval.Approved,
        autoContinueEnabled = true,
      ),
    )
    assertFalse(
      nodeApprovalShouldAutoContinue(
        step = OnboardingStep.NodeApproval,
        ready = true,
        nodeCapabilityApproval = GatewayNodeCapabilityApproval.Approved,
        autoContinueEnabled = false,
      ),
    )
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
        gatewayConnectionProblem =
          GatewayConnectionProblem(
            code = "PAIRING_REQUIRED",
            message = "pairing required: device approval is required",
            reason = "not-paired",
            requestId = "request-1",
            recommendedNextStep = null,
            pauseReconnect = true,
            retryable = false,
          ),
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
        gatewayConnectionProblem =
          GatewayConnectionProblem(
            code = "PAIRING_REQUIRED",
            message = "pairing required: device approval is required",
            reason = "not-paired",
            requestId = "request-1",
            recommendedNextStep = null,
            pauseReconnect = true,
            retryable = false,
          ),
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
        gatewayConnectionProblem =
          GatewayConnectionProblem(
            code = "PAIRING_REQUIRED",
            message = "pairing required: device approval is required",
            reason = "not-paired",
            requestId = "request-1",
            recommendedNextStep = "wait_then_retry",
            pauseReconnect = false,
            retryable = true,
          ),
      ),
    )
  }

  @Test
  fun gatewayPairingWaitsWhenOperatorConnectedButNoContinueDestinationExists() {
    assertEquals(
      GatewayRecoveryUiState.Finishing,
      gatewayPairingUiState(
        gatewayPaired = true,
        gatewayPairingCanContinue = false,
        statusText = "Connected (node offline)",
        connectSettling = false,
        connectTimedOut = false,
      ),
    )
    assertEquals(
      GatewayRecoveryUiState.TakingLonger,
      gatewayPairingUiState(
        gatewayPaired = true,
        gatewayPairingCanContinue = false,
        statusText = "Connected (node offline)",
        connectSettling = false,
        connectTimedOut = true,
      ),
    )
  }

  @Test
  fun gatewayPairingShowsSlowConnectionWhenGatewayNeverPairs() {
    assertEquals(
      GatewayRecoveryUiState.Finishing,
      gatewayPairingUiState(
        gatewayPaired = false,
        gatewayPairingCanContinue = false,
        statusText = "Connecting…",
        connectSettling = false,
        connectTimedOut = false,
      ),
    )
    assertEquals(
      GatewayRecoveryUiState.TakingLonger,
      gatewayPairingUiState(
        gatewayPaired = false,
        gatewayPairingCanContinue = false,
        statusText = "Connecting…",
        connectSettling = false,
        connectTimedOut = true,
      ),
    )
  }

  @Test
  fun gatewayPairingPreservesExplicitFailureStatusText() {
    assertEquals(
      GatewayRecoveryUiState.Failed,
      gatewayPairingUiState(
        gatewayPaired = false,
        gatewayPairingCanContinue = false,
        statusText = "Failed: this host requires wss:// or Tailscale Serve. No TLS endpoint detected.",
        connectSettling = false,
        connectTimedOut = false,
      ),
    )
    assertEquals(
      GatewayRecoveryUiState.Failed,
      gatewayPairingUiState(
        gatewayPaired = false,
        gatewayPairingCanContinue = false,
        statusText = "Failed: this host requires wss:// or Tailscale Serve. No TLS endpoint detected.",
        connectSettling = false,
        connectTimedOut = true,
      ),
    )
    assertEquals(
      GatewayRecoveryUiState.Failed,
      gatewayPairingUiState(
        gatewayPaired = false,
        gatewayPairingCanContinue = false,
        statusText = "Gateway error: unauthorized: gateway token missing",
        connectSettling = false,
        connectTimedOut = false,
      ),
    )
  }

  @Test
  fun recoveryGatewayDetailPreservesRetryablePairingGuidance() {
    assertEquals(
      "Gateway approval is in progress. OpenClaw will retry automatically.",
      recoveryGatewayDetail(
        ready = false,
        remoteAddress = null,
        statusText = "Connected (node offline)",
        nodeCapabilityApproval = GatewayNodeCapabilityApproval.Approved,
        gatewayConnectionProblem =
          GatewayConnectionProblem(
            code = "PAIRING_REQUIRED",
            message = "pairing required: device approval is required",
            reason = "not-paired",
            requestId = "request-1",
            recommendedNextStep = "wait_then_retry",
            pauseReconnect = false,
            retryable = true,
          ),
      ),
    )
  }

  @Test
  fun recoveryGatewayDetailPrefersAuthProblemOverStaleAddressWhenNotReady() {
    assertEquals(
      "Saved authentication is invalid. Re-authenticate or reset this gateway connection.",
      recoveryGatewayDetail(
        ready = false,
        remoteAddress = "wss://gateway.example.test",
        statusText = "Connected (node offline)",
        nodeCapabilityApproval = GatewayNodeCapabilityApproval.Approved,
        gatewayConnectionProblem =
          GatewayConnectionProblem(
            code = "AUTH_DEVICE_TOKEN_MISMATCH",
            message = "authentication needed",
            reason = null,
            requestId = null,
            recommendedNextStep = "update_auth_credentials",
            pauseReconnect = true,
            retryable = false,
          ),
      ),
    )
  }

  @Test
  fun recoveryGatewayDetailPrefersAuthProblemWhileNodeApprovalIsLoading() {
    assertEquals(
      "Saved authentication is invalid. Re-authenticate or reset this gateway connection.",
      recoveryGatewayDetail(
        ready = false,
        remoteAddress = "wss://gateway.example.test",
        statusText = "Connected (node offline)",
        nodeCapabilityApproval = GatewayNodeCapabilityApproval.Loading,
        gatewayConnectionProblem =
          GatewayConnectionProblem(
            code = "AUTH_DEVICE_TOKEN_MISMATCH",
            message = "authentication needed",
            reason = null,
            requestId = null,
            recommendedNextStep = "update_auth_credentials",
            pauseReconnect = true,
            retryable = false,
          ),
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
        recoveryGatewayAuthDetail(
          GatewayConnectionProblem(
            code = code,
            message = "authentication needed",
            reason = null,
            requestId = null,
            recommendedNextStep = null,
            pauseReconnect = true,
            retryable = false,
          ),
        ),
      )
    }
  }

  @Test
  fun recoveryGatewayAuthDetailPreservesProtocolMismatchGuidance() {
    assertEquals(
      "This app is older than the Gateway. Update OpenClaw on this device, then retry. (app protocol v4, gateway protocol v5).",
      recoveryGatewayAuthDetail(
        GatewayConnectionProblem(
          code = "PROTOCOL_MISMATCH",
          message = "protocol mismatch",
          reason = null,
          requestId = null,
          recommendedNextStep = null,
          pauseReconnect = true,
          retryable = false,
          clientMinProtocol = 4,
          clientMaxProtocol = 4,
          expectedProtocol = 5,
        ),
      ),
    )
  }

  @Test
  fun recoveryGatewayAuthDetailExplainsOlderGatewayProtocolMismatch() {
    assertEquals(
      "The Gateway is older than this app. Update OpenClaw on the Gateway host, then retry. (app protocol v6, gateway protocol v5).",
      recoveryGatewayAuthDetail(
        GatewayConnectionProblem(
          code = "PROTOCOL_MISMATCH",
          message = "protocol mismatch",
          reason = null,
          requestId = null,
          recommendedNextStep = null,
          pauseReconnect = true,
          retryable = false,
          clientMinProtocol = 6,
          clientMaxProtocol = 6,
          expectedProtocol = 5,
        ),
      ),
    )
    assertEquals(
      "openclaw update",
      recoveryGatewayProtocolMismatchCommand(
        GatewayConnectionProblem(
          code = "PROTOCOL_MISMATCH",
          message = "protocol mismatch",
          reason = null,
          requestId = null,
          recommendedNextStep = null,
          pauseReconnect = true,
          retryable = false,
          clientMinProtocol = 6,
          clientMaxProtocol = 6,
          expectedProtocol = 5,
        ),
      ),
    )
  }

  @Test
  fun recoveryGatewayAuthDetailExplainsIncompatibleProtocolMismatch() {
    assertEquals(
      "The app and Gateway use incompatible protocol versions. Update OpenClaw on both, then retry. (app protocols v4-v6).",
      recoveryGatewayAuthDetail(
        GatewayConnectionProblem(
          code = "PROTOCOL_MISMATCH",
          message = "protocol mismatch",
          reason = null,
          requestId = null,
          recommendedNextStep = null,
          pauseReconnect = true,
          retryable = false,
          clientMinProtocol = 4,
          clientMaxProtocol = 6,
          expectedProtocol = null,
        ),
      ),
    )
  }

  @Test
  fun recoveryGatewayAuthDetailUsesRecommendedNextStepFallbacks() {
    assertEquals(
      "Gateway authentication is not configured. Edit this connection and try again.",
      recoveryGatewayAuthDetail(
        GatewayConnectionProblem(
          code = "UNKNOWN",
          message = "authentication needed",
          reason = null,
          requestId = null,
          recommendedNextStep = "update_auth_configuration",
          pauseReconnect = true,
          retryable = false,
        ),
      ),
    )
    assertEquals(
      "gateway says no",
      recoveryGatewayAuthDetail(
        GatewayConnectionProblem(
          code = "UNKNOWN",
          message = "gateway says no",
          reason = null,
          requestId = null,
          recommendedNextStep = null,
          pauseReconnect = true,
          retryable = false,
        ),
      ),
    )
  }

  @Test
  fun recoveryPrimaryActionOnlyAppearsForCompleteFailureOrSlowConnectionStates() {
    assertEquals(GatewayRecoveryPrimaryAction.Finish, gatewayRecoveryPrimaryAction(GatewayRecoveryUiState.Connected))
    assertEquals(GatewayRecoveryPrimaryAction.Back, gatewayRecoveryPrimaryAction(GatewayRecoveryUiState.Failed))
    assertEquals(GatewayRecoveryPrimaryAction.Retry, gatewayRecoveryPrimaryAction(GatewayRecoveryUiState.TakingLonger))
    assertEquals(GatewayRecoveryPrimaryAction.Retry, gatewayRecoveryPrimaryAction(GatewayRecoveryUiState.ApprovalRequired))

    listOf(
      GatewayRecoveryUiState.NodeCapabilityApprovalPending,
      GatewayRecoveryUiState.Pairing,
      GatewayRecoveryUiState.Finishing,
    ).forEach { state ->
      assertEquals(null, gatewayRecoveryPrimaryAction(state))
    }
  }

  @Test
  fun recoveryDiagnosticActionAppearsForFailuresSlowStatesAndGatewayProblems() {
    assertTrue(gatewayRecoveryShowsDiagnosticAction(GatewayRecoveryUiState.Failed, gatewayConnectionProblem = null))
    assertTrue(gatewayRecoveryShowsDiagnosticAction(GatewayRecoveryUiState.TakingLonger, gatewayConnectionProblem = null))
    assertTrue(
      gatewayRecoveryShowsDiagnosticAction(
        GatewayRecoveryUiState.Pairing,
        gatewayConnectionProblem =
          GatewayConnectionProblem(
            code = "PAIRING_REQUIRED",
            message = "pairing required",
            reason = "not-paired",
            requestId = "request-1",
            recommendedNextStep = "wait_then_retry",
            pauseReconnect = false,
            retryable = true,
          ),
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

  @Test
  fun resolvesOnboardingSetupCodeConnectConfigForScannedQr() {
    val setupCode =
      encodeSetupCode("""{"url":"ws://10.0.2.2:18789","bootstrapToken":"bootstrap-1"}""")
    val scanned = resolveScannedSetupCodeResult(setupCode)

    val plan =
      resolveOnboardingGatewayConnectPlan(
        setupCode = requireNotNull(scanned.setupCode),
        savedManualHost = "127.0.0.1",
        savedManualPort = "18789",
        savedManualTls = false,
        manualHost = "127.0.0.1",
        manualPort = "18789",
        manualTls = false,
        token = "stale-shared-token",
        password = "stale-shared-password",
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
  fun resolvesOnboardingManualConnectConfigWhenSetupCodeIsBlank() {
    val plan =
      resolveOnboardingGatewayConnectPlan(
        setupCode = "",
        savedManualHost = "127.0.0.1",
        savedManualPort = "18789",
        savedManualTls = false,
        manualHost = "127.0.0.1",
        manualPort = "18789",
        manualTls = false,
        token = "shared-token",
        password = "shared-password",
      )

    assertEquals(GatewaySavedAuthAction.REPLACE_CREDENTIALS, plan?.savedAuthAction)
    assertEquals("127.0.0.1", plan?.config?.host)
    assertEquals(18789, plan?.config?.port)
    assertEquals(false, plan?.config?.tls)
    assertEquals("", plan?.config?.bootstrapToken)
    assertEquals("shared-token", plan?.config?.token)
    assertEquals("", plan?.config?.password)
  }

  @Test
  fun onboardingManualEndpointChangeReplacesSavedGatewayAuth() {
    val plan =
      resolveOnboardingGatewayConnectPlan(
        setupCode = "",
        savedManualHost = "127.0.0.1",
        savedManualPort = "18789",
        savedManualTls = false,
        manualHost = "10.0.2.2",
        manualPort = "18790",
        manualTls = false,
        token = "replacement-token",
        password = "",
      )

    assertEquals(GatewaySavedAuthAction.REPLACE_ENDPOINT, plan?.savedAuthAction)
    assertEquals("10.0.2.2", plan?.config?.host)
    assertEquals("replacement-token", plan?.config?.token)
  }

  private fun encodeSetupCode(payloadJson: String): String = Base64.getUrlEncoder().withoutPadding().encodeToString(payloadJson.toByteArray(Charsets.UTF_8))
}
