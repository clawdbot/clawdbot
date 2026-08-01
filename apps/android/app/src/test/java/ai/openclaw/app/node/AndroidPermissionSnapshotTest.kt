package ai.openclaw.app.node

import android.Manifest
import android.app.Application
import android.content.pm.PackageManager
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import org.robolectric.Shadows.shadowOf
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34])
class AndroidPermissionSnapshotTest {
  @Test
  fun gatewayPermissions_keepIndependentlyGrantableAuthoritySeparate() {
    val app = appContext()
    shadowOf(app.packageManager).setSystemFeature(PackageManager.FEATURE_TELEPHONY, true)
    shadowOf(app).grantPermissions(
      Manifest.permission.CAMERA,
      Manifest.permission.ACCESS_COARSE_LOCATION,
      Manifest.permission.SEND_SMS,
      Manifest.permission.READ_CONTACTS,
      Manifest.permission.WRITE_CALENDAR,
    )

    val permissions =
      readAndroidPermissionSnapshot(
        context = app,
        smsEnabled = true,
        callLogEnabled = true,
        photosEnabled = true,
        backgroundLocationEnabled = true,
      ).gatewayPermissions()

    assertTrue(permissions.getValue("camera"))
    assertTrue(permissions.getValue("location"))
    assertFalse(permissions.getValue("locationPrecise"))
    assertFalse(permissions.getValue("locationBackground"))
    assertTrue(permissions.getValue("smsSend"))
    assertFalse(permissions.getValue("smsRead"))
    assertTrue(permissions.getValue("contactsRead"))
    assertFalse(permissions.getValue("contactsWrite"))
    assertFalse(permissions.getValue("calendarRead"))
    assertTrue(permissions.getValue("calendarWrite"))
  }

  @Test
  fun snapshotGatesVariantSpecificPermissionsByAvailableFeature() {
    val app = appContext()
    shadowOf(app.packageManager).setSystemFeature(PackageManager.FEATURE_TELEPHONY, true)
    shadowOf(app).grantPermissions(
      Manifest.permission.SEND_SMS,
      Manifest.permission.READ_SMS,
      Manifest.permission.READ_CALL_LOG,
      Manifest.permission.READ_MEDIA_IMAGES,
    )

    val snapshot =
      readAndroidPermissionSnapshot(
        context = app,
        smsEnabled = false,
        callLogEnabled = false,
        photosEnabled = false,
        backgroundLocationEnabled = false,
      )

    assertFalse(snapshot.smsSend)
    assertFalse(snapshot.smsRead)
    assertFalse(snapshot.callLog)
    assertFalse(snapshot.photos)
  }

  @Test
  fun backgroundLocationRequiresFeatureAndForegroundAuthority() {
    val app = appContext()
    shadowOf(app).grantPermissions(Manifest.permission.ACCESS_BACKGROUND_LOCATION)

    val withoutForeground =
      readAndroidPermissionSnapshot(
        context = app,
        smsEnabled = false,
        callLogEnabled = false,
        photosEnabled = false,
        backgroundLocationEnabled = true,
      )
    assertFalse(withoutForeground.locationBackground)

    shadowOf(app).grantPermissions(Manifest.permission.ACCESS_COARSE_LOCATION)
    val featureDisabled =
      readAndroidPermissionSnapshot(
        context = app,
        smsEnabled = false,
        callLogEnabled = false,
        photosEnabled = false,
        backgroundLocationEnabled = false,
      )
    assertFalse(featureDisabled.locationBackground)

    val available =
      readAndroidPermissionSnapshot(
        context = app,
        smsEnabled = false,
        callLogEnabled = false,
        photosEnabled = false,
        backgroundLocationEnabled = true,
      )
    assertTrue(available.locationBackground)
  }

  @Test
  fun gatewayPermissionOrderIsStable() {
    val permissions =
      readAndroidPermissionSnapshot(
        context = appContext(),
        smsEnabled = false,
        callLogEnabled = false,
        photosEnabled = false,
        backgroundLocationEnabled = false,
      ).gatewayPermissions()

    assertEquals(
      listOf(
        "camera",
        "microphone",
        "location",
        "locationPrecise",
        "locationBackground",
        "smsSend",
        "smsRead",
        "notificationListener",
        "notifications",
        "photos",
        "contactsRead",
        "contactsWrite",
        "calendarRead",
        "calendarWrite",
        "callLog",
        "motion",
      ),
      permissions.keys.toList(),
    )
  }

  private fun appContext(): Application = RuntimeEnvironment.getApplication()
}
