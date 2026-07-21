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
import androidx.compose.foundation.layout.padding
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.outlined.Dashboard
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

/** Gateway Control UI dashboard for one chat session. */
@Composable
internal fun SessionDashboardScreen(
  viewModel: MainViewModel,
  sessionKey: String,
  onBack: () -> Unit,
) {
  val isConnected by viewModel.isConnected.collectAsState()
  val controlPage by viewModel.gatewayControlPage.collectAsState()
  ClawScaffold(
    contentPadding = PaddingValues(start = ClawTheme.spacing.lg, top = 14.dp, end = ClawTheme.spacing.lg, bottom = 6.dp),
  ) {
    Column(modifier = Modifier.fillMaxSize(), verticalArrangement = Arrangement.spacedBy(10.dp)) {
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
          text = nativeString("Dashboard"),
          style = ClawTheme.type.title,
          color = ClawTheme.colors.text,
          modifier = Modifier.weight(1f),
          maxLines = 1,
          overflow = TextOverflow.Ellipsis,
        )
        Icon(
          imageVector = Icons.Outlined.Dashboard,
          contentDescription = null,
          tint = ClawTheme.colors.textMuted,
        )
      }
      Box(modifier = Modifier.fillMaxWidth().weight(1f)) {
        val page = controlPage
        if (isConnected && page != null) {
          key(page, sessionKey) {
            ControlUiWebView(
              page = page,
              url = sessionDashboardUrl(baseUrl = page.baseUrl, sessionKey = sessionKey),
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
              text = nativeString("Dashboard needs a connected gateway"),
              style = ClawTheme.type.section,
              color = ClawTheme.colors.text,
            )
            Text(
              text = nativeString("Connect to your gateway to open this session dashboard."),
              style = ClawTheme.type.body,
              color = ClawTheme.colors.textMuted,
            )
          }
        }
      }
    }
  }
}

/**
 * Builds the one-shot dashboard route without placing credentials in the URL.
 * Appends to the served base like the terminal screen so a Control UI mounted
 * under gateway.controlUi.basePath keeps its prefix.
 */
internal fun sessionDashboardUrl(
  baseUrl: String,
  sessionKey: String,
): String =
  baseUrl
    .trimEnd('/')
    .toUri()
    .buildUpon()
    .appendPath("chat")
    .clearQuery()
    .fragment(null)
    .appendQueryParameter("session", sessionKey)
    .appendQueryParameter("face", "dashboard")
    .build()
    .toString()
