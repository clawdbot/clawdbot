package bot.molt.android.ui

import android.Manifest
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Build
import android.provider.Settings
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.animation.AnimatedVisibility
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.WindowInsetsSides
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.only
import androidx.compose.foundation.layout.safeDrawing
import androidx.compose.foundation.layout.windowInsetsPadding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.ExpandLess
import androidx.compose.material.icons.filled.ExpandMore
import androidx.compose.material3.Button
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.ListItem
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.RadioButton
import androidx.compose.material3.Switch
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.focus.onFocusChanged
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalFocusManager
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.core.content.ContextCompat
import bot.molt.android.BuildConfig
import bot.molt.android.LocationMode
import bot.molt.android.MainViewModel
import bot.molt.android.NodeForegroundService
import bot.molt.android.VoiceWakeMode
import bot.molt.android.WakeWords

@Composable
fun SettingsSheet(viewModel: MainViewModel) {
  val context = LocalContext.current
  val instanceId by viewModel.instanceId.collectAsState()
  val displayName by viewModel.displayName.collectAsState()
  val cameraEnabled by viewModel.cameraEnabled.collectAsState()
  val locationMode by viewModel.locationMode.collectAsState()
  val locationPreciseEnabled by viewModel.locationPreciseEnabled.collectAsState()
  val preventSleep by viewModel.preventSleep.collectAsState()
  val wakeWords by viewModel.wakeWords.collectAsState()
  val voiceWakeMode by viewModel.voiceWakeMode.collectAsState()
  val voiceWakeStatusText by viewModel.voiceWakeStatusText.collectAsState()
  val isConnected by viewModel.isConnected.collectAsState()
  val manualEnabled by viewModel.manualEnabled.collectAsState()
  val manualHost by viewModel.manualHost.collectAsState()
  val manualPort by viewModel.manualPort.collectAsState()
  val manualTls by viewModel.manualTls.collectAsState()
  val canvasDebugStatusEnabled by viewModel.canvasDebugStatusEnabled.collectAsState()
  val statusText by viewModel.statusText.collectAsState()
  val serverName by viewModel.serverName.collectAsState()
  val remoteAddress by viewModel.remoteAddress.collectAsState()
  val gateways by viewModel.gateways.collectAsState()
  val discoveryStatusText by viewModel.discoveryStatusText.collectAsState()

  val listState = rememberLazyListState()
  val (wakeWordsText, setWakeWordsText) = remember { mutableStateOf("") }
  val (advancedExpanded, setAdvancedExpanded) = remember { mutableStateOf(false) }
  val focusManager = LocalFocusManager.current
  var wakeWordsHadFocus by remember { mutableStateOf(false) }
  val deviceModel =
    remember {
      listOfNotNull(Build.MANUFACTURER, Build.MODEL)
        .joinToString(" ")
        .trim()
        .ifEmpty { "Android" }
    }
  val appVersion =
    remember {
      val versionName = BuildConfig.VERSION_NAME.trim().ifEmpty { "dev" }
      if (BuildConfig.DEBUG && !versionName.contains("dev", ignoreCase = true)) {
        "$versionName-dev"
      } else {
        versionName
      }
    }

  LaunchedEffect(wakeWords) { setWakeWordsText(wakeWords.joinToString(", ")) }
  val commitWakeWords = {
    val parsed = WakeWords.parseIfChanged(wakeWordsText, wakeWords)
    if (parsed != null) {
      viewModel.setWakeWords(parsed)
    }
  }

  val permissionLauncher =
    rememberLauncherForActivityResult(ActivityResultContracts.RequestMultiplePermissions()) { perms ->
      val cameraOk = perms[Manifest.permission.CAMERA] == true
      viewModel.setCameraEnabled(cameraOk)
    }

  var pendingLocationMode by remember { mutableStateOf<LocationMode?>(null) }
  var pendingPreciseToggle by remember { mutableStateOf(false) }

  val locationPermissionLauncher =
    rememberLauncherForActivityResult(ActivityResultContracts.RequestMultiplePermissions()) { perms ->
      val fineOk = perms[Manifest.permission.ACCESS_FINE_LOCATION] == true
      val coarseOk = perms[Manifest.permission.ACCESS_COARSE_LOCATION] == true
      val granted = fineOk || coarseOk
      val requestedMode = pendingLocationMode
      pendingLocationMode = null

      if (pendingPreciseToggle) {
        pendingPreciseToggle = false
        viewModel.setLocationPreciseEnabled(fineOk)
        return@rememberLauncherForActivityResult
      }

      if (!granted) {
        viewModel.setLocationMode(LocationMode.Off)
        return@rememberLauncherForActivityResult
      }

      if (requestedMode != null) {
        viewModel.setLocationMode(requestedMode)
        if (requestedMode == LocationMode.Always) {
          val backgroundOk =
            ContextCompat.checkSelfPermission(context, Manifest.permission.ACCESS_BACKGROUND_LOCATION) ==
              PackageManager.PERMISSION_GRANTED
          if (!backgroundOk) {
            openAppSettings(context)
          }
        }
      }
    }

  val audioPermissionLauncher =
    rememberLauncherForActivityResult(ActivityResultContracts.RequestPermission()) { _ ->
      // Status text is handled by NodeRuntime.
    }

  val smsPermissionAvailable =
    remember {
      context.packageManager?.hasSystemFeature(PackageManager.FEATURE_TELEPHONY) == true
    }
  var smsPermissionGranted by
    remember {
      mutableStateOf(
        ContextCompat.checkSelfPermission(context, Manifest.permission.SEND_SMS) ==
          PackageManager.PERMISSION_GRANTED,
      )
    }
  val smsPermissionLauncher =
    rememberLauncherForActivityResult(ActivityResultContracts.RequestPermission()) { granted ->
      smsPermissionGranted = granted
      viewModel.refreshGatewayConnection()
    }

  fun setCameraEnabledChecked(checked: Boolean) {
    if (!checked) {
      viewModel.setCameraEnabled(false)
      return
    }

    val cameraOk =
      ContextCompat.checkSelfPermission(context, Manifest.permission.CAMERA) ==
        PackageManager.PERMISSION_GRANTED
    if (cameraOk) {
      viewModel.setCameraEnabled(true)
    } else {
      permissionLauncher.launch(arrayOf(Manifest.permission.CAMERA, Manifest.permission.RECORD_AUDIO))
    }
  }

  fun requestLocationPermissions(targetMode: LocationMode) {
    val fineOk =
      ContextCompat.checkSelfPermission(context, Manifest.permission.ACCESS_FINE_LOCATION) ==
        PackageManager.PERMISSION_GRANTED
    val coarseOk =
      ContextCompat.checkSelfPermission(context, Manifest.permission.ACCESS_COARSE_LOCATION) ==
        PackageManager.PERMISSION_GRANTED
    if (fineOk || coarseOk) {
      viewModel.setLocationMode(targetMode)
      if (targetMode == LocationMode.Always) {
        val backgroundOk =
          ContextCompat.checkSelfPermission(context, Manifest.permission.ACCESS_BACKGROUND_LOCATION) ==
            PackageManager.PERMISSION_GRANTED
        if (!backgroundOk) {
          openAppSettings(context)
        }
      }
    } else {
      pendingLocationMode = targetMode
      locationPermissionLauncher.launch(
        arrayOf(Manifest.permission.ACCESS_FINE_LOCATION, Manifest.permission.ACCESS_COARSE_LOCATION),
      )
    }
  }

  fun setPreciseLocationChecked(checked: Boolean) {
    if (!checked) {
      viewModel.setLocationPreciseEnabled(false)
      return
    }
    val fineOk =
      ContextCompat.checkSelfPermission(context, Manifest.permission.ACCESS_FINE_LOCATION) ==
        PackageManager.PERMISSION_GRANTED
    if (fineOk) {
      viewModel.setLocationPreciseEnabled(true)
    } else {
      pendingPreciseToggle = true
      locationPermissionLauncher.launch(arrayOf(Manifest.permission.ACCESS_FINE_LOCATION))
    }
  }

  val visibleGateways =
    if (isConnected && remoteAddress != null) {
      gateways.filterNot { "${it.host}:${it.port}" == remoteAddress }
    } else {
      gateways
    }

  val gatewayDiscoveryFooterText =
    if (visibleGateways.isEmpty()) {
      discoveryStatusText
    } else if (isConnected) {
      "Discovery active • ${visibleGateways.size} other gateway${if (visibleGateways.size == 1) "" else "s"} found"
    } else {
      "Discovery active • ${visibleGateways.size} gateway${if (visibleGateways.size == 1) "" else "s"} found"
    }

  LazyColumn(
    state = listState,
    modifier =
      Modifier
        .fillMaxWidth()
        .fillMaxHeight()
        .imePadding()
        .windowInsetsPadding(WindowInsets.safeDrawing.only(WindowInsetsSides.Bottom)),
    contentPadding = PaddingValues(16.dp),
    verticalArrangement = Arrangement.spacedBy(6.dp),
  ) {
    // Order parity: Node → Gateway → Voice → Camera → Messaging → Location → Screen.
    item { Text("Node", style = MaterialTheme.typography.titleSmall) }
    item {
      OutlinedTextField(
        value = displayName,
        onValueChange = viewModel::setDisplayName,
        label = { Text("Name") },
        modifier = Modifier.fillMaxWidth(),
      )
    }
    item { Text("Instance ID: $instanceId", color = MaterialTheme.colorScheme.onSurfaceVariant) }
    item { Text("Device: $deviceModel", color = MaterialTheme.colorScheme.onSurfaceVariant) }
    item { Text("Version: $appVersion", color = MaterialTheme.colorScheme.onSurfaceVariant) }

    item { HorizontalDivider() }

    // Gateway
    item { Text("Gateway", style = MaterialTheme.typography.titleSmall) }
    item { ListItem(headlineContent = { Text("Status") }, supportingContent = { Text(statusText) }) }
    if (serverName != null) {
      item { ListItem(headlineContent = { Text("Server") }, supportingContent = { Text(serverName!!) }) }
    }
    if (remoteAddress != null) {
      item { ListItem(headlineContent = { Text("Address") }, supportingContent = { Text(remoteAddress!!) }) }
    }
    item {
      // UI sanity: "Disconnect" only when we have an active remote.
      if (isConnected && remoteAddress != null) {
        Button(
          onClick = {
            viewModel.disconnect()
            NodeForegroundService.stop(context)
          },
        ) {
          Text("Disconnect")
        }
      }
    }

    item { HorizontalDivider() }

    if (!isConnected || visibleGateways.isNotEmpty()) {
      item {
        Text(
          if (isConnected) "Other Gateways" else "Discovered Gateways",
          style = MaterialTheme.typography.titleSmall,
        )
      }
      if (!isConnected && visibleGateways.isEmpty()) {
        item { Text("No gateways found yet.", color = MaterialTheme.colorScheme.onSurfaceVariant) }
      } else {
        items(items = visibleGateways, key = { it.stableId }) { gateway ->
          val detailLines =
            buildList {
              add("IP: ${gateway.host}:${gateway.port}")
              gateway.lanHost?.let { add("LAN: $it") }
              gateway.tailnetDns?.let { add("Tailnet: $it") }
              if (gateway.gatewayPort != null || gateway.canvasPort != null) {
                val gw = (gateway.gatewayPort ?: gateway.port).toString()
                val canvas = gateway.canvasPort?.toString() ?: "—"
                add("Ports: gw $gw · canvas $canvas")
              }
            }
          ListItem(
            headlineContent = { Text(gateway.name) },
            supportingContent = {
              Column(verticalArrangement = Arrangement.spacedBy(2.dp)) {
                detailLines.forEach { line ->
                  Text(line, color = MaterialTheme.colorScheme.onSurfaceVariant)
                }
              }
            },
            trailingContent = {
              Button(
                onClick = {
                  NodeForegroundService.start(context)
                  viewModel.connect(gateway)
                },
              ) {
                Text("Connect")
              }
            },
          )
        }
      }
      item {
        Text(
          gatewayDiscoveryFooterText,
          modifier = Modifier.fillMaxWidth(),
          textAlign = TextAlign.Center,
          style = MaterialTheme.typography.labelMedium,
          color = MaterialTheme.colorScheme.onSurfaceVariant,
        )
      }
    }

    item { HorizontalDivider() }

    item {
      ListItem(
        headlineContent = { Text("Advanced") },
        supportingContent = { Text("Manual gateway connection") },
        trailingContent = {
          Icon(
            imageVector = if (advancedExpanded) Icons.Filled.ExpandLess else Icons.Filled.ExpandMore,
            contentDescription = if (advancedExpanded) "Collapse" else "Expand",
          )
        },
        modifier =
          Modifier.clickable {
            setAdvancedExpanded(!advancedExpanded)
          },
      )
    }
    item {
      AnimatedVisibility(visible = advancedExpanded) {
        Column(verticalArrangement = Arrangement.spacedBy(10.dp), modifier = Modifier.fillMaxWidth()) {
          ListItem(
            headlineContent = { Text("Use Manual Gateway") },
            supportingContent = { Text("Use this when discovery is blocked.") },
            trailingContent = { Switch(checked = manualEnabled, onCheckedChange = viewModel::setManualEnabled) },
          )

          OutlinedTextField(
            value = manualHost,
            onValueChange = viewModel::setManualHost,
            label = { Text("Host") },
            modifier = Modifier.fillMaxWidth(),
            enabled = manualEnabled,
          )
          OutlinedTextField(
            value = manualPort.toString(),
            onValueChange = { v -> viewModel.setManualPort(v.toIntOrNull() ?: 0) },
            label = { Text("Port") },
            modifier = Modifier.fillMaxWidth(),
            enabled = manualEnabled,
          )
          ListItem(
            headlineContent = { Text("Require TLS") },
            supportingContent = { Text("Pin the gateway certificate on first connect.") },
            trailingContent = { Switch(checked = manualTls, onCheckedChange = viewModel::setManualTls, enabled = manualEnabled) },
            modifier = Modifier.alpha(if (manualEnabled) 1f else 0.5f),
          )

          val hostOk = manualHost.trim().isNotEmpty()
          val portOk = manualPort in 1..65535
          Button(
            onClick = {
              NodeForegroundService.start(context)
              viewModel.connectManual()
            },
            enabled = manualEnabled && hostOk && portOk,
          ) {
            Text("Connect (Manual)")
          }
        }
      }
    }

    item { HorizontalDivider() }

    // Voice
    item { Text("Voice", style = MaterialTheme.typography.titleSmall) }
    item {
      val enabled = voiceWakeMode != VoiceWakeMode.Off
      ListItem(
        headlineContent = { Text("Voice Wake") },
        supportingContent = { Text(voiceWakeStatusText) },
        trailingContent = {
          Switch(
            checked = enabled,
            onCheckedChange = { on ->
              if (on) {
                val micOk =
                  ContextCompat.checkSelfPermission(context, Manifest.permission.RECORD_AUDIO) ==
                    PackageManager.PERMISSION_GRANTED
                if (!micOk) audioPermissionLauncher.launch(Manifest.permission.RECORD_AUDIO)
                viewModel.setVoiceWakeMode(VoiceWakeMode.Foreground)
              } else {
                viewModel.setVoiceWakeMode(VoiceWakeMode.Off)
              }
            },
          )
        },
      )
    }
    item {
      AnimatedVisibility(visible = voiceWakeMode != VoiceWakeMode.Off) {
        Column(verticalArrangement = Arrangement.spacedBy(6.dp), modifier = Modifier.fillMaxWidth()) {
          ListItem(
            headlineContent = { Text("Foreground Only") },
            supportingContent = { Text("Listens only while Moltbot is open.") },
            trailingContent = {
              RadioButton(
                selected = voiceWakeMode == VoiceWakeMode.Foreground,
                onClick = {
                  val micOk =
                    ContextCompat.checkSelfPermission(context, Manifest.permission.RECORD_AUDIO) ==
                      PackageManager.PERMISSION_GRANTED
                  if (!micOk) audioPermissionLauncher.launch(Manifest.permission.RECORD_AUDIO)
                  viewModel.setVoiceWakeMode(VoiceWakeMode.Foreground)
                },
              )
            },
          )
          ListItem(
            headlineContent = { Text("Always") },
            supportingContent = { Text("Keeps listening in the background (shows a persistent notification).") },
            trailingContent = {
              RadioButton(
                selected = voiceWakeMode == VoiceWakeMode.Always,
                onClick = {
                  val micOk =
                    ContextCompat.checkSelfPermission(context, Manifest.permission.RECORD_AUDIO) ==
                      PackageManager.PERMISSION_GRANTED
                  if (!micOk) audioPermissionLauncher.launch(Manifest.permission.RECORD_AUDIO)
                  viewModel.setVoiceWakeMode(VoiceWakeMode.Always)
                },
              )
            },
          )
        }
      }
    }
    item {
      OutlinedTextField(
        value = wakeWordsText,
        onValueChange = setWakeWordsText,
        label = { Text("Wake Words (comma-separated)") },
        modifier =
          Modifier.fillMaxWidth().onFocusChanged { focusState ->
            if (focusState.isFocused) {
              wakeWordsHadFocus = true
            } else if (wakeWordsHadFocus) {
              wakeWordsHadFocus = false
              commitWakeWords()
            }
          },
        singleLine = true,
        keyboardOptions = KeyboardOptions(imeAction = ImeAction.Done),
        keyboardActions =
          KeyboardActions(
            onDone = {
              commitWakeWords()
              focusManager.clearFocus()
            },
          ),
      )
    }
    item { Button(onClick = viewModel::resetWakeWordsDefaults) { Text("Reset defaults") } }
    item {
      Text(
        if (isConnected) {
          "Any node can edit wake words. Changes sync via the gateway."
        } else {
          "Connect to a gateway to sync wake words globally."
        },
        color = MaterialTheme.colorScheme.onSurfaceVariant,
      )
    }

    item { HorizontalDivider() }

    // Camera
    item { Text("Camera", style = MaterialTheme.typography.titleSmall) }
    item {
      ListItem(
        headlineContent = { Text("Allow Camera") },
        supportingContent = { Text("Allows the gateway to request photos or short video clips (foreground only).") },
        trailingContent = { Switch(checked = cameraEnabled, onCheckedChange = ::setCameraEnabledChecked) },
      )
    }
    item {
      Text(
        "Tip: grant Microphone permission for video clips with audio.",
        color = MaterialTheme.colorScheme.onSurfaceVariant,
      )
    }

    item { HorizontalDivider() }

    // Messaging
    item { Text("Messaging", style = MaterialTheme.typography.titleSmall) }
    item {
      val buttonLabel =
        when {
          !smsPermissionAvailable -> "Unavailable"
          smsPermissionGranted -> "Manage"
          else -> "Grant"
        }
      ListItem(
        headlineContent = { Text("SMS Permission") },
        supportingContent = {
          Text(
            if (smsPermissionAvailable) {
              "Allow the gateway to send SMS from this device."
            } else {
              "SMS requires a device with telephony hardware."
            },
          )
        },
        trailingContent = {
          Button(
            onClick = {
              if (!smsPermissionAvailable) return@Button
              if (smsPermissionGranted) {
                openAppSettings(context)
              } else {
                smsPermissionLauncher.launch(Manifest.permission.SEND_SMS)
              }
            },
            enabled = smsPermissionAvailable,
          ) {
            Text(buttonLabel)
          }
        },
      )
    }

    item { HorizontalDivider() }

    // Location
    item { Text("Location", style = MaterialTheme.typography.titleSmall) }
    item {
      Column(verticalArrangement = Arrangement.spacedBy(6.dp), modifier = Modifier.fillMaxWidth()) {
        ListItem(
          headlineContent = { Text("Off") },
          supportingContent = { Text("Disable location sharing.") },
          trailingContent = {
            RadioButton(
              selected = locationMode == LocationMode.Off,
              onClick = { viewModel.setLocationMode(LocationMode.Off) },
            )
          },
        )
        ListItem(
          headlineContent = { Text("While Using") },
          supportingContent = { Text("Only while Moltbot is open.") },
          trailingContent = {
            RadioButton(
              selected = locationMode == LocationMode.WhileUsing,
              onClick = { requestLocationPermissions(LocationMode.WhileUsing) },
            )
          },
        )
        ListItem(
          headlineContent = { Text("Always") },
          supportingContent = { Text("Allow background location (requires system permission).") },
          trailingContent = {
            RadioButton(
              selected = locationMode == LocationMode.Always,
              onClick = { requestLocationPermissions(LocationMode.Always) },
            )
          },
        )
      }
    }
    item {
      ListItem(
        headlineContent = { Text("Precise Location") },
        supportingContent = { Text("Use precise GPS when available.") },
        trailingContent = {
          Switch(
            checked = locationPreciseEnabled,
            onCheckedChange = ::setPreciseLocationChecked,
            enabled = locationMode != LocationMode.Off,
          )
        },
      )
    }
    item {
      Text(
        "Always may require Android Settings to allow background location.",
        color = MaterialTheme.colorScheme.onSurfaceVariant,
      )
    }

    item { HorizontalDivider() }

    // Screen
    item { Text("Screen", style = MaterialTheme.typography.titleSmall) }
    item {
      ListItem(
        headlineContent = { Text("Prevent Sleep") },
        supportingContent = { Text("Keeps the screen awake while Moltbot is open.") },
        trailingContent = { Switch(checked = preventSleep, onCheckedChange = viewModel::setPreventSleep) },
      )
    }

    item { HorizontalDivider() }

    // Debug
    item { Text("Debug", style = MaterialTheme.typography.titleSmall) }
    item {
      ListItem(
        headlineContent = { Text("Debug Canvas Status") },
        supportingContent = { Text("Show status text in the canvas when debug is enabled.") },
        trailingContent = {
          Switch(
            checked = canvasDebugStatusEnabled,
            onCheckedChange = viewModel::setCanvasDebugStatusEnabled,
          )
        },
      )
    }

    item { Spacer(modifier = Modifier.height(20.dp)) }
  }
}

private fun openAppSettings(context: Context) {
  val intent =
    Intent(
      Settings.ACTION_APPLICATION_DETAILS_SETTINGS,
      Uri.fromParts("package", context.packageName, null),
    )
  context.startActivity(intent)
}
