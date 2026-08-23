package ai.openclaw.app.ui

import ai.openclaw.app.R
import ai.openclaw.app.ui.design.ClawPanel
import ai.openclaw.app.ui.design.ClawTheme
import android.content.ClipData
import android.content.ClipboardManager
import android.content.Context
import android.widget.Toast
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.onClick
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextDirection
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import java.text.DateFormat
import java.time.Instant
import java.util.Date
import java.util.Locale
import java.util.TimeZone

internal data class AboutBuildIdentity(
  val version: String,
  val commit: String,
  val fullCommit: String?,
  val built: String,
  val buildTimestamp: String?,
)

private data class AboutBuildCell(
  val title: String,
  val value: String,
  val accessibilityLabel: String,
  val forceLeftToRight: Boolean = false,
  val monospace: Boolean = false,
  val onClick: (() -> Unit)? = null,
  val onClickLabel: String? = null,
)

private val fullGitCommitPattern = Regex("^[a-f0-9]{40}$")

internal fun aboutBuildIdentity(
  versionName: String,
  versionCode: Int,
  gitCommit: String,
  buildTimestamp: String,
  locale: Locale,
  unknownLabel: String,
): AboutBuildIdentity {
  val normalizedCommit = gitCommit.trim().lowercase().takeIf(fullGitCommitPattern::matches)
  val normalizedBuildTimestamp =
    buildTimestamp.trim().takeIf { it.endsWith("Z") }?.takeIf { timestamp ->
      runCatching { Instant.parse(timestamp) }.isSuccess
    }
  val buildInstant = normalizedBuildTimestamp?.let(Instant::parse)
  val built =
    buildInstant?.let { instant ->
      DateFormat.getDateInstance(DateFormat.MEDIUM, locale).run {
        timeZone = TimeZone.getTimeZone("UTC")
        format(Date.from(instant))
      }
    } ?: unknownLabel

  return AboutBuildIdentity(
    version = "${versionName.trim()} ($versionCode)",
    commit = normalizedCommit?.take(12) ?: unknownLabel,
    fullCommit = normalizedCommit,
    built = built,
    buildTimestamp = normalizedBuildTimestamp,
  )
}

internal fun aboutCommitAccessibilityValue(
  fullCommit: String?,
  unknownLabel: String,
): String =
  fullCommit?.let { commit ->
    commit.toCharArray().joinToString(" ")
  } ?: unknownLabel

@Composable
internal fun AboutBuildIdentityPanel(
  versionName: String,
  versionCode: Int,
  gitCommit: String,
  buildTimestamp: String,
  locale: Locale,
) {
  val context = LocalContext.current
  val unknownLabel = stringResource(R.string.about_build_unknown)
  val identity =
    aboutBuildIdentity(
      versionName = versionName,
      versionCode = versionCode,
      gitCommit = gitCommit,
      buildTimestamp = buildTimestamp,
      locale = locale,
      unknownLabel = unknownLabel,
    )
  val commitClipboardLabel = stringResource(R.string.about_build_commit_clipboard_label)
  val commitCopiedConfirmation = stringResource(R.string.about_build_commit_copied)
  val timestampClipboardLabel = stringResource(R.string.about_build_timestamp_clipboard_label)
  val timestampCopiedConfirmation = stringResource(R.string.about_build_timestamp_copied)
  val copyCommitLabel = stringResource(R.string.about_build_copy_commit)
  val copyTimestampLabel = stringResource(R.string.about_build_copy_timestamp)
  val commitClick: (() -> Unit)? =
    identity.fullCommit?.let { commit ->
      {
        copyAboutBuildValue(
          context = context,
          label = commitClipboardLabel,
          value = commit,
          confirmation = commitCopiedConfirmation,
        )
      }
    }
  val timestampClick: (() -> Unit)? =
    identity.buildTimestamp?.let { timestamp ->
      {
        copyAboutBuildValue(
          context = context,
          label = timestampClipboardLabel,
          value = timestamp,
          confirmation = timestampCopiedConfirmation,
        )
      }
    }
  val builtAccessibilityLabel =
    identity.buildTimestamp?.let { timestamp ->
      stringResource(R.string.about_build_built_accessibility, identity.built, timestamp)
    } ?: stringResource(R.string.about_build_date_accessibility, identity.built)
  val cells =
    listOf(
      AboutBuildCell(
        title = stringResource(R.string.about_build_version_title),
        value = identity.version,
        accessibilityLabel = stringResource(R.string.about_build_version_accessibility, identity.version),
        forceLeftToRight = true,
      ),
      AboutBuildCell(
        title = stringResource(R.string.about_build_commit_title),
        value = identity.commit,
        accessibilityLabel =
          stringResource(
            R.string.about_build_commit_accessibility,
            aboutCommitAccessibilityValue(identity.fullCommit, unknownLabel),
          ),
        forceLeftToRight = true,
        monospace = true,
        onClick = commitClick,
        onClickLabel = identity.fullCommit?.let { copyCommitLabel },
      ),
      AboutBuildCell(
        title = stringResource(R.string.about_build_built_title),
        value = identity.built,
        accessibilityLabel = builtAccessibilityLabel,
        onClick = timestampClick,
        onClickLabel = identity.buildTimestamp?.let { copyTimestampLabel },
      ),
    )

  ClawPanel(contentPadding = PaddingValues(horizontal = 12.dp, vertical = 8.dp)) {
    BoxWithConstraints(modifier = Modifier.fillMaxWidth()) {
      val wraps = maxWidth < 260.dp || LocalDensity.current.fontScale >= 1.3f
      if (wraps) {
        Column(verticalArrangement = Arrangement.spacedBy(4.dp)) {
          cells.forEach { cell ->
            AboutBuildIdentityCell(cell = cell, modifier = Modifier.fillMaxWidth())
          }
        }
      } else {
        Row(modifier = Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(6.dp)) {
          cells.forEach { cell ->
            AboutBuildIdentityCell(cell = cell, modifier = Modifier.weight(1f))
          }
        }
      }
    }
  }
}

@Composable
private fun AboutBuildIdentityCell(
  cell: AboutBuildCell,
  modifier: Modifier,
) {
  val clickModifier =
    cell.onClick?.let { action ->
      Modifier.clickable(onClickLabel = cell.onClickLabel, onClick = action)
    } ?: Modifier
  val accessibilityModifier =
    Modifier.clearAndSetSemantics {
      contentDescription = cell.accessibilityLabel
      cell.onClick?.let { action ->
        onClick(label = cell.onClickLabel) {
          action()
          true
        }
      }
    }

  Column(
    modifier =
      modifier
        .then(clickModifier)
        .then(accessibilityModifier)
        .heightIn(min = 54.dp)
        .padding(horizontal = 5.dp, vertical = 6.dp),
    horizontalAlignment = Alignment.CenterHorizontally,
    verticalArrangement = Arrangement.Center,
  ) {
    Text(
      text = cell.title,
      style = ClawTheme.type.caption.copy(fontSize = 11.sp, lineHeight = 14.sp),
      color = ClawTheme.colors.textSubtle,
      textAlign = TextAlign.Center,
    )
    Text(
      text = cell.value,
      style =
        ClawTheme.type.caption.copy(
          fontFamily = if (cell.monospace) FontFamily.Monospace else ClawTheme.type.caption.fontFamily,
          fontSize = 12.5.sp,
          lineHeight = 17.sp,
          textDirection = if (cell.forceLeftToRight) TextDirection.Ltr else ClawTheme.type.caption.textDirection,
        ),
      color = if (cell.onClick == null) ClawTheme.colors.text else ClawTheme.colors.primary,
      modifier = Modifier.fillMaxWidth(),
      textAlign = TextAlign.Center,
    )
  }
}

private fun copyAboutBuildValue(
  context: Context,
  label: String,
  value: String,
  confirmation: String,
) {
  val clipboard = context.getSystemService(ClipboardManager::class.java) ?: return
  clipboard.setPrimaryClip(ClipData.newPlainText(label, value))
  Toast.makeText(context, confirmation, Toast.LENGTH_SHORT).show()
}
