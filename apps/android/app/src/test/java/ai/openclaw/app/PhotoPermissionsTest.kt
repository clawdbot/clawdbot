package ai.openclaw.app

import android.Manifest
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
class PhotoPermissionsTest {
  @Test
  @Config(sdk = [34])
  fun api34RequestsFullAndSelectedPhotoPermissions() {
    assertEquals(
      listOf(
        Manifest.permission.READ_MEDIA_IMAGES,
        Manifest.permission.READ_MEDIA_VISUAL_USER_SELECTED,
      ),
      photoReadPermissionsForRequest(),
    )
  }

  @Test
  @Config(sdk = [34])
  fun api34TreatsSelectedPhotoPermissionAsPhotoAccess() {
    val app = RuntimeEnvironment.getApplication()
    shadowOf(app).grantPermissions(Manifest.permission.READ_MEDIA_VISUAL_USER_SELECTED)

    assertTrue(hasPhotoReadPermission(app))
  }

  @Test
  @Config(sdk = [34])
  fun api34ReportsNoPhotoAccessWhenNeitherFullNorSelectedPermissionIsGranted() {
    assertFalse(hasPhotoReadPermission(RuntimeEnvironment.getApplication()))
  }

  @Test
  @Config(sdk = [33])
  fun api33RequestsImagePermissionOnly() {
    assertEquals(listOf(Manifest.permission.READ_MEDIA_IMAGES), photoReadPermissionsForRequest())
  }
}
