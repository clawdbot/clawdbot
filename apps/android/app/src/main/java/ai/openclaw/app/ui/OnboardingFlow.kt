package ai.openclaw.app.ui

import ai.openclaw.app.GatewayConnectionProblem
import ai.openclaw.app.GatewayNodeCapabilityApproval
import ai.openclaw.app.LocationMode
import ai.openclaw.app.MainViewModel
import ai.openclaw.app.R
import ai.openclaw.app.SensitiveFeatureConfig
import ai.openclaw.app.gateway.GatewayEndpoint
import ai.openclaw.app.gateway.isLocalCleartextGatewayHost
import ai.openclaw.app.hasPhotoReadPermission
import ai.openclaw.app.node.DeviceNotificationListenerService
import ai.openclaw.app.photoReadPermissionsForRequest
import ai.openclaw.app.ui.design.ClawDesignTheme
import ai.openclaw.app.ui.design.ClawPrimaryButton
import ai.openclaw.app.ui.design.ClawScaffold
import ai.openclaw.app.ui.design.ClawSecondaryButton
import ai.openclaw.app.ui.design.ClawTextField
import ai.openclaw.app.ui.design.ClawTheme
import ai.openclaw.app.ui.design.OpenClawMascot
import android.Manifest
import android.content.ClipData
import android.content.ClipboardManager
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.hardware.Sensor
import android.hardware.SensorManager
import android.os.Build
import android.os.SystemClock
import android.provider.Settings
import android.widget.Toast
import androidx.activity.compose.BackHandler
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.camera.core.CameraSelector
import androidx.camera.core.ExperimentalGetImage
import androidx.camera.core.ImageAnalysis
import androidx.camera.core.ImageProxy
import androidx.camera.core.Preview
import androidx.camera.core.UseCase
import androidx.camera.lifecycle.ProcessCameraProvider
import androidx.camera.view.PreviewView
import androidx.compose.animation.core.RepeatMode
import androidx.compose.animation.core.animateFloat
import androidx.compose.animation.core.infiniteRepeatable
import androidx.compose.animation.core.rememberInfiniteTransition
import androidx.compose.animation.core.tween
import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.isSystemInDarkTheme
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ColumnScope
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.aspectRatio
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.selection.SelectionContainer
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.automirrored.filled.KeyboardArrowRight
import androidx.compose.material.icons.filled.CalendarMonth
import androidx.compose.material.icons.filled.CameraAlt
import androidx.compose.material.icons.filled.CheckCircle
import androidx.compose.material.icons.filled.Close
import androidx.compose.material.icons.filled.ContentCopy
import androidx.compose.material.icons.filled.ErrorOutline
import androidx.compose.material.icons.filled.Image
import androidx.compose.material.icons.filled.Link
import androidx.compose.material.icons.filled.LocationOn
import androidx.compose.material.icons.filled.Mic
import androidx.compose.material.icons.filled.Notifications
import androidx.compose.material.icons.filled.Person
import androidx.compose.material.icons.filled.QrCode2
import androidx.compose.material.icons.filled.Security
import androidx.compose.material.icons.filled.Sensors
import androidx.compose.material.icons.filled.WifiTethering
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.Icon
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableLongStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalUriHandler
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.compose.ui.viewinterop.AndroidView
import androidx.compose.ui.window.Dialog
import androidx.compose.ui.window.DialogProperties
import androidx.core.content.ContextCompat
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.LifecycleEventObserver
import androidx.lifecycle.compose.LocalLifecycleOwner
import com.google.mlkit.vision.barcode.BarcodeScanner
import com.google.mlkit.vision.barcode.BarcodeScannerOptions
import com.google.mlkit.vision.barcode.BarcodeScanning
import com.google.mlkit.vision.barcode.common.Barcode
import com.google.mlkit.vision.common.InputImage
import kotlinx.coroutines.delay
import java.util.concurrent.Executors
import java.util.concurrent.atomic.AtomicBoolean

internal enum class OnboardingStep {
  Welcome,
  Gateway,
  SetupCode,
  EnterSetupCode,
  Manual,
  Recovery,
  NodeApproval,
  Permissions,
}

internal enum class OnboardingNodeApprovalSuccess {
  ShowPermissions,
  CompleteOnboarding,
}

/** Keeps post-pairing navigation in one closed mode so approval and permissions cannot form a cycle. */
internal enum class OnboardingAccessStage(
  val nodeApprovalBackStep: OnboardingStep,
  val permissionsBackStep: OnboardingStep,
  val nodeApprovalSuccess: OnboardingNodeApprovalSuccess,
) {
  DirectPermissions(
    nodeApprovalBackStep = OnboardingStep.Recovery,
    permissionsBackStep = OnboardingStep.Recovery,
    nodeApprovalSuccess = OnboardingNodeApprovalSuccess.ShowPermissions,
  ),
  InitialApproval(
    nodeApprovalBackStep = OnboardingStep.Recovery,
    permissionsBackStep = OnboardingStep.NodeApproval,
    nodeApprovalSuccess = OnboardingNodeApprovalSuccess.ShowPermissions,
  ),
  PermissionReapproval(
    nodeApprovalBackStep = OnboardingStep.Permissions,
    permissionsBackStep = OnboardingStep.Recovery,
    nodeApprovalSuccess = OnboardingNodeApprovalSuccess.CompleteOnboarding,
  ),
}

internal enum class OnboardingGatewayInputSource {
  SetupScanner,
  SetupGallery,
  SetupEntry,
  Manual,
}

private const val GATEWAY_CONNECT_SETTLING_MS = 2_500L
private const val GATEWAY_CONNECT_TIMEOUT_MS = 20_000L
private const val NODE_APPROVAL_REFRESH_OBSERVE_TIMEOUT_MS = 750L
private const val NODE_APPROVAL_AUTO_REFRESH_MS = 2_000L
private const val ANDROID_SETUP_GUIDE_URL = "https://docs.openclaw.ai/platforms/android"
private val OnboardingHorizontalPadding = 24.dp
private val OnboardingTopPadding = 12.dp
private val OnboardingBottomPadding = 20.dp
private val OnboardingHeroTopOffset = 70.dp
private val OnboardingHeroTopOffsetAfterHeader = 0.dp
private val OnboardingHeroMarkSize = 78.dp
private val OnboardingButtonHeight = 56.dp
private val OnboardingActionGap = 10.dp
private val OnboardingBottomInset = 16.dp

private fun onboardingContentPadding() =
  PaddingValues(
    start = OnboardingHorizontalPadding,
    top = OnboardingTopPadding,
    end = OnboardingHorizontalPadding,
    bottom = OnboardingBottomPadding,
  )

private fun Modifier.onboardingActionButton() = fillMaxWidth().height(OnboardingButtonHeight)

internal data class OnboardingBackDestination(
  val step: OnboardingStep,
  val inlineQrScannerActive: Boolean = false,
)

internal data class OnboardingBackState(
  val step: OnboardingStep,
  val inlineQrScannerActive: Boolean = false,
  val setupCodeEntryOpenedFromScanner: Boolean = false,
)

internal fun onboardingBackDestination(
  step: OnboardingStep,
  lastGatewayInputSource: OnboardingGatewayInputSource = OnboardingGatewayInputSource.SetupScanner,
  accessStage: OnboardingAccessStage = OnboardingAccessStage.InitialApproval,
): OnboardingBackDestination? =
  when (step) {
    OnboardingStep.Welcome -> null
    OnboardingStep.Gateway -> OnboardingBackDestination(OnboardingStep.Welcome)
    OnboardingStep.SetupCode -> OnboardingBackDestination(OnboardingStep.Gateway)
    OnboardingStep.EnterSetupCode -> OnboardingBackDestination(OnboardingStep.SetupCode)
    OnboardingStep.Manual -> OnboardingBackDestination(OnboardingStep.Gateway)
    OnboardingStep.Recovery ->
      when (lastGatewayInputSource) {
        OnboardingGatewayInputSource.SetupScanner -> OnboardingBackDestination(OnboardingStep.SetupCode, inlineQrScannerActive = true)
        OnboardingGatewayInputSource.SetupGallery,
        OnboardingGatewayInputSource.SetupEntry,
        -> OnboardingBackDestination(OnboardingStep.SetupCode)
        OnboardingGatewayInputSource.Manual -> OnboardingBackDestination(OnboardingStep.Manual)
      }
    OnboardingStep.NodeApproval -> OnboardingBackDestination(accessStage.nodeApprovalBackStep)
    OnboardingStep.Permissions -> OnboardingBackDestination(accessStage.permissionsBackStep)
  }

internal fun onboardingBackStateAfterBack(
  step: OnboardingStep,
  lastGatewayInputSource: OnboardingGatewayInputSource = OnboardingGatewayInputSource.SetupScanner,
  setupCodeEntryOpenedFromScanner: Boolean = false,
  accessStage: OnboardingAccessStage = OnboardingAccessStage.InitialApproval,
): OnboardingBackState? {
  if (step == OnboardingStep.EnterSetupCode) {
    return OnboardingBackState(
      step = OnboardingStep.SetupCode,
      inlineQrScannerActive = setupCodeEntryOpenedFromScanner,
    )
  }
  val destination =
    onboardingBackDestination(
      step = step,
      lastGatewayInputSource = lastGatewayInputSource,
      accessStage = accessStage,
    ) ?: return null
  return OnboardingBackState(step = destination.step, inlineQrScannerActive = destination.inlineQrScannerActive)
}

/** First-run Android onboarding flow for gateway pairing and permission setup. */
@Composable
fun OnboardingFlow(
  viewModel: MainViewModel,
  modifier: Modifier = Modifier,
) {
  val appearanceThemeMode by viewModel.appearanceThemeMode.collectAsState()
  val onboardingDark = appearanceThemeMode.isDark(systemDark = isSystemInDarkTheme())
  ClawDesignTheme(dark = onboardingDark) {
    val context = LocalContext.current
    val gatewayConnectionDisplay by viewModel.gatewayConnectionDisplay.collectAsState()
    val statusText = gatewayConnectionDisplay.statusText
    val gatewayConnectionProblem = gatewayConnectionDisplay.problem
    val isConnected = gatewayConnectionDisplay.isConnected
    val isNodeConnected by viewModel.isNodeConnected.collectAsState()
    val nodeCapabilityApproval by viewModel.nodeCapabilityApproval.collectAsState()
    val nodesDevicesRefreshing by viewModel.nodesDevicesRefreshing.collectAsState()
    val serverName by viewModel.serverName.collectAsState()
    val gateways by viewModel.gateways.collectAsState()
    val savedManualHost by viewModel.manualHost.collectAsState()
    val savedManualPort by viewModel.manualPort.collectAsState()
    val savedManualTls by viewModel.manualTls.collectAsState()
    val pendingTrust by viewModel.pendingGatewayTrust.collectAsState()
    val startAtGatewaySetup by viewModel.startOnboardingAtGatewaySetup.collectAsState()
    val ready =
      canFinishOnboarding(
        isConnected = isConnected,
        isNodeConnected = isNodeConnected,
        nodeCapabilityApproval = nodeCapabilityApproval,
      )

    var step by rememberSaveable { mutableStateOf(OnboardingStep.Welcome) }
    var setupCode by rememberSaveable { mutableStateOf("") }
    var manualHost by rememberSaveable { mutableStateOf("") }
    var manualPort by rememberSaveable { mutableStateOf("18789") }
    var manualTls by rememberSaveable { mutableStateOf(false) }
    var token by rememberSaveable { mutableStateOf("") }
    var password by rememberSaveable { mutableStateOf("") }
    var setupError by rememberSaveable { mutableStateOf<String?>(null) }
    var setupScanError by rememberSaveable { mutableStateOf<String?>(null) }
    var attemptedConnect by rememberSaveable { mutableStateOf(false) }
    var attemptedGatewayName by rememberSaveable { mutableStateOf<String?>(null) }
    var lastGatewayInputSource by rememberSaveable { mutableStateOf(OnboardingGatewayInputSource.SetupScanner) }
    var inlineQrScannerActive by rememberSaveable { mutableStateOf(false) }
    var setupCodeEntryOpenedFromScanner by rememberSaveable { mutableStateOf(false) }
    var connectAttemptStartedAtMs by rememberSaveable { mutableLongStateOf(0L) }
    var recoveryNowMs by remember { mutableLongStateOf(SystemClock.elapsedRealtime()) }
    var accessStage by rememberSaveable { mutableStateOf(OnboardingAccessStage.InitialApproval) }
    var nodeApprovalCheckRequested by rememberSaveable { mutableStateOf(false) }
    var nodeApprovalCheckRefreshStarted by rememberSaveable { mutableStateOf(false) }
    var nodeApprovalAutoContinueEnabled by rememberSaveable { mutableStateOf(false) }

    OpenClawSystemBarAppearance(lightAppearance = !onboardingDark)

    var cameraPermissionGranted by rememberSaveable {
      mutableStateOf(ContextCompat.checkSelfPermission(context, Manifest.permission.CAMERA) == PackageManager.PERMISSION_GRANTED)
    }
    val setupBarcodeScannerOptions =
      remember {
        BarcodeScannerOptions
          .Builder()
          .setBarcodeFormats(Barcode.FORMAT_QR_CODE)
          .build()
      }
    val setupBarcodeScanner = remember(setupBarcodeScannerOptions) { BarcodeScanning.getClient(setupBarcodeScannerOptions) }
    val cameraPermissionLauncher =
      rememberLauncherForActivityResult(ActivityResultContracts.RequestPermission()) { granted ->
        cameraPermissionGranted = granted
      }

    val permissionState = rememberPermissionState(context = context, viewModel = viewModel)

    DisposableEffect(setupBarcodeScanner) {
      onDispose { setupBarcodeScanner.close() }
    }

    fun goBack() {
      val next =
        onboardingBackStateAfterBack(
          step = step,
          lastGatewayInputSource = lastGatewayInputSource,
          setupCodeEntryOpenedFromScanner = setupCodeEntryOpenedFromScanner,
          accessStage = accessStage,
        ) ?: return
      inlineQrScannerActive = next.inlineQrScannerActive
      setupCodeEntryOpenedFromScanner = next.setupCodeEntryOpenedFromScanner
      step = next.step
    }

    BackHandler(
      enabled =
        onboardingBackDestination(
          step = step,
          lastGatewayInputSource = lastGatewayInputSource,
          accessStage = accessStage,
        ) != null,
    ) {
      goBack()
    }

    LaunchedEffect(startAtGatewaySetup) {
      if (startAtGatewaySetup) {
        step = OnboardingStep.Gateway
        viewModel.clearGatewaySetupStartRequest()
      }
    }

    LaunchedEffect(step) {
      if (step == OnboardingStep.Gateway || step == OnboardingStep.Manual) {
        viewModel.startGatewayDiscovery()
      }
    }

    LaunchedEffect(step, connectAttemptStartedAtMs) {
      if (step != OnboardingStep.Recovery || connectAttemptStartedAtMs <= 0L) return@LaunchedEffect
      recoveryNowMs = SystemClock.elapsedRealtime()
      while (true) {
        delay(1_000L)
        recoveryNowMs = SystemClock.elapsedRealtime()
      }
    }

    fun advanceAfterNodeApproval() {
      nodeApprovalCheckRequested = false
      nodeApprovalCheckRefreshStarted = false
      nodeApprovalAutoContinueEnabled = false
      when (accessStage.nodeApprovalSuccess) {
        OnboardingNodeApprovalSuccess.ShowPermissions -> {
          accessStage = OnboardingAccessStage.InitialApproval
          step = OnboardingStep.Permissions
        }
        OnboardingNodeApprovalSuccess.CompleteOnboarding -> viewModel.setOnboardingCompleted(true)
      }
    }

    LaunchedEffect(nodeApprovalCheckRequested, nodesDevicesRefreshing) {
      if (nodeApprovalCheckRequested && nodesDevicesRefreshing) {
        nodeApprovalCheckRefreshStarted = true
      }
    }

    LaunchedEffect(step, nodeApprovalCheckRequested, nodeApprovalCheckRefreshStarted, nodesDevicesRefreshing) {
      if (
        !nodeApprovalCheckShouldClearUnobservedRefresh(
          step = step,
          checkRequested = nodeApprovalCheckRequested,
          refreshStarted = nodeApprovalCheckRefreshStarted,
          nodesDevicesRefreshing = nodesDevicesRefreshing,
        )
      ) {
        return@LaunchedEffect
      }
      delay(NODE_APPROVAL_REFRESH_OBSERVE_TIMEOUT_MS)
      if (
        nodeApprovalCheckShouldClearUnobservedRefresh(
          step = step,
          checkRequested = nodeApprovalCheckRequested,
          refreshStarted = nodeApprovalCheckRefreshStarted,
          nodesDevicesRefreshing = nodesDevicesRefreshing,
        )
      ) {
        nodeApprovalCheckRequested = false
      }
    }

    LaunchedEffect(step, ready, nodeApprovalCheckRequested, nodeApprovalCheckRefreshStarted, nodesDevicesRefreshing) {
      if (
        step == OnboardingStep.NodeApproval &&
        nodeApprovalCheckCanContinue(
          checkRequested = nodeApprovalCheckRequested,
          refreshStarted = nodeApprovalCheckRefreshStarted,
          nodesDevicesRefreshing = nodesDevicesRefreshing,
          ready = ready,
        )
      ) {
        advanceAfterNodeApproval()
      }
    }

    LaunchedEffect(step, ready, nodeCapabilityApproval, nodeApprovalAutoContinueEnabled) {
      if (
        nodeApprovalShouldAutoContinue(
          step = step,
          ready = ready,
          nodeCapabilityApproval = nodeCapabilityApproval,
          autoContinueEnabled = nodeApprovalAutoContinueEnabled,
        )
      ) {
        advanceAfterNodeApproval()
      }
    }

    LaunchedEffect(step, nodeCapabilityApproval, nodesDevicesRefreshing) {
      if (
        step != OnboardingStep.NodeApproval ||
        !nodeCapabilityApprovalNeedsUserAction(nodeCapabilityApproval) ||
        nodesDevicesRefreshing
      ) {
        return@LaunchedEffect
      }
      while (true) {
        delay(NODE_APPROVAL_AUTO_REFRESH_MS)
        viewModel.refreshNodesDevices()
      }
    }

    fun connectGateway(
      plan: GatewayConnectPlan,
      inputSource: OnboardingGatewayInputSource,
      attemptedName: String? = null,
    ) {
      setupError = null
      setupScanError = null
      attemptedGatewayName = attemptedName
      attemptedConnect = true
      lastGatewayInputSource = inputSource
      connectAttemptStartedAtMs = SystemClock.elapsedRealtime()
      viewModel.saveGatewayConfigAndConnect(plan)
      step = OnboardingStep.Recovery
    }

    fun continueFromGatewayPairing() {
      when (
        gatewayPairingContinueDestination(
          ready = ready,
          nodeCapabilityApproval = nodeCapabilityApproval,
        )
      ) {
        OnboardingStep.Permissions -> {
          accessStage = OnboardingAccessStage.DirectPermissions
          step = OnboardingStep.Permissions
        }
        OnboardingStep.NodeApproval -> {
          nodeApprovalCheckRequested = false
          nodeApprovalCheckRefreshStarted = false
          nodeApprovalAutoContinueEnabled = true
          accessStage = OnboardingAccessStage.InitialApproval
          step = OnboardingStep.NodeApproval
        }
        else -> {
          viewModel.refreshNodesDevices()
          viewModel.refreshGatewayConnection()
        }
      }
    }

    fun checkNodeApproval() {
      nodeApprovalCheckRequested = true
      nodeApprovalCheckRefreshStarted = false
      viewModel.refreshNodesDevices()
      viewModel.refreshGatewayConnection()
    }

    fun showSetupScanError(message: String) {
      setupError = null
      setupScanError = message
      inlineQrScannerActive = false
    }

    fun pairFromSetupCode(
      code: String,
      inputSource: OnboardingGatewayInputSource,
    ) {
      val trimmed = code.trim()
      if (trimmed.isEmpty()) {
        setupError = "Enter the setup code from openclaw qr."
        return
      }
      val plan =
        resolveGatewayConnectPlan(
          useSetupCode = true,
          setupCode = trimmed,
          savedManualHost = manualHost,
          savedManualPort = manualPort,
          savedManualTls = manualTls,
          manualHostInput = manualHost,
          manualPortInput = manualPort,
          manualTlsInput = manualTls,
          bootstrapTokenInput = "",
          tokenInput = token,
          passwordInput = password,
        )
      if (plan == null) {
        val endpointError =
          decodeGatewaySetupCode(trimmed)
            ?.let { parseGatewayEndpointResult(it.url).error }
        setupError =
          endpointError?.let {
            gatewayEndpointValidationMessage(it, GatewayEndpointInputSource.SETUP_CODE)
          } ?: "Setup code was not accepted. Generate a fresh code with openclaw qr."
        return
      }
      connectGateway(plan = plan, inputSource = inputSource)
    }

    fun handleScannedSetupCode(
      rawValue: String,
      inputSource: OnboardingGatewayInputSource,
    ) {
      val scanned = resolveScannedSetupCodeResult(rawValue)
      if (scanned.setupCode == null) {
        val message =
          when (scanned.error) {
            GatewayEndpointValidationError.INSECURE_REMOTE_URL,
            GatewayEndpointValidationError.IPV6_ZONE_ID_UNSUPPORTED,
            ->
              gatewayEndpointValidationMessage(scanned.error, GatewayEndpointInputSource.QR_SCAN)
            else -> "That QR code is not an OpenClaw setup QR. Generate a fresh code with openclaw qr, then try again."
          }
        showSetupScanError(message)
        return
      }
      setupCode = scanned.setupCode
      setupScanError = null
      pairFromSetupCode(scanned.setupCode, inputSource = inputSource)
    }

    fun pairFromManualFields() {
      if (manualTokenLooksLikeSetupCode(token)) {
        setupError = "That looks like a setup code. Go back and choose Setup Gateway, then Use setup code."
        return
      }
      val transport =
        gatewayManualTransportPresentation(
          hostInput = manualHost,
          requestedTls = manualTls,
        )
      val plan =
        resolveGatewayConnectPlan(
          useSetupCode = false,
          setupCode = "",
          savedManualHost = savedManualHost,
          savedManualPort = savedManualPort.toString(),
          savedManualTls = savedManualTls,
          manualHostInput = manualHost,
          manualPortInput = manualPort,
          manualTlsInput = transport.effectiveTls,
          bootstrapTokenInput = "",
          tokenInput = token,
          passwordInput = password,
        )
      if (plan == null) {
        val endpointError =
          composeGatewayManualUrl(manualHost, manualPort, transport.effectiveTls)
            ?.let(::parseGatewayEndpointResult)
            ?.error
            ?: GatewayEndpointValidationError.INVALID_URL
        setupError = gatewayEndpointValidationMessage(endpointError, GatewayEndpointInputSource.MANUAL)
        return
      }
      connectGateway(plan = plan, inputSource = OnboardingGatewayInputSource.Manual)
    }

    fun prefillManualFromNearby(endpoint: GatewayEndpoint) {
      manualHost = endpoint.host
      manualPort = nearbyGatewayManualPort(endpoint)
      manualTls = nearbyGatewayManualTls(endpoint)
      attemptedGatewayName = endpoint.name
      setupError = null
      step = OnboardingStep.Manual
    }

    val galleryPicker =
      rememberLauncherForActivityResult(ActivityResultContracts.GetContent()) { uri ->
        if (uri == null) return@rememberLauncherForActivityResult
        setupError = null
        val image =
          try {
            InputImage.fromFilePath(context, uri)
          } catch (_: Exception) {
            showSetupScanError("Could not read that image. Choose a clear screenshot or image of the QR from openclaw qr.")
            return@rememberLauncherForActivityResult
          }
        setupBarcodeScanner
          .process(image)
          .addOnSuccessListener { barcodes ->
            val rawValue = barcodes.firstNotNullOfOrNull { barcode -> barcode.rawValue?.takeIf { it.isNotBlank() } }
            if (rawValue == null) {
              showSetupScanError("No setup QR code was found in that image. Choose the QR generated by openclaw qr, or enter the setup code manually.")
              return@addOnSuccessListener
            }
            handleScannedSetupCode(rawValue, inputSource = OnboardingGatewayInputSource.SetupGallery)
          }.addOnFailureListener {
            showSetupScanError("Could not read a QR code from that image. Choose a clearer image or enter the setup code manually.")
          }
      }

    setupScanError?.let { message ->
      SetupScanErrorDialog(
        message = message,
        onDismiss = { setupScanError = null },
        onChooseAnotherImage = {
          setupScanError = null
          galleryPicker.launch("image/*")
        },
        onEnterSetupCode = {
          setupScanError = null
          setupError = null
          inlineQrScannerActive = false
          setupCodeEntryOpenedFromScanner = false
          step = OnboardingStep.EnterSetupCode
        },
      )
    }

    pendingTrust?.let { prompt ->
      AlertDialog(
        onDismissRequest = viewModel::declineGatewayTrustPrompt,
        containerColor = ClawTheme.colors.surfaceRaised,
        title = { Text(stringResource(R.string.trust_this_gateway), style = ClawTheme.type.section, color = ClawTheme.colors.text) },
        text = {
          val message =
            if (prompt.previousFingerprintSha256.isNullOrBlank()) {
              stringResource(R.string.gateway_trust_first_seen, prompt.fingerprintSha256)
            } else {
              stringResource(
                R.string.gateway_trust_changed,
                prompt.previousFingerprintSha256,
                prompt.fingerprintSha256,
              )
            }
          Text(
            message,
            style = ClawTheme.type.body,
            color = ClawTheme.colors.textMuted,
          )
        },
        confirmButton = {
          TextButton(onClick = viewModel::acceptGatewayTrustPrompt) {
            Text("Trust")
          }
        },
        dismissButton = {
          TextButton(onClick = viewModel::declineGatewayTrustPrompt) {
            Text("Cancel")
          }
        },
      )
    }

    when (step) {
      OnboardingStep.Welcome ->
        WelcomeScreen(
          modifier = modifier,
          onConnect = { step = OnboardingStep.Gateway },
        )
      OnboardingStep.Gateway ->
        GatewaySetupScreen(
          modifier = modifier,
          nearbyGateway = gateways.firstOrNull(),
          onBack = ::goBack,
          onSetupCode = {
            setupError = null
            setupScanError = null
            inlineQrScannerActive = false
            step = OnboardingStep.SetupCode
          },
          onManualSetup = {
            setupError = null
            setupScanError = null
            val nearbyGateway = gateways.firstOrNull()
            if (nearbyGateway == null) {
              attemptedGatewayName = null
              step = OnboardingStep.Manual
            } else {
              prefillManualFromNearby(nearbyGateway)
            }
          },
        )
      OnboardingStep.SetupCode ->
        SetupCodeInstructionsScreen(
          modifier = modifier,
          scannerActive = inlineQrScannerActive,
          cameraPermissionGranted = cameraPermissionGranted,
          scanner = setupBarcodeScanner,
          onBack = ::goBack,
          onScan = {
            setupError = null
            setupScanError = null
            inlineQrScannerActive = true
            if (!cameraPermissionGranted) {
              cameraPermissionLauncher.launch(Manifest.permission.CAMERA)
            }
          },
          onRequestCameraPermission = { cameraPermissionLauncher.launch(Manifest.permission.CAMERA) },
          onCodeScanned = { rawValue -> handleScannedSetupCode(rawValue, inputSource = OnboardingGatewayInputSource.SetupScanner) },
          onCameraError = {
            showSetupScanError("Could not start the camera. Choose a QR image from gallery or enter the setup code manually.")
          },
          onCloseScanner = { inlineQrScannerActive = false },
          onChooseFromGallery = {
            inlineQrScannerActive = false
            galleryPicker.launch("image/*")
          },
          onEnterSetupCode = {
            setupError = null
            setupScanError = null
            setupCodeEntryOpenedFromScanner = inlineQrScannerActive
            inlineQrScannerActive = false
            step = OnboardingStep.EnterSetupCode
          },
        )
      OnboardingStep.EnterSetupCode ->
        SetupCodeEntryScreen(
          modifier = modifier,
          setupCode = setupCode,
          error = setupError,
          onBack = ::goBack,
          onSetupCodeChange = {
            setupCode = it
            setupError = null
          },
          onUseSetupCode = { pairFromSetupCode(setupCode, inputSource = OnboardingGatewayInputSource.SetupEntry) },
        )
      OnboardingStep.Manual ->
        ManualGatewaySetupScreen(
          modifier = modifier,
          manualHost = manualHost,
          manualPort = manualPort,
          manualTls = manualTls,
          token = token,
          password = password,
          error = setupError,
          onBack = ::goBack,
          onManualHostChange = {
            manualHost = it
            setupError = null
          },
          onManualPortChange = {
            manualPort = it
            setupError = null
          },
          onManualTlsChange = { manualTls = it },
          onTokenChange = {
            token = it
            setupError = null
          },
          onPasswordChange = {
            password = it
            setupError = null
          },
          onPair = ::pairFromManualFields,
        )
      OnboardingStep.Recovery ->
        GatewayRecoveryScreen(
          modifier = modifier,
          statusText = statusText,
          serverName = serverName,
          attemptedGatewayName = attemptedGatewayName,
          gatewayPaired = isConnected,
          gatewayPairingCanContinue =
            isConnected &&
              gatewayPairingContinueDestination(
                ready = ready,
                nodeCapabilityApproval = nodeCapabilityApproval,
              ) != null,
          gatewayConnectionProblem = gatewayConnectionProblem,
          connectSettling = recoveryNowMs - connectAttemptStartedAtMs < GATEWAY_CONNECT_SETTLING_MS,
          connectTimedOut = recoveryNowMs - connectAttemptStartedAtMs >= GATEWAY_CONNECT_TIMEOUT_MS,
          onBack = ::goBack,
          onRetry = {
            connectAttemptStartedAtMs = SystemClock.elapsedRealtime()
            viewModel.refreshGatewayConnection()
          },
          onContinue = ::continueFromGatewayPairing,
        )
      OnboardingStep.NodeApproval ->
        NodeApprovalScreen(
          modifier = modifier,
          approval = nodeCapabilityApproval,
          checkingApproval =
            nodeApprovalCheckingInProgress(
              checkRequested = nodeApprovalCheckRequested,
              refreshStarted = nodeApprovalCheckRefreshStarted,
              nodesDevicesRefreshing = nodesDevicesRefreshing,
            ),
          checkRequested = nodeApprovalCheckRequested,
          ready = ready,
          onBack = ::goBack,
          onCopyCommand = { command -> copyApprovalCommand(context, command) },
          onCheckApproval = ::checkNodeApproval,
        )
      OnboardingStep.Permissions ->
        PermissionSetupScreen(
          modifier = modifier,
          permissionState = permissionState,
          onBack = ::goBack,
          onContinue = {
            val requiresNodeSurfaceRefresh = permissionState.requiresNodeApprovalAfterApply
            permissionState.applyToViewModel()
            if (
              permissionContinueNeedsNodeApproval(
                ready = ready,
                requiresNodeApprovalAfterApply = requiresNodeSurfaceRefresh,
                nodeCapabilityApproval = nodeCapabilityApproval,
              )
            ) {
              accessStage = OnboardingAccessStage.PermissionReapproval
              nodeApprovalCheckRequested = false
              nodeApprovalCheckRefreshStarted = false
              nodeApprovalAutoContinueEnabled = false
              viewModel.refreshNodesDevices()
              viewModel.refreshGatewayConnection()
              step = OnboardingStep.NodeApproval
            } else {
              if (requiresNodeSurfaceRefresh) {
                viewModel.refreshGatewayConnection()
              }
              viewModel.setOnboardingCompleted(true)
            }
          },
        )
    }
  }
}

@Composable
private fun WelcomeScreen(
  onConnect: () -> Unit,
  modifier: Modifier = Modifier,
) {
  ClawScaffold(modifier = modifier, contentPadding = onboardingContentPadding()) {
    Column(modifier = Modifier.fillMaxSize(), horizontalAlignment = Alignment.CenterHorizontally) {
      OnboardingHeroTopSpacer(afterHeader = false)
      OnboardingIntroHero(
        title = "Welcome to OpenClaw",
        subtitle = "Turn this device into a secure OpenClaw node for chat, voice, camera, and device tools.",
        mark = { WelcomeLogo() },
      )
      Spacer(modifier = Modifier.height(24.dp))
      WelcomeChecklist()
      Spacer(modifier = Modifier.height(16.dp))
      SecurityNotice()
      Spacer(modifier = Modifier.weight(1f))
      OnboardingActions {
        ClawPrimaryButton(text = "Continue", onClick = onConnect, modifier = Modifier.onboardingActionButton())
      }
    }
  }
}

@Composable
private fun WelcomeLogo() {
  Surface(
    modifier = Modifier.size(OnboardingHeroMarkSize),
    shape = CircleShape,
    color = ClawTheme.colors.surfaceRaised,
    contentColor = Color.Unspecified,
    border = BorderStroke(1.dp, ClawTheme.colors.border),
  ) {
    Box(modifier = Modifier.fillMaxSize().padding(12.dp), contentAlignment = Alignment.Center) {
      OpenClawMascot(contentDescription = "OpenClaw logo", modifier = Modifier.fillMaxSize())
    }
  }
}

@Composable
private fun GatewayLogo() {
  Surface(
    modifier = Modifier.size(OnboardingHeroMarkSize),
    shape = CircleShape,
    color = ClawTheme.colors.surfaceRaised,
    contentColor = ClawTheme.colors.text,
    border = BorderStroke(1.dp, ClawTheme.colors.border),
  ) {
    Box(contentAlignment = Alignment.Center) {
      Icon(imageVector = Icons.Default.QrCode2, contentDescription = null, modifier = Modifier.size(40.dp), tint = ClawTheme.colors.text)
    }
  }
}

@Composable
private fun OnboardingIntroHero(
  title: String,
  subtitle: String,
  mark: @Composable () -> Unit,
) {
  Column(modifier = Modifier.fillMaxWidth(), horizontalAlignment = Alignment.CenterHorizontally) {
    mark()
    Spacer(modifier = Modifier.height(26.dp))
    Text(
      text = title,
      style = ClawTheme.type.display.copy(fontSize = 31.sp, lineHeight = 36.sp, fontWeight = FontWeight.Bold),
      color = ClawTheme.colors.text,
      textAlign = TextAlign.Center,
      modifier = Modifier.fillMaxWidth(),
    )
    Spacer(modifier = Modifier.height(10.dp))
    Text(
      text = subtitle,
      style = ClawTheme.type.body,
      color = ClawTheme.colors.textMuted,
      textAlign = TextAlign.Center,
      modifier = Modifier.fillMaxWidth(),
    )
  }
}

@Composable
private fun OnboardingHeroTopSpacer(afterHeader: Boolean) {
  Spacer(modifier = Modifier.height(if (afterHeader) OnboardingHeroTopOffsetAfterHeader else OnboardingHeroTopOffset))
}

@Composable
private fun WelcomeChecklist() {
  SoftPanel {
    Column(verticalArrangement = Arrangement.spacedBy(13.dp)) {
      WelcomeChecklistRow(icon = Icons.Default.Link, text = "Connect to your Gateway")
      WelcomeChecklistRow(icon = Icons.Default.Security, text = "Choose device permissions")
      WelcomeChecklistRow(icon = Icons.Default.CheckCircle, text = "Use OpenClaw from your phone")
    }
  }
}

@Composable
private fun WelcomeChecklistRow(
  icon: ImageVector,
  text: String,
) {
  Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(12.dp)) {
    Icon(imageVector = icon, contentDescription = null, modifier = Modifier.size(18.dp), tint = ClawTheme.colors.text)
    Text(text = text, style = ClawTheme.type.section, color = ClawTheme.colors.text)
  }
}

@Composable
private fun SecurityNotice() {
  SoftPanel {
    Row(horizontalArrangement = Arrangement.spacedBy(12.dp), verticalAlignment = Alignment.Top) {
      Icon(imageVector = Icons.Default.ErrorOutline, contentDescription = null, modifier = Modifier.size(24.dp), tint = ClawTheme.colors.warning)
      Column(verticalArrangement = Arrangement.spacedBy(6.dp)) {
        Text(text = "Security notice", style = ClawTheme.type.section, color = ClawTheme.colors.text)
        Text(
          text = "The connected OpenClaw agent can use device capabilities you enable. Continue only if you trust the Gateway and agent you connect to.",
          style = ClawTheme.type.body,
          color = ClawTheme.colors.textMuted,
        )
      }
    }
  }
}

@Composable
private fun SoftPanel(
  modifier: Modifier = Modifier,
  content: @Composable ColumnScope.() -> Unit,
) {
  Surface(
    modifier = modifier.fillMaxWidth(),
    shape = RoundedCornerShape(ClawTheme.radii.panel),
    color = ClawTheme.colors.surfaceRaised,
    contentColor = ClawTheme.colors.text,
    border = BorderStroke(1.dp, ClawTheme.colors.border),
  ) {
    Column(modifier = Modifier.padding(18.dp), content = content)
  }
}

@Composable
private fun GatewaySetupScreen(
  nearbyGateway: GatewayEndpoint?,
  onBack: () -> Unit,
  onSetupCode: () -> Unit,
  onManualSetup: () -> Unit,
  modifier: Modifier = Modifier,
) {
  val context = LocalContext.current
  val uriHandler = LocalUriHandler.current
  ClawScaffold(modifier = modifier, contentPadding = onboardingContentPadding()) {
    Column(modifier = Modifier.fillMaxSize()) {
      OnboardingHeader(title = "", onBack = onBack)
      OnboardingHeroTopSpacer(afterHeader = true)
      Column(modifier = Modifier.fillMaxWidth(), horizontalAlignment = Alignment.CenterHorizontally) {
        OnboardingIntroHero(
          title = "Connect Gateway",
          subtitle = "Scan a QR code or use the setup code from your OpenClaw Gateway.",
          mark = { GatewayLogo() },
        )
        Spacer(modifier = Modifier.height(24.dp))
        GatewayPrerequisites(
          onOpenSetupGuide = {
            runCatching {
              uriHandler.openUri(ANDROID_SETUP_GUIDE_URL)
            }.onFailure {
              Toast.makeText(context, "Could not open setup guide.", Toast.LENGTH_SHORT).show()
            }
          },
        )
      }
      Spacer(modifier = Modifier.weight(1f))
      OnboardingActions {
        ClawPrimaryButton(
          text = "Scan QR or setup code",
          icon = Icons.Default.QrCode2,
          onClick = onSetupCode,
          modifier = Modifier.onboardingActionButton(),
        )
        ClawSecondaryButton(
          text = "Set up manually",
          icon = Icons.Default.Link,
          onClick = onManualSetup,
          modifier = Modifier.onboardingActionButton(),
        )
      }
    }
  }
}

@Composable
private fun OnboardingActions(content: @Composable ColumnScope.() -> Unit) {
  Column(modifier = Modifier.fillMaxWidth()) {
    Column(modifier = Modifier.fillMaxWidth(), verticalArrangement = Arrangement.spacedBy(OnboardingActionGap), content = content)
    Spacer(modifier = Modifier.height(OnboardingBottomInset))
  }
}

@Composable
private fun GatewayPrerequisites(onOpenSetupGuide: () -> Unit) {
  Column(modifier = Modifier.fillMaxWidth(), verticalArrangement = Arrangement.spacedBy(14.dp)) {
    Text(
      text = "Before you start",
      style = ClawTheme.type.label,
      color = ClawTheme.colors.text,
      modifier = Modifier.fillMaxWidth(),
    )
    GatewayPrerequisiteRow(
      title = "Access to the Gateway device",
      body = "Have a terminal open on the device running OpenClaw.",
    )
    GatewayPrerequisiteRow(
      title = "Phone can reach the Gateway",
      body = "Use the same network, or a secure remote Gateway URL.",
    )
    Box(modifier = Modifier.fillMaxWidth(), contentAlignment = Alignment.Center) {
      TextButton(onClick = onOpenSetupGuide) {
        Icon(imageVector = Icons.Default.Link, contentDescription = null, modifier = Modifier.size(16.dp), tint = ClawTheme.colors.primary)
        Spacer(modifier = Modifier.width(7.dp))
        Text(text = "Android setup guide", style = ClawTheme.type.label, color = ClawTheme.colors.primary)
      }
    }
  }
}

@Composable
private fun GatewayPrerequisiteRow(
  title: String,
  body: String,
) {
  Row(modifier = Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(14.dp), verticalAlignment = Alignment.CenterVertically) {
    Box(modifier = Modifier.size(10.dp).background(ClawTheme.colors.primary, CircleShape))
    Column(modifier = Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(3.dp)) {
      Text(text = title, style = ClawTheme.type.body.copy(fontWeight = FontWeight.SemiBold), color = ClawTheme.colors.text)
      Text(text = body, style = ClawTheme.type.caption, color = ClawTheme.colors.textMuted)
    }
  }
}

@Composable
private fun SetupCodeInstructionsScreen(
  scannerActive: Boolean,
  cameraPermissionGranted: Boolean,
  scanner: BarcodeScanner,
  onBack: () -> Unit,
  onScan: () -> Unit,
  onRequestCameraPermission: () -> Unit,
  onCodeScanned: (String) -> Unit,
  onCameraError: () -> Unit,
  onCloseScanner: () -> Unit,
  onChooseFromGallery: () -> Unit,
  onEnterSetupCode: () -> Unit,
  modifier: Modifier = Modifier,
) {
  ClawScaffold(modifier = modifier, contentPadding = onboardingContentPadding()) {
    Column(modifier = Modifier.fillMaxSize().imePadding(), verticalArrangement = Arrangement.SpaceBetween) {
      LazyColumn(
        modifier = Modifier.weight(1f),
        contentPadding = PaddingValues(bottom = 18.dp),
        verticalArrangement = Arrangement.spacedBy(18.dp),
      ) {
        item {
          OnboardingHeader(title = "Setup Gateway", onBack = onBack)
        }
        item {
          Column(modifier = Modifier.fillMaxWidth().padding(top = 8.dp), verticalArrangement = Arrangement.spacedBy(18.dp)) {
            SetupInstruction(
              step = "Step 1",
              title = "Start your Gateway.",
              body = "openclaw gateway",
              monospaceBody = true,
            )
            SetupInstruction(
              step = "Step 2",
              title = "Generate a QR code.",
              body = "openclaw qr",
              monospaceBody = true,
            )
          }
        }
        item {
          ScanQrTile(
            scannerActive = scannerActive,
            cameraPermissionGranted = cameraPermissionGranted,
            scanner = scanner,
            onClick = onScan,
            onClose = onCloseScanner,
            onRequestCameraPermission = onRequestCameraPermission,
            onCodeScanned = onCodeScanned,
            onCameraError = onCameraError,
          )
        }
      }
      OnboardingActions {
        ClawSecondaryButton(
          text = "Choose from gallery",
          icon = Icons.Default.Image,
          onClick = onChooseFromGallery,
          modifier = Modifier.onboardingActionButton(),
        )
        ClawSecondaryButton(
          text = "Enter setup code",
          icon = Icons.Default.QrCode2,
          onClick = onEnterSetupCode,
          modifier = Modifier.onboardingActionButton(),
        )
      }
    }
  }
}

@Composable
private fun SetupScanErrorDialog(
  message: String,
  onDismiss: () -> Unit,
  onChooseAnotherImage: () -> Unit,
  onEnterSetupCode: () -> Unit,
) {
  Dialog(
    onDismissRequest = onDismiss,
    properties = DialogProperties(usePlatformDefaultWidth = false),
  ) {
    Surface(
      modifier = Modifier.fillMaxWidth().padding(horizontal = 26.dp),
      shape = RoundedCornerShape(ClawTheme.radii.sheet),
      color = ClawTheme.colors.surfaceRaised,
      contentColor = ClawTheme.colors.text,
      border = BorderStroke(1.dp, ClawTheme.colors.borderStrong),
    ) {
      Column(
        modifier = Modifier.fillMaxWidth().padding(18.dp),
        verticalArrangement = Arrangement.spacedBy(16.dp),
      ) {
        Row(
          modifier = Modifier.fillMaxWidth(),
          verticalAlignment = Alignment.CenterVertically,
          horizontalArrangement = Arrangement.spacedBy(12.dp),
        ) {
          Surface(
            modifier = Modifier.size(38.dp),
            shape = CircleShape,
            color = ClawTheme.colors.warningSoft,
            contentColor = ClawTheme.colors.warning,
          ) {
            Box(contentAlignment = Alignment.Center) {
              Icon(imageVector = Icons.Default.ErrorOutline, contentDescription = null, modifier = Modifier.size(22.dp))
            }
          }
          Text(
            text = "QR code not accepted",
            style = ClawTheme.type.title,
            color = ClawTheme.colors.text,
            modifier = Modifier.weight(1f),
          )
        }

        Text(
          text = message,
          style = ClawTheme.type.body,
          color = ClawTheme.colors.textMuted,
        )

        Column(verticalArrangement = Arrangement.spacedBy(OnboardingActionGap), modifier = Modifier.fillMaxWidth()) {
          ClawPrimaryButton(
            text = "Choose another image",
            icon = Icons.Default.Image,
            onClick = onChooseAnotherImage,
            modifier = Modifier.onboardingActionButton(),
          )
          ClawSecondaryButton(
            text = "Enter setup code",
            icon = Icons.Default.QrCode2,
            onClick = onEnterSetupCode,
            modifier = Modifier.onboardingActionButton(),
          )
        }
      }
    }
  }
}

@Composable
private fun ScanQrTile(
  scannerActive: Boolean,
  cameraPermissionGranted: Boolean,
  scanner: BarcodeScanner,
  onClick: () -> Unit,
  onClose: () -> Unit,
  onRequestCameraPermission: () -> Unit,
  onCodeScanned: (String) -> Unit,
  onCameraError: () -> Unit,
  modifier: Modifier = Modifier,
) {
  val tileShape = RoundedCornerShape(12.dp)

  if (!scannerActive) {
    Surface(
      onClick = onClick,
      modifier = modifier.fillMaxWidth().aspectRatio(1f),
      shape = tileShape,
      color = ClawTheme.colors.surfaceRaised,
      contentColor = ClawTheme.colors.text,
      border = BorderStroke(1.dp, ClawTheme.colors.borderStrong),
    ) {
      Box(modifier = Modifier.fillMaxSize().padding(24.dp), contentAlignment = Alignment.Center) {
        Column(horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.spacedBy(10.dp)) {
          Surface(
            modifier = Modifier.size(56.dp),
            shape = CircleShape,
            color = ClawTheme.colors.surfacePressed,
            contentColor = ClawTheme.colors.text,
            border = BorderStroke(1.dp, ClawTheme.colors.border),
          ) {
            Box(contentAlignment = Alignment.Center) {
              Icon(imageVector = Icons.Default.CameraAlt, contentDescription = null, modifier = Modifier.size(28.dp))
            }
          }
          Text(text = "Scan QR code", style = ClawTheme.type.title.copy(fontSize = 20.sp, lineHeight = 25.sp), color = ClawTheme.colors.text, textAlign = TextAlign.Center)
          Text(
            text = "Open the camera and frame the code from openclaw qr.",
            style = ClawTheme.type.caption,
            color = ClawTheme.colors.textMuted,
            textAlign = TextAlign.Center,
          )
        }
      }
    }
    return
  }

  Surface(
    modifier = modifier.fillMaxWidth().aspectRatio(1f),
    shape = tileShape,
    color = ClawTheme.colors.surfaceRaised,
    contentColor = ClawTheme.colors.text,
    border = BorderStroke(1.dp, ClawTheme.colors.borderStrong),
  ) {
    if (cameraPermissionGranted) {
      Box(modifier = Modifier.fillMaxSize()) {
        QrCameraPreview(scanner = scanner, onCodeScanned = onCodeScanned, onCameraError = onCameraError, modifier = Modifier.fillMaxSize())
        ScannerCloseButton(onClick = onClose, modifier = Modifier.align(Alignment.TopEnd).padding(12.dp))
        Box(
          modifier = Modifier.fillMaxSize().padding(42.dp),
          contentAlignment = Alignment.Center,
        ) {
          Box(
            modifier =
              Modifier
                .fillMaxSize()
                .border(2.dp, ClawTheme.colors.primary, RoundedCornerShape(24.dp)),
          )
        }
        Text(
          text = "Align the QR code inside the square.",
          style = ClawTheme.type.caption,
          color = Color.White,
          modifier =
            Modifier
              .align(Alignment.BottomCenter)
              .fillMaxWidth()
              .background(Color.Black.copy(alpha = 0.62f))
              .padding(horizontal = 14.dp, vertical = 12.dp),
          textAlign = TextAlign.Center,
        )
      }
    } else {
      Box(modifier = Modifier.fillMaxSize().padding(24.dp), contentAlignment = Alignment.Center) {
        ScannerCloseButton(onClick = onClose, modifier = Modifier.align(Alignment.TopEnd))
        Column(horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.spacedBy(12.dp)) {
          Icon(imageVector = Icons.Default.CameraAlt, contentDescription = null, modifier = Modifier.size(36.dp), tint = ClawTheme.colors.text)
          Text(
            text = "Camera access is needed to scan the setup QR.",
            style = ClawTheme.type.body,
            color = ClawTheme.colors.textMuted,
            textAlign = TextAlign.Center,
          )
          ClawPrimaryButton(text = "Allow camera", icon = Icons.Default.CameraAlt, onClick = onRequestCameraPermission, modifier = Modifier.onboardingActionButton())
        }
      }
    }
  }
}

@Composable
private fun ScannerCloseButton(
  onClick: () -> Unit,
  modifier: Modifier = Modifier,
) {
  Surface(
    onClick = onClick,
    modifier = modifier.size(40.dp),
    shape = CircleShape,
    color = Color.Black.copy(alpha = 0.68f),
    contentColor = Color.White,
    border = BorderStroke(1.dp, Color.White.copy(alpha = 0.26f)),
  ) {
    Box(contentAlignment = Alignment.Center) {
      Icon(imageVector = Icons.Default.Close, contentDescription = "Close scanner", modifier = Modifier.size(20.dp))
    }
  }
}

@Composable
private fun QrCameraPreview(
  scanner: BarcodeScanner,
  onCodeScanned: (String) -> Unit,
  onCameraError: () -> Unit,
  modifier: Modifier = Modifier,
) {
  val context = LocalContext.current
  val lifecycleOwner = LocalLifecycleOwner.current
  val previewView =
    remember {
      PreviewView(context).apply {
        scaleType = PreviewView.ScaleType.FILL_CENTER
      }
    }
  val analysisExecutor = remember { Executors.newSingleThreadExecutor() }
  val processingFrame = remember { AtomicBoolean(false) }
  val handledScan = remember { AtomicBoolean(false) }
  val scanActive = remember { AtomicBoolean(true) }

  DisposableEffect(context, lifecycleOwner, scanner, previewView) {
    scanActive.set(true)
    val cameraProviderFuture = ProcessCameraProvider.getInstance(context)
    var cameraProvider: ProcessCameraProvider? = null
    var preview: Preview? = null
    var analysis: ImageAnalysis? = null
    var disposed = false
    val listener =
      Runnable {
        val provider =
          try {
            cameraProviderFuture.get()
          } catch (_: Exception) {
            if (!disposed) onCameraError()
            return@Runnable
          }
        if (disposed) return@Runnable
        val previewUseCase =
          Preview
            .Builder()
            .build()
            .also { it.surfaceProvider = previewView.surfaceProvider }
        val analysisUseCase =
          ImageAnalysis
            .Builder()
            .setBackpressureStrategy(ImageAnalysis.STRATEGY_KEEP_ONLY_LATEST)
            .build()

        analysisUseCase.setAnalyzer(analysisExecutor) { imageProxy ->
          analyzeSetupQrFrame(
            imageProxy = imageProxy,
            scanner = scanner,
            processingFrame = processingFrame,
            handledScan = handledScan,
            scanActive = scanActive,
            onCodeScanned = onCodeScanned,
          )
        }

        try {
          val selector =
            setupQrCameraSelector(provider) ?: run {
              analysisUseCase.clearAnalyzer()
              if (!disposed) onCameraError()
              return@Runnable
            }
          if (disposed) {
            analysisUseCase.clearAnalyzer()
            return@Runnable
          }
          provider.bindToLifecycle(lifecycleOwner, selector, previewUseCase, analysisUseCase)
          if (disposed) {
            analysisUseCase.clearAnalyzer()
            provider.unbind(previewUseCase, analysisUseCase)
            return@Runnable
          }
          cameraProvider = provider
          preview = previewUseCase
          analysis = analysisUseCase
        } catch (_: Exception) {
          analysisUseCase.clearAnalyzer()
          if (!disposed) onCameraError()
        }
      }
    cameraProviderFuture.addListener(listener, ContextCompat.getMainExecutor(context))

    onDispose {
      disposed = true
      scanActive.set(false)
      analysis?.clearAnalyzer()
      val boundUseCases = listOfNotNull<UseCase>(preview, analysis)
      if (boundUseCases.isNotEmpty()) {
        cameraProvider?.unbind(*boundUseCases.toTypedArray())
      }
    }
  }

  DisposableEffect(Unit) {
    onDispose { analysisExecutor.shutdown() }
  }

  AndroidView(factory = { previewView }, modifier = modifier)
}

private fun setupQrCameraSelector(provider: ProcessCameraProvider): CameraSelector? =
  when {
    provider.hasCamera(CameraSelector.DEFAULT_BACK_CAMERA) -> CameraSelector.DEFAULT_BACK_CAMERA
    provider.hasCamera(CameraSelector.DEFAULT_FRONT_CAMERA) -> CameraSelector.DEFAULT_FRONT_CAMERA
    else -> null
  }

@androidx.annotation.OptIn(ExperimentalGetImage::class)
private fun analyzeSetupQrFrame(
  imageProxy: ImageProxy,
  scanner: BarcodeScanner,
  processingFrame: AtomicBoolean,
  handledScan: AtomicBoolean,
  scanActive: AtomicBoolean,
  onCodeScanned: (String) -> Unit,
) {
  if (!scanActive.get() || handledScan.get() || !processingFrame.compareAndSet(false, true)) {
    imageProxy.close()
    return
  }
  val mediaImage = imageProxy.image
  if (mediaImage == null) {
    processingFrame.set(false)
    imageProxy.close()
    return
  }

  val inputImage = InputImage.fromMediaImage(mediaImage, imageProxy.imageInfo.rotationDegrees)
  scanner
    .process(inputImage)
    .addOnSuccessListener { barcodes ->
      val rawValue = barcodes.firstNotNullOfOrNull { barcode -> barcode.rawValue?.takeIf { it.isNotBlank() } }
      if (rawValue != null && scanActive.get() && handledScan.compareAndSet(false, true)) {
        onCodeScanned(rawValue)
      }
    }.addOnCompleteListener {
      processingFrame.set(false)
      imageProxy.close()
    }
}

@Composable
private fun SetupCodeEntryScreen(
  setupCode: String,
  error: String?,
  onBack: () -> Unit,
  onSetupCodeChange: (String) -> Unit,
  onUseSetupCode: () -> Unit,
  modifier: Modifier = Modifier,
) {
  ClawScaffold(modifier = modifier, contentPadding = onboardingContentPadding()) {
    Column(modifier = Modifier.fillMaxSize().imePadding(), verticalArrangement = Arrangement.SpaceBetween) {
      Column(verticalArrangement = Arrangement.spacedBy(18.dp)) {
        OnboardingHeader(title = "Enter setup code", onBack = onBack)
        LabeledField(label = "Setup code") {
          ClawTextField(
            value = setupCode,
            onValueChange = onSetupCodeChange,
            placeholder = "Paste setup code",
          )
        }
        error?.let { message ->
          InlineError(title = "Setup code was not accepted", body = message)
        }
      }
      OnboardingActions {
        ClawPrimaryButton(text = "Use setup code", icon = Icons.Default.QrCode2, onClick = onUseSetupCode, modifier = Modifier.onboardingActionButton())
      }
    }
  }
}

@Composable
private fun ManualGatewaySetupScreen(
  manualHost: String,
  manualPort: String,
  manualTls: Boolean,
  token: String,
  password: String,
  error: String?,
  onBack: () -> Unit,
  onManualHostChange: (String) -> Unit,
  onManualPortChange: (String) -> Unit,
  onManualTlsChange: (Boolean) -> Unit,
  onTokenChange: (String) -> Unit,
  onPasswordChange: (String) -> Unit,
  onPair: () -> Unit,
  modifier: Modifier = Modifier,
) {
  val transport =
    remember(manualHost, manualTls) {
      gatewayManualTransportPresentation(
        hostInput = manualHost,
        requestedTls = manualTls,
      )
    }
  ClawScaffold(modifier = modifier, contentPadding = onboardingContentPadding()) {
    Column(modifier = Modifier.fillMaxSize().imePadding(), verticalArrangement = Arrangement.SpaceBetween) {
      LazyColumn(
        modifier = Modifier.weight(1f),
        contentPadding = PaddingValues(bottom = 18.dp),
        verticalArrangement = Arrangement.spacedBy(16.dp),
      ) {
        item {
          OnboardingHeader(title = "Manual setup", onBack = onBack)
        }
        item {
          LabeledField(label = "Gateway URL") {
            Row(horizontalArrangement = Arrangement.spacedBy(10.dp)) {
              ClawTextField(value = manualHost, onValueChange = onManualHostChange, placeholder = "Host", modifier = Modifier.weight(1f))
              ClawTextField(value = manualPort, onValueChange = onManualPortChange, placeholder = "Port", modifier = Modifier.width(104.dp))
            }
            Text(
              text = "Use the Gateway computer's LAN address or secure remote hostname.",
              style = ClawTheme.type.caption,
              color = ClawTheme.colors.textMuted,
            )
          }
        }
        item {
          LabeledField(label = "Token") {
            ClawTextField(value = token, onValueChange = onTokenChange, placeholder = "Paste token")
            Text(
              text = "Paste a shared Gateway token or operator-issued token.",
              style = ClawTheme.type.caption,
              color = ClawTheme.colors.textMuted,
            )
          }
        }
        item {
          LabeledField(label = "Password") {
            ClawTextField(value = password, onValueChange = onPasswordChange, placeholder = "Password optional")
          }
        }
        item {
          LabeledField(label = "Connection security") {
            Row(horizontalArrangement = Arrangement.spacedBy(9.dp)) {
              TogglePill(
                text = "Unencrypted",
                selected = !transport.effectiveTls,
                enabled = !transport.requiresTls,
                onClick = { onManualTlsChange(false) },
              )
              TogglePill(
                text = "Secure (TLS)",
                selected = transport.effectiveTls,
                onClick = { onManualTlsChange(true) },
              )
            }
            transport.helperText?.let { helperText ->
              Text(
                text = helperText,
                style = ClawTheme.type.caption,
                color = ClawTheme.colors.textMuted,
              )
            }
          }
        }
        error?.let { message ->
          item {
            InlineError(title = "Could not test connection", body = message)
          }
        }
      }
      OnboardingActions {
        ClawPrimaryButton(text = "Test connection", icon = Icons.Default.Security, onClick = onPair, modifier = Modifier.onboardingActionButton())
      }
    }
  }
}

@Composable
private fun SetupInstruction(
  step: String,
  title: String,
  body: String,
  modifier: Modifier = Modifier,
  monospaceBody: Boolean = false,
) {
  Column(modifier = modifier.fillMaxWidth(), verticalArrangement = Arrangement.spacedBy(4.dp)) {
    Text(text = step, style = ClawTheme.type.caption, color = ClawTheme.colors.textSubtle)
    Text(text = title, style = ClawTheme.type.section, color = ClawTheme.colors.text)
    if (monospaceBody) {
      Surface(
        modifier = Modifier.fillMaxWidth().padding(top = 3.dp),
        shape = RoundedCornerShape(ClawTheme.radii.control),
        color = ClawTheme.colors.surfaceRaised,
        border = BorderStroke(1.dp, ClawTheme.colors.border),
      ) {
        Text(text = body, modifier = Modifier.padding(horizontal = 11.dp, vertical = 9.dp), style = ClawTheme.type.mono, color = ClawTheme.colors.text)
      }
    } else {
      Text(text = body, style = ClawTheme.type.caption, color = ClawTheme.colors.textMuted)
    }
  }
}

@Composable
private fun LabeledField(
  label: String,
  modifier: Modifier = Modifier,
  content: @Composable ColumnScope.() -> Unit,
) {
  Column(modifier = modifier.fillMaxWidth(), verticalArrangement = Arrangement.spacedBy(7.dp)) {
    Text(text = label, style = ClawTheme.type.caption, color = ClawTheme.colors.textMuted)
    content()
  }
}

@Composable
private fun InlineError(
  title: String,
  body: String,
  modifier: Modifier = Modifier,
) {
  Column(modifier = modifier.fillMaxWidth(), verticalArrangement = Arrangement.spacedBy(5.dp)) {
    Text(text = title, style = ClawTheme.type.section, color = ClawTheme.colors.warning)
    Text(text = body, style = ClawTheme.type.caption, color = ClawTheme.colors.textMuted)
  }
}

@Composable
private fun GatewayRecoveryScreen(
  statusText: String,
  serverName: String?,
  attemptedGatewayName: String?,
  gatewayPaired: Boolean,
  gatewayPairingCanContinue: Boolean,
  gatewayConnectionProblem: GatewayConnectionProblem?,
  connectSettling: Boolean,
  connectTimedOut: Boolean,
  onBack: () -> Unit,
  onRetry: () -> Unit,
  onContinue: () -> Unit,
  modifier: Modifier = Modifier,
) {
  val recoveryState =
    gatewayPairingUiState(
      gatewayPaired = gatewayPaired,
      gatewayPairingCanContinue = gatewayPairingCanContinue,
      statusText = statusText,
      connectSettling = connectSettling,
      connectTimedOut = connectTimedOut,
      gatewayConnectionProblem = gatewayConnectionProblem,
    )
  val context = LocalContext.current
  val approvalCommand = recoveryGatewayApprovalCommand(gatewayConnectionProblem)
  val protocolUpdateCommand = recoveryGatewayProtocolMismatchCommand(gatewayConnectionProblem)
  val recoveryTitle =
    when {
      recoveryState == GatewayRecoveryUiState.Connected -> "Gateway paired"
      gatewayConnectionProblem?.code == "AUTH_BOOTSTRAP_TOKEN_INVALID" -> "Setup code was not accepted"
      else -> recoveryState.title
    }
  val recoveryMessage =
    when {
      recoveryState == GatewayRecoveryUiState.Connected ->
        "Your phone is paired with ${recoveryGatewayName(serverName = serverName, attemptedGatewayName = attemptedGatewayName)}. " +
          "Continue to finish node access."
      gatewayConnectionProblem != null && recoveryState == GatewayRecoveryUiState.Failed ->
        recoveryGatewayAuthDetail(gatewayConnectionProblem)
      else -> recoveryState.message
    }
  val recoveryProgressItems =
    gatewayRecoveryProgressItems(
      state = recoveryState,
      statusText = statusText,
      connectSettling = connectSettling,
    )
  val primaryAction = gatewayRecoveryPrimaryAction(recoveryState)
  val showDiagnosticAction =
    gatewayRecoveryShowsDiagnosticAction(
      state = recoveryState,
      gatewayConnectionProblem = gatewayConnectionProblem,
    )
  val diagnosticText =
    remember(
      statusText,
      serverName,
      attemptedGatewayName,
      gatewayPaired,
      gatewayPairingCanContinue,
      gatewayConnectionProblem,
    ) {
      gatewayRecoveryDiagnosticText(
        statusText = statusText,
        gatewayName = recoveryGatewayName(serverName = serverName, attemptedGatewayName = attemptedGatewayName),
        gatewayPaired = gatewayPaired,
        gatewayPairingCanContinue = gatewayPairingCanContinue,
        gatewayConnectionProblem = gatewayConnectionProblem,
      )
    }
  var diagnosticDialogVisible by rememberSaveable { mutableStateOf(false) }

  if (diagnosticDialogVisible) {
    GatewayRecoveryDiagnosticDialog(
      diagnosticText = diagnosticText,
      onDismiss = { diagnosticDialogVisible = false },
      onCopy = { copyGatewayDiagnostic(context = context, diagnosticText = diagnosticText) },
    )
  }

  ClawScaffold(modifier = modifier, contentPadding = onboardingContentPadding()) {
    Column(modifier = Modifier.fillMaxSize()) {
      OnboardingHeader(
        title =
          when (recoveryState) {
            GatewayRecoveryUiState.Connected -> "Gateway paired"
            else -> "Pair Gateway"
          },
        onBack = onBack,
      )

      Column(
        modifier =
          Modifier
            .weight(1f)
            .fillMaxWidth()
            .verticalScroll(rememberScrollState())
            .padding(horizontal = 6.dp, vertical = 12.dp),
        horizontalAlignment = Alignment.CenterHorizontally,
        verticalArrangement = Arrangement.Center,
      ) {
        GatewayRecoveryIcon(state = recoveryState)
        Spacer(modifier = Modifier.height(13.dp))
        Text(text = recoveryTitle, style = ClawTheme.type.display, color = ClawTheme.colors.text, textAlign = TextAlign.Center)
        Spacer(modifier = Modifier.height(8.dp))
        Text(
          text = recoveryMessage,
          style = ClawTheme.type.body,
          color = ClawTheme.colors.textMuted,
          textAlign = TextAlign.Center,
        )
        approvalCommand?.let { command ->
          Spacer(modifier = Modifier.height(18.dp))
          ApprovalCommandBlock(command = command, onCopy = { copyApprovalCommand(context, command) })
        }
        protocolUpdateCommand?.let { command ->
          Spacer(modifier = Modifier.height(18.dp))
          Text(
            text = "On the Gateway computer, run:",
            style = ClawTheme.type.caption,
            color = ClawTheme.colors.textMuted,
          )
          Spacer(modifier = Modifier.height(8.dp))
          ApprovalCommandBlock(command = command, onCopy = { copyGatewayCommand(context, command) })
        }
        if (recoveryProgressItems.isNotEmpty()) {
          Spacer(modifier = Modifier.height(20.dp))
          GatewayRecoveryProgress(items = recoveryProgressItems)
        }
        if (showDiagnosticAction) {
          Spacer(modifier = Modifier.height(14.dp))
          TextButton(onClick = { diagnosticDialogVisible = true }) {
            Text("View details", style = ClawTheme.type.body, color = ClawTheme.colors.text)
          }
        }
      }

      primaryAction?.let { action ->
        OnboardingActions {
          ClawPrimaryButton(
            text = action.text,
            icon = action.icon,
            onClick =
              when (action) {
                GatewayRecoveryPrimaryAction.Finish -> onContinue
                GatewayRecoveryPrimaryAction.Retry -> onRetry
                GatewayRecoveryPrimaryAction.Back -> onBack
              },
            modifier = Modifier.onboardingActionButton(),
          )
        }
      }
    }
  }
}

@Composable
private fun GatewayRecoveryDiagnosticDialog(
  diagnosticText: String,
  onDismiss: () -> Unit,
  onCopy: () -> Unit,
) {
  AlertDialog(
    onDismissRequest = onDismiss,
    containerColor = ClawTheme.colors.surfaceRaised,
    title = { Text("Connection details", style = ClawTheme.type.section, color = ClawTheme.colors.text) },
    text = {
      SelectionContainer {
        Text(
          text = diagnosticText,
          style = ClawTheme.type.mono,
          color = ClawTheme.colors.textMuted,
        )
      }
    },
    confirmButton = {
      TextButton(onClick = onCopy) {
        Text("Copy")
      }
    },
    dismissButton = {
      TextButton(onClick = onDismiss) {
        Text("Close")
      }
    },
  )
}

private fun copyGatewayDiagnostic(
  context: Context,
  diagnosticText: String,
) {
  val clipboard = context.getSystemService(Context.CLIPBOARD_SERVICE) as ClipboardManager
  clipboard.setPrimaryClip(ClipData.newPlainText("OpenClaw gateway diagnostic", diagnosticText))
  Toast.makeText(context, "Details copied", Toast.LENGTH_SHORT).show()
}

@Composable
private fun GatewayRecoveryIcon(state: GatewayRecoveryUiState) {
  val icon =
    when (state) {
      GatewayRecoveryUiState.Connected -> Icons.Default.CheckCircle
      GatewayRecoveryUiState.NodeCapabilityApprovalPending -> Icons.Default.Security
      GatewayRecoveryUiState.ApprovalRequired -> Icons.Default.WifiTethering
      GatewayRecoveryUiState.Pairing -> Icons.Default.WifiTethering
      GatewayRecoveryUiState.Finishing -> Icons.Default.WifiTethering
      GatewayRecoveryUiState.TakingLonger -> Icons.Default.WifiTethering
      GatewayRecoveryUiState.Failed -> Icons.Default.ErrorOutline
    }
  val tint =
    when (state) {
      GatewayRecoveryUiState.Connected -> ClawTheme.colors.success
      GatewayRecoveryUiState.NodeCapabilityApprovalPending -> ClawTheme.colors.warning
      GatewayRecoveryUiState.ApprovalRequired -> ClawTheme.colors.warning
      GatewayRecoveryUiState.Pairing -> ClawTheme.colors.text
      GatewayRecoveryUiState.Finishing -> ClawTheme.colors.text
      GatewayRecoveryUiState.TakingLonger -> ClawTheme.colors.warning
      GatewayRecoveryUiState.Failed -> ClawTheme.colors.warning
    }
  Surface(
    modifier = Modifier.size(62.dp),
    shape = CircleShape,
    color =
      when (state) {
        GatewayRecoveryUiState.Connected -> ClawTheme.colors.successSoft
        GatewayRecoveryUiState.TakingLonger -> ClawTheme.colors.warningSoft
        GatewayRecoveryUiState.Failed -> ClawTheme.colors.warningSoft
        else -> ClawTheme.colors.surfaceRaised
      },
    contentColor = tint,
  ) {
    Box(contentAlignment = Alignment.Center) {
      Icon(imageVector = icon, contentDescription = null, modifier = Modifier.size(36.dp), tint = tint)
    }
  }
}

@Composable
private fun NodeApprovalScreen(
  approval: GatewayNodeCapabilityApproval,
  checkingApproval: Boolean,
  checkRequested: Boolean,
  ready: Boolean,
  onBack: () -> Unit,
  onCopyCommand: (String) -> Unit,
  onCheckApproval: () -> Unit,
  modifier: Modifier = Modifier,
) {
  val approveCommand = recoveryNodeApprovalCommand(approvalRequestId(approval))
  var waitingDialogDismissed by rememberSaveable { mutableStateOf(false) }
  LaunchedEffect(checkingApproval) {
    if (checkingApproval) {
      waitingDialogDismissed = false
    }
  }
  val showWaitingDialog =
    checkRequested &&
      !checkingApproval &&
      !ready &&
      nodeCapabilityApprovalNeedsUserAction(approval) &&
      !waitingDialogDismissed

  ClawScaffold(modifier = modifier, contentPadding = onboardingContentPadding()) {
    Column(modifier = Modifier.fillMaxSize()) {
      OnboardingHeader(title = "Approve node access", onBack = onBack)

      Column(
        modifier =
          Modifier
            .weight(1f)
            .fillMaxWidth()
            .verticalScroll(rememberScrollState())
            .padding(horizontal = 6.dp, vertical = 12.dp),
        horizontalAlignment = Alignment.CenterHorizontally,
        verticalArrangement = Arrangement.Center,
      ) {
        GatewayRecoveryIcon(state = GatewayRecoveryUiState.NodeCapabilityApprovalPending)
        Spacer(modifier = Modifier.height(13.dp))
        Text(
          text = "Approve node access",
          style = ClawTheme.type.display,
          color = ClawTheme.colors.text,
          textAlign = TextAlign.Center,
        )
        Spacer(modifier = Modifier.height(8.dp))
        Text(
          text = "Gateway pairing is complete. Approve this phone as a node so OpenClaw can use the device capabilities you enable.",
          style = ClawTheme.type.body,
          color = ClawTheme.colors.textMuted,
          textAlign = TextAlign.Center,
        )
        Spacer(modifier = Modifier.height(18.dp))
        Column(modifier = Modifier.fillMaxWidth(), verticalArrangement = Arrangement.spacedBy(8.dp)) {
          Text(
            text = "On the Gateway computer, run:",
            style = ClawTheme.type.caption,
            color = ClawTheme.colors.textMuted,
            textAlign = TextAlign.Center,
            modifier = Modifier.fillMaxWidth(),
          )
          ApprovalCommandBlock(command = "openclaw nodes pending", onCopy = { onCopyCommand("openclaw nodes pending") })
          ApprovalCommandBlock(command = approveCommand, onCopy = { onCopyCommand(approveCommand) })
          Text(
            text = "Use the requestId from the pending command in the approve command.",
            style = ClawTheme.type.caption,
            color = ClawTheme.colors.textSubtle,
            textAlign = TextAlign.Center,
            modifier = Modifier.fillMaxWidth(),
          )
        }
      }

      OnboardingActions {
        OnboardingLoadingPrimaryButton(
          text = "I have approved",
          loadingText = "Checking approval…",
          loading = checkingApproval,
          modifier = Modifier.onboardingActionButton(),
          onClick = onCheckApproval,
        )
      }
    }
  }

  if (showWaitingDialog) {
    AlertDialog(
      onDismissRequest = { waitingDialogDismissed = true },
      title = { Text(text = "Still waiting for approval") },
      text = {
        Text(
          text = "Run the approve command on the Gateway computer, then check again.",
          style = ClawTheme.type.body,
          color = ClawTheme.colors.textMuted,
        )
      },
      confirmButton = {
        TextButton(onClick = { waitingDialogDismissed = true }) {
          Text(text = "OK")
        }
      },
    )
  }
}

@Composable
private fun OnboardingLoadingPrimaryButton(
  text: String,
  loadingText: String,
  loading: Boolean,
  modifier: Modifier = Modifier,
  onClick: () -> Unit,
) {
  Button(
    onClick = onClick,
    enabled = !loading,
    modifier = modifier.heightIn(min = ClawTheme.spacing.touchTarget),
    shape = RoundedCornerShape(ClawTheme.radii.button),
    colors =
      ButtonDefaults.buttonColors(
        containerColor = ClawTheme.colors.primary,
        contentColor = ClawTheme.colors.primaryText,
        disabledContainerColor = ClawTheme.colors.surfacePressed,
        disabledContentColor = ClawTheme.colors.textMuted,
      ),
    contentPadding = PaddingValues(horizontal = 16.dp, vertical = 8.dp),
    elevation = ButtonDefaults.buttonElevation(defaultElevation = 0.dp, pressedElevation = 0.dp),
  ) {
    if (loading) {
      CircularProgressIndicator(
        modifier = Modifier.size(18.dp),
        color = ClawTheme.colors.textMuted,
        strokeWidth = 2.dp,
        trackColor = Color.Transparent,
      )
      Spacer(modifier = Modifier.width(8.dp))
    }
    Text(text = if (loading) loadingText else text, style = ClawTheme.type.label)
  }
}

@Composable
private fun GatewayRecoveryProgress(items: List<GatewayRecoveryProgressItem>) {
  val transition = rememberInfiniteTransition(label = "gateway-progress")
  val currentAlpha by
    transition.animateFloat(
      initialValue = 0.36f,
      targetValue = 1f,
      animationSpec =
        infiniteRepeatable(
          animation = tween(durationMillis = 680),
          repeatMode = RepeatMode.Reverse,
        ),
      label = "current-step-alpha",
    )
  Column(
    modifier = Modifier.fillMaxWidth().padding(horizontal = 16.dp),
    verticalArrangement = Arrangement.spacedBy(12.dp),
  ) {
    items.forEach { item ->
      Row(
        modifier = Modifier.fillMaxWidth(),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(12.dp),
      ) {
        GatewayRecoveryProgressDot(status = item.status, currentAlpha = currentAlpha)
        Text(
          text = item.label,
          style = ClawTheme.type.caption,
          color =
            when (item.status) {
              GatewayRecoveryProgressStatus.Complete -> ClawTheme.colors.success
              GatewayRecoveryProgressStatus.Current -> ClawTheme.colors.text
              GatewayRecoveryProgressStatus.Pending -> ClawTheme.colors.textMuted
            },
        )
      }
    }
  }
}

@Composable
private fun GatewayRecoveryProgressDot(
  status: GatewayRecoveryProgressStatus,
  currentAlpha: Float,
) {
  Box(modifier = Modifier.width(18.dp), contentAlignment = Alignment.Center) {
    when (status) {
      GatewayRecoveryProgressStatus.Complete ->
        Surface(
          modifier = Modifier.size(9.dp),
          shape = CircleShape,
          color = ClawTheme.colors.success,
          contentColor = Color.Transparent,
        ) {}
      GatewayRecoveryProgressStatus.Current -> {
        Surface(
          modifier = Modifier.size(18.dp).alpha(currentAlpha),
          shape = CircleShape,
          color = ClawTheme.colors.warningSoft,
          contentColor = Color.Transparent,
        ) {}
        Surface(
          modifier = Modifier.size(9.dp),
          shape = CircleShape,
          color = ClawTheme.colors.warning,
          contentColor = Color.Transparent,
        ) {}
      }
      GatewayRecoveryProgressStatus.Pending ->
        Surface(
          modifier = Modifier.size(8.dp),
          shape = CircleShape,
          color = ClawTheme.colors.border,
          contentColor = Color.Transparent,
        ) {}
    }
  }
}

@Composable
private fun ApprovalCommandBlock(
  command: String,
  onCopy: () -> Unit,
) {
  Surface(
    modifier = Modifier.fillMaxWidth(),
    shape = RoundedCornerShape(8.dp),
    color = ClawTheme.colors.surfacePressed,
    border = BorderStroke(1.dp, ClawTheme.colors.border),
  ) {
    Row(
      modifier = Modifier.fillMaxWidth().padding(start = 12.dp, end = 6.dp, top = 8.dp, bottom = 8.dp),
      verticalAlignment = Alignment.CenterVertically,
      horizontalArrangement = Arrangement.spacedBy(8.dp),
    ) {
      SelectionContainer(modifier = Modifier.weight(1f)) {
        Text(text = command, style = ClawTheme.type.body.copy(fontFamily = FontFamily.Monospace), color = ClawTheme.colors.text)
      }
      Surface(
        onClick = onCopy,
        modifier = Modifier.size(36.dp),
        shape = RoundedCornerShape(8.dp),
        color = ClawTheme.colors.surfaceRaised,
        contentColor = ClawTheme.colors.text,
        border = BorderStroke(1.dp, ClawTheme.colors.border),
      ) {
        Box(contentAlignment = Alignment.Center) {
          Icon(imageVector = Icons.Default.ContentCopy, contentDescription = "Copy approval command", modifier = Modifier.size(18.dp))
        }
      }
    }
  }
}

@Composable
private fun PermissionSetupScreen(
  permissionState: PermissionState,
  onBack: () -> Unit,
  onContinue: () -> Unit,
  modifier: Modifier = Modifier,
) {
  ClawScaffold(modifier = modifier, contentPadding = onboardingContentPadding()) {
    Column(modifier = Modifier.fillMaxSize(), verticalArrangement = Arrangement.SpaceBetween) {
      LazyColumn(
        modifier = Modifier.weight(1f),
        contentPadding = PaddingValues(bottom = 14.dp),
        verticalArrangement = Arrangement.spacedBy(6.dp),
      ) {
        item {
          PermissionTopBar(onBack = onBack)
        }
        item {
          Text(
            text = "Only enable access you are comfortable letting OpenClaw use while this phone is connected. You can change these later in Android Settings.",
            style = ClawTheme.type.body,
            color = ClawTheme.colors.textMuted,
            textAlign = TextAlign.Center,
            modifier = Modifier.fillMaxWidth().padding(top = 4.dp, bottom = 12.dp),
          )
        }
        items(permissionState.rows, key = { it.title }) { row ->
          PermissionRow(row = row)
        }
      }
      OnboardingActions {
        ClawPrimaryButton(text = "Continue", onClick = onContinue, modifier = Modifier.onboardingActionButton())
      }
    }
  }
}

@Composable
private fun OnboardingHeader(
  title: String,
  modifier: Modifier = Modifier,
  subtitle: String? = null,
  onBack: (() -> Unit)? = null,
  action: (@Composable () -> Unit)? = null,
) {
  Surface(modifier = modifier.fillMaxWidth(), color = ClawTheme.colors.canvas, contentColor = ClawTheme.colors.text) {
    Box(modifier = Modifier.fillMaxWidth().height(ClawTheme.spacing.touchTarget), contentAlignment = Alignment.Center) {
      onBack?.let {
        Surface(
          onClick = it,
          modifier =
            Modifier
              .align(Alignment.CenterStart)
              .size(ClawTheme.spacing.touchTarget),
          color = Color.Transparent,
          contentColor = ClawTheme.colors.text,
        ) {
          Box(contentAlignment = Alignment.CenterStart) {
            Icon(imageVector = Icons.AutoMirrored.Filled.ArrowBack, contentDescription = "Back", modifier = Modifier.size(23.dp))
          }
        }
      }
      Column(
        modifier = Modifier.fillMaxWidth().padding(horizontal = 56.dp),
        horizontalAlignment = Alignment.CenterHorizontally,
        verticalArrangement = Arrangement.spacedBy(4.dp),
      ) {
        if (title.isNotBlank()) {
          Text(text = title, style = ClawTheme.type.title, color = ClawTheme.colors.text, textAlign = TextAlign.Center)
        }
        subtitle?.let {
          Text(text = it, style = ClawTheme.type.body, color = ClawTheme.colors.textMuted, textAlign = TextAlign.Center)
        }
      }
      action?.let {
        Box(modifier = Modifier.align(Alignment.CenterEnd), contentAlignment = Alignment.Center) {
          it()
        }
      }
    }
  }
}

@Composable
private fun TogglePill(
  text: String,
  selected: Boolean,
  enabled: Boolean = true,
  onClick: () -> Unit,
) {
  Surface(
    onClick = onClick,
    enabled = enabled,
    modifier = Modifier.height(34.dp),
    shape = RoundedCornerShape(ClawTheme.radii.pill),
    color = if (selected) ClawTheme.colors.primary else ClawTheme.colors.surfaceRaised,
    contentColor = if (selected) ClawTheme.colors.primaryText else ClawTheme.colors.textMuted,
    border = BorderStroke(1.dp, if (selected) ClawTheme.colors.primary else ClawTheme.colors.border),
  ) {
    Box(modifier = Modifier.fillMaxHeight().padding(horizontal = 12.dp), contentAlignment = Alignment.Center) {
      Text(text = text, style = ClawTheme.type.label)
    }
  }
}

@Composable
private fun PermissionTopBar(onBack: () -> Unit) {
  OnboardingHeader(title = "Permissions", onBack = onBack)
}

@Composable
private fun PermissionRow(row: PermissionRowModel) {
  Surface(
    onClick = row.onClick,
    modifier = Modifier.fillMaxWidth().heightIn(min = 44.dp),
    shape = RoundedCornerShape(ClawTheme.radii.control),
    color = ClawTheme.colors.surfaceRaised,
    contentColor = ClawTheme.colors.text,
    border = BorderStroke(1.dp, ClawTheme.colors.borderStrong),
  ) {
    Row(
      modifier = Modifier.fillMaxWidth().padding(horizontal = 10.dp, vertical = 7.dp),
      verticalAlignment = Alignment.CenterVertically,
      horizontalArrangement = Arrangement.spacedBy(10.dp),
    ) {
      Surface(
        modifier = Modifier.size(30.dp),
        shape = CircleShape,
        color = ClawTheme.colors.surfacePressed,
        border = BorderStroke(1.dp, ClawTheme.colors.border),
      ) {
        Box(contentAlignment = Alignment.Center) {
          Icon(imageVector = row.icon, contentDescription = null, modifier = Modifier.size(17.dp), tint = ClawTheme.colors.text)
        }
      }
      Column(modifier = Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(2.dp)) {
        Text(
          text = row.title,
          style = ClawTheme.type.title.copy(fontSize = 18.sp, lineHeight = 23.sp),
          color = ClawTheme.colors.text,
        )
        Text(
          text = row.subtitle,
          style = ClawTheme.type.body,
          color = ClawTheme.colors.textMuted,
        )
      }
      Icon(
        imageVector = if (row.granted) Icons.Default.CheckCircle else Icons.Default.Close,
        contentDescription = row.statusText,
        modifier = Modifier.size(20.dp),
        tint = if (row.granted) ClawTheme.colors.success else ClawTheme.colors.danger,
      )
      Icon(
        imageVector = Icons.AutoMirrored.Filled.KeyboardArrowRight,
        contentDescription = null,
        modifier = Modifier.size(17.dp),
        tint = ClawTheme.colors.text,
      )
    }
  }
}

internal enum class GatewayRecoveryUiState(
  val title: String,
  val message: String,
) {
  Connected(
    title = "Connected",
    message = "Your Gateway is ready.",
  ),
  ApprovalRequired(
    title = "Pairing Gateway",
    message = "Approve this phone on the gateway.\nThen retry the connection.",
  ),
  NodeCapabilityApprovalPending(
    title = "Node Approval Pending",
    message = "Gateway pairing worked.\nApprove this phone's node capabilities from an operator UI.",
  ),
  Pairing(
    title = "Pairing Gateway",
    message = "Approval is in progress.\nOpenClaw will reconnect automatically.",
  ),
  Finishing(
    title = "Connecting Gateway",
    message = "OpenClaw is checking gateway and node access.",
  ),
  TakingLonger(
    title = "Still connecting",
    message = "This is taking longer than expected.\nCheck that the Gateway is running and reachable.",
  ),
  Failed(
    title = "Connection issue",
    message = "We could not reach your Gateway.\nLet's fix this.",
  ),
}

internal enum class GatewayRecoveryPrimaryAction(
  val text: String,
  val icon: ImageVector? = null,
) {
  Finish(text = "Continue"),
  Retry(text = "Retry connection", icon = Icons.Default.WifiTethering),
  Back(text = "Go back", icon = Icons.AutoMirrored.Filled.ArrowBack),
}

internal enum class GatewayRecoveryProgressStatus {
  Complete,
  Current,
  Pending,
}

internal data class GatewayRecoveryProgressItem(
  val label: String,
  val status: GatewayRecoveryProgressStatus,
)

internal fun gatewayRecoveryPrimaryAction(state: GatewayRecoveryUiState): GatewayRecoveryPrimaryAction? =
  when (state) {
    GatewayRecoveryUiState.Connected -> GatewayRecoveryPrimaryAction.Finish
    GatewayRecoveryUiState.Failed -> GatewayRecoveryPrimaryAction.Back
    GatewayRecoveryUiState.ApprovalRequired -> GatewayRecoveryPrimaryAction.Retry
    GatewayRecoveryUiState.NodeCapabilityApprovalPending,
    GatewayRecoveryUiState.Pairing,
    GatewayRecoveryUiState.Finishing,
    -> null
    GatewayRecoveryUiState.TakingLonger -> GatewayRecoveryPrimaryAction.Retry
  }

internal fun gatewayRecoveryShowsDiagnosticAction(
  state: GatewayRecoveryUiState,
  gatewayConnectionProblem: GatewayConnectionProblem?,
): Boolean =
  state == GatewayRecoveryUiState.Failed ||
    state == GatewayRecoveryUiState.TakingLonger ||
    gatewayConnectionProblem != null

internal fun gatewayRecoveryDiagnosticText(
  statusText: String,
  gatewayName: String,
  gatewayPaired: Boolean,
  gatewayPairingCanContinue: Boolean,
  gatewayConnectionProblem: GatewayConnectionProblem?,
): String =
  listOf(
    "OpenClaw Android gateway diagnostic",
    "Gateway: $gatewayName",
    "Status: ${gatewayStatusForDisplay(statusText)}",
    "Gateway paired: $gatewayPaired",
    "Ready to continue: $gatewayPairingCanContinue",
    "Error code: ${gatewayConnectionProblem?.code ?: "n/a"}",
    "Reason: ${gatewayConnectionProblem?.reason ?: "n/a"}",
    "Request ID: ${gatewayConnectionProblem?.requestId ?: "n/a"}",
    "Next step: ${gatewayConnectionProblem?.recommendedNextStep ?: "n/a"}",
    "Retryable: ${gatewayConnectionProblem?.retryable ?: false}",
  ).joinToString("\n")

internal fun gatewayPairingUiState(
  gatewayPaired: Boolean,
  gatewayPairingCanContinue: Boolean,
  statusText: String,
  connectSettling: Boolean,
  connectTimedOut: Boolean = false,
  gatewayConnectionProblem: GatewayConnectionProblem? = null,
): GatewayRecoveryUiState =
  when {
    gatewayPairingCanContinue -> GatewayRecoveryUiState.Connected
    gatewayConnectionProblem?.isPairingRequired == true &&
      !gatewayConnectionProblem.canAutoRetry -> GatewayRecoveryUiState.ApprovalRequired
    gatewayConnectionProblem?.isPairingRequired == true -> GatewayRecoveryUiState.Pairing
    gatewayConnectionProblem?.pauseReconnect == true -> GatewayRecoveryUiState.Failed
    gatewayStatusLooksLikePairing(statusText) -> GatewayRecoveryUiState.Pairing
    gatewayStatusLooksLikeFailure(statusText) -> GatewayRecoveryUiState.Failed
    gatewayPaired -> if (connectTimedOut) GatewayRecoveryUiState.TakingLonger else GatewayRecoveryUiState.Finishing
    connectSettling -> GatewayRecoveryUiState.Finishing
    connectTimedOut -> GatewayRecoveryUiState.TakingLonger
    else -> GatewayRecoveryUiState.Finishing
  }

internal fun gatewayRecoveryProgressItems(
  state: GatewayRecoveryUiState,
  statusText: String = "",
  connectSettling: Boolean = false,
): List<GatewayRecoveryProgressItem> =
  when (state) {
    GatewayRecoveryUiState.Finishing ->
      finishingGatewayProgressItems(
        statusText = statusText,
        connectSettling = connectSettling,
      )
    GatewayRecoveryUiState.TakingLonger ->
      finishingGatewayProgressItems(
        statusText = statusText,
        connectSettling = connectSettling,
      )
    GatewayRecoveryUiState.Pairing ->
      listOf(
        GatewayRecoveryProgressItem("Gateway received this phone", GatewayRecoveryProgressStatus.Complete),
        GatewayRecoveryProgressItem("Waiting for device approval", GatewayRecoveryProgressStatus.Current),
        GatewayRecoveryProgressItem("Retrying automatically", GatewayRecoveryProgressStatus.Pending),
      )
    GatewayRecoveryUiState.ApprovalRequired ->
      listOf(
        GatewayRecoveryProgressItem("Gateway needs device approval", GatewayRecoveryProgressStatus.Current),
        GatewayRecoveryProgressItem("Run the approval command on the Gateway", GatewayRecoveryProgressStatus.Pending),
      )
    GatewayRecoveryUiState.NodeCapabilityApprovalPending -> emptyList()
    GatewayRecoveryUiState.Connected,
    GatewayRecoveryUiState.Failed,
    -> emptyList()
  }

private fun finishingGatewayProgressItems(
  statusText: String,
  connectSettling: Boolean,
): List<GatewayRecoveryProgressItem> {
  val gatewayAccessComplete = gatewayStatusLooksLikePartialConnect(statusText)
  val nodeAccessCurrent = gatewayAccessComplete
  return listOf(
    GatewayRecoveryProgressItem(
      label = "Opening Gateway connection",
      status =
        if (gatewayAccessComplete) {
          GatewayRecoveryProgressStatus.Complete
        } else {
          GatewayRecoveryProgressStatus.Current
        },
    ),
    GatewayRecoveryProgressItem(
      label = "Checking pairing access",
      status =
        when {
          gatewayAccessComplete -> GatewayRecoveryProgressStatus.Complete
          else -> GatewayRecoveryProgressStatus.Pending
        },
    ),
    GatewayRecoveryProgressItem(
      label = "Checking node access",
      status =
        when {
          nodeAccessCurrent -> GatewayRecoveryProgressStatus.Current
          else -> GatewayRecoveryProgressStatus.Pending
        },
    ),
  )
}

/** Detects gateway-approved states where the Android node is still coming online. */
internal fun gatewayStatusLooksLikePartialConnect(statusText: String): Boolean {
  val lower = gatewayStatusForDisplay(statusText).lowercase()
  return lower.contains("operator offline") || lower.contains("node offline")
}

/** Detects explicit endpoint/auth failures surfaced as status text without structured details. */
internal fun gatewayStatusLooksLikeFailure(statusText: String): Boolean {
  val lower = gatewayStatusForDisplay(statusText).lowercase()
  return lower.startsWith("failed:") || lower.startsWith("error:") || lower.startsWith("gateway error:")
}

internal fun recoveryGatewayName(
  serverName: String?,
  attemptedGatewayName: String?,
): String =
  serverName
    ?.trim()
    ?.takeIf { it.isNotEmpty() }
    ?: attemptedGatewayName
      ?.trim()
      ?.takeIf { it.isNotEmpty() }
    ?: "Home Gateway"

/** Resolves onboarding setup-code or manual fields into the gateway plan used for connect. */
internal fun resolveOnboardingGatewayConnectPlan(
  setupCode: String,
  savedManualHost: String,
  savedManualPort: String,
  savedManualTls: Boolean,
  manualHost: String,
  manualPort: String,
  manualTls: Boolean,
  token: String,
  password: String,
): GatewayConnectPlan? =
  resolveGatewayConnectPlan(
    useSetupCode = setupCode.isNotBlank(),
    setupCode = setupCode,
    savedManualHost = savedManualHost,
    savedManualPort = savedManualPort,
    savedManualTls = savedManualTls,
    manualHostInput = manualHost,
    manualPortInput = manualPort,
    manualTlsInput = manualTls,
    bootstrapTokenInput = "",
    tokenInput = token,
    passwordInput = password,
  )

/** Selects the recovery detail line from endpoint metadata and transient gateway status. */
internal fun recoveryGatewayDetail(
  ready: Boolean,
  remoteAddress: String?,
  statusText: String,
  nodeCapabilityApproval: GatewayNodeCapabilityApproval,
  gatewayConnectionProblem: GatewayConnectionProblem?,
): String =
  if (ready) {
    remoteAddress?.takeIf { it.isNotBlank() } ?: "Ready for chat and voice"
  } else if (nodeCapabilityApprovalNeedsUserAction(nodeCapabilityApproval)) {
    "Gateway paired. Waiting for node capability approval."
  } else if (gatewayConnectionProblem?.isPairingRequired == true && !gatewayConnectionProblem.canAutoRetry) {
    recoveryGatewayApprovalCommand(gatewayConnectionProblem)
      ?.let { "Gateway approval is pending. Run this on the gateway host:" }
      ?: "Gateway approval is pending. Run openclaw devices list on the gateway host, approve this phone, then retry."
  } else if (gatewayConnectionProblem?.isPairingRequired == true && gatewayConnectionProblem.canAutoRetry) {
    "Gateway approval is in progress. OpenClaw will retry automatically."
  } else if (gatewayConnectionProblem != null) {
    recoveryGatewayAuthDetail(gatewayConnectionProblem)
  } else if (nodeCapabilityApproval == GatewayNodeCapabilityApproval.Loading) {
    "Gateway paired. Checking node capability approval."
  } else if (statusText.contains("operator offline", ignoreCase = true)) {
    "Gateway paired. Waiting for operator access."
  } else if (gatewayStatusLooksLikePairing(statusText)) {
    "Gateway approval is in progress. OpenClaw will retry automatically."
  } else {
    remoteAddress?.takeIf { it.isNotBlank() } ?: "Gateway unreachable"
  }

internal fun recoveryGatewayAuthDetail(gatewayConnectionProblem: GatewayConnectionProblem): String =
  when (gatewayConnectionProblem.code) {
    "PROTOCOL_MISMATCH" -> recoveryGatewayProtocolMismatchDetail(gatewayConnectionProblem)
    "AUTH_BOOTSTRAP_TOKEN_INVALID" -> "The code may have expired or been generated for another Gateway."
    "AUTH_DEVICE_TOKEN_MISMATCH",
    "AUTH_TOKEN_MISMATCH",
    -> "Saved authentication is invalid. Re-authenticate or reset this gateway connection."
    "AUTH_PASSWORD_MISSING" -> "Gateway password is required. Enter it again or edit this connection."
    "AUTH_PASSWORD_MISMATCH" -> "Gateway password is invalid. Re-enter it or reset this gateway connection."
    "AUTH_TOKEN_MISSING" -> "Gateway token is required. Enter it again or edit this connection."
    "CONTROL_UI_DEVICE_IDENTITY_REQUIRED",
    "DEVICE_IDENTITY_REQUIRED",
    -> "Gateway requires this device identity. Re-authenticate or reset this gateway connection."
    else ->
      when (gatewayConnectionProblem.recommendedNextStep) {
        "update_auth_credentials" -> "Saved authentication is invalid. Re-authenticate or reset this gateway connection."
        "update_auth_configuration" -> "Gateway authentication is not configured. Edit this connection and try again."
        "review_auth_configuration" -> "Gateway authentication needs review. Check gateway settings, then retry."
        else -> gatewayConnectionProblem.message.takeIf { it.isNotBlank() } ?: "Gateway authentication needs attention."
      }
  }

private fun recoveryGatewayProtocolMismatchDetail(gatewayConnectionProblem: GatewayConnectionProblem): String {
  val clientMin = gatewayConnectionProblem.clientMinProtocol
  val clientMax = gatewayConnectionProblem.clientMaxProtocol
  val expected = gatewayConnectionProblem.expectedProtocol
  val summary =
    when {
      clientMax != null && expected != null && clientMax < expected ->
        "This app is older than the Gateway. Update OpenClaw on this device, then retry."
      clientMin != null && expected != null && clientMin > expected ->
        "The Gateway is older than this app. Update OpenClaw on the Gateway host, then retry."
      else -> "The app and Gateway use incompatible protocol versions. Update OpenClaw on both, then retry."
    }
  return protocolMismatchVersions(clientMin, clientMax, expected)?.let { "$summary $it" } ?: summary
}

internal fun recoveryGatewayProtocolMismatchCommand(
  gatewayConnectionProblem: GatewayConnectionProblem?,
): String? {
  if (gatewayConnectionProblem?.code != "PROTOCOL_MISMATCH") return null
  val clientMin = gatewayConnectionProblem.clientMinProtocol ?: return null
  val expected = gatewayConnectionProblem.expectedProtocol ?: return null
  return "openclaw update".takeIf { clientMin > expected }
}

private fun protocolMismatchVersions(
  clientMin: Int?,
  clientMax: Int?,
  expected: Int?,
): String? {
  val clientRange =
    when {
      clientMin == null && clientMax == null -> null
      clientMin != null && clientMin == clientMax -> "app protocol v$clientMin"
      clientMin != null && clientMax != null -> "app protocols v$clientMin-v$clientMax"
      clientMin != null -> "app protocol min v$clientMin"
      else -> "app protocol max v$clientMax"
    }
  val gatewayVersion = expected?.let { "gateway protocol v$it" }
  return listOfNotNull(clientRange, gatewayVersion)
    .takeIf { it.isNotEmpty() }
    ?.joinToString(prefix = "(", postfix = ").")
}

private fun recoveryGatewayApprovalCommand(gatewayConnectionProblem: GatewayConnectionProblem?): String? {
  if (gatewayConnectionProblem?.isPairingRequired != true || gatewayConnectionProblem.canAutoRetry) return null
  val requestId = gatewayConnectionProblem.requestId?.trim()?.takeIf { it.isNotEmpty() }
  return if (requestId != null) {
    "openclaw devices approve $requestId"
  } else {
    "openclaw devices list"
  }
}

internal fun recoveryNodeApprovalCommand(pendingRequestId: String?): String {
  val requestId = pendingRequestId?.trim()?.takeIf { it.isNotEmpty() }
  return if (requestId != null) {
    "openclaw nodes approve $requestId"
  } else {
    "openclaw nodes approve REQUEST_ID"
  }
}

private fun approvalRequestId(approval: GatewayNodeCapabilityApproval): String? =
  when (approval) {
    is GatewayNodeCapabilityApproval.PendingApproval -> approval.requestId
    is GatewayNodeCapabilityApproval.PendingReapproval -> approval.requestId
    else -> null
  }

internal fun nodeCapabilityApprovalNeedsUserAction(approval: GatewayNodeCapabilityApproval): Boolean =
  approval is GatewayNodeCapabilityApproval.PendingApproval ||
    approval is GatewayNodeCapabilityApproval.PendingReapproval ||
    approval == GatewayNodeCapabilityApproval.Unapproved

internal fun gatewayPairingContinueDestination(
  ready: Boolean,
  nodeCapabilityApproval: GatewayNodeCapabilityApproval,
): OnboardingStep? =
  when {
    ready -> OnboardingStep.Permissions
    nodeCapabilityApprovalNeedsUserAction(nodeCapabilityApproval) -> OnboardingStep.NodeApproval
    else -> null
  }

internal fun nodeApprovalCheckingInProgress(
  checkRequested: Boolean,
  refreshStarted: Boolean,
  nodesDevicesRefreshing: Boolean,
): Boolean = checkRequested && (!refreshStarted || nodesDevicesRefreshing)

internal fun nodeApprovalCheckShouldClearUnobservedRefresh(
  step: OnboardingStep,
  checkRequested: Boolean,
  refreshStarted: Boolean,
  nodesDevicesRefreshing: Boolean,
): Boolean =
  step == OnboardingStep.NodeApproval &&
    checkRequested &&
    !refreshStarted &&
    !nodesDevicesRefreshing

internal fun nodeApprovalCheckCanContinue(
  checkRequested: Boolean,
  refreshStarted: Boolean,
  nodesDevicesRefreshing: Boolean,
  ready: Boolean,
): Boolean =
  checkRequested &&
    refreshStarted &&
    !nodesDevicesRefreshing &&
    ready

internal fun nodeApprovalShouldAutoContinue(
  step: OnboardingStep,
  ready: Boolean,
  nodeCapabilityApproval: GatewayNodeCapabilityApproval,
  autoContinueEnabled: Boolean,
): Boolean =
  step == OnboardingStep.NodeApproval &&
    autoContinueEnabled &&
    ready &&
    !nodeCapabilityApprovalNeedsUserAction(nodeCapabilityApproval)

internal fun permissionContinueNeedsNodeApproval(
  ready: Boolean,
  requiresNodeApprovalAfterApply: Boolean,
  nodeCapabilityApproval: GatewayNodeCapabilityApproval,
): Boolean =
  (
    requiresNodeApprovalAfterApply &&
      nodeCapabilityApproval != GatewayNodeCapabilityApproval.Unsupported
  ) ||
    (
      !ready &&
        nodeCapabilityApprovalNeedsUserAction(nodeCapabilityApproval)
    )

private fun copyApprovalCommand(
  context: Context,
  command: String,
) {
  val clipboard = context.getSystemService(Context.CLIPBOARD_SERVICE) as ClipboardManager
  clipboard.setPrimaryClip(ClipData.newPlainText("OpenClaw pairing approval command", command))
  Toast.makeText(context, "Approval command copied", Toast.LENGTH_SHORT).show()
}

private fun copyGatewayCommand(
  context: Context,
  command: String,
) {
  val clipboard = context.getSystemService(Context.CLIPBOARD_SERVICE) as ClipboardManager
  clipboard.setPrimaryClip(ClipData.newPlainText("OpenClaw gateway command", command))
  Toast.makeText(context, "Command copied", Toast.LENGTH_SHORT).show()
}

/** One permission row plus launcher callback for onboarding's final setup step. */
private data class PermissionRowModel(
  val title: String,
  val subtitle: String,
  val icon: ImageVector,
  val granted: Boolean,
  val statusText: String = permissionRowStatusText(granted),
  val onClick: () -> Unit,
)

/** Permission screen model plus a commit hook that persists granted feature toggles. */
private class PermissionState(
  val rows: List<PermissionRowModel>,
  val requiresNodeApprovalAfterApply: Boolean,
  val applyToViewModel: () -> Unit,
)

/** Onboarding finishes only after the gateway resolves node capability approval. */
internal fun canFinishOnboarding(
  isConnected: Boolean,
  isNodeConnected: Boolean,
  nodeCapabilityApproval: GatewayNodeCapabilityApproval,
): Boolean =
  isConnected &&
    isNodeConnected &&
    when (nodeCapabilityApproval) {
      is GatewayNodeCapabilityApproval.PendingApproval,
      is GatewayNodeCapabilityApproval.PendingReapproval,
      GatewayNodeCapabilityApproval.Unapproved,
      GatewayNodeCapabilityApproval.Loading,
      -> false
      GatewayNodeCapabilityApproval.Approved,
      GatewayNodeCapabilityApproval.Unsupported,
      -> true
    }

private val requiredContactPermissions = listOf(Manifest.permission.READ_CONTACTS, Manifest.permission.WRITE_CONTACTS)
private val requiredCalendarPermissions = listOf(Manifest.permission.READ_CALENDAR, Manifest.permission.WRITE_CALENDAR)

internal fun initialCameraCapabilityEnabled(
  savedCapabilityEnabled: Boolean,
  androidCameraPermissionGranted: Boolean,
): Boolean = savedCapabilityEnabled && androidCameraPermissionGranted

internal fun cameraPermissionRowStatusText(
  capabilityEnabled: Boolean,
  androidCameraPermissionGranted: Boolean,
): String =
  when {
    capabilityEnabled -> "Enabled"
    androidCameraPermissionGranted -> "Off"
    else -> "Not allowed"
  }

internal fun cameraCapabilityAfterRowTap(
  currentCapabilityEnabled: Boolean,
  androidCameraPermissionGranted: Boolean,
): Boolean? = if (androidCameraPermissionGranted) !currentCapabilityEnabled else null

private fun permissionRowStatusText(granted: Boolean): String = if (granted) "Granted" else "Not granted"

internal fun permissionChangesRequireNodeApproval(
  currentCameraEnabled: Boolean,
  requestedCameraEnabled: Boolean,
  currentLocationMode: LocationMode,
  requestedLocationMode: LocationMode,
  currentSmsGranted: Boolean,
  requestedSmsGranted: Boolean,
): Boolean =
  currentCameraEnabled != requestedCameraEnabled ||
    currentLocationMode != requestedLocationMode ||
    currentSmsGranted != requestedSmsGranted

/** Builds permission rows and applies granted feature toggles after onboarding. */
@Composable
private fun rememberPermissionState(
  context: Context,
  viewModel: MainViewModel,
): PermissionState {
  val currentCameraEnabled by viewModel.cameraEnabled.collectAsState()
  val currentLocationMode by viewModel.locationMode.collectAsState()
  var microphoneGranted by rememberSaveable { mutableStateOf(hasPermission(context, Manifest.permission.RECORD_AUDIO)) }
  val cameraPermissionGranted = hasPermission(context, Manifest.permission.CAMERA)
  var cameraGranted by rememberSaveable { mutableStateOf(initialCameraCapabilityEnabled(currentCameraEnabled, cameraPermissionGranted)) }
  var locationGranted by rememberSaveable {
    mutableStateOf(hasPermission(context, Manifest.permission.ACCESS_FINE_LOCATION) || hasPermission(context, Manifest.permission.ACCESS_COARSE_LOCATION))
  }
  val photosPermissions = photoReadPermissionsForRequest()
  var photosGranted by rememberSaveable { mutableStateOf(hasPhotoReadPermission(context)) }
  var contactsGranted by rememberSaveable {
    mutableStateOf(requiredContactPermissions.all { permission -> hasPermission(context, permission) })
  }
  var calendarGranted by rememberSaveable {
    mutableStateOf(requiredCalendarPermissions.all { permission -> hasPermission(context, permission) })
  }
  var notificationsGranted by rememberSaveable {
    mutableStateOf(Build.VERSION.SDK_INT < 33 || hasPermission(context, Manifest.permission.POST_NOTIFICATIONS))
  }
  var notificationListenerGranted by rememberSaveable { mutableStateOf(DeviceNotificationListenerService.isAccessEnabled(context)) }
  val photosAvailable = SensitiveFeatureConfig.photosEnabled
  val motionAvailable = remember(context) { hasMotionCapabilities(context) }
  val smsAvailable =
    remember(context) {
      SensitiveFeatureConfig.smsEnabled &&
        context.packageManager?.hasSystemFeature(PackageManager.FEATURE_TELEPHONY) == true
    }
  val currentSmsGranted =
    !smsAvailable ||
      (
        hasPermission(context, Manifest.permission.SEND_SMS) &&
          hasPermission(context, Manifest.permission.READ_SMS)
      )
  val callLogAvailable = SensitiveFeatureConfig.callLogEnabled
  var motionGranted by rememberSaveable { mutableStateOf(!motionAvailable || hasPermission(context, Manifest.permission.ACTIVITY_RECOGNITION)) }
  var smsGranted by rememberSaveable { mutableStateOf(currentSmsGranted) }
  var callLogGranted by rememberSaveable { mutableStateOf(!callLogAvailable || hasPermission(context, Manifest.permission.READ_CALL_LOG)) }
  val lifecycleOwner = LocalLifecycleOwner.current

  DisposableEffect(lifecycleOwner, context) {
    val observer =
      LifecycleEventObserver { _, event ->
        if (event == Lifecycle.Event.ON_RESUME) {
          notificationListenerGranted = DeviceNotificationListenerService.isAccessEnabled(context)
        }
      }
    lifecycleOwner.lifecycle.addObserver(observer)
    onDispose { lifecycleOwner.lifecycle.removeObserver(observer) }
  }

  val permissionLauncher =
    rememberLauncherForActivityResult(ActivityResultContracts.RequestMultiplePermissions()) { permissions ->
      microphoneGranted = permissions[Manifest.permission.RECORD_AUDIO] ?: microphoneGranted
      cameraGranted = permissions[Manifest.permission.CAMERA] ?: cameraGranted
      locationGranted =
        permissions[Manifest.permission.ACCESS_FINE_LOCATION] == true ||
        permissions[Manifest.permission.ACCESS_COARSE_LOCATION] == true ||
        locationGranted
      photosGranted = hasPhotoReadPermission(context) || photosPermissions.any { permissions[it] == true }
      contactsGranted =
        mergedRequiredPermissionGrantState(
          permissions = permissions,
          requiredPermissions = requiredContactPermissions,
          currentlyGranted = { permission -> hasPermission(context, permission) },
        )
      calendarGranted =
        mergedRequiredPermissionGrantState(
          permissions = permissions,
          requiredPermissions = requiredCalendarPermissions,
          currentlyGranted = { permission -> hasPermission(context, permission) },
        )
      notificationsGranted =
        if (Build.VERSION.SDK_INT >= 33) {
          permissions[Manifest.permission.POST_NOTIFICATIONS] ?: notificationsGranted
        } else {
          true
        }
      motionGranted = permissions[Manifest.permission.ACTIVITY_RECOGNITION] ?: motionGranted
      smsGranted =
        mergedRequiredPermissionGrantState(
          permissions = permissions,
          requiredPermissions = listOf(Manifest.permission.SEND_SMS, Manifest.permission.READ_SMS),
          currentlyGranted = { permission -> hasPermission(context, permission) },
        )
      callLogGranted = permissions[Manifest.permission.READ_CALL_LOG] ?: callLogGranted
    }

  fun request(vararg permissions: String) {
    permissionLauncher.launch(permissions.filterNot { hasPermission(context, it) }.toTypedArray())
  }

  fun requestCameraCapability() {
    val nextCapabilityEnabled =
      cameraCapabilityAfterRowTap(
        currentCapabilityEnabled = cameraGranted,
        androidCameraPermissionGranted = hasPermission(context, Manifest.permission.CAMERA),
      )
    if (nextCapabilityEnabled != null) {
      cameraGranted = nextCapabilityEnabled
    } else {
      request(Manifest.permission.CAMERA)
    }
  }

  val rows =
    listOfNotNull(
      PermissionRowModel("Voice", "Transcribe voice prompts", Icons.Default.Mic, microphoneGranted) {
        request(Manifest.permission.RECORD_AUDIO)
      },
      PermissionRowModel(
        "Camera",
        "Capture photos and clips from this phone",
        Icons.Default.CameraAlt,
        cameraGranted,
        cameraPermissionRowStatusText(
          capabilityEnabled = cameraGranted,
          androidCameraPermissionGranted = hasPermission(context, Manifest.permission.CAMERA),
        ),
        ::requestCameraCapability,
      ),
      PermissionRowModel("Location", "Read this phone's location", Icons.Default.LocationOn, locationGranted) {
        request(Manifest.permission.ACCESS_FINE_LOCATION, Manifest.permission.ACCESS_COARSE_LOCATION)
      },
      if (photosAvailable) {
        PermissionRowModel("Photos", "Read recent photos and media", Icons.Default.Image, photosGranted) {
          request(*photosPermissions.toTypedArray())
        }
      } else {
        null
      },
      PermissionRowModel("Contacts", "Find people and contact details", Icons.Default.Person, contactsGranted) {
        request(*requiredContactPermissions.toTypedArray())
      },
      PermissionRowModel("Calendar", "Read and update events", Icons.Default.CalendarMonth, calendarGranted) {
        request(*requiredCalendarPermissions.toTypedArray())
      },
      PermissionRowModel("Notifications", "Show OpenClaw alerts", Icons.Default.Notifications, notificationsGranted) {
        if (Build.VERSION.SDK_INT >= 33) request(Manifest.permission.POST_NOTIFICATIONS)
      },
      PermissionRowModel("Notification listener", "Read selected app notifications", Icons.Default.Sensors, notificationListenerGranted) {
        context.startActivity(Intent(Settings.ACTION_NOTIFICATION_LISTENER_SETTINGS).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
      },
      if (motionAvailable) {
        PermissionRowModel("Motion", "Share steps and activity", Icons.Default.Sensors, motionGranted) {
          request(Manifest.permission.ACTIVITY_RECOGNITION)
        }
      } else {
        null
      },
      if (smsAvailable) {
        PermissionRowModel("SMS", "Device access; Gateway opt-in still required", Icons.Default.Notifications, smsGranted) {
          request(Manifest.permission.SEND_SMS, Manifest.permission.READ_SMS)
        }
      } else {
        null
      },
      if (callLogAvailable) {
        PermissionRowModel("Call Log", "Show recent call history", Icons.Default.Person, callLogGranted) {
          request(Manifest.permission.READ_CALL_LOG)
        }
      } else {
        null
      },
    )

  return PermissionState(
    rows = rows,
    requiresNodeApprovalAfterApply =
      permissionChangesRequireNodeApproval(
        currentCameraEnabled = currentCameraEnabled,
        requestedCameraEnabled = cameraGranted,
        currentLocationMode = currentLocationMode,
        requestedLocationMode = if (locationGranted) LocationMode.WhileUsing else LocationMode.Off,
        currentSmsGranted = currentSmsGranted,
        requestedSmsGranted = smsGranted,
      ),
    applyToViewModel = {
      viewModel.setCameraEnabled(cameraGranted)
      viewModel.setLocationMode(if (locationGranted) LocationMode.WhileUsing else LocationMode.Off)
      viewModel.setNotificationForwardingEnabled(notificationListenerGranted)
    },
  )
}

/** RequestMultiplePermissions only reports launched permissions, so omitted entries use current system state. */
internal fun mergedRequiredPermissionGrantState(
  permissions: Map<String, Boolean>,
  requiredPermissions: List<String>,
  currentlyGranted: (String) -> Boolean,
): Boolean = requiredPermissions.all { permission -> permissions[permission] ?: currentlyGranted(permission) }

internal fun nearbyGatewayManualPort(endpoint: GatewayEndpoint): String = endpoint.port.toString()

internal fun nearbyGatewayManualTls(endpoint: GatewayEndpoint): Boolean =
  endpoint.tlsEnabled ||
    !endpoint.tlsFingerprintSha256.isNullOrBlank() ||
    !isLocalCleartextGatewayHost(endpoint.host)

private fun hasPermission(
  context: Context,
  permission: String,
): Boolean = ContextCompat.checkSelfPermission(context, permission) == PackageManager.PERMISSION_GRANTED

/** Returns true when Android exposes any motion sensor that can back node motion commands. */
private fun hasMotionCapabilities(context: Context): Boolean {
  val sensorManager = context.getSystemService(SensorManager::class.java) ?: return false
  return sensorManager.getDefaultSensor(Sensor.TYPE_ACCELEROMETER) != null ||
    sensorManager.getDefaultSensor(Sensor.TYPE_STEP_COUNTER) != null ||
    sensorManager.getDefaultSensor(Sensor.TYPE_STEP_DETECTOR) != null
}
