package ai.openclaw.app.ui

import ai.openclaw.app.GatewayConnectionProblem
import ai.openclaw.app.LocationMode
import ai.openclaw.app.MainViewModel
import ai.openclaw.app.R
import ai.openclaw.app.SensitiveFeatureConfig
import ai.openclaw.app.node.DeviceNotificationListenerService
import ai.openclaw.app.ui.design.ClawDesignTheme
import ai.openclaw.app.ui.design.ClawErrorState
import ai.openclaw.app.ui.design.ClawListItem
import ai.openclaw.app.ui.design.ClawPanel
import ai.openclaw.app.ui.design.ClawPrimaryButton
import ai.openclaw.app.ui.design.ClawScaffold
import ai.openclaw.app.ui.design.ClawStatus
import ai.openclaw.app.ui.design.ClawStatusPill
import ai.openclaw.app.ui.design.ClawTextField
import ai.openclaw.app.ui.design.ClawTheme
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
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.Canvas
import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.safeDrawing
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.windowInsetsPadding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.selection.SelectionContainer
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.automirrored.filled.KeyboardArrowRight
import androidx.compose.material.icons.filled.CalendarMonth
import androidx.compose.material.icons.filled.CameraAlt
import androidx.compose.material.icons.filled.CheckCircle
import androidx.compose.material.icons.filled.ContentCopy
import androidx.compose.material.icons.filled.Edit
import androidx.compose.material.icons.filled.ErrorOutline
import androidx.compose.material.icons.filled.Image
import androidx.compose.material.icons.filled.KeyboardArrowDown
import androidx.compose.material.icons.filled.KeyboardArrowUp
import androidx.compose.material.icons.filled.Link
import androidx.compose.material.icons.filled.LocationOn
import androidx.compose.material.icons.filled.Mic
import androidx.compose.material.icons.filled.Notifications
import androidx.compose.material.icons.filled.Person
import androidx.compose.material.icons.filled.QrCode2
import androidx.compose.material.icons.filled.Refresh
import androidx.compose.material.icons.filled.Security
import androidx.compose.material.icons.filled.Sensors
import androidx.compose.material.icons.filled.WifiTethering
import androidx.compose.material3.AlertDialog
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
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.core.content.ContextCompat
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.LifecycleEventObserver
import androidx.lifecycle.compose.LocalLifecycleOwner
import com.google.mlkit.vision.barcode.common.Barcode
import com.google.mlkit.vision.codescanner.GmsBarcodeScannerOptions
import com.google.mlkit.vision.codescanner.GmsBarcodeScanning
import kotlinx.coroutines.delay

private enum class OnboardingStep {
  Welcome,
  Gateway,
  Recovery,
  Permissions,
}

private const val GATEWAY_CONNECT_SETTLING_MS = 2_500L

/** First-run Android onboarding flow for gateway pairing and permission setup. */
@Composable
fun OnboardingFlow(
  viewModel: MainViewModel,
  modifier: Modifier = Modifier,
) {
  ClawDesignTheme {
    val context = LocalContext.current
    val statusText by viewModel.statusText.collectAsState()
    val gatewayConnectionProblem by viewModel.gatewayConnectionProblem.collectAsState()
    val isConnected by viewModel.isConnected.collectAsState()
    val isNodeConnected by viewModel.isNodeConnected.collectAsState()
    val runtimeInitialized by viewModel.runtimeInitialized.collectAsState()
    val serverName by viewModel.serverName.collectAsState()
    val remoteAddress by viewModel.remoteAddress.collectAsState()
    val gateways by viewModel.gateways.collectAsState()
    val discoveryStatusText by viewModel.discoveryStatusText.collectAsState()
    val savedToken by viewModel.gatewayToken.collectAsState()
    val pendingTrust by viewModel.pendingGatewayTrust.collectAsState()
    val startAtGatewaySetup by viewModel.startOnboardingAtGatewaySetup.collectAsState()
    val ready = canFinishOnboarding(isConnected = isConnected, isNodeConnected = isNodeConnected)

    var step by rememberSaveable { mutableStateOf(OnboardingStep.Welcome) }
    var setupCode by rememberSaveable { mutableStateOf("") }
    var manualHost by rememberSaveable { mutableStateOf("127.0.0.1") }
    var manualPort by rememberSaveable { mutableStateOf("18789") }
    var manualTls by rememberSaveable { mutableStateOf(false) }
    var token by rememberSaveable { mutableStateOf(savedToken) }
    var password by rememberSaveable { mutableStateOf("") }
    var setupError by rememberSaveable { mutableStateOf<String?>(null) }
    var attemptedConnect by rememberSaveable { mutableStateOf(false) }
    var attemptedGatewayName by rememberSaveable { mutableStateOf<String?>(null) }
    var connectAttemptStartedAtMs by rememberSaveable { mutableLongStateOf(0L) }
    var recoveryNowMs by remember { mutableLongStateOf(SystemClock.elapsedRealtime()) }

    val qrScannerOptions =
      remember {
        GmsBarcodeScannerOptions
          .Builder()
          .setBarcodeFormats(Barcode.FORMAT_QR_CODE)
          .build()
      }
    val qrScanner = remember(context, qrScannerOptions) { GmsBarcodeScanning.getClient(context, qrScannerOptions) }

    val permissionState = rememberPermissionState(context = context, viewModel = viewModel)

    LaunchedEffect(startAtGatewaySetup) {
      if (startAtGatewaySetup) {
        step = OnboardingStep.Gateway
        viewModel.clearGatewaySetupStartRequest()
      }
    }

    LaunchedEffect(step) {
      if (step == OnboardingStep.Gateway) {
        viewModel.startGatewayDiscovery()
      }
    }

    LaunchedEffect(ready, attemptedConnect) {
      if (attemptedConnect && ready) {
        step = OnboardingStep.Permissions
      }
    }

    LaunchedEffect(step, connectAttemptStartedAtMs) {
      if (step != OnboardingStep.Recovery || connectAttemptStartedAtMs <= 0L) return@LaunchedEffect
      recoveryNowMs = SystemClock.elapsedRealtime()
      delay(GATEWAY_CONNECT_SETTLING_MS)
      recoveryNowMs = SystemClock.elapsedRealtime()
    }

    pendingTrust?.let { prompt ->
      AlertDialog(
        onDismissRequest = viewModel::declineGatewayTrustPrompt,
        containerColor = ClawTheme.colors.surfaceRaised,
        title = { Text("Trust this gateway?", style = ClawTheme.type.section, color = ClawTheme.colors.text) },
        text = {
          Text(
            "Verify the certificate fingerprint before continuing.\n\n${prompt.fingerprintSha256}",
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
          setupCode = setupCode,
          manualHost = manualHost,
          manualPort = manualPort,
          manualTls = manualTls,
          token = token,
          password = password,
          nearbyGatewayName = gateways.firstOrNull()?.name,
          discoveryStatusText = discoveryStatusText,
          discoveryStarted = runtimeInitialized,
          error = setupError,
          onBack = { step = OnboardingStep.Welcome },
          onScan = {
            setupError = null
            qrScanner
              .startScan()
              .addOnSuccessListener { barcode ->
                val scanned = resolveScannedSetupCodeResult(barcode.rawValue.orEmpty())
                if (scanned.setupCode == null) {
                  setupError =
                    gatewayEndpointValidationMessage(
                      scanned.error ?: GatewayEndpointValidationError.INVALID_URL,
                      GatewayEndpointInputSource.QR_SCAN,
                    )
                  return@addOnSuccessListener
                }
                setupCode = scanned.setupCode
              }.addOnFailureListener { setupError = "Could not open the scanner." }
          },
          onSetupCodeChange = {
            setupCode = it
            setupError = null
          },
          onManualHostChange = {
            manualHost = it
            setupError = null
          },
          onManualPortChange = {
            manualPort = it
            setupError = null
          },
          onManualTlsChange = { manualTls = it },
          onTokenChange = { token = it },
          onPasswordChange = { password = it },
          onUseNearby = {
            val endpoint = gateways.firstOrNull() ?: return@GatewaySetupScreen
            attemptedGatewayName = endpoint.name
            attemptedConnect = true
            connectAttemptStartedAtMs = SystemClock.elapsedRealtime()
            viewModel.connectInBackground(endpoint)
            step = OnboardingStep.Recovery
          },
          onPair = {
            val config =
              resolveGatewayConfig(
                setupCode = setupCode,
                manualHost = manualHost,
                manualPort = manualPort,
                manualTls = manualTls,
                token = token,
                password = password,
              )
            if (config == null) {
              setupError = "Enter a setup code or a valid gateway URL."
              return@GatewaySetupScreen
            }

            setupError = null
            attemptedGatewayName = null
            attemptedConnect = true
            connectAttemptStartedAtMs = SystemClock.elapsedRealtime()
            viewModel.saveGatewayConfigAndConnect(
              host = config.host,
              port = config.port,
              tls = config.tls,
              token = config.token,
              bootstrapToken = config.bootstrapToken,
              password = config.password,
              resetSetupAuth = true,
            )
            step = OnboardingStep.Recovery
          },
        )
      OnboardingStep.Recovery ->
        GatewayRecoveryScreen(
          modifier = modifier,
          statusText = statusText,
          serverName = serverName,
          attemptedGatewayName = attemptedGatewayName,
          remoteAddress = remoteAddress,
          ready = ready,
          gatewayConnectionProblem = gatewayConnectionProblem,
          connectSettling = recoveryNowMs - connectAttemptStartedAtMs < GATEWAY_CONNECT_SETTLING_MS,
          onBack = { step = OnboardingStep.Gateway },
          onRetry = {
            attemptedConnect = true
            connectAttemptStartedAtMs = SystemClock.elapsedRealtime()
            val config =
              resolveGatewayConfig(
                setupCode = setupCode,
                manualHost = manualHost,
                manualPort = manualPort,
                manualTls = manualTls,
                token = token,
                password = password,
              ) ?: return@GatewayRecoveryScreen
            viewModel.saveGatewayConfigAndConnect(
              host = config.host,
              port = config.port,
              tls = config.tls,
              token = config.token,
              bootstrapToken = config.bootstrapToken,
              password = config.password,
              resetSetupAuth = false,
            )
          },
          onEdit = { step = OnboardingStep.Gateway },
          onContinue = { step = OnboardingStep.Permissions },
        )
      OnboardingStep.Permissions ->
        PermissionSetupScreen(
          modifier = modifier,
          permissionState = permissionState,
          onBack = { step = OnboardingStep.Gateway },
          onContinue = {
            permissionState.applyToViewModel()
            viewModel.setOnboardingCompleted(true)
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
  val welcomeBackground =
    Brush.verticalGradient(
      colors =
        listOf(
          Color(0xFFFF4D4D),
          Color(0xFFD73332),
          Color(0xFF991B1B),
          Color(0xFF260707),
        ),
    )

  Box(
    modifier =
      modifier
        .fillMaxSize()
        .background(welcomeBackground)
        .windowInsetsPadding(WindowInsets.safeDrawing)
        .padding(horizontal = 24.dp, vertical = 18.dp),
  ) {
    Column(
      modifier = Modifier.fillMaxSize(),
      horizontalAlignment = Alignment.CenterHorizontally,
    ) {
      Spacer(modifier = Modifier.height(96.dp))
      Column(horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.spacedBy(18.dp)) {
        WelcomeLogo()
        Text(
          text = "OPENCLAW",
          style = ClawTheme.type.display.copy(fontSize = 34.sp, lineHeight = 38.sp, fontWeight = FontWeight.Black),
          color = ClawTheme.colors.text,
        )
        Text(
          text = "Your personal AI assistant.\nExfoliate! Exfoliate!",
          style = ClawTheme.type.section,
          color = ClawTheme.colors.text,
          textAlign = TextAlign.Center,
        )
      }
      Spacer(modifier = Modifier.weight(1f))
      WelcomeHorizon()
      Spacer(modifier = Modifier.height(30.dp))
      Column(modifier = Modifier.fillMaxWidth(), verticalArrangement = Arrangement.spacedBy(10.dp)) {
        HeroPrimaryAction(title = "Connect Gateway", onClick = onConnect)
      }
      Spacer(modifier = Modifier.height(104.dp))
    }
  }
}

@Composable
private fun WelcomeLogo() {
  Surface(
    modifier = Modifier.size(82.dp),
    shape = CircleShape,
    color = Color.White.copy(alpha = 0.92f),
    contentColor = Color.Unspecified,
  ) {
    Box(modifier = Modifier.fillMaxSize().padding(12.dp), contentAlignment = Alignment.Center) {
      Image(painter = painterResource(id = R.drawable.openclaw_logo), contentDescription = "OpenClaw logo", modifier = Modifier.fillMaxSize())
    }
  }
}

@Composable
private fun WelcomeHorizon() {
  Canvas(modifier = Modifier.fillMaxWidth().height(120.dp)) {
    val arcWidth = size.width * 1.24f
    val arcHeight = size.height * 1.18f
    val left = (size.width - arcWidth) / 2f
    val top = size.height * 0.28f
    drawArc(
      color = Color.White.copy(alpha = 0.7f),
      startAngle = 202f,
      sweepAngle = 136f,
      useCenter = false,
      topLeft =
        androidx.compose.ui.geometry
          .Offset(left, top),
      size =
        androidx.compose.ui.geometry
          .Size(arcWidth, arcHeight),
      style = Stroke(width = 2.2f),
    )
    drawArc(
      color = Color.White.copy(alpha = 0.16f),
      startAngle = 200f,
      sweepAngle = 140f,
      useCenter = false,
      topLeft =
        androidx.compose.ui.geometry
          .Offset(left, top + 8f),
      size =
        androidx.compose.ui.geometry
          .Size(arcWidth, arcHeight),
      style = Stroke(width = 10f),
    )
  }
}

@Composable
private fun GatewaySetupScreen(
  setupCode: String,
  manualHost: String,
  manualPort: String,
  manualTls: Boolean,
  token: String,
  password: String,
  nearbyGatewayName: String?,
  discoveryStatusText: String,
  discoveryStarted: Boolean,
  error: String?,
  onBack: () -> Unit,
  onScan: () -> Unit,
  onSetupCodeChange: (String) -> Unit,
  onManualHostChange: (String) -> Unit,
  onManualPortChange: (String) -> Unit,
  onManualTlsChange: (Boolean) -> Unit,
  onTokenChange: (String) -> Unit,
  onPasswordChange: (String) -> Unit,
  onUseNearby: () -> Unit,
  onPair: () -> Unit,
  modifier: Modifier = Modifier,
) {
  var advancedOpen by rememberSaveable { mutableStateOf(false) }
  var nearbySearchTimedOut by remember { mutableStateOf(false) }

  LaunchedEffect(nearbyGatewayName, discoveryStatusText, discoveryStarted) {
    if (!nearbyGatewayName.isNullOrBlank()) {
      nearbySearchTimedOut = false
      return@LaunchedEffect
    }
    if (!discoveryStarted) {
      nearbySearchTimedOut = false
      return@LaunchedEffect
    }
    nearbySearchTimedOut = false
    delay(5_000)
    nearbySearchTimedOut = true
  }

  val nearbyGateway =
    nearbyGatewayUiState(
      nearbyGatewayName = nearbyGatewayName,
      discoveryStatusText = discoveryStatusText,
      discoveryStarted = discoveryStarted,
      searchTimedOut = nearbySearchTimedOut,
    )

  ClawScaffold(modifier = modifier, contentPadding = PaddingValues(horizontal = 18.dp, vertical = 16.dp)) {
    Column(modifier = Modifier.fillMaxSize().imePadding(), verticalArrangement = Arrangement.SpaceBetween) {
      LazyColumn(verticalArrangement = Arrangement.spacedBy(9.dp)) {
        item {
          OnboardingHeader(title = "Gateway Setup", subtitle = "Connect to your Gateway", onBack = onBack)
        }
        item {
          GatewayOption(
            icon = Icons.Default.QrCode2,
            title = "Scan setup code",
            subtitle = "Use your Gateway QR or setup code",
            onClick = onScan,
          )
        }
        item {
          GatewayOption(
            icon = Icons.Default.WifiTethering,
            title = "Nearby gateway",
            subtitle = nearbyGateway.subtitle,
            status = nearbyGateway.status,
            onClick = onUseNearby.takeIf { nearbyGateway.canConnect },
          )
        }
        item {
          GatewayOption(
            icon = Icons.Default.Link,
            title = "Enter gateway URL",
            subtitle = "Connect using a manual URL",
            onClick = { advancedOpen = true },
          )
        }
        error?.let { message ->
          item {
            ClawErrorState(
              title = "Setup code issue",
              body = message,
            )
          }
        }
        item {
          Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
            Surface(
              onClick = { advancedOpen = !advancedOpen },
              color = Color.Transparent,
              contentColor = ClawTheme.colors.text,
            ) {
              Row(
                modifier = Modifier.fillMaxWidth().padding(vertical = 8.dp),
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.SpaceBetween,
              ) {
                Text(text = "Advanced", style = ClawTheme.type.section, color = ClawTheme.colors.text)
                Icon(
                  imageVector = if (advancedOpen) Icons.Default.KeyboardArrowUp else Icons.Default.KeyboardArrowDown,
                  contentDescription = null,
                  modifier = Modifier.size(25.dp),
                )
              }
            }
            if (advancedOpen) {
              ClawTextField(value = setupCode, onValueChange = onSetupCodeChange, placeholder = "Setup code")
              Row(horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                ClawTextField(value = manualHost, onValueChange = onManualHostChange, placeholder = "Host", modifier = Modifier.weight(1f))
                ClawTextField(value = manualPort, onValueChange = onManualPortChange, placeholder = "Port", modifier = Modifier.width(104.dp))
              }
              Row(horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                TogglePill(text = if (manualTls) "TLS on" else "TLS off", selected = manualTls, onClick = { onManualTlsChange(!manualTls) })
                TogglePill(text = "Local", selected = !manualTls, onClick = { onManualTlsChange(false) })
              }
              ClawTextField(value = token, onValueChange = onTokenChange, placeholder = "Token optional")
              ClawTextField(value = password, onValueChange = onPasswordChange, placeholder = "Password optional")
            }
          }
        }
      }
      ClawPrimaryButton(text = "Pair with Gateway", icon = Icons.Default.Security, onClick = onPair, modifier = Modifier.fillMaxWidth())
    }
  }
}

@Composable
private fun GatewayRecoveryScreen(
  statusText: String,
  serverName: String?,
  attemptedGatewayName: String?,
  remoteAddress: String?,
  ready: Boolean,
  gatewayConnectionProblem: GatewayConnectionProblem?,
  connectSettling: Boolean,
  onBack: () -> Unit,
  onRetry: () -> Unit,
  onEdit: () -> Unit,
  onContinue: () -> Unit,
  modifier: Modifier = Modifier,
) {
  val recoveryState = gatewayRecoveryUiState(ready = ready, statusText = statusText, connectSettling = connectSettling, gatewayConnectionProblem = gatewayConnectionProblem)
  val context = LocalContext.current

  ClawScaffold(modifier = modifier, contentPadding = PaddingValues(horizontal = 18.dp, vertical = 16.dp)) {
    Column(modifier = Modifier.fillMaxSize(), verticalArrangement = Arrangement.spacedBy(18.dp)) {
      OnboardingHeader(title = "Gateway Recovery", onBack = onBack)
      Spacer(modifier = Modifier.height(12.dp))
      Column(modifier = Modifier.fillMaxWidth(), horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.spacedBy(12.dp)) {
        Icon(
          imageVector =
            when (recoveryState) {
              GatewayRecoveryUiState.Connected -> Icons.Default.CheckCircle
              GatewayRecoveryUiState.ApprovalRequired -> Icons.Default.WifiTethering
              GatewayRecoveryUiState.Pairing -> Icons.Default.WifiTethering
              GatewayRecoveryUiState.Finishing -> Icons.Default.WifiTethering
              GatewayRecoveryUiState.Failed -> Icons.Default.ErrorOutline
            },
          contentDescription = null,
          modifier = Modifier.size(64.dp),
          tint =
            when (recoveryState) {
              GatewayRecoveryUiState.Connected -> ClawTheme.colors.success
              GatewayRecoveryUiState.ApprovalRequired -> ClawTheme.colors.warning
              GatewayRecoveryUiState.Pairing -> ClawTheme.colors.text
              GatewayRecoveryUiState.Finishing -> ClawTheme.colors.text
              GatewayRecoveryUiState.Failed -> ClawTheme.colors.warning
            },
        )
        Text(text = recoveryState.title, style = ClawTheme.type.display, color = ClawTheme.colors.text)
        Text(
          text = recoveryState.message,
          style = ClawTheme.type.body,
          color = ClawTheme.colors.textMuted,
          textAlign = TextAlign.Center,
        )
      }

      ClawPanel {
        Column(verticalArrangement = Arrangement.spacedBy(10.dp)) {
          Text(text = "Last gateway", style = ClawTheme.type.caption, color = ClawTheme.colors.textMuted)
          Text(text = recoveryGatewayName(serverName = serverName, attemptedGatewayName = attemptedGatewayName), style = ClawTheme.type.section, color = ClawTheme.colors.text)
          Text(text = recoveryGatewayDetail(ready = ready, remoteAddress = remoteAddress, statusText = statusText, gatewayConnectionProblem = gatewayConnectionProblem), style = ClawTheme.type.body, color = ClawTheme.colors.textMuted)
          recoveryGatewayApprovalCommand(gatewayConnectionProblem)?.let { command ->
            ApprovalCommandBlock(command = command, onCopy = { copyApprovalCommand(context, command) })
          }
          ClawStatusPill(
            text =
              when (recoveryState) {
                GatewayRecoveryUiState.Connected -> "Healthy"
                GatewayRecoveryUiState.ApprovalRequired -> "Needs approval"
                GatewayRecoveryUiState.Pairing -> "Pairing"
                GatewayRecoveryUiState.Finishing -> "Connecting"
                GatewayRecoveryUiState.Failed -> "Needs attention"
              },
            status =
              when (recoveryState) {
                GatewayRecoveryUiState.Connected -> ClawStatus.Success
                GatewayRecoveryUiState.ApprovalRequired -> ClawStatus.Warning
                GatewayRecoveryUiState.Pairing -> ClawStatus.Neutral
                GatewayRecoveryUiState.Finishing -> ClawStatus.Neutral
                GatewayRecoveryUiState.Failed -> ClawStatus.Warning
              },
          )
        }
      }

      Column(verticalArrangement = Arrangement.spacedBy(10.dp)) {
        ClawPrimaryButton(
          text = if (ready) "Continue" else "Retry connection",
          icon = if (ready) Icons.Default.CheckCircle else Icons.Default.Refresh,
          onClick = if (ready) onContinue else onRetry,
          modifier = Modifier.fillMaxWidth(),
        )
        OutlinedAction(title = "Edit connection", icon = Icons.Default.Edit, onClick = onEdit)
        OutlinedAction(title = "Copy diagnostic", icon = Icons.Default.ContentCopy, onClick = { copyGatewayDiagnostic(context, statusText, serverName, remoteAddress, ready, gatewayConnectionProblem) })
      }
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
  ClawScaffold(modifier = modifier, contentPadding = PaddingValues(horizontal = 18.dp, vertical = 16.dp)) {
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
          Column(modifier = Modifier.padding(top = 10.dp, bottom = 18.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
            Text(
              text = "Allow permissions",
              style = ClawTheme.type.title.copy(fontSize = 20.sp, lineHeight = 25.sp, fontWeight = FontWeight.Bold),
              color = ClawTheme.colors.text,
            )
            Text(
              text = "These permissions keep OpenClaw secure\nand useful.",
              style = ClawTheme.type.body,
              color = ClawTheme.colors.textMuted,
            )
          }
        }
        items(permissionState.rows, key = { it.title }) { row ->
          PermissionRow(row = row)
        }
      }
      PermissionContinueButton(onClick = onContinue)
    }
  }
}

@Composable
private fun HeroPrimaryAction(
  title: String,
  onClick: () -> Unit,
) {
  Surface(
    onClick = onClick,
    modifier = Modifier.fillMaxWidth().height(46.dp),
    shape = RoundedCornerShape(23.dp),
    color = ClawTheme.colors.primary,
    contentColor = ClawTheme.colors.primaryText,
  ) {
    Row(
      modifier = Modifier.padding(horizontal = 22.dp),
      verticalAlignment = Alignment.CenterVertically,
      horizontalArrangement = Arrangement.spacedBy(14.dp),
    ) {
      Icon(imageVector = Icons.Default.Security, contentDescription = null, modifier = Modifier.size(18.dp))
      Text(text = title, style = ClawTheme.type.title.copy(fontSize = 14.5.sp, lineHeight = 18.sp), modifier = Modifier.weight(1f), textAlign = TextAlign.Center)
      Icon(imageVector = Icons.AutoMirrored.Filled.KeyboardArrowRight, contentDescription = null, modifier = Modifier.size(21.dp))
    }
  }
}

@Composable
private fun OnboardingHeader(
  title: String,
  modifier: Modifier = Modifier,
  subtitle: String? = null,
  onBack: (() -> Unit)? = null,
) {
  Row(modifier = modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(12.dp)) {
    onBack?.let {
      Surface(onClick = it, modifier = Modifier.size(34.dp), color = Color.Transparent, contentColor = ClawTheme.colors.text) {
        Box(contentAlignment = Alignment.Center) {
          Icon(imageVector = Icons.AutoMirrored.Filled.ArrowBack, contentDescription = "Back", modifier = Modifier.size(23.dp))
        }
      }
    }
    Column(verticalArrangement = Arrangement.spacedBy(4.dp)) {
      Text(text = title, style = ClawTheme.type.display, color = ClawTheme.colors.text)
      subtitle?.let { Text(text = it, style = ClawTheme.type.body, color = ClawTheme.colors.textMuted) }
    }
  }
}

@Composable
private fun GatewayOption(
  icon: ImageVector,
  title: String,
  subtitle: String,
  onClick: (() -> Unit)?,
  status: String? = null,
) {
  ClawPanel(contentPadding = PaddingValues(horizontal = 12.dp, vertical = 8.dp)) {
    ClawListItem(
      title = title,
      subtitle = subtitle,
      metadata = status,
      leading = { Icon(imageVector = icon, contentDescription = null, modifier = Modifier.size(22.dp), tint = ClawTheme.colors.text) },
      trailing =
        onClick?.let {
          {
            Icon(imageVector = Icons.AutoMirrored.Filled.KeyboardArrowRight, contentDescription = "Open $title", modifier = Modifier.size(20.dp), tint = ClawTheme.colors.text)
          }
        },
      onClick = onClick,
    )
  }
}

@Composable
private fun OutlinedAction(
  title: String,
  icon: ImageVector,
  onClick: () -> Unit,
) {
  Surface(
    onClick = onClick,
    modifier = Modifier.fillMaxWidth(),
    shape = RoundedCornerShape(ClawTheme.radii.control),
    color = Color.Transparent,
    contentColor = ClawTheme.colors.text,
    border = BorderStroke(1.dp, ClawTheme.colors.borderStrong),
  ) {
    Row(
      modifier = Modifier.padding(horizontal = 15.dp, vertical = 12.dp),
      verticalAlignment = Alignment.CenterVertically,
      horizontalArrangement = Arrangement.spacedBy(14.dp),
    ) {
      Icon(imageVector = icon, contentDescription = null, modifier = Modifier.size(20.dp))
      Text(text = title, style = ClawTheme.type.section, modifier = Modifier.weight(1f))
    }
  }
}

@Composable
private fun TogglePill(
  text: String,
  selected: Boolean,
  onClick: () -> Unit,
) {
  Surface(
    onClick = onClick,
    shape = RoundedCornerShape(ClawTheme.radii.pill),
    color = if (selected) ClawTheme.colors.primary else ClawTheme.colors.surfaceRaised,
    contentColor = if (selected) ClawTheme.colors.primaryText else ClawTheme.colors.textMuted,
    border = BorderStroke(1.dp, if (selected) ClawTheme.colors.primary else ClawTheme.colors.border),
  ) {
    Text(text = text, modifier = Modifier.padding(horizontal = 12.dp, vertical = 7.dp), style = ClawTheme.type.label)
  }
}

@Composable
private fun PermissionTopBar(onBack: () -> Unit) {
  var showHelp by remember { mutableStateOf(false) }
  if (showHelp) {
    AlertDialog(
      onDismissRequest = { showHelp = false },
      containerColor = ClawTheme.colors.surfaceRaised,
      title = { Text("Permissions", style = ClawTheme.type.section, color = ClawTheme.colors.text) },
      text = {
        Text(
          "Choose what this phone can share with OpenClaw. You can change these later in Settings.",
          style = ClawTheme.type.body,
          color = ClawTheme.colors.textMuted,
        )
      },
      confirmButton = {
        TextButton(onClick = { showHelp = false }) {
          Text("Done")
        }
      },
    )
  }
  Box(modifier = Modifier.fillMaxWidth().height(38.dp), contentAlignment = Alignment.Center) {
    Surface(
      onClick = onBack,
      modifier = Modifier.align(Alignment.CenterStart).size(34.dp),
      color = Color.Transparent,
      contentColor = ClawTheme.colors.text,
    ) {
      Box(contentAlignment = Alignment.Center) {
        Icon(imageVector = Icons.AutoMirrored.Filled.ArrowBack, contentDescription = "Back", modifier = Modifier.size(22.dp))
      }
    }
    Text(
      text = "Permission Setup",
      style = ClawTheme.type.title.copy(fontSize = 15.2.sp, lineHeight = 19.sp),
      color = ClawTheme.colors.text,
      maxLines = 1,
    )
    Surface(
      onClick = { showHelp = true },
      modifier = Modifier.align(Alignment.CenterEnd).size(28.dp),
      shape = CircleShape,
      color = Color.Transparent,
      contentColor = ClawTheme.colors.text,
      border = BorderStroke(1.dp, ClawTheme.colors.text),
    ) {
      Box(contentAlignment = Alignment.Center) {
        Text(text = "?", style = ClawTheme.type.label.copy(fontSize = 13.sp, lineHeight = 16.sp), color = ClawTheme.colors.text)
      }
    }
  }
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
      Surface(modifier = Modifier.size(30.dp), shape = CircleShape, color = ClawTheme.colors.surfacePressed, border = BorderStroke(1.dp, ClawTheme.colors.border)) {
        Box(contentAlignment = Alignment.Center) {
          Icon(imageVector = row.icon, contentDescription = null, modifier = Modifier.size(17.dp), tint = ClawTheme.colors.text)
        }
      }
      Column(modifier = Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(2.dp)) {
        Text(
          text = row.title,
          style = ClawTheme.type.title.copy(fontSize = 18.sp, lineHeight = 23.sp),
          color = ClawTheme.colors.text,
          maxLines = 1,
        )
        Text(
          text = row.subtitle,
          style = ClawTheme.type.body,
          color = ClawTheme.colors.textMuted,
          maxLines = 1,
        )
      }
      Text(
        text = if (row.granted) "Granted" else "Not granted",
        style = ClawTheme.type.body,
        color = if (row.granted) ClawTheme.colors.success else ClawTheme.colors.textMuted,
        maxLines = 1,
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

@Composable
private fun PermissionContinueButton(onClick: () -> Unit) {
  Surface(
    onClick = onClick,
    modifier = Modifier.fillMaxWidth().height(44.dp),
    shape = RoundedCornerShape(22.dp),
    color = ClawTheme.colors.primary,
    contentColor = ClawTheme.colors.primaryText,
  ) {
    Box(modifier = Modifier.fillMaxWidth(), contentAlignment = Alignment.Center) {
      Text(text = "Continue", style = ClawTheme.type.title.copy(fontSize = 18.sp, lineHeight = 23.sp), color = ClawTheme.colors.primaryText)
      Icon(
        imageVector = Icons.AutoMirrored.Filled.KeyboardArrowRight,
        contentDescription = null,
        modifier = Modifier.align(Alignment.CenterEnd).padding(end = 20.dp).size(19.dp),
        tint = ClawTheme.colors.primaryText,
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
  Pairing(
    title = "Pairing Gateway",
    message = "Approval is in progress.\nOpenClaw will reconnect automatically.",
  ),
  Finishing(
    title = "Connecting Gateway",
    message = "OpenClaw is checking gateway and node access.",
  ),
  Failed(
    title = "Connection issue",
    message = "We could not reach your Gateway.\nLet's fix this.",
  ),
}

internal data class NearbyGatewayUiState(
  val subtitle: String,
  val status: String?,
  val canConnect: Boolean,
)

/** Maps best-effort discovery into row copy and clickability for onboarding. */
internal fun nearbyGatewayUiState(
  nearbyGatewayName: String?,
  discoveryStatusText: String,
  discoveryStarted: Boolean = true,
  searchTimedOut: Boolean = false,
): NearbyGatewayUiState {
  val name = nearbyGatewayName?.trim().takeUnless { it.isNullOrEmpty() }
  if (name != null) {
    return NearbyGatewayUiState(subtitle = name, status = "Found", canConnect = true)
  }
  if (!discoveryStarted) {
    return NearbyGatewayUiState(subtitle = "Starting discovery...", status = "Starting", canConnect = false)
  }

  val status = discoveryStatusText.trim()
  val searching =
    status.isEmpty() ||
      status.equals("Searching…", ignoreCase = true) ||
      status.contains("Searching", ignoreCase = true) ||
      status.endsWith("?", ignoreCase = true)
  return if (searching) {
    if (searchTimedOut) {
      NearbyGatewayUiState(subtitle = "No gateway found", status = "Not found", canConnect = false)
    } else {
      NearbyGatewayUiState(subtitle = "Searching for gateways...", status = "Searching", canConnect = false)
    }
  } else {
    NearbyGatewayUiState(subtitle = "No gateway found", status = "Not found", canConnect = false)
  }
}

/** Derives recovery screen state from gateway/node readiness and transient status text. */
internal fun gatewayRecoveryUiState(
  ready: Boolean,
  statusText: String,
  connectSettling: Boolean,
  gatewayConnectionProblem: GatewayConnectionProblem? = null,
): GatewayRecoveryUiState =
  when {
    ready -> GatewayRecoveryUiState.Connected
    gatewayConnectionProblem?.isPairingRequired == true &&
      !gatewayConnectionProblem.canAutoRetry -> GatewayRecoveryUiState.ApprovalRequired
    gatewayConnectionProblem?.isPairingRequired == true -> GatewayRecoveryUiState.Pairing
    gatewayConnectionProblem?.pauseReconnect == true -> GatewayRecoveryUiState.Failed
    connectSettling -> GatewayRecoveryUiState.Finishing
    gatewayStatusLooksLikePairing(statusText) -> GatewayRecoveryUiState.Pairing
    gatewayStatusLooksLikePartialConnect(statusText) -> GatewayRecoveryUiState.Finishing
    else -> GatewayRecoveryUiState.Failed
  }

/** Detects gateway-approved states where the Android node is still coming online. */
internal fun gatewayStatusLooksLikePartialConnect(statusText: String): Boolean {
  val lower = gatewayStatusForDisplay(statusText).lowercase()
  return lower.contains("operator offline") || lower.contains("node offline")
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

private data class GatewayConfig(
  val host: String,
  val port: Int,
  val tls: Boolean,
  val bootstrapToken: String,
  val token: String,
  val password: String,
)

/** Resolves setup-code or manual fields into the gateway config used for first connect. */
private fun resolveGatewayConfig(
  setupCode: String,
  manualHost: String,
  manualPort: String,
  manualTls: Boolean,
  token: String,
  password: String,
): GatewayConfig? {
  val setup = setupCode.takeIf { it.isNotBlank() }?.let(::decodeGatewaySetupCode)
  if (setup != null) {
    val endpoint = parseGatewayEndpointResult(setup.url).config ?: return null
    val bootstrapToken = setup.bootstrapToken?.trim().orEmpty()
    // Bootstrap setup codes own first-pairing auth; fall back to typed token or
    // password only for non-bootstrap setup payloads.
    return GatewayConfig(
      host = endpoint.host,
      port = endpoint.port,
      tls = endpoint.tls,
      bootstrapToken = bootstrapToken,
      token =
        setup.token
          ?.trim()
          .orEmpty()
          .ifEmpty { if (bootstrapToken.isEmpty()) token.trim() else "" },
      password =
        setup.password
          ?.trim()
          .orEmpty()
          .ifEmpty { if (bootstrapToken.isEmpty()) password.trim() else "" },
    )
  }

  val manualUrl = composeGatewayManualUrl(manualHost, manualPort, manualTls) ?: return null
  val endpoint = parseGatewayEndpointResult(manualUrl).config ?: return null
  return GatewayConfig(
    host = endpoint.host,
    port = endpoint.port,
    tls = endpoint.tls,
    bootstrapToken = "",
    token = token.trim(),
    password = password.trim(),
  )
}

/** Selects the recovery detail line from endpoint metadata and transient gateway status. */
private fun recoveryGatewayDetail(
  ready: Boolean,
  remoteAddress: String?,
  statusText: String,
  gatewayConnectionProblem: GatewayConnectionProblem?,
): String =
  remoteAddress
    ?.takeIf { it.isNotBlank() }
    ?: if (ready) {
      "Ready for chat and voice"
    } else if (gatewayConnectionProblem?.isPairingRequired == true && !gatewayConnectionProblem.canAutoRetry) {
      recoveryGatewayApprovalCommand(gatewayConnectionProblem)
        ?.let { "Gateway approval is pending. Run this on the gateway host:" }
        ?: "Gateway approval is pending. Run openclaw devices list on the gateway host, approve this phone, then retry."
    } else if (statusText.contains("operator offline", ignoreCase = true)) {
      "Gateway paired. Waiting for operator access."
    } else if (gatewayStatusLooksLikePairing(statusText)) {
      "Gateway approval is in progress. OpenClaw will retry automatically."
    } else {
      "Gateway unreachable"
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

private fun copyApprovalCommand(
  context: Context,
  command: String,
) {
  val clipboard = context.getSystemService(Context.CLIPBOARD_SERVICE) as ClipboardManager
  clipboard.setPrimaryClip(ClipData.newPlainText("OpenClaw pairing approval command", command))
  Toast.makeText(context, "Approval command copied", Toast.LENGTH_SHORT).show()
}

/** Copies the onboarding recovery snapshot for support without including credentials. */
private fun copyGatewayDiagnostic(
  context: Context,
  statusText: String,
  serverName: String?,
  remoteAddress: String?,
  ready: Boolean,
  gatewayConnectionProblem: GatewayConnectionProblem?,
) {
  val approvalCommand = recoveryGatewayApprovalCommand(gatewayConnectionProblem)
  val diagnostic =
    listOfNotNull(
      "OpenClaw Android gateway diagnostic",
      "Status: $statusText",
      gatewayConnectionProblem?.message?.let { "Gateway problem: $it" },
      gatewayConnectionProblem?.requestId?.let { "Pairing request: $it" },
      approvalCommand?.let { "Approval command: $it" },
      "Gateway: ${serverName?.takeIf { it.isNotBlank() } ?: "Home Gateway"}",
      "Address: ${remoteAddress?.takeIf { it.isNotBlank() } ?: "Not available"}",
      "Ready: ${if (ready) "yes" else "no"}",
    ).joinToString("\n")
  val clipboard = context.getSystemService(Context.CLIPBOARD_SERVICE) as ClipboardManager
  clipboard.setPrimaryClip(ClipData.newPlainText("OpenClaw gateway diagnostic", diagnostic))
  Toast.makeText(context, "Diagnostic copied", Toast.LENGTH_SHORT).show()
}

/** One permission row plus launcher callback for onboarding's final setup step. */
private data class PermissionRowModel(
  val title: String,
  val subtitle: String,
  val icon: ImageVector,
  val granted: Boolean,
  val onClick: () -> Unit,
)

/** Permission screen model plus a commit hook that persists granted feature toggles. */
private class PermissionState(
  val rows: List<PermissionRowModel>,
  val applyToViewModel: () -> Unit,
)

/** Onboarding can finish only after gateway and node channels are both ready. */
internal fun canFinishOnboarding(
  isConnected: Boolean,
  isNodeConnected: Boolean,
): Boolean = isConnected && isNodeConnected

/** Builds permission rows and applies granted feature toggles after onboarding. */
@Composable
private fun rememberPermissionState(
  context: Context,
  viewModel: MainViewModel,
): PermissionState {
  var microphoneGranted by rememberSaveable { mutableStateOf(hasPermission(context, Manifest.permission.RECORD_AUDIO)) }
  var cameraGranted by rememberSaveable { mutableStateOf(hasPermission(context, Manifest.permission.CAMERA)) }
  var locationGranted by rememberSaveable {
    mutableStateOf(hasPermission(context, Manifest.permission.ACCESS_FINE_LOCATION) || hasPermission(context, Manifest.permission.ACCESS_COARSE_LOCATION))
  }
  val photosPermission = if (Build.VERSION.SDK_INT >= 33) Manifest.permission.READ_MEDIA_IMAGES else Manifest.permission.READ_EXTERNAL_STORAGE
  var photosGranted by rememberSaveable { mutableStateOf(hasPermission(context, photosPermission)) }
  var contactsGranted by rememberSaveable { mutableStateOf(hasPermission(context, Manifest.permission.READ_CONTACTS)) }
  var calendarGranted by rememberSaveable { mutableStateOf(hasPermission(context, Manifest.permission.READ_CALENDAR)) }
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
  val callLogAvailable = SensitiveFeatureConfig.callLogEnabled
  var motionGranted by rememberSaveable { mutableStateOf(!motionAvailable || hasPermission(context, Manifest.permission.ACTIVITY_RECOGNITION)) }
  var smsGranted by rememberSaveable {
    mutableStateOf(
      !smsAvailable ||
        (
          hasPermission(context, Manifest.permission.SEND_SMS) &&
            hasPermission(context, Manifest.permission.READ_SMS)
        ),
    )
  }
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
      photosGranted = permissions[photosPermission] ?: photosGranted
      contactsGranted = permissions[Manifest.permission.READ_CONTACTS] ?: contactsGranted
      calendarGranted = permissions[Manifest.permission.READ_CALENDAR] ?: calendarGranted
      notificationsGranted = permissions[Manifest.permission.POST_NOTIFICATIONS] ?: notificationsGranted
      motionGranted = permissions[Manifest.permission.ACTIVITY_RECOGNITION] ?: motionGranted
      smsGranted =
        (permissions[Manifest.permission.SEND_SMS] ?: smsGranted) &&
        (permissions[Manifest.permission.READ_SMS] ?: smsGranted)
      callLogGranted = permissions[Manifest.permission.READ_CALL_LOG] ?: callLogGranted
    }

  fun request(vararg permissions: String) {
    permissionLauncher.launch(permissions.filterNot { hasPermission(context, it) }.toTypedArray())
  }

  val rows =
    listOfNotNull(
      PermissionRowModel("Voice", "Record and transcribe audio", Icons.Default.Mic, microphoneGranted) {
        request(Manifest.permission.RECORD_AUDIO)
      },
      PermissionRowModel("Camera", "Capture photos and video", Icons.Default.CameraAlt, cameraGranted) {
        request(Manifest.permission.CAMERA)
      },
      PermissionRowModel("Location", "Use location when needed", Icons.Default.LocationOn, locationGranted) {
        request(Manifest.permission.ACCESS_FINE_LOCATION, Manifest.permission.ACCESS_COARSE_LOCATION)
      },
      if (photosAvailable) {
        PermissionRowModel("Photos", "Attach photos and media", Icons.Default.Image, photosGranted) {
          request(photosPermission)
        }
      } else {
        null
      },
      PermissionRowModel("Contacts", "Read contacts securely", Icons.Default.Person, contactsGranted) {
        request(Manifest.permission.READ_CONTACTS, Manifest.permission.WRITE_CONTACTS)
      },
      PermissionRowModel("Calendar", "Read events and schedules", Icons.Default.CalendarMonth, calendarGranted) {
        request(Manifest.permission.READ_CALENDAR, Manifest.permission.WRITE_CALENDAR)
      },
      PermissionRowModel("Notifications", "Send important alerts", Icons.Default.Notifications, notificationsGranted) {
        if (Build.VERSION.SDK_INT >= 33) request(Manifest.permission.POST_NOTIFICATIONS)
      },
      PermissionRowModel("Notification listener", "Forward selected app alerts", Icons.Default.Sensors, notificationListenerGranted) {
        context.startActivity(Intent(Settings.ACTION_NOTIFICATION_LISTENER_SETTINGS).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
      },
      if (motionAvailable) {
        PermissionRowModel("Motion", "Read activity and step context", Icons.Default.Sensors, motionGranted) {
          request(Manifest.permission.ACTIVITY_RECOGNITION)
        }
      } else {
        null
      },
      if (smsAvailable) {
        PermissionRowModel("SMS", "Send and read messages when approved", Icons.Default.Notifications, smsGranted) {
          request(Manifest.permission.SEND_SMS, Manifest.permission.READ_SMS)
        }
      } else {
        null
      },
      if (callLogAvailable) {
        PermissionRowModel("Call Log", "Read recent call context", Icons.Default.Person, callLogGranted) {
          request(Manifest.permission.READ_CALL_LOG)
        }
      } else {
        null
      },
    )

  return PermissionState(
    rows = rows,
    applyToViewModel = {
      viewModel.setCameraEnabled(cameraGranted)
      viewModel.setLocationMode(if (locationGranted) LocationMode.WhileUsing else LocationMode.Off)
      viewModel.setNotificationForwardingEnabled(notificationListenerGranted)
    },
  )
}

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
