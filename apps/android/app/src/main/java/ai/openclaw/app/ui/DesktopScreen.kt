package ai.openclaw.app.ui

import ai.openclaw.app.MainViewModel
import ai.openclaw.app.i18n.nativeString
import ai.openclaw.app.ui.design.ClawPlainIconButton
import ai.openclaw.app.ui.design.ClawScaffold
import ai.openclaw.app.ui.design.ClawTheme
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.padding
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.outlined.DesktopWindows
import androidx.compose.material3.Icon
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.key
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.core.net.toUri

/** Full-height viewer for a gateway-observable desktop source. */
@Composable
internal fun DesktopScreen(
  viewModel: MainViewModel,
  source: String? = null,
  onBack: () -> Unit,
) {
  val isConnected by viewModel.isConnected.collectAsState()
  val controlPage by viewModel.gatewayControlPage.collectAsState()
  ClawScaffold(
    contentPadding = PaddingValues(start = ClawTheme.spacing.lg, top = 14.dp, end = ClawTheme.spacing.lg, bottom = 6.dp),
  ) {
    // The viewer's keyboard affordance opens the soft keyboard over the canvas; without
    // imePadding it would also cover the viewer's own touch toolbar.
    Column(modifier = Modifier.fillMaxSize().imePadding(), verticalArrangement = Arrangement.spacedBy(10.dp)) {
      Row(
        modifier = Modifier.fillMaxWidth(),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(9.dp),
      ) {
        ClawPlainIconButton(
          icon = Icons.AutoMirrored.Filled.ArrowBack,
          contentDescription = nativeString("Back"),
          onClick = onBack,
        )
        Text(
          text = nativeString("Desktop"),
          style = ClawTheme.type.title,
          color = ClawTheme.colors.text,
          modifier = Modifier.weight(1f),
          maxLines = 1,
          overflow = TextOverflow.Ellipsis,
        )
        Icon(
          imageVector = Icons.Outlined.DesktopWindows,
          contentDescription = null,
          tint = ClawTheme.colors.textMuted,
        )
      }
      Box(modifier = Modifier.fillMaxWidth().weight(1f)) {
        val page = controlPage
        if (isConnected && page != null) {
          // GatewayControlPage equality includes credentials and the accepted TLS pin.
          key(page, source) {
            ControlUiWebView(
              page = page,
              url = desktopUrl(baseUrl = page.baseUrl, source = source),
              modifier = Modifier.fillMaxSize(),
            )
          }
        } else {
          Column(
            modifier = Modifier.fillMaxWidth().padding(top = 48.dp),
            horizontalAlignment = Alignment.CenterHorizontally,
            verticalArrangement = Arrangement.spacedBy(6.dp),
          ) {
            Text(
              text = nativeString("Desktop needs a connected gateway"),
              style = ClawTheme.type.section,
              color = ClawTheme.colors.text,
            )
            Text(
              text = nativeString("Connect to your gateway to view a machine screen."),
              style = ClawTheme.type.body,
              color = ClawTheme.colors.textMuted,
            )
          }
        }
      }
    }
  }
}

/** Builds the desktop document route; credentials stay in ControlUiWebView's startup script. */
internal fun desktopUrl(
  baseUrl: String,
  source: String? = null,
): String {
  val baseUri = baseUrl.trimEnd('/').toUri()
  val routePath = "${baseUri.encodedPath.orEmpty().trimEnd('/')}/"
  val builder =
    baseUri
      .buildUpon()
      .encodedPath(routePath)
      .clearQuery()
      .fragment(null)
      .appendQueryParameter("view", "desktop")
  source?.let { builder.appendQueryParameter("source", it) }
  return builder.build().toString()
}
