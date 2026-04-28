package ai.openclaw.app.node

import ai.openclaw.app.NotificationBurstLimiter
import ai.openclaw.app.SecurePrefs
import ai.openclaw.app.allowsPackage
import ai.openclaw.app.isWithinQuietHours
import android.app.Notification
import android.app.NotificationManager
import android.app.RemoteInput
import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.service.notification.NotificationListenerService
import android.service.notification.StatusBarNotification
import androidx.core.content.edit
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put

private const val MAX_NOTIFICATION_TEXT_CHARS = 512
private const val NOTIFICATIONS_CHANGED_EVENT = "notifications.changed"

internal fun sanitizeNotificationText(value: CharSequence?): String? {
  val normalized = value?.toString()?.trim().orEmpty()
  return normalized.take(MAX_NOTIFICATION_TEXT_CHARS).ifEmpty { null }
}

data class DeviceNotificationEntry(
  val key: String,
  val packageName: String,
  val title: String?,
  val text: String?,
  val subText: String?,
  val category: String?,
  val channelId: String?,
  val postTimeMs: Long,
  val isOngoing: Boolean,
  val isClearable: Boolean,
)

internal fun DeviceNotificationEntry.toJsonObject(): JsonObject =
  buildJsonObject {
    put("key", JsonPrimitive(key))
    put("packageName", JsonPrimitive(packageName))
    put("postTimeMs", JsonPrimitive(postTimeMs))
    put("isOngoing", JsonPrimitive(isOngoing))
    put("isClearable", JsonPrimitive(isClearable))
    title?.let { put("title", JsonPrimitive(it)) }
    text?.let { put("text", JsonPrimitive(it)) }
    subText?.let { put("subText", JsonPrimitive(it)) }
    category?.let { put("category", JsonPrimitive(it)) }
    channelId?.let { put("channelId", JsonPrimitive(it)) }
  }

data class DeviceNotificationSnapshot(
  val enabled: Boolean,
  val connected: Boolean,
  val notifications: List<DeviceNotificationEntry>,
)

enum class NotificationActionKind {
  Open,
  Dismiss,
  Reply,
}

data class NotificationActionRequest(
  val key: String,
  val kind: NotificationActionKind,
  val replyText: String? = null,
)

data class NotificationActionResult(
  val ok: Boolean,
  val code: String? = null,
  val message: String? = null,
)

internal fun actionRequiresClearableNotification(kind: NotificationActionKind): Boolean = kind == NotificationActionKind.Dismiss

private object DeviceNotificationStore {
  private val lock = Any()
  private var connected = false
  private val byKey = LinkedHashMap<String, DeviceNotificationEntry>()

  fun replace(entries: List<DeviceNotificationEntry>) {
    synchronized(lock) {
      byKey.clear()
      for (entry in entries) {
        byKey[entry.key] = entry
      }
    }
  }

  fun upsert(entry: DeviceNotificationEntry) {
    synchronized(lock) {
      byKey[entry.key] = entry
    }
  }

  fun remove(key: String) {
    synchronized(lock) {
      byKey.remove(key)
    }
  }

  fun setConnected(value: Boolean) {
    synchronized(lock) {
      connected = value
      if (!value) {
        byKey.clear()
      }
    }
  }

  fun snapshot(enabled: Boolean): DeviceNotificationSnapshot {
    val (isConnected, entries) =
      synchronized(lock) {
        connected to byKey.values.sortedByDescending { it.postTimeMs }
      }
    return DeviceNotificationSnapshot(
      enabled = enabled,
      connected = isConnected,
      notifications = entries,
    )
  }
}

class DeviceNotificationListenerService : NotificationListenerService() {
  private val securePrefs by lazy { SecurePrefs(applicationContext) }
  private val forwardingLimiter = NotificationBurstLimiter()

  override fun onListenerConnected() {
    super.onListenerConnected()
    activeService = this
    DeviceNotificationStore.setConnected(true)
    refreshActiveNotifications()
  }

  override fun onListenerDisconnected() {
    if (activeService === this) {
      activeService = null
    }
    DeviceNotificationStore.setConnected(false)
    super.onListenerDisconnected()
  }

  override fun onDestroy() {
    if (activeService === this) {
      activeService = null
    }
    super.onDestroy()
  }

  override fun onNotificationPosted(sbn: StatusBarNotification?) {
    super.onNotificationPosted(sbn)
    val entry = sbn?.toEntry() ?: return
    DeviceNotificationStore.upsert(entry)
    rememberRecentPackage(entry.packageName)
    if (entry.packageName == packageName) {
      return
    }
    val payload = notificationChangedPayload(entry) ?: return
    emitNotificationsChanged(payload)
  }

  override fun onNotificationRemoved(sbn: StatusBarNotification?) {
    super.onNotificationRemoved(sbn)
    val removed = sbn ?: return
    val key = removed.key.trim()
    if (key.isEmpty()) {
      return
    }
    DeviceNotificationStore.remove(key)
    rememberRecentPackage(removed.packageName)
    if (removed.packageName == packageName) {
      return
    }
    val packageName = removed.packageName.trim()
    val payload =
      notificationChangedPayload(
        entry = null,
        change = "removed",
        key = key,
        packageName = packageName,
        postTimeMs = removed.postTime,
        isOngoing = removed.isOngoing,
        isClearable = removed.isClearable,
      ) ?: return
    emitNotificationsChanged(payload)
  }

  private fun notificationChangedPayload(entry: DeviceNotificationEntry): String? =
    notificationChangedPayload(
      entry = entry,
      change = "posted",
      key = entry.key,
      packageName = entry.packageName,
      postTimeMs = entry.postTimeMs,
      isOngoing = entry.isOngoing,
      isClearable = entry.isClearable,
    )

  private fun notificationChangedPayload(
    entry: DeviceNotificationEntry?,
    change: String,
    key: String,
    packageName: String,
    postTimeMs: Long,
    isOngoing: Boolean,
    isClearable: Boolean,
  ): String? {
    val normalizedPackage = packageName.trim()
    if (normalizedPackage.isEmpty()) {
      return null
    }
    val policy = securePrefs.getNotificationForwardingPolicy(appPackageName = this.packageName)
    if (!policy.enabled) {
      return null
    }
    if (!policy.allowsPackage(normalizedPackage)) {
      return null
    }
    val nowEpochMs = System.currentTimeMillis()
    if (policy.isWithinQuietHours(nowEpochMs = nowEpochMs)) {
      return null
    }
    if (!forwardingLimiter.allow(nowEpochMs, policy.maxEventsPerMinute)) {
      return null
    }
    return buildJsonObject {
      put("change", JsonPrimitive(change))
      put("key", JsonPrimitive(key))
      put("packageName", JsonPrimitive(normalizedPackage))
      put("postTimeMs", JsonPrimitive(postTimeMs))
      put("isOngoing", JsonPrimitive(isOngoing))
      put("isClearable", JsonPrimitive(isClearable))
      policy.sessionKey?.let { put("sessionKey", JsonPrimitive(it)) }
      entry?.title?.let { put("title", JsonPrimitive(it)) }
      entry?.text?.let { put("text", JsonPrimitive(it)) }
      entry?.subText?.let { put("subText", JsonPrimitive(it)) }
      entry?.category?.let { put("category", JsonPrimitive(it)) }
      entry?.channelId?.let { put("channelId", JsonPrimitive(it)) }
    }.toString()
  }

  private fun refreshActiveNotifications() {
    val entries =
      runCatching {
        activeNotifications
          ?.mapNotNull { it.toEntry() }
          ?: emptyList()
      }.getOrElse { emptyList() }
    DeviceNotificationStore.replace(entries)
  }

  private fun StatusBarNotification.toEntry(): DeviceNotificationEntry {
    val extras = notification.extras
    val keyValue = key.takeIf { it.isNotBlank() } ?: "$packageName:$id:$postTime"
    val title = sanitizeNotificationText(extras?.getCharSequence(Notification.EXTRA_TITLE))
    val body =
      sanitizeNotificationText(extras?.getCharSequence(Notification.EXTRA_BIG_TEXT))
        ?: sanitizeNotificationText(extras?.getCharSequence(Notification.EXTRA_TEXT))
    val subText = sanitizeNotificationText(extras?.getCharSequence(Notification.EXTRA_SUB_TEXT))
    return DeviceNotificationEntry(
      key = keyValue,
      packageName = packageName,
      title = title,
      text = body,
      subText = subText,
      category = notification.category?.trim()?.ifEmpty { null },
      channelId = notification.channelId?.trim()?.ifEmpty { null },
      postTimeMs = postTime,
      isOngoing = isOngoing,
      isClearable = isClearable,
    )
  }

  companion object {
    private const val recentPackagesPref = "notifications.forwarding.recentPackages"
    private const val legacyRecentPackagesPref = "notifications.recentPackages"
    private const val recentPackagesLimit = 64

    @Volatile private var activeService: DeviceNotificationListenerService? = null

    @Volatile private var nodeEventSink: ((event: String, payloadJson: String?) -> Unit)? = null

    private fun serviceComponent(context: Context): ComponentName = ComponentName(context, DeviceNotificationListenerService::class.java)

    fun setNodeEventSink(sink: ((event: String, payloadJson: String?) -> Unit)?) {
      nodeEventSink = sink
    }

    private fun recentPackagesPrefs(context: Context) = context.applicationContext.getSharedPreferences("openclaw.secure", Context.MODE_PRIVATE)

    private fun migrateLegacyRecentPackagesIfNeeded(context: Context) {
      val prefs = recentPackagesPrefs(context)
      val hasNew = prefs.contains(recentPackagesPref)
      val legacy = prefs.getString(legacyRecentPackagesPref, null)?.trim().orEmpty()
      if (!hasNew && legacy.isNotEmpty()) {
        prefs.edit {
          putString(recentPackagesPref, legacy)
          remove(legacyRecentPackagesPref)
        }
      } else if (hasNew && prefs.contains(legacyRecentPackagesPref)) {
        prefs.edit { remove(legacyRecentPackagesPref) }
      }
    }

    fun recentPackages(context: Context): List<String> {
      migrateLegacyRecentPackagesIfNeeded(context)
      val prefs = recentPackagesPrefs(context)
      val stored = prefs.getString(recentPackagesPref, null).orEmpty()
      return stored
        .split(',')
        .map { it.trim() }
        .filter { it.isNotEmpty() }
        .distinct()
    }

    fun isAccessEnabled(context: Context): Boolean {
      val manager = context.getSystemService(NotificationManager::class.java) ?: return false
      return manager.isNotificationListenerAccessGranted(serviceComponent(context))
    }

    fun snapshot(
      context: Context,
      enabled: Boolean = isAccessEnabled(context),
    ): DeviceNotificationSnapshot = DeviceNotificationStore.snapshot(enabled = enabled)

    fun requestServiceRebind(context: Context) {
      runCatching {
        NotificationListenerService.requestRebind(serviceComponent(context))
      }
    }

    fun executeAction(
      context: Context,
      request: NotificationActionRequest,
    ): NotificationActionResult {
      if (!isAccessEnabled(context)) {
        return NotificationActionResult(
          ok = false,
          code = "NOTIFICATIONS_DISABLED",
          message = "NOTIFICATIONS_DISABLED: enable notification access in system Settings",
        )
      }
      val service =
        activeService
          ?: return NotificationActionResult(
            ok = false,
            code = "NOTIFICATIONS_UNAVAILABLE",
            message = "NOTIFICATIONS_UNAVAILABLE: notification listener not connected",
          )
      return service.executeActionInternal(request)
    }

    private fun emitNotificationsChanged(payloadJson: String) {
      runCatching {
        nodeEventSink?.invoke(NOTIFICATIONS_CHANGED_EVENT, payloadJson)
      }
    }

    private fun rememberRecentPackage(packageName: String?) {
      val service = activeService ?: return
      val normalized = packageName?.trim().orEmpty()
      if (normalized.isEmpty() || normalized == service.packageName) return
      migrateLegacyRecentPackagesIfNeeded(service.applicationContext)
      val prefs = recentPackagesPrefs(service.applicationContext)
      val existing =
        prefs
          .getString(recentPackagesPref, null)
          .orEmpty()
          .split(',')
          .map { it.trim() }
          .filter { it.isNotEmpty() && it != normalized }
          .take(recentPackagesLimit - 1)
      val updated = listOf(normalized) + existing
      prefs.edit { putString(recentPackagesPref, updated.joinToString(",")) }
    }
  }

  private fun executeActionInternal(request: NotificationActionRequest): NotificationActionResult {
    val sbn =
      activeNotifications
        ?.firstOrNull { it.key == request.key }
        ?: return NotificationActionResult(
          ok = false,
          code = "NOTIFICATION_NOT_FOUND",
          message = "NOTIFICATION_NOT_FOUND: notification key not found",
        )
    if (actionRequiresClearableNotification(request.kind) && !sbn.isClearable) {
      return NotificationActionResult(
        ok = false,
        code = "NOTIFICATION_NOT_CLEARABLE",
        message = "NOTIFICATION_NOT_CLEARABLE: notification is ongoing or protected",
      )
    }

    return when (request.kind) {
      NotificationActionKind.Open -> {
        val pendingIntent =
          sbn.notification.contentIntent
            ?: return NotificationActionResult(
              ok = false,
              code = "ACTION_UNAVAILABLE",
              message = "ACTION_UNAVAILABLE: notification has no open action",
            )
        runCatching {
          pendingIntent.send()
        }.fold(
          onSuccess = { NotificationActionResult(ok = true) },
          onFailure = { err ->
            NotificationActionResult(
              ok = false,
              code = "ACTION_FAILED",
              message = "ACTION_FAILED: ${err.message ?: "open failed"}",
            )
          },
        )
      }

      NotificationActionKind.Dismiss -> {
        runCatching {
          cancelNotification(sbn.key)
          DeviceNotificationStore.remove(sbn.key)
        }.fold(
          onSuccess = { NotificationActionResult(ok = true) },
          onFailure = { err ->
            NotificationActionResult(
              ok = false,
              code = "ACTION_FAILED",
              message = "ACTION_FAILED: ${err.message ?: "dismiss failed"}",
            )
          },
        )
      }

      NotificationActionKind.Reply -> {
        val replyText = request.replyText?.trim().orEmpty()
        if (replyText.isEmpty()) {
          return NotificationActionResult(
            ok = false,
            code = "INVALID_REQUEST",
            message = "INVALID_REQUEST: replyText required for reply action",
          )
        }
        val action =
          sbn.notification.actions
            ?.firstOrNull { candidate ->
              candidate.actionIntent != null && !candidate.remoteInputs.isNullOrEmpty()
            }
            ?: return NotificationActionResult(
              ok = false,
              code = "ACTION_UNAVAILABLE",
              message = "ACTION_UNAVAILABLE: notification has no reply action",
            )
        val remoteInputs = action.remoteInputs ?: emptyArray()
        val fillInIntent = Intent()
        val replyBundle = android.os.Bundle()
        for (remoteInput in remoteInputs) {
          replyBundle.putCharSequence(remoteInput.resultKey, replyText)
        }
        RemoteInput.addResultsToIntent(remoteInputs, fillInIntent, replyBundle)
        runCatching {
          action.actionIntent.send(this, 0, fillInIntent)
        }.fold(
          onSuccess = { NotificationActionResult(ok = true) },
          onFailure = { err ->
            NotificationActionResult(
              ok = false,
              code = "ACTION_FAILED",
              message = "ACTION_FAILED: ${err.message ?: "reply failed"}",
            )
          },
        )
      }
    }
  }
}
