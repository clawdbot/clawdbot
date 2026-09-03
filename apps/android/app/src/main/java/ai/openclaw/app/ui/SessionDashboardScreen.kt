package ai.openclaw.app.ui

import ai.openclaw.app.MainViewModel
import ai.openclaw.app.i18n.nativeString
import ai.openclaw.app.ui.design.ClawPlainIconButton
import ai.openclaw.app.ui.design.ClawScaffold
import ai.openclaw.app.ui.design.ClawTheme
import androidx.activity.compose.BackHandler
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
import androidx.compose.material.icons.outlined.DesktopWindows
import androidx.compose.material3.Icon
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.key
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.core.net.toUri
import java.util.Locale

/** Gateway Control UI dashboard for one chat session. */
@Composable
internal fun SessionDashboardScreen(
  viewModel: MainViewModel,
  sessionKey: String,
  onBack: () -> Unit,
) {
  val isConnected by viewModel.isConnected.collectAsState()
  val controlPage by viewModel.gatewayControlPage.collectAsState()
  val desktopObserveAvailable by viewModel.desktopObserveAvailable.collectAsState()
  val sessionOwnerAgentId by viewModel.chatSessionOwnerAgentId.collectAsState()
  val gatewayDefaultAgentId by viewModel.gatewayDefaultAgentId.collectAsState()
  val mainSessionKey by viewModel.mainSessionKey.collectAsState()
  val dashboardUrl =
    controlPage?.let { page ->
      sessionDashboardUrl(
        baseUrl = page.baseUrl,
        sessionKey = sessionKey,
        fallbackAgentId = sessionOwnerAgentId ?: gatewayDefaultAgentId,
        mainSessionKey = mainSessionKey,
      )
    }
  var showingDesktop by rememberSaveable(sessionKey) { mutableStateOf(false) }
  if (showingDesktop) {
    // The viewer replaces this screen in place rather than pushing a shell tab, so it must
    // claim System Back itself; the shell handler would otherwise pop the whole dashboard.
    BackHandler { showingDesktop = false }
    DesktopScreen(viewModel = viewModel, session = sessionKey, onBack = { showingDesktop = false })
    return
  }
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
        if (desktopObserveAvailable && dashboardUrl != null) {
          ClawPlainIconButton(
            icon = Icons.Outlined.DesktopWindows,
            contentDescription = nativeString("Open desktop"),
            onClick = { showingDesktop = true },
          )
        }
        Icon(
          imageVector = Icons.Outlined.Dashboard,
          contentDescription = null,
          tint = ClawTheme.colors.textMuted,
        )
      }
      Box(modifier = Modifier.fillMaxWidth().weight(1f)) {
        val page = controlPage
        if (isConnected && page != null && dashboardUrl != null) {
          key(page, dashboardUrl) {
            ControlUiWebView(
              page = page,
              url = dashboardUrl,
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
              text =
                if (isConnected && page != null) {
                  nativeString("Session dashboard unavailable")
                } else {
                  nativeString("Dashboard needs a connected gateway")
                },
              style = ClawTheme.type.section,
              color = ClawTheme.colors.text,
            )
            Text(
              text =
                if (isConnected && page != null) {
                  nativeString("Go back and select a session to open its dashboard.")
                } else {
                  nativeString("Connect to your gateway to open this session dashboard.")
                },
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
 * Mirrors buildControlUiSessionPath(exactKey = true), preserving the Control UI base path.
 * A known session key must not become an ambiguous short session reference.
 */
internal fun sessionDashboardUrl(
  baseUrl: String,
  sessionKey: String,
  fallbackAgentId: String? = null,
  mainSessionKey: String? = null,
): String? {
  val rawKey = sessionKey.trim().takeIf(String::isNotEmpty) ?: return null
  val parsed = parseAgentSessionKey(rawKey)
  if (parsed == null && rawKey.startsWith("agent:", ignoreCase = true)) return null
  val rawAgentId = (parsed?.first ?: fallbackAgentId)?.trim()?.takeIf(String::isNotEmpty) ?: return null
  val agentId = normalizeDashboardAgentId(rawAgentId)
  val rest = parsed?.second ?: rawKey
  val segments = rest.split(':')
  if (segments.any(String::isEmpty)) return null
  val configuredMainKey =
    mainSessionKey
      ?.trim()
      ?.takeIf(String::isNotEmpty)
      ?.let { key -> parseAgentSessionKey(key)?.second ?: key }
      ?.lowercase(Locale.ROOT)
      ?: "main"
  val normalizedRest = rest.lowercase(Locale.ROOT)
  val routeSegments =
    when {
      (parsed == null && normalizedRest == "main") ||
        normalizedRest == configuredMainKey ||
        normalizedRest == "global" -> {
        emptyList()
      }

      segments.size == 1 &&
        (normalizedRest in dashboardReservedSessionRests || dashboardShortSessionRef.matches(rest)) -> {
        listOf("~key", encodeDashboardPathSegment(rest))
      }

      else -> {
        segments.map(::encodeDashboardPathSegment)
      }
    }
  val uri = baseUrl.trimEnd('/').toUri()
  val basePath = uri.encodedPath.orEmpty().trimEnd('/')
  val encodedRoute =
    buildList {
      add("dashboard")
      add(encodeDashboardPathSegment(agentId))
      addAll(routeSegments)
    }.joinToString("/")
  return uri
    .buildUpon()
    .encodedPath("$basePath/$encodedRoute")
    .clearQuery()
    .fragment(null)
    .build()
    .toString()
}

private val dashboardReservedSessionRests = setOf("main", "global", "boot", "sessions")
private val dashboardShortSessionRef = Regex("^(?:.*-)?[0-9a-f]{8,32}$", RegexOption.IGNORE_CASE)

private fun parseAgentSessionKey(sessionKey: String): Pair<String, String>? {
  val parts = sessionKey.split(':')
  if (parts.size < 3 || !parts.first().equals("agent", ignoreCase = true)) return null
  val agentId = parts[1].trim().takeIf(String::isNotEmpty) ?: return null
  val rest = parts.drop(2)
  if (rest.any(String::isEmpty)) return null
  return agentId to rest.joinToString(":")
}

private fun normalizeDashboardAgentId(agentId: String): String {
  val normalized =
    agentId
      .lowercase(Locale.ROOT)
      .replace(Regex("[^a-z0-9_-]+"), "-")
      .trim('-')
      .take(64)
  return normalized.ifEmpty { "main" }
}

private fun encodeDashboardPathSegment(segment: String): String =
  when (segment) {
    "." -> {
      "~dot"
    }

    ".." -> {
      "~dotdot"
    }

    else -> {
      android.net.Uri
        .encode(segment)
        .replace(".", "%2E")
        .let { encoded -> if (encoded.startsWith("~")) "~$encoded" else encoded }
    }
  }
