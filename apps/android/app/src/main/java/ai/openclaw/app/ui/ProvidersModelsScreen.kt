package ai.openclaw.app.ui

import ai.openclaw.app.GatewayModelProviderSummary
import ai.openclaw.app.GatewayModelSummary
import ai.openclaw.app.MainViewModel
import ai.openclaw.app.providerDisplayName
import ai.openclaw.app.ui.design.ClawEmptyState
import ai.openclaw.app.ui.design.ClawPanel
import ai.openclaw.app.ui.design.ClawScaffold
import ai.openclaw.app.ui.design.ClawSecondaryButton
import ai.openclaw.app.ui.design.ClawTheme
import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.WindowInsetsSides
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.only
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.safeDrawing
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp

/** Android provider readiness screen backed by the configured gateway model view. */
@Composable
internal fun ProvidersModelsScreen(
  viewModel: MainViewModel,
  onBack: () -> Unit,
) {
  val isConnected by viewModel.isConnected.collectAsState()
  val models by viewModel.modelCatalog.collectAsState()
  val providers by viewModel.modelAuthProviders.collectAsState()
  val refreshing by viewModel.modelCatalogRefreshing.collectAsState()
  val errorText by viewModel.modelCatalogErrorText.collectAsState()
  val providerRows = providerRows(providers = providers, models = models)

  LaunchedEffect(isConnected) {
    if (isConnected) {
      viewModel.refreshModelCatalog()
    }
  }

  ClawScaffold(
    contentPadding = PaddingValues(start = 20.dp, top = 13.dp, end = 20.dp, bottom = 6.dp),
    contentWindowInsets = WindowInsets.safeDrawing.only(WindowInsetsSides.Top + WindowInsetsSides.Horizontal),
  ) {
    Box(modifier = Modifier.fillMaxSize()) {
      LazyColumn(
        modifier = Modifier.fillMaxSize(),
        verticalArrangement = Arrangement.spacedBy(7.dp),
        contentPadding = PaddingValues(bottom = 4.dp),
      ) {
        item {
          Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
            Row(
              modifier = Modifier.fillMaxWidth(),
              verticalAlignment = Alignment.CenterVertically,
              horizontalArrangement = Arrangement.SpaceBetween,
            ) {
              ProviderHeaderIconButton(icon = Icons.AutoMirrored.Filled.ArrowBack, contentDescription = "Back", onClick = onBack)
            }
            Column(verticalArrangement = Arrangement.spacedBy(3.dp)) {
              Text(text = "Providers & Models", style = ClawTheme.type.display.copy(fontSize = 14.8.sp, lineHeight = 18.sp), color = ClawTheme.colors.text, maxLines = 1)
              Text(
                text = "Review provider readiness\nand configured models.",
                style = ClawTheme.type.caption.copy(fontSize = 12.5.sp, lineHeight = 16.sp),
                color = ClawTheme.colors.textMuted,
              )
            }
          }
        }

        item {
          ProviderOverviewPanel(
            isConnected = isConnected,
            providerRows = providerRows,
            modelCount = models.size,
            onRefresh = viewModel::refreshModelCatalog,
            refreshing = refreshing,
          )
        }

        item {
          ProviderSectionLabel(title = "Connected providers")
        }

        item {
          if (!isConnected && providerRows.isEmpty()) {
            ClawEmptyState(title = "Gateway offline", body = "Connect your Gateway to load provider readiness.")
          } else {
            ProviderList(rows = providerRows, refreshing = refreshing)
          }
        }

        errorText?.let { message ->
          item {
            ClawPanel {
              Text(text = message, style = ClawTheme.type.body, color = ClawTheme.colors.textMuted)
            }
          }
        }
      }
    }
  }
}

internal data class ProviderRow(
  val id: String,
  val name: String,
  val status: String,
  val ready: Boolean,
  val modelCount: Int,
)

/** Combines gateway auth-provider readiness with configured model providers. */
internal fun providerRows(
  providers: List<GatewayModelProviderSummary>,
  models: List<GatewayModelSummary>,
): List<ProviderRow> {
  val modelCounts = models.groupingBy { it.provider }.eachCount()
  val authRows =
    providers
      .map { provider ->
        val ready = modelProviderReady(provider.status)
        ProviderRow(
          id = provider.id,
          name = provider.displayName,
          status = if (ready) "Ready" else "Needs attention",
          ready = ready,
          modelCount = modelCounts[provider.id] ?: 0,
        )
      }
  val authProviderIds = authRows.mapTo(mutableSetOf()) { it.id.trim().lowercase() }
  val configuredModelRows =
    modelCounts.keys
      .filter { provider -> provider.trim().lowercase() !in authProviderIds }
      .map { provider ->
        ProviderRow(
          id = provider,
          name = providerDisplayName(provider),
          status = "Ready",
          ready = true,
          modelCount = modelCounts[provider] ?: 0,
        )
      }
  return (authRows + configuredModelRows).sortedWith(compareBy(::providerPriority, { it.name.lowercase() }))
}

/** Normalizes gateway provider status strings into a ready/not-ready boolean. */
internal fun modelProviderReady(status: String): Boolean {
  val normalized = status.trim().lowercase()
  return normalized == "ok" ||
    normalized == "ready" ||
    normalized == "healthy" ||
    normalized == "configured" ||
    normalized == "static"
}

private fun providerPriority(row: ProviderRow): Int = providerPriority(row.id)

private fun providerPriority(provider: String): Int =
  when (provider.trim().lowercase()) {
    "openai" -> 0
    "anthropic" -> 1
    "google" -> 2
    "openrouter" -> 3
    "ollama", "ollama-local" -> 4
    "codex" -> 5
    else -> 100
  }

@Composable
private fun ProviderList(
  rows: List<ProviderRow>,
  refreshing: Boolean,
) {
  ClawPanel(contentPadding = PaddingValues(horizontal = 0.dp, vertical = 0.dp)) {
    Column {
      if (rows.isEmpty()) {
        ProviderListRow(
          ProviderRow(
            id = "loading",
            name = "Provider catalog",
            status = if (refreshing) "Loading" else "No providers",
            ready = false,
            modelCount = 0,
          ),
        )
      } else {
        val visibleRows = rows.take(5)
        visibleRows.forEachIndexed { index, row ->
          ProviderListRow(row)
          if (index != visibleRows.lastIndex) {
            HorizontalDivider(color = ClawTheme.colors.border, thickness = 1.dp)
          }
        }
      }
    }
  }
}

@Composable
private fun ProviderOverviewPanel(
  isConnected: Boolean,
  providerRows: List<ProviderRow>,
  modelCount: Int,
  refreshing: Boolean,
  onRefresh: () -> Unit,
) {
  val readyCount = providerRows.count { it.ready }
  val needsSetupCount = providerRows.count { !it.ready }
  ClawPanel(contentPadding = PaddingValues(horizontal = 12.dp, vertical = 12.dp)) {
    Column(verticalArrangement = Arrangement.spacedBy(10.dp)) {
      Row(modifier = Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
        ProviderMetricTile(label = "Ready", value = readyCount.toString(), modifier = Modifier.weight(1f))
        ProviderMetricTile(label = "Models", value = modelCount.toString(), modifier = Modifier.weight(1f))
        ProviderMetricTile(label = "Needs", value = needsSetupCount.toString(), modifier = Modifier.weight(1f))
      }
      Text(
        text = if (isConnected) "Refresh to recheck provider readiness from your Gateway." else "Connect your Gateway to view provider readiness.",
        style = ClawTheme.type.body,
        color = ClawTheme.colors.textMuted,
      )
      ClawSecondaryButton(text = if (refreshing) "Refreshing" else "Refresh", onClick = onRefresh, enabled = isConnected && !refreshing, modifier = Modifier.fillMaxWidth())
    }
  }
}

@Composable
private fun ProviderMetricTile(
  label: String,
  value: String,
  modifier: Modifier = Modifier,
) {
  Surface(
    modifier = modifier,
    shape = RoundedCornerShape(ClawTheme.radii.panel),
    color = ClawTheme.colors.surface,
    border = BorderStroke(1.dp, ClawTheme.colors.border),
    contentColor = ClawTheme.colors.text,
  ) {
    Column(modifier = Modifier.padding(horizontal = 9.dp, vertical = 8.dp), verticalArrangement = Arrangement.spacedBy(2.dp)) {
      Text(text = value, style = ClawTheme.type.title, color = ClawTheme.colors.text, maxLines = 1)
      Text(text = label, style = ClawTheme.type.caption, color = ClawTheme.colors.textMuted, maxLines = 1)
    }
  }
}

@Composable
private fun ProviderListRow(row: ProviderRow) {
  Row(modifier = Modifier.fillMaxWidth().heightIn(min = 58.dp).padding(horizontal = 10.dp, vertical = 6.dp), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(10.dp)) {
    ProviderBadge(text = row.name)
    Column(modifier = Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(1.dp)) {
      Text(text = row.name, style = ClawTheme.type.body, color = ClawTheme.colors.text, maxLines = 1)
      Text(text = if (row.modelCount > 0) "${row.modelCount} models" else "No configured models", style = ClawTheme.type.caption.copy(fontSize = 12.5.sp, lineHeight = 16.sp), color = ClawTheme.colors.textMuted, maxLines = 1)
    }
    Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(5.dp)) {
      Box(modifier = Modifier.size(4.5.dp).clip(CircleShape).background(if (row.ready) ClawTheme.colors.success else ClawTheme.colors.warning))
      Text(text = row.status, style = ClawTheme.type.caption.copy(fontSize = 12.5.sp, lineHeight = 16.sp), color = ClawTheme.colors.textMuted, maxLines = 1)
    }
  }
}

@Composable
private fun ProviderBadge(text: String) {
  Surface(modifier = Modifier.size(30.dp), shape = RoundedCornerShape(ClawTheme.radii.row), color = ClawTheme.colors.surfacePressed, border = BorderStroke(1.dp, ClawTheme.colors.border)) {
    Box(contentAlignment = Alignment.Center) {
      Text(text = providerInitials(text), style = ClawTheme.type.label, color = ClawTheme.colors.text, textAlign = TextAlign.Center)
    }
  }
}

private fun providerInitials(value: String): String =
  value
    .split(' ', '-', '_')
    .filter { it.isNotBlank() }
    .take(2)
    .mapNotNull { it.firstOrNull()?.uppercaseChar()?.toString() }
    .joinToString("")
    .ifBlank { "AI" }

@Composable
private fun ProviderSectionLabel(title: String) {
  Row(modifier = Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.SpaceBetween) {
    Text(text = title.uppercase(), style = ClawTheme.type.caption.copy(fontSize = 12.5.sp, lineHeight = 16.sp), color = ClawTheme.colors.textMuted)
  }
}

@Composable
private fun ProviderHeaderIconButton(
  icon: ImageVector,
  contentDescription: String,
  outlined: Boolean = false,
  onClick: () -> Unit,
) {
  Surface(
    onClick = onClick,
    modifier = Modifier.size(ClawTheme.spacing.touchTarget),
    shape = CircleShape,
    color = Color.Transparent,
    contentColor = ClawTheme.colors.text,
    border = if (outlined) BorderStroke(1.dp, ClawTheme.colors.borderStrong) else null,
  ) {
    Box(contentAlignment = Alignment.Center) {
      Icon(imageVector = icon, contentDescription = contentDescription, modifier = Modifier.size(if (outlined) 17.dp else 20.dp))
    }
  }
}
