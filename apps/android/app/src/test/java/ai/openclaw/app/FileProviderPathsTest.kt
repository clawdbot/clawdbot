package ai.openclaw.app

import android.app.Application
import android.net.Uri
import androidx.core.content.FileProvider
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import org.robolectric.annotation.Config
import org.robolectric.shadows.ShadowContentResolver
import java.io.File
import java.nio.file.Files

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [36], application = Application::class)
class FileProviderPathsTest {
  private val application = RuntimeEnvironment.getApplication()
  private val authority = "${application.packageName}.fileprovider"

  @Before
  fun attachManifestProvider() {
    assertTrue(ShadowContentResolver.getProvider(Uri.parse("content://$authority")) is FileProvider)
  }

  @Test
  fun activeExportRootsServeTheirOriginalBytes() {
    for (root in listOf("exports", "workspace-files")) {
      withCacheFile(root) { file ->
        val uri = FileProvider.getUriForFile(application, authority, file)
        val bytes = checkNotNull(application.contentResolver.openInputStream(uri)).use { it.readBytes() }
        assertArrayEquals("synthetic $root export".toByteArray(), bytes)
      }
    }
  }

  @Test
  fun retiredUpdatesCannotIssueContentUris() {
    withCacheFile("updates") { file ->
      assertThrows(IllegalArgumentException::class.java) {
        FileProvider.getUriForFile(application, authority, file)
      }
    }
  }

  @Test
  fun retiredUpdateUrisCannotBeResolved() {
    withCacheFile("updates") { file ->
      val uri = Uri.parse("content://$authority/apk_updates/${checkNotNull(file.parentFile).name}/${file.name}")
      assertThrows(IllegalArgumentException::class.java) {
        application.contentResolver.openInputStream(uri)?.close()
      }
    }
  }

  private fun withCacheFile(
    root: String,
    block: (File) -> Unit,
  ) {
    val cacheRoot = File(application.cacheDir, root)
    val rootExisted = cacheRoot.exists()
    check(cacheRoot.isDirectory || cacheRoot.mkdirs())
    val directory = Files.createTempDirectory(cacheRoot.toPath(), "file-provider-").toFile()
    try {
      val file = File(directory, if (root == "updates") "update.apk" else "export.txt")
      file.writeText("synthetic $root export")
      block(file)
    } finally {
      check(directory.deleteRecursively())
      if (!rootExisted) check(cacheRoot.delete())
    }
  }
}
