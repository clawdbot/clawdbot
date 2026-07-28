package ai.openclaw.app

import ai.openclaw.app.i18n.nativeString
import android.Manifest
import android.content.Intent
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Handler
import android.os.Looper
import android.provider.Settings
import androidx.activity.ComponentActivity
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
import kotlinx.coroutines.withTimeout
import java.util.concurrent.atomic.AtomicBoolean
import kotlin.coroutines.resume

/**
 * Serializes Android runtime-permission prompts behind coroutine-friendly request calls.
 */
class PermissionRequester internal constructor(
  private val activity: ComponentActivity,
  private val permissionRequestLauncher: (Array<String>, Int) -> Unit,
  private val requestCodeAllocator: PermissionRequestCodeAllocator = PermissionRequestCodeAllocator(),
) {
  private data class PendingPermissionRequest(
    val requestCode: Int,
    val permissions: List<String>,
    val deferred: CompletableDeferred<Map<String, Boolean>>,
  )

  constructor(activity: ComponentActivity) : this(
    activity = activity,
    permissionRequestLauncher = { permissions, requestCode ->
      ActivityCompat.requestPermissions(activity, permissions, requestCode)
    },
  )

  private val mutex = Mutex()
  private val permissionRequestsLock = Any()
  private val mainHandler = Handler(Looper.getMainLooper())
  private val pendingPermissionRequests = mutableMapOf<Int, PendingPermissionRequest>()

  /**
   * Request missing Android runtime permissions and return the final grant state for every requested permission.
   */
  suspend fun requestIfMissing(
    permissions: List<String>,
    timeoutMs: Long = 20_000,
  ): Map<String, Boolean> {
    return mutex.withLock {
      while (true) {
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
        val request = reservePermissionRequest(missing, deferred)
        try {
          withContext(Dispatchers.Main) {
            permissionRequestLauncher(missing.toTypedArray(), request.requestCode)
          }
        } catch (err: Throwable) {
          clearPermissionRequest(request)
          throw err
        }

        val result =
          try {
            withTimeout(timeoutMs) { deferred.await() }
          } finally {
            // Timeout and caller cancellation both retire the request code before the mutex admits another prompt.
            clearPermissionRequest(request)
          }

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
      error("unreachable")
    }
  }

  internal fun onRequestPermissionsResult(
    requestCode: Int,
    permissions: Array<String>,
    grantResults: IntArray,
  ): Boolean {
    val request =
      synchronized(permissionRequestsLock) {
        pendingPermissionRequests.remove(requestCode)
      } ?: return false
    val grants =
      permissions
        .mapIndexed { index, permission ->
          permission to (grantResults.getOrNull(index) == PackageManager.PERMISSION_GRANTED)
        }.toMap()
    request.deferred.complete(request.permissions.associateWith { permission -> grants[permission] == true })
    return true
  }

  private fun reservePermissionRequest(
    permissions: List<String>,
    deferred: CompletableDeferred<Map<String, Boolean>>,
  ): PendingPermissionRequest =
    synchronized(permissionRequestsLock) {
      val requestCode = requestCodeAllocator.allocate(pendingPermissionRequests::containsKey)
      val request = PendingPermissionRequest(requestCode, permissions, deferred)
      pendingPermissionRequests[requestCode] = request
      request
    }

  private fun clearPermissionRequest(
    request: PendingPermissionRequest,
  ) {
    synchronized(permissionRequestsLock) {
      if (pendingPermissionRequests[request.requestCode] === request) {
        pendingPermissionRequests.remove(request.requestCode)
      }
    }
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
            // Do not resume a destroyed Activity with a positive result.
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
            .setTitle(nativeString("Permission required"))
            .setMessage(buildRationaleMessage(permissions))
            .setPositiveButton(nativeString("Continue")) { _, _ -> finish(true) }
            .setNegativeButton(nativeString("Not now")) { _, _ -> finish(false) }
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
          .setTitle(nativeString("Enable permission in Settings"))
          .setMessage(buildSettingsMessage(permissions))
          .setPositiveButton(nativeString("Open Settings")) { _, _ ->
            if (activity.isFinishing || activity.isDestroyed) return@setPositiveButton
            val intent =
              Intent(
                Settings.ACTION_APPLICATION_DETAILS_SETTINGS,
                Uri.fromParts("package", activity.packageName, null),
              )
            activity.startActivity(intent)
          }.setNegativeButton(nativeString("Cancel"), null)
          .setOnDismissListener { removeObserver() }
          .show()
    }

  private fun buildRationaleMessage(permissions: List<String>): String {
    val labels = permissions.map { permissionLabel(it) }
    return nativeString(
      "OpenClaw needs \${labels.joinToString(\", \")} permissions to continue.",
      labels.joinToString(", "),
    )
  }

  private fun buildSettingsMessage(permissions: List<String>): String {
    val labels = permissions.map { permissionLabel(it) }
    return nativeString(
      "Please enable \${labels.joinToString(\", \")} in Android Settings to continue.",
      labels.joinToString(", "),
    )
  }

  private fun permissionLabel(permission: String): String =
    when (permission) {
      Manifest.permission.CAMERA -> nativeString("Camera")
      Manifest.permission.RECORD_AUDIO -> nativeString("Microphone")
      Manifest.permission.SEND_SMS -> nativeString("Send SMS")
      Manifest.permission.READ_SMS -> nativeString("Read SMS")
      Manifest.permission.READ_CONTACTS -> nativeString("Read Contacts")
      Manifest.permission.WRITE_CONTACTS -> nativeString("Write Contacts")
      Manifest.permission.READ_CALENDAR -> nativeString("Read Calendar")
      Manifest.permission.WRITE_CALENDAR -> nativeString("Write Calendar")
      Manifest.permission.READ_CALL_LOG -> nativeString("Read Call Log")
      Manifest.permission.ACTIVITY_RECOGNITION -> nativeString("Motion Activity")
      Manifest.permission.READ_MEDIA_IMAGES -> nativeString("Photos")
      Manifest.permission.READ_MEDIA_VISUAL_USER_SELECTED -> nativeString("Photos")
      Manifest.permission.READ_EXTERNAL_STORAGE -> nativeString("Photos")
      else -> permission
    }
}

internal class PermissionRequestCodeAllocator(
  initialRequestCode: Int = FIRST_PERMISSION_REQUEST_CODE,
) {
  private var nextRequestCode = initialRequestCode

  init {
    require(initialRequestCode in FIRST_PERMISSION_REQUEST_CODE..LAST_PERMISSION_REQUEST_CODE)
  }

  fun allocate(isInUse: (Int) -> Boolean): Int {
    repeat(PERMISSION_REQUEST_CODE_COUNT) {
      val requestCode = nextRequestCode
      nextRequestCode =
        if (requestCode == LAST_PERMISSION_REQUEST_CODE) {
          FIRST_PERMISSION_REQUEST_CODE
        } else {
          requestCode + 1
        }
      if (!isInUse(requestCode)) return requestCode
    }
    error("permission request codes exhausted")
  }

  internal companion object {
    // AndroidX ActivityResultRegistry reserves request codes >= 0x10000. Direct ActivityCompat
    // requests stay in a disjoint 16-bit range and skip live codes when the counter wraps.
    const val FIRST_PERMISSION_REQUEST_CODE = 0x4C00
    const val LAST_PERMISSION_REQUEST_CODE = 0xFFFF
    private const val PERMISSION_REQUEST_CODE_COUNT =
      LAST_PERMISSION_REQUEST_CODE - FIRST_PERMISSION_REQUEST_CODE + 1
  }
}
