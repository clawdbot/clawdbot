package ai.openclaw.app.ui

import ai.openclaw.app.MainViewModel
import ai.openclaw.app.accessibility.AccessibilityComponentController
import ai.openclaw.app.i18n.nativeString
import android.content.Context
import android.content.Intent
import android.provider.Settings
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ScreenShare
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.unit.dp

@Composable
internal fun FlavorPhoneCapabilitiesSettings(viewModel: MainViewModel) {
  val context = LocalContext.current
  val enabled by viewModel.accessibilityControlEnabled.collectAsState()
  var showDisclosure by rememberSaveable { mutableStateOf(false) }

  fun setControlEnabled(checked: Boolean) {
    if (checked) {
      showDisclosure = true
      return
    }
    viewModel.setAccessibilityControlEnabled(false)
    AccessibilityComponentController(context).setEnabled(false)
  }

  SettingsTogglePanel(
    rows =
      listOf(
        SettingsToggleRow(
          title = nativeString("Control other apps"),
          subtitle =
            if (enabled) {
              nativeString("Shown in Android Accessibility settings.")
            } else {
              nativeString("Other apps stay untouched.")
            },
          icon = Icons.AutoMirrored.Filled.ScreenShare,
          checked = enabled,
          onCheckedChange = ::setControlEnabled,
        ),
      ),
  )

  if (showDisclosure) {
    AccessibilityControlDisclosureDialog(
      onDismiss = { showDisclosure = false },
      onAgree = {
        showDisclosure = false
        viewModel.setAccessibilityControlEnabled(true)
        AccessibilityComponentController(context).setEnabled(true)
        openAccessibilitySettings(context)
      },
    )
  }
}

@Composable
private fun AccessibilityControlDisclosureDialog(
  onDismiss: () -> Unit,
  onAgree: () -> Unit,
) {
  AlertDialog(
    onDismissRequest = onDismiss,
    title = { Text(nativeString("Allow control of other apps?")) },
    text = {
      Column(verticalArrangement = Arrangement.spacedBy(10.dp)) {
        Text(
          nativeString(
            "Enabling lets OpenClaw observe and control other apps' screens when armed. Android accessibility access is required.",
          ),
        )
      }
    },
    confirmButton = {
      TextButton(onClick = onAgree) {
        Text(nativeString("Enable and Open Settings"))
      }
    },
    dismissButton = {
      TextButton(onClick = onDismiss) {
        Text(nativeString("Not Now"))
      }
    },
  )
}

private fun openAccessibilitySettings(context: Context) {
  val intent = Intent(Settings.ACTION_ACCESSIBILITY_SETTINGS).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
  context.startActivity(intent)
}
