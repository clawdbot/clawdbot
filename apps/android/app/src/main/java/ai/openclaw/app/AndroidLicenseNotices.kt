package ai.openclaw.app

import android.content.res.AssetManager

internal const val ANDROID_LICENSE_ASSET_DIRECTORY = "openclaw/licenses"

internal data class AndroidLicenseNotice(
  val title: String,
  val fileName: String,
  val text: String,
)

internal fun loadAndroidLicenseNotices(assetManager: AssetManager): List<AndroidLicenseNotice> {
  val files =
    assetManager
      .list(ANDROID_LICENSE_ASSET_DIRECTORY)
      .orEmpty()
      .filter(::isAndroidLicenseFileName)

  return files
    .map { fileName ->
      val rawText =
        assetManager
          .open("$ANDROID_LICENSE_ASSET_DIRECTORY/$fileName")
          .bufferedReader(Charsets.UTF_8)
          .use { reader -> reader.readText() }
      AndroidLicenseNotice(title = androidLicenseTitleFromFileName(fileName), fileName = fileName, text = rawText)
    }.sortedWith(
      compareBy<AndroidLicenseNotice, String>(String.CASE_INSENSITIVE_ORDER) { notice -> notice.title }
        .thenBy(String.CASE_INSENSITIVE_ORDER) { notice -> notice.fileName },
    )
}

internal fun isAndroidLicenseFileName(fileName: String): Boolean = fileName.endsWith(".txt", ignoreCase = true)

internal fun androidLicenseTitleFromFileName(fileName: String): String =
  fileName
    .substringBeforeLast('.')
    .trim()
    .ifBlank { "License" }
