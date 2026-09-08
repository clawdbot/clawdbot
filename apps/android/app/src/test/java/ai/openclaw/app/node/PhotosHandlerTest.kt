package ai.openclaw.app.node

import android.Manifest
import android.content.ContentProvider
import android.content.ContentResolver
import android.content.ContentValues
import android.content.Context
import android.content.pm.ProviderInfo
import android.database.Cursor
import android.database.sqlite.SQLiteDatabase
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.Paint
import android.net.Uri
import android.os.Bundle
import android.os.CancellationSignal
import android.os.ParcelFileDescriptor
import android.provider.MediaStore
import android.util.Base64
import androidx.exifinterface.media.ExifInterface
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.int
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import org.robolectric.RuntimeEnvironment
import org.robolectric.Shadows.shadowOf
import org.robolectric.annotation.GraphicsMode
import org.robolectric.shadows.ShadowContentResolver
import java.io.File

@GraphicsMode(GraphicsMode.Mode.NATIVE)
class PhotosHandlerTest : NodeHandlerRobolectricTest() {
  private val photoStores = mutableListOf<TestPhotoStore>()

  @After
  fun closePhotoStores() {
    photoStores.forEach(TestPhotoStore::close)
  }

  @Test
  fun handlePhotosLatest_requiresPermission() {
    val handler = PhotosHandler(appContext(), FakePhotosDataSource(hasPermission = false))

    val result = handler.handlePhotosLatest(null)

    assertFalse(result.ok)
    assertEquals("PHOTOS_PERMISSION_REQUIRED", result.error?.code)
  }

  @Test
  fun handlePhotosLatest_rejectsInvalidJson() {
    val handler = PhotosHandler(appContext(), FakePhotosDataSource(hasPermission = true))

    val result = handler.handlePhotosLatest("[]")

    assertFalse(result.ok)
    assertEquals("INVALID_REQUEST", result.error?.code)
  }

  @Test
  fun handlePhotosLatest_returnsPayload() {
    val source =
      FakePhotosDataSource(
        hasPermission = true,
        latest =
          listOf(
            EncodedPhotoPayload(
              format = "jpeg",
              base64 = "abc123",
              width = 640,
              height = 480,
              createdAt = "2026-02-28T00:00:00Z",
            ),
            EncodedPhotoPayload(
              format = "jpeg",
              base64 = "xyz789",
              width = 320,
              height = 240,
              createdAt = null,
            ),
          ),
      )
    val handler = PhotosHandler(appContext(), source)

    val result = handler.handlePhotosLatest("""{"limit":2}""")

    assertTrue(result.ok)
    assertEquals(
      Json.parseToJsonElement(
        """{"photos":[{"format":"jpeg","base64":"abc123","width":640,"height":480,"createdAt":"2026-02-28T00:00:00Z"},{"format":"jpeg","base64":"xyz789","width":320,"height":240}]}""",
      ),
      Json.parseToJsonElement(result.payloadJson ?: error("missing payload")),
    )
  }

  @Test
  fun handlePhotosLatest_usesAddedTimeWhenCaptureMetadataIsMissing() {
    val handler =
      systemPhotosHandler(
        TestPhotoRow(id = 1, dateTakenMs = 100_000, dateAddedSeconds = 100),
        TestPhotoRow(id = 2, dateTakenMs = null, dateAddedSeconds = 200),
      )

    val photo = onlyPhoto(handler.handlePhotosLatest("""{"limit":1}"""))

    assertEquals("1970-01-01T00:03:20Z", photo.getValue("createdAt").jsonPrimitive.content)
  }

  @Test
  fun handlePhotosLatest_preservesCaptureOrderingForNewlyImportedOldPhotos() {
    val handler =
      systemPhotosHandler(
        TestPhotoRow(id = 1, dateTakenMs = 250_000, dateAddedSeconds = 250),
        TestPhotoRow(id = 2, dateTakenMs = 50_000, dateAddedSeconds = 300),
      )

    val photo = onlyPhoto(handler.handlePhotosLatest("""{"limit":1}"""))

    assertEquals("1970-01-01T00:04:10Z", photo.getValue("createdAt").jsonPrimitive.content)
  }

  @Test
  fun handlePhotosLatest_treatsZeroCaptureTimeAsMissing() {
    val handler =
      systemPhotosHandler(
        TestPhotoRow(id = 1, dateTakenMs = 100_000, dateAddedSeconds = 100),
        TestPhotoRow(id = 2, dateTakenMs = 0, dateAddedSeconds = 200),
      )

    val photo = onlyPhoto(handler.handlePhotosLatest("""{"limit":1}"""))

    assertEquals("1970-01-01T00:03:20Z", photo.getValue("createdAt").jsonPrimitive.content)
  }

  @Test
  fun handlePhotosLatest_scalesLargePhotoToRequestedWidth() {
    val handler =
      systemPhotosHandler(
        TestPhotoRow(id = 1, dateTakenMs = 100_000, dateAddedSeconds = 100, width = 4032),
      )

    val photo = onlyPhoto(handler.handlePhotosLatest("""{"limit":1,"maxWidth":1600}"""))

    assertEquals(1600, photo.getValue("width").jsonPrimitive.int)
  }

  @Test
  fun handlePhotosLatest_usesNewestIdForEqualEffectiveCaptureTimes() {
    val handler =
      systemPhotosHandler(
        TestPhotoRow(id = 1, dateTakenMs = 100_000, dateAddedSeconds = 100, width = 640),
        TestPhotoRow(id = 2, dateTakenMs = 100_000, dateAddedSeconds = 100, width = 320),
      )

    val photo = onlyPhoto(handler.handlePhotosLatest("""{"limit":1}"""))

    assertEquals(320, photo.getValue("width").jsonPrimitive.int)
  }

  @Test
  fun handlePhotosLatest_normalizesEveryExifOrientationBeforeEncoding() {
    val cases =
      listOf(
        OrientationCase(ExifInterface.ORIENTATION_NORMAL, Color.RED, Color.GREEN, Color.BLUE, Color.YELLOW),
        OrientationCase(ExifInterface.ORIENTATION_FLIP_HORIZONTAL, Color.GREEN, Color.RED, Color.YELLOW, Color.BLUE),
        OrientationCase(ExifInterface.ORIENTATION_ROTATE_180, Color.YELLOW, Color.BLUE, Color.GREEN, Color.RED),
        OrientationCase(ExifInterface.ORIENTATION_FLIP_VERTICAL, Color.BLUE, Color.YELLOW, Color.RED, Color.GREEN),
        OrientationCase(ExifInterface.ORIENTATION_TRANSPOSE, Color.RED, Color.BLUE, Color.GREEN, Color.YELLOW, true),
        OrientationCase(ExifInterface.ORIENTATION_ROTATE_90, Color.BLUE, Color.RED, Color.YELLOW, Color.GREEN, true),
        OrientationCase(ExifInterface.ORIENTATION_TRANSVERSE, Color.YELLOW, Color.GREEN, Color.BLUE, Color.RED, true),
        OrientationCase(ExifInterface.ORIENTATION_ROTATE_270, Color.GREEN, Color.YELLOW, Color.RED, Color.BLUE, true),
      )

    cases.forEach { expected ->
      val handler =
        systemPhotosHandler(
          TestPhotoRow(
            id = expected.orientation.toLong(),
            dateTakenMs = 100_000,
            dateAddedSeconds = 100,
            width = 120,
            height = 80,
            orientation = expected.orientation,
          ),
        )

      val photo = onlyPhoto(handler.handlePhotosLatest(null))
      val encoded = Base64.decode(photo.getValue("base64").jsonPrimitive.content, Base64.DEFAULT)
      val decoded = requireNotNull(BitmapFactory.decodeByteArray(encoded, 0, encoded.size))
      try {
        assertEquals("orientation ${expected.orientation} width", if (expected.transposed) 80 else 120, decoded.width)
        assertEquals("orientation ${expected.orientation} height", if (expected.transposed) 120 else 80, decoded.height)
        assertEquals(decoded.width, photo.getValue("width").jsonPrimitive.int)
        assertEquals(decoded.height, photo.getValue("height").jsonPrimitive.int)
        assertPixel(expected.orientation, decoded.getPixel(decoded.width / 4, decoded.height / 4), expected.topLeft)
        assertPixel(expected.orientation, decoded.getPixel(decoded.width * 3 / 4, decoded.height / 4), expected.topRight)
        assertPixel(expected.orientation, decoded.getPixel(decoded.width / 4, decoded.height * 3 / 4), expected.bottomLeft)
        assertPixel(expected.orientation, decoded.getPixel(decoded.width * 3 / 4, decoded.height * 3 / 4), expected.bottomRight)
      } finally {
        decoded.recycle()
      }
    }
  }

  @Test
  fun handlePhotosLatest_capsWidthAfterExifRotation() {
    val handler =
      systemPhotosHandler(
        TestPhotoRow(
          id = 1,
          dateTakenMs = 100_000,
          dateAddedSeconds = 100,
          width = 320,
          height = 2400,
          orientation = ExifInterface.ORIENTATION_ROTATE_90,
        ),
      )

    val photo = onlyPhoto(handler.handlePhotosLatest("""{"maxWidth":800}"""))

    assertEquals(800, photo.getValue("width").jsonPrimitive.int)
    assertEquals(107, photo.getValue("height").jsonPrimitive.int)
  }

  @Test
  fun handlePhotosLatest_doesNotDownsampleTallUnrotatedPhotos() {
    val handler =
      systemPhotosHandler(
        TestPhotoRow(id = 1, dateTakenMs = 100_000, dateAddedSeconds = 100, width = 320, height = 2400),
      )

    val photo = onlyPhoto(handler.handlePhotosLatest("""{"maxWidth":800}"""))

    assertEquals(320, photo.getValue("width").jsonPrimitive.int)
    assertEquals(2400, photo.getValue("height").jsonPrimitive.int)
  }

  private fun assertPixel(
    orientation: Int,
    actual: Int,
    expected: Int,
  ) {
    assertTrue("orientation $orientation red", kotlin.math.abs(Color.red(actual) - Color.red(expected)) <= 40)
    assertTrue("orientation $orientation green", kotlin.math.abs(Color.green(actual) - Color.green(expected)) <= 40)
    assertTrue("orientation $orientation blue", kotlin.math.abs(Color.blue(actual) - Color.blue(expected)) <= 40)
  }

  private data class OrientationCase(
    val orientation: Int,
    val topLeft: Int,
    val topRight: Int,
    val bottomLeft: Int,
    val bottomRight: Int,
    val transposed: Boolean = false,
  )

  private fun systemPhotosHandler(vararg rows: TestPhotoRow): PhotosHandler {
    shadowOf(RuntimeEnvironment.getApplication()).grantPermissions(Manifest.permission.READ_MEDIA_IMAGES)
    val store = TestPhotoStore(appContext(), rows.toList()).also(photoStores::add)
    store.attachInfo(appContext(), ProviderInfo().apply { authority = MediaStore.AUTHORITY })
    ShadowContentResolver.registerProviderInternal(MediaStore.AUTHORITY, store)
    return PhotosHandler(appContext())
  }

  private fun onlyPhoto(result: ai.openclaw.app.gateway.GatewaySession.InvokeResult) =
    Json
      .parseToJsonElement(result.payloadJson ?: error("missing photo payload: ${result.error?.message}"))
      .jsonObject
      .getValue("photos")
      .jsonArray
      .single()
      .jsonObject
}

private class FakePhotosDataSource(
  private val hasPermission: Boolean,
  private val latest: List<EncodedPhotoPayload> = emptyList(),
) : PhotosDataSource {
  override fun hasPermission(context: Context): Boolean = hasPermission

  override fun latest(
    context: Context,
    request: PhotosLatestRequest,
  ): List<EncodedPhotoPayload> = latest
}

private data class TestPhotoRow(
  val id: Long,
  val dateTakenMs: Long?,
  val dateAddedSeconds: Long,
  val width: Int = 640,
  val height: Int = 32,
  val orientation: Int? = null,
)

private class TestPhotoStore(
  context: Context,
  rows: List<TestPhotoRow>,
) : ContentProvider(),
  AutoCloseable {
  private val database = SQLiteDatabase.create(null)
  private val images = mutableMapOf<Long, File>()

  init {
    database.execSQL("CREATE TABLE images (_id INTEGER PRIMARY KEY, datetaken INTEGER, date_added INTEGER)")
    rows.forEach { row ->
      database.insert(
        "images",
        null,
        ContentValues().apply {
          put(MediaStore.Images.Media._ID, row.id)
          if (row.dateTakenMs == null) {
            putNull(MediaStore.Images.Media.DATE_TAKEN)
          } else {
            put(MediaStore.Images.Media.DATE_TAKEN, row.dateTakenMs)
          }
          put(MediaStore.Images.Media.DATE_ADDED, row.dateAddedSeconds)
        },
      )
      val image = File.createTempFile("photos-handler-${row.id}-", ".jpg", context.cacheDir)
      val bitmap =
        Bitmap.createBitmap(row.width, row.height, Bitmap.Config.ARGB_8888).apply {
          eraseColor(Color.RED)
          Canvas(this).apply {
            val paint = Paint()
            paint.color = Color.GREEN
            drawRect(width / 2f, 0f, width.toFloat(), height / 2f, paint)
            paint.color = Color.BLUE
            drawRect(0f, height / 2f, width / 2f, height.toFloat(), paint)
            paint.color = Color.YELLOW
            drawRect(width / 2f, height / 2f, width.toFloat(), height.toFloat(), paint)
          }
        }
      try {
        image.outputStream().use { output -> check(bitmap.compress(Bitmap.CompressFormat.JPEG, 90, output)) }
      } finally {
        bitmap.recycle()
      }
      row.orientation?.let { orientation ->
        ExifInterface(image.absolutePath).apply {
          setAttribute(ExifInterface.TAG_ORIENTATION, orientation.toString())
          saveAttributes()
        }
      }
      images[row.id] = image
    }
  }

  override fun onCreate(): Boolean = true

  override fun query(
    uri: Uri,
    projection: Array<out String>?,
    queryArgs: Bundle?,
    cancellationSignal: CancellationSignal?,
  ): Cursor =
    database.query(
      "images",
      projection?.toList()?.toTypedArray(),
      null,
      null,
      null,
      null,
      queryArgs?.getString(ContentResolver.QUERY_ARG_SQL_SORT_ORDER),
      queryArgs?.getInt(ContentResolver.QUERY_ARG_LIMIT)?.toString(),
    )

  override fun query(
    uri: Uri,
    projection: Array<out String>?,
    selection: String?,
    selectionArgs: Array<out String>?,
    sortOrder: String?,
  ): Cursor = database.query("images", projection?.toList()?.toTypedArray(), null, null, null, null, sortOrder)

  override fun openFile(
    uri: Uri,
    mode: String,
  ): ParcelFileDescriptor =
    ParcelFileDescriptor.open(
      images.getValue(requireNotNull(uri.lastPathSegment).toLong()),
      ParcelFileDescriptor.MODE_READ_ONLY,
    )

  override fun getType(uri: Uri): String = "image/jpeg"

  override fun insert(
    uri: Uri,
    values: ContentValues?,
  ): Uri? = null

  override fun delete(
    uri: Uri,
    selection: String?,
    selectionArgs: Array<out String>?,
  ): Int = 0

  override fun update(
    uri: Uri,
    values: ContentValues?,
    selection: String?,
    selectionArgs: Array<out String>?,
  ): Int = 0

  override fun close() {
    database.close()
    images.values.forEach(File::delete)
  }
}
