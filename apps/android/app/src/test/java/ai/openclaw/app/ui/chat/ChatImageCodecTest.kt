package ai.openclaw.app.ui.chat

import ai.openclaw.app.chat.CHAT_IMAGE_MAX_BASE64_CHARS
import android.content.ContentProvider
import android.content.ContentValues
import android.content.pm.ProviderInfo
import android.database.Cursor
import android.database.MatrixCursor
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.graphics.Color
import android.net.Uri
import android.os.ParcelFileDescriptor
import android.provider.OpenableColumns
import android.util.Base64
import androidx.exifinterface.media.ExifInterface
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import org.robolectric.annotation.GraphicsMode
import org.robolectric.shadows.ShadowContentResolver
import java.io.ByteArrayInputStream
import java.io.ByteArrayOutputStream
import java.io.File

@RunWith(RobolectricTestRunner::class)
@GraphicsMode(GraphicsMode.Mode.NATIVE)
class ChatImageCodecTest {
  private val temporaryImages = mutableListOf<File>()

  @After
  fun deleteTemporaryImages() {
    temporaryImages.forEach(File::delete)
  }

  @Test
  fun computeInSampleSizeCapsLongestEdge() {
    assertEquals(4, computeInSampleSize(width = 4032, height = 3024, maxDimension = 1600))
    assertEquals(1, computeInSampleSize(width = 800, height = 600, maxDimension = 1600))
  }

  @Test
  fun normalizeAttachmentFileNameForcesJpegExtension() {
    assertEquals("photo.jpg", normalizeAttachmentFileName("photo.png"))
    assertEquals("image.jpg", normalizeAttachmentFileName(""))
  }

  @Test
  fun decodeBase64BitmapRejectsOversizedInputBeforeDecode() {
    assertNull(decodeBase64Bitmap("A".repeat(CHAT_IMAGE_MAX_BASE64_CHARS + 1)))
  }

  @Test
  fun managedImageDecoderAppliesEveryExifOrientation() {
    val cases =
      listOf(
        OrientationCase(ExifInterface.ORIENTATION_NORMAL, RED, GREEN, BLUE, YELLOW),
        OrientationCase(ExifInterface.ORIENTATION_FLIP_HORIZONTAL, GREEN, RED, YELLOW, BLUE),
        OrientationCase(ExifInterface.ORIENTATION_ROTATE_180, YELLOW, BLUE, GREEN, RED),
        OrientationCase(ExifInterface.ORIENTATION_FLIP_VERTICAL, BLUE, YELLOW, RED, GREEN),
        OrientationCase(ExifInterface.ORIENTATION_TRANSPOSE, RED, BLUE, GREEN, YELLOW, transposed = true),
        OrientationCase(ExifInterface.ORIENTATION_ROTATE_90, BLUE, RED, YELLOW, GREEN, transposed = true),
        OrientationCase(ExifInterface.ORIENTATION_TRANSVERSE, YELLOW, GREEN, BLUE, RED, transposed = true),
        OrientationCase(ExifInterface.ORIENTATION_ROTATE_270, GREEN, YELLOW, RED, BLUE, transposed = true),
      )

    cases.forEach { expected ->
      val bytes = createTaggedImage(expected.orientation).readBytes()
      val decoded = requireNotNull(decodeImageBytes(bytes))

      assertOrientedPixels(decoded, expected)
    }
  }

  @Test
  fun inlineImageDecoderAppliesExifOrientation() {
    val bytes = createTaggedImage(ExifInterface.ORIENTATION_ROTATE_270).readBytes()

    val decoded = requireNotNull(decodeBase64Bitmap(Base64.encodeToString(bytes, Base64.NO_WRAP)))

    assertOrientedPixels(
      decoded,
      OrientationCase(ExifInterface.ORIENTATION_ROTATE_270, GREEN, YELLOW, RED, BLUE, transposed = true),
    )
  }

  @Test
  fun pickedImageIsNormalizedBeforeJpegUpload() {
    val image = createTaggedImage(ExifInterface.ORIENTATION_ROTATE_90)
    val resolver = RuntimeEnvironment.getApplication().contentResolver

    val attachment = loadSizedImageAttachment(resolver, Uri.fromFile(image))
    val encoded = Base64.decode(attachment.base64, Base64.DEFAULT)
    val decoded = requireNotNull(BitmapFactory.decodeByteArray(encoded, 0, encoded.size))

    assertEquals("image/jpeg", attachment.mimeType)
    val outputOrientation =
      ExifInterface(ByteArrayInputStream(encoded)).getAttributeInt(
        ExifInterface.TAG_ORIENTATION,
        ExifInterface.ORIENTATION_UNDEFINED,
      )
    assertTrue(
      "re-encoded JPEG must not require an orientation transform",
      outputOrientation == ExifInterface.ORIENTATION_UNDEFINED || outputOrientation == ExifInterface.ORIENTATION_NORMAL,
    )
    assertOrientedPixels(
      decoded,
      OrientationCase(ExifInterface.ORIENTATION_ROTATE_90, BLUE, RED, YELLOW, GREEN, transposed = true),
    )
  }

  @Test
  fun pickedImagePreservesMirroredExifOrientation() {
    val image = createTaggedImage(ExifInterface.ORIENTATION_FLIP_HORIZONTAL)
    val resolver = RuntimeEnvironment.getApplication().contentResolver

    val attachment = loadSizedImageAttachment(resolver, Uri.fromFile(image))
    val encoded = Base64.decode(attachment.base64, Base64.DEFAULT)
    val decoded = requireNotNull(BitmapFactory.decodeByteArray(encoded, 0, encoded.size))

    assertOrientedPixels(
      decoded,
      OrientationCase(ExifInterface.ORIENTATION_FLIP_HORIZONTAL, GREEN, RED, YELLOW, BLUE),
    )
  }

  @Test
  fun pickedImagePreservesProviderDisplayNameInsteadOfContentUriId() {
    val attachment = loadProviderImage(displayName = "vacation-photo.png")

    assertEquals("vacation-photo.jpg", attachment.fileName)
  }

  @Test
  fun pickedImageSanitizesUnsafeProviderDisplayName() {
    val attachment = loadProviderImage(displayName = "Summer/Trips\\2026\u0007.png")

    assertEquals("Summer_Trips_2026_.jpg", attachment.fileName)
  }

  @Test
  fun pickedImagePreservesUnicodeProviderDisplayName() {
    val attachment = loadProviderImage(displayName = "旅-été.png")

    assertEquals("旅-été.jpg", attachment.fileName)
  }

  @Test
  fun pickedImageFallsBackWhenProviderDisplayNameIsBlank() {
    val attachment = loadProviderImage(displayName = "   ")

    assertEquals("42.jpg", attachment.fileName)
  }

  @Test
  fun pickedImageFallsBackWhenProviderDisplayNameQueryFails() {
    val attachment = loadProviderImage(displayName = "unavailable.png", failQuery = true)

    assertEquals("42.jpg", attachment.fileName)
  }

  @Test
  fun imageDecoderPreservesImagesWithoutExifMetadata() {
    val bitmap = createAsymmetricBitmap()
    val bytes =
      ByteArrayOutputStream().use { output ->
        assertTrue(bitmap.compress(Bitmap.CompressFormat.PNG, 100, output))
        output.toByteArray()
      }
    bitmap.recycle()

    val decoded = requireNotNull(decodeImageBytes(bytes))

    assertOrientedPixels(
      decoded,
      OrientationCase(ExifInterface.ORIENTATION_NORMAL, RED, GREEN, BLUE, YELLOW),
    )
  }

  private fun loadProviderImage(
    displayName: String,
    failQuery: Boolean = false,
  ): PendingAttachment {
    val image = createTaggedImage(ExifInterface.ORIENTATION_NORMAL)
    val authority = "ai.openclaw.app.image-proof"
    val provider = TestImageContentProvider(image, displayName, failQuery)
    provider.attachInfo(RuntimeEnvironment.getApplication(), ProviderInfo().apply { this.authority = authority })
    ShadowContentResolver.registerProviderInternal(authority, provider)
    return loadSizedImageAttachment(
      RuntimeEnvironment.getApplication().contentResolver,
      Uri.parse("content://$authority/images/42"),
    )
  }

  private fun createTaggedImage(orientation: Int): File {
    val image = File.createTempFile("chat-image-orientation-", ".jpg", RuntimeEnvironment.getApplication().cacheDir)
    temporaryImages += image
    val bitmap = createAsymmetricBitmap()
    image.outputStream().use { output -> assertTrue(bitmap.compress(Bitmap.CompressFormat.JPEG, 100, output)) }
    bitmap.recycle()
    ExifInterface(image.absolutePath).apply {
      setAttribute(ExifInterface.TAG_ORIENTATION, orientation.toString())
      saveAttributes()
    }
    return image
  }

  private fun createAsymmetricBitmap(): Bitmap =
    Bitmap.createBitmap(IMAGE_WIDTH, IMAGE_HEIGHT, Bitmap.Config.ARGB_8888).apply {
      for (y in 0 until height) {
        for (x in 0 until width) {
          setPixel(
            x,
            y,
            when {
              x < width / 2 && y < height / 2 -> RED
              x >= width / 2 && y < height / 2 -> GREEN
              x < width / 2 -> BLUE
              else -> YELLOW
            },
          )
        }
      }
    }

  private fun assertOrientedPixels(
    bitmap: Bitmap,
    expected: OrientationCase,
  ) {
    val expectedWidth = if (expected.transposed) IMAGE_HEIGHT else IMAGE_WIDTH
    val expectedHeight = if (expected.transposed) IMAGE_WIDTH else IMAGE_HEIGHT
    assertEquals("orientation ${expected.orientation} width", expectedWidth, bitmap.width)
    assertEquals("orientation ${expected.orientation} height", expectedHeight, bitmap.height)
    assertPixel(expected, bitmap.getPixel(bitmap.width / 4, bitmap.height / 4), expected.topLeft)
    assertPixel(expected, bitmap.getPixel(bitmap.width * 3 / 4, bitmap.height / 4), expected.topRight)
    assertPixel(expected, bitmap.getPixel(bitmap.width / 4, bitmap.height * 3 / 4), expected.bottomLeft)
    assertPixel(expected, bitmap.getPixel(bitmap.width * 3 / 4, bitmap.height * 3 / 4), expected.bottomRight)
  }

  private fun assertPixel(
    orientation: OrientationCase,
    actual: Int,
    expected: Int,
  ) {
    assertTrue("orientation ${orientation.orientation} red", kotlin.math.abs(Color.red(actual) - Color.red(expected)) <= 40)
    assertTrue("orientation ${orientation.orientation} green", kotlin.math.abs(Color.green(actual) - Color.green(expected)) <= 40)
    assertTrue("orientation ${orientation.orientation} blue", kotlin.math.abs(Color.blue(actual) - Color.blue(expected)) <= 40)
  }

  private data class OrientationCase(
    val orientation: Int,
    val topLeft: Int,
    val topRight: Int,
    val bottomLeft: Int,
    val bottomRight: Int,
    val transposed: Boolean = false,
  )

  private companion object {
    const val IMAGE_WIDTH = 120
    const val IMAGE_HEIGHT = 80
    val RED = Color.rgb(255, 0, 0)
    val GREEN = Color.rgb(0, 255, 0)
    val BLUE = Color.rgb(0, 0, 255)
    val YELLOW = Color.rgb(255, 255, 0)
  }
}

private class TestImageContentProvider(
  private val image: File,
  private val displayName: String,
  private val failQuery: Boolean,
) : ContentProvider() {
  override fun onCreate(): Boolean = true

  override fun query(
    uri: Uri,
    projection: Array<out String>?,
    selection: String?,
    selectionArgs: Array<out String>?,
    sortOrder: String?,
  ): Cursor {
    if (failQuery) throw SecurityException("display name unavailable")
    return MatrixCursor(arrayOf(OpenableColumns.DISPLAY_NAME)).apply { addRow(arrayOf(displayName)) }
  }

  override fun openFile(
    uri: Uri,
    mode: String,
  ): ParcelFileDescriptor = ParcelFileDescriptor.open(image, ParcelFileDescriptor.MODE_READ_ONLY)

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
}
