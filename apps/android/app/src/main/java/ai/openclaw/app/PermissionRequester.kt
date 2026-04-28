package ai.openclaw.app

import android.Manifest
import android.content.Intent
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Handler
import android.os.Looper
import android.provider.Settings
import androidx.activity.ComponentActivity
import androidx.activity.result.ActivityResultLauncher
import androidx.activity.result.contract.ActivityResultContracts
import androidx.appcompat.app.AlertDialog
import androidx.core.app.ActivityCompat
import androidx.core.content.ContextCompat
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.LifecycleEventObserver
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.suspendCancellableCoroutine
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.coroutines.withContext
import java.util.concurrent.atomic.AtomicBoolean
import kotlin.coroutines.resume

class PermissionRequester(
  private val activity: ComponentActivity,
) {
  private val mutex = Mutex()
  private var pending: CompletableDeferred<Map<String, Boolean>>? = null
  private val mainHandler = Handler(Looper.getMainLooper())

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
      if (activity.isFinishing || activity.isDestroyed) {
        return@withContext false
      }
      suspendCancellableCoroutine { cont ->
        val lifecycle = activity.lifecycle
        var dialog: AlertDialog? = null
        var observer: LifecycleEventObserver? = null
        val finished = AtomicBoolean(false)
        val removeObserver = {
          observer?.let(lifecycle::removeObserver)
          observer = null
        }

        fun finish(result: Boolean?) {
          if (!finished.compareAndSet(false, true)) return
          removeObserver()
          dialog?.dismiss()
          if (result != null) {
            cont.resume(result)
          }
        }
        val actualObserver =
          LifecycleEventObserver { _, event ->
            if (event != Lifecycle.Event.ON_DESTROY) return@LifecycleEventObserver
            finish(false)
          }
        observer = actualObserver
        lifecycle.addObserver(actualObserver)
        cont.invokeOnCancellation {
          mainHandler.post {
            finish(null)
          }
        }
        dialog =
          AlertDialog
            .Builder(activity)
            .setTitle("Permission required")
            .setMessage(buildRationaleMessage(permissions))
            .setPositiveButton("Continue") { _, _ -> finish(true) }
            .setNegativeButton("Not now") { _, _ -> finish(false) }
            .setOnCancelListener { finish(false) }
            .show()
      }
    }

  private suspend fun showSettingsDialog(permissions: List<String>) =
    withContext(Dispatchers.Main) {
      if (activity.isFinishing || activity.isDestroyed) return@withContext
      val lifecycle = activity.lifecycle
      var dialog: AlertDialog? = null
      var observer: LifecycleEventObserver? = null
      val removeObserver = {
        observer?.let(lifecycle::removeObserver)
        observer = null
      }
      val actualObserver =
        LifecycleEventObserver { _, event ->
          if (event != Lifecycle.Event.ON_DESTROY) return@LifecycleEventObserver
          removeObserver()
          dialog?.dismiss()
        }
      observer = actualObserver
      lifecycle.addObserver(actualObserver)
      dialog =
        AlertDialog
          .Builder(activity)
          .setTitle("Enable permission in Settings")
          .setMessage(buildSettingsMessage(permissions))
          .setPositiveButton("Open Settings") { _, _ ->
            if (activity.isFinishing || activity.isDestroyed) return@setPositiveButton
            val intent =
              Intent(
                Settings.ACTION_APPLICATION_DETAILS_SETTINGS,
                Uri.fromParts("package", activity.packageName, null),
              )
            activity.startActivity(intent)
          }.setNegativeButton("Cancel", null)
          .setOnDismissListener { removeObserver() }
          .show()
    }

  private fun buildRationaleMessage(permissions: List<String>): String {
    val labels = permissions.map { permissionLabel(it) }
    return "OpenClaw needs ${labels.joinToString(", ")} permissions to continue."
  }

  private fun buildSettingsMessage(permissions: List<String>): String {
    val labels = permissions.map { permissionLabel(it) }
    return "Please enable ${labels.joinToString(", ")} in Android Settings to continue."
  }

  private fun permissionLabel(permission: String): String =
    when (permission) {
      Manifest.permission.CAMERA -> "Camera"
      Manifest.permission.RECORD_AUDIO -> "Microphone"
      Manifest.permission.SEND_SMS -> "Send SMS"
      Manifest.permission.READ_SMS -> "Read SMS"
      Manifest.permission.READ_CONTACTS -> "Read Contacts"
      Manifest.permission.WRITE_CONTACTS -> "Write Contacts"
      Manifest.permission.READ_CALENDAR -> "Read Calendar"
      Manifest.permission.WRITE_CALENDAR -> "Write Calendar"
      Manifest.permission.READ_CALL_LOG -> "Read Call Log"
      Manifest.permission.ACTIVITY_RECOGNITION -> "Motion Activity"
      Manifest.permission.READ_MEDIA_IMAGES -> "Photos"
      Manifest.permission.READ_EXTERNAL_STORAGE -> "Photos"
      else -> permission
    }
}
