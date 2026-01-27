package com.clawdbot.android

import android.content.pm.PackageManager
import android.content.Intent
import android.Manifest
import android.net.Uri
import android.provider.Settings
import androidx.appcompat.app.AlertDialog
import androidx.activity.ComponentActivity
import androidx.activity.result.ActivityResultLauncher
import androidx.activity.result.contract.ActivityResultContracts
import androidx.core.content.ContextCompat
import androidx.core.app.ActivityCompat
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.coroutines.withContext
import kotlinx.coroutines.suspendCancellableCoroutine
import kotlin.coroutines.resume

class PermissionRequester(private val activity: ComponentActivity) {
  private val mutex = Mutex()
  private var pending: CompletableDeferred<Map<String, Boolean>>? = null

  private val launcher: ActivityResultLauncher<Array<String>> =
    activity.registerForActivityResult(ActivityResultContracts.RequestMultiplePermissions()) { result ->
      val p = pending
      pending = null
      p?.complete(result)
    }

  suspend fun requestIfMissing(
    permissions: List<String>,
    timeoutMs: Long = 20_000,
  ): Map<String, Boolean> =
    mutex.withLock {
      val missing =
        permissions.filter { perm ->
          ContextCompat.checkSelfPermission(activity, perm) != PackageManager.PERMISSION_GRANTED
        }
      if (missing.isEmpty()) {
        return permissions.associateWith { true }
      }

      val needsRationale =
        missing.any { ActivityCompat.shouldShowRequestPermissionRationale(activity, it) }
      if (needsRationale) {
        val proceed = showRationaleDialog(missing)
        if (!proceed) {
          return permissions.associateWith { perm ->
            ContextCompat.checkSelfPermission(activity, perm) == PackageManager.PERMISSION_GRANTED
          }
        }
      }

      val deferred = CompletableDeferred<Map<String, Boolean>>()
      pending = deferred
      withContext(Dispatchers.Main) {
        launcher.launch(missing.toTypedArray())
      }

      val result =
        withContext(Dispatchers.Default) {
          kotlinx.coroutines.withTimeout(timeoutMs) { deferred.await() }
        }

      // Merge: if something was already granted, treat it as granted even if launcher omitted it.
      val merged =
        permissions.associateWith { perm ->
        val nowGranted =
          ContextCompat.checkSelfPermission(activity, perm) == PackageManager.PERMISSION_GRANTED
        result[perm] == true || nowGranted
      }

      val denied =
        merged.filterValues { !it }.keys.filter {
          !ActivityCompat.shouldShowRequestPermissionRationale(activity, it)
        }
      if (denied.isNotEmpty()) {
        showSettingsDialog(denied)
      }

      return merged
    }

  private suspend fun showRationaleDialog(permissions: List<String>): Boolean =
    withContext(Dispatchers.Main) {
      suspendCancellableCoroutine { cont ->
        AlertDialog.Builder(activity)
          .setTitle("Permission required")
          .setMessage(buildRationaleMessage(permissions))
          .setPositiveButton("Continue") { _, _ -> cont.resume(true) }
          .setNegativeButton("Not now") { _, _ -> cont.resume(false) }
          .setOnCancelListener { cont.resume(false) }
          .show()
      }
    }

  private fun showSettingsDialog(permissions: List<String>) {
    AlertDialog.Builder(activity)
      .setTitle("Enable permission in Settings")
      .setMessage(buildSettingsMessage(permissions))
      .setPositiveButton("Open Settings") { _, _ ->
        val intent =
          Intent(
            Settings.ACTION_APPLICATION_DETAILS_SETTINGS,
            Uri.fromParts("package", activity.packageName, null),
          )
        activity.startActivity(intent)
      }
      .setNegativeButton("Cancel", null)
      .show()
  }

  private fun buildRationaleMessage(permissions: List<String>): String {
    val labels = permissions.map { permissionLabel(it) }
    return "Moltbot needs ${labels.joinToString(", ")} permissions to continue."
  }

  private fun buildSettingsMessage(permissions: List<String>): String {
    val labels = permissions.map { permissionLabel(it) }
    return "Please enable ${labels.joinToString(", ")} in Android Settings to continue."
  }

  private fun permissionLabel(permission: String): String =
    when (permission) {
      Manifest.permission.CAMERA -> "Camera"
      Manifest.permission.RECORD_AUDIO -> "Microphone"
      Manifest.permission.SEND_SMS -> "SMS"
      else -> permission
    }
}
