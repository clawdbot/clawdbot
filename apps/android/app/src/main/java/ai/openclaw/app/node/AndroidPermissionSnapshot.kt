package ai.openclaw.app.node

import ai.openclaw.app.hasPhotoReadPermission
import android.Manifest
import android.content.Context
import android.content.pm.PackageManager
import android.os.Build
import androidx.core.content.ContextCompat

/**
 * Canonical Android authority snapshot shared by node approval and device.permissions.
 */
internal data class AndroidPermissionSnapshot(
  val camera: Boolean,
  val microphone: Boolean,
  val location: Boolean,
  val locationPrecise: Boolean,
  val locationBackground: Boolean,
  val smsSend: Boolean,
  val smsRead: Boolean,
  val notificationListener: Boolean,
  val notifications: Boolean,
  val photos: Boolean,
  val contactsRead: Boolean,
  val contactsWrite: Boolean,
  val calendarRead: Boolean,
  val calendarWrite: Boolean,
  val callLog: Boolean,
  val motion: Boolean,
) {
  /**
   * Keep independently grantable authority separate so any widening requires node reapproval.
   */
  fun gatewayPermissions(): Map<String, Boolean> =
    linkedMapOf(
      "camera" to camera,
      "microphone" to microphone,
      "location" to location,
      "locationPrecise" to locationPrecise,
      "locationBackground" to locationBackground,
      "smsSend" to smsSend,
      "smsRead" to smsRead,
      "notificationListener" to notificationListener,
      "notifications" to notifications,
      "photos" to photos,
      "contactsRead" to contactsRead,
      "contactsWrite" to contactsWrite,
      "calendarRead" to calendarRead,
      "calendarWrite" to calendarWrite,
      "callLog" to callLog,
      "motion" to motion,
    )
}

internal fun readAndroidPermissionSnapshot(
  context: Context,
  smsEnabled: Boolean,
  callLogEnabled: Boolean,
  photosEnabled: Boolean,
  backgroundLocationEnabled: Boolean,
): AndroidPermissionSnapshot {
  fun hasPermission(permission: String): Boolean = ContextCompat.checkSelfPermission(context, permission) == PackageManager.PERMISSION_GRANTED

  val locationFine = hasPermission(Manifest.permission.ACCESS_FINE_LOCATION)
  val locationCoarse = hasPermission(Manifest.permission.ACCESS_COARSE_LOCATION)
  val telephonyAvailable = context.packageManager.hasSystemFeature(PackageManager.FEATURE_TELEPHONY)

  return AndroidPermissionSnapshot(
    camera = hasPermission(Manifest.permission.CAMERA),
    microphone = hasPermission(Manifest.permission.RECORD_AUDIO),
    location = locationFine || locationCoarse,
    locationPrecise = locationFine,
    locationBackground =
      backgroundLocationEnabled &&
        (locationFine || locationCoarse) &&
        hasPermission(Manifest.permission.ACCESS_BACKGROUND_LOCATION),
    smsSend = smsEnabled && telephonyAvailable && hasPermission(Manifest.permission.SEND_SMS),
    smsRead = smsEnabled && telephonyAvailable && hasPermission(Manifest.permission.READ_SMS),
    notificationListener = DeviceNotificationListenerService.isAccessEnabled(context),
    notifications =
      Build.VERSION.SDK_INT < 33 ||
        hasPermission(Manifest.permission.POST_NOTIFICATIONS),
    photos = photosEnabled && hasPhotoReadPermission(context),
    contactsRead = hasPermission(Manifest.permission.READ_CONTACTS),
    contactsWrite = hasPermission(Manifest.permission.WRITE_CONTACTS),
    calendarRead = hasPermission(Manifest.permission.READ_CALENDAR),
    calendarWrite = hasPermission(Manifest.permission.WRITE_CALENDAR),
    callLog = callLogEnabled && hasPermission(Manifest.permission.READ_CALL_LOG),
    motion = hasPermission(Manifest.permission.ACTIVITY_RECOGNITION),
  )
}
