package ai.openclaw.app

import ai.openclaw.app.i18n.nativeString
import android.Manifest
import android.content.Context
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
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.CoroutineStart
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.filterNotNull
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.launch
import kotlinx.coroutines.suspendCancellableCoroutine
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.coroutines.withContext
import kotlinx.coroutines.withTimeout
import java.util.IdentityHashMap
import java.util.concurrent.atomic.AtomicBoolean
import kotlin.coroutines.resume

/**
 * Serializes Android runtime-permission prompts behind coroutine-friendly request calls.
 */
class PermissionRequester internal constructor(
  context: Context,
  private val requestCodeAllocator: PermissionRequestCodeAllocator = PermissionRequestCodeAllocator(),
) {
  private data class ActivityHost(
    val activity: ComponentActivity,
    val permissionRequestLauncher: (Array<String>, Int) -> Unit,
  )

  private data class ActiveActivityHost(
    val host: ActivityHost,
    val activation: Long,
  )

  private data class PendingPermissionRequest(
    val requestCode: Int,
    val permissions: List<String>,
    val deferred: CompletableDeferred<Map<String, Boolean>>,
  )

  private enum class RationaleResult {
    Proceed,
    Decline,
    HostLost,
  }

  private enum class SettingsResult {
    Shown,
    HostLost,
  }

  private val appContext = context.applicationContext
  private val mutex = Mutex()
  private val activityHostLock = Any()
  private val permissionRequestsLock = Any()
  private val mainHandler = Handler(Looper.getMainLooper())
  private val activityHosts = IdentityHashMap<ComponentActivity, ActivityHost>()
  private val activeActivitySequences = IdentityHashMap<ComponentActivity, Long>()
  private val activeActivityHost = MutableStateFlow<ActiveActivityHost?>(null)
  private var nextActivityActivation = 0L
  private val pendingPermissionRequests = mutableMapOf<Int, PendingPermissionRequest>()

  internal fun attach(
    activity: ComponentActivity,
    permissionRequestLauncher: (Array<String>, Int) -> Unit = { permissions, requestCode ->
      ActivityCompat.requestPermissions(activity, permissions, requestCode)
    },
  ) {
    synchronized(activityHostLock) {
      activityHosts[activity] = ActivityHost(activity, permissionRequestLauncher)
      publishActiveActivityHostLocked()
    }
  }

  internal fun activate(activity: ComponentActivity) {
    synchronized(activityHostLock) {
      check(activityHosts.containsKey(activity)) { "permission Activity must attach before activation" }
      nextActivityActivation += 1
      activeActivitySequences[activity] = nextActivityActivation
      publishActiveActivityHostLocked()
    }
  }

  internal fun deactivate(activity: ComponentActivity) {
    synchronized(activityHostLock) {
      activeActivitySequences.remove(activity)
      publishActiveActivityHostLocked()
    }
  }

  internal fun detach(activity: ComponentActivity) {
    synchronized(activityHostLock) {
      activeActivitySequences.remove(activity)
      activityHosts.remove(activity)
      publishActiveActivityHostLocked()
    }
  }

  /**
   * Request missing Android runtime permissions and return the final grant state for every requested permission.
   */
  suspend fun requestIfMissing(
    permissions: List<String>,
    timeoutMs: Long = 20_000,
  ): Map<String, Boolean> =
    mutex.withLock {
      val missing =
        permissions.filter { perm ->
          ContextCompat.checkSelfPermission(appContext, perm) != PackageManager.PERMISSION_GRANTED
        }
      if (missing.isEmpty()) return@withLock permissions.associateWith { true }

      if (!confirmRationaleIfNeeded(missing, timeoutMs)) {
        return@withLock permissions.associateWith { perm ->
          ContextCompat.checkSelfPermission(appContext, perm) == PackageManager.PERMISSION_GRANTED
        }
      }

      val request = reservePermissionRequest(missing)
      val result =
        try {
          launchPermissionRequest(missing, request.requestCode, timeoutMs)
          withTimeout(timeoutMs) { request.deferred.await() }
        } finally {
          // Retire the code on launch failure, timeout, or cancellation before admitting another prompt.
          clearPermissionRequest(request)
        }

      val merged =
        permissions.associateWith { perm ->
          val nowGranted =
            ContextCompat.checkSelfPermission(appContext, perm) == PackageManager.PERMISSION_GRANTED
          result[perm] == true || nowGranted
        }

      showSettingsForPermanentDenials(merged, timeoutMs)
      merged
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
  ): PendingPermissionRequest =
    synchronized(permissionRequestsLock) {
      val requestCode = requestCodeAllocator.allocate(pendingPermissionRequests::containsKey)
      val request = PendingPermissionRequest(requestCode, permissions, CompletableDeferred())
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

  private fun publishActiveActivityHostLocked() {
    val active =
      activeActivitySequences.entries.maxByOrNull { it.value }?.let { entry ->
        activityHosts[entry.key]?.let { host ->
          ActiveActivityHost(host = host, activation = entry.value)
        }
      }
    activeActivityHost.value = active
  }

  private suspend fun awaitActiveActivityHost(timeoutMs: Long): ActiveActivityHost =
    withTimeout(timeoutMs) {
      activeActivityHost
        .filterNotNull()
        .first { active ->
          !active.host.activity.isFinishing && !active.host.activity.isDestroyed
        }
    }

  private suspend fun launchPermissionRequest(
    permissions: List<String>,
    requestCode: Int,
    timeoutMs: Long,
  ) {
    withTimeout(timeoutMs) {
      var rejected: ActiveActivityHost? = null
      while (true) {
        val active =
          activeActivityHost
            .filterNotNull()
            .first { candidate ->
              candidate != rejected &&
                !candidate.host.activity.isFinishing &&
                !candidate.host.activity.isDestroyed
            }
        val launched =
          withContext(Dispatchers.Main) {
            if (activeActivityHost.value != active) return@withContext false
            val host = active.host
            if (host.activity.isFinishing || host.activity.isDestroyed) return@withContext false
            host.permissionRequestLauncher(permissions.toTypedArray(), requestCode)
            true
          }
        if (launched) return@withTimeout
        rejected = active
      }
    }
  }

  private suspend fun confirmRationaleIfNeeded(
    permissions: List<String>,
    timeoutMs: Long,
  ): Boolean =
    withTimeout(timeoutMs) {
      while (true) {
        val active = awaitActiveActivityHost(timeoutMs)
        val needsRationale =
          withContext(Dispatchers.Main) {
            if (!isCurrentActiveHost(active)) return@withContext null
            permissions.any { permission ->
              ActivityCompat.shouldShowRequestPermissionRationale(active.host.activity, permission)
            }
          } ?: continue
        if (!needsRationale) return@withTimeout true
        when (showRationaleDialog(active, permissions)) {
          RationaleResult.Proceed -> return@withTimeout true
          RationaleResult.Decline -> return@withTimeout false
          RationaleResult.HostLost -> Unit
        }
      }
      error("unreachable")
    }

  private suspend fun showSettingsForPermanentDenials(
    grants: Map<String, Boolean>,
    timeoutMs: Long,
  ) {
    if (grants.values.none { granted -> !granted }) return
    withTimeout(timeoutMs) {
      while (true) {
        val active = awaitActiveActivityHost(timeoutMs)
        val denied =
          withContext(Dispatchers.Main) {
            if (!isCurrentActiveHost(active)) return@withContext null
            grants
              .filterValues { granted -> !granted }
              .keys
              .filter { permission ->
                !ActivityCompat.shouldShowRequestPermissionRationale(active.host.activity, permission)
              }
          } ?: continue
        if (denied.isEmpty()) return@withTimeout
        when (showSettingsDialog(active, denied)) {
          SettingsResult.Shown -> return@withTimeout
          SettingsResult.HostLost -> Unit
        }
      }
    }
  }

  private fun isCurrentActiveHost(active: ActiveActivityHost): Boolean =
    activeActivityHost.value == active &&
      !active.host.activity.isFinishing &&
      !active.host.activity.isDestroyed

  private suspend fun showRationaleDialog(
    active: ActiveActivityHost,
    permissions: List<String>,
  ): RationaleResult =
    showPermissionDialog(active, RationaleResult.HostLost) { activity, finish ->
      AlertDialog
        .Builder(activity)
        .setTitle(nativeString("Permission required"))
        .setMessage(buildRationaleMessage(permissions))
        .setPositiveButton(nativeString("Continue")) { _, _ -> finish(RationaleResult.Proceed) }
        .setNegativeButton(nativeString("Not now")) { _, _ -> finish(RationaleResult.Decline) }
        .setOnCancelListener { finish(RationaleResult.Decline) }
        .show()
    }

  private suspend fun showSettingsDialog(
    active: ActiveActivityHost,
    permissions: List<String>,
  ): SettingsResult =
    showPermissionDialog(active, SettingsResult.HostLost) { activity, finish ->
      AlertDialog
        .Builder(activity)
        .setTitle(nativeString("Enable permission in Settings"))
        .setMessage(buildSettingsMessage(permissions))
        .setPositiveButton(nativeString("Open Settings")) { _, _ ->
          if (!isCurrentActiveHost(active)) {
            finish(SettingsResult.HostLost)
            return@setPositiveButton
          }
          val intent =
            Intent(
              Settings.ACTION_APPLICATION_DETAILS_SETTINGS,
              Uri.fromParts("package", activity.packageName, null),
            )
          activity.startActivity(intent)
          finish(SettingsResult.Shown)
        }.setNegativeButton(nativeString("Cancel")) { _, _ ->
          finish(SettingsResult.Shown)
        }.setOnCancelListener { finish(SettingsResult.Shown) }
        .setOnDismissListener { finish(SettingsResult.Shown) }
        .show()
    }

  private suspend fun <T : Any> showPermissionDialog(
    active: ActiveActivityHost,
    hostLost: T,
    buildDialog: (ComponentActivity, (T) -> Unit) -> AlertDialog,
  ): T =
    withContext(Dispatchers.Main) {
      if (!isCurrentActiveHost(active)) return@withContext hostLost
      val activity = active.host.activity
      suspendCancellableCoroutine { cont ->
        val lifecycle = activity.lifecycle
        var dialog: AlertDialog? = null
        var observer: LifecycleEventObserver? = null
        var hostLossJob: Job? = null
        val finished = AtomicBoolean(false)

        fun finish(result: T?) {
          if (!finished.compareAndSet(false, true)) return
          hostLossJob?.cancel()
          hostLossJob = null
          observer?.let(lifecycle::removeObserver)
          observer = null
          dialog?.dismiss()
          if (result != null) cont.resume(result)
        }
        val actualObserver =
          LifecycleEventObserver { _, event ->
            if (event == Lifecycle.Event.ON_DESTROY) finish(hostLost)
          }
        observer = actualObserver
        lifecycle.addObserver(actualObserver)
        hostLossJob =
          CoroutineScope(cont.context)
            .launch(start = CoroutineStart.LAZY) {
              activeActivityHost.first { current -> current != active }
              finish(hostLost)
            }.also(Job::start)
        cont.invokeOnCancellation {
          mainHandler.post {
            finish(null)
          }
        }
        if (finished.get()) return@suspendCancellableCoroutine
        dialog = buildDialog(activity, ::finish)
      }
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
