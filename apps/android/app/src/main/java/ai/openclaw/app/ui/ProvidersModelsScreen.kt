package ai.openclaw.app.ui

import ai.openclaw.app.GatewayModelProviderSummary
import ai.openclaw.app.GatewayModelSummary
import ai.openclaw.app.MainViewModel
import ai.openclaw.app.currentAppLanguage
import ai.openclaw.app.i18n.nativeString
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
import androidx.compose.foundation.layout.only
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.safeDrawing
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.LazyListScope
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
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
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp

/** Android provider readiness screen backed by the configured gateway model view. */
@Composable
internal fun ProvidersModelsScreen(
  viewModel: MainViewModel,
  onBack: () -> Unit,
) {
  val isConnected by viewModel.isConnected.collectAsState()
  val models by viewModel.providerModelCatalog.collectAsState()
  val providers by viewModel.modelAuthProviders.collectAsState()
  val refreshing by viewModel.providerModelCatalogRefreshing.collectAsState()
  val errorText by viewModel.providerModelCatalogErrorText.collectAsState()
  val providerRows = providerRows(providers = providers, models = models)

  LaunchedEffect(isConnected) {
    if (isConnected) {
      viewModel.refreshProviderModels()
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
              ProviderHeaderIconButton(icon = Icons.AutoMirrored.Filled.ArrowBack, contentDescription = nativeString("Back"), outlined = true, onClick = onBack)
            }
            Column(verticalArrangement = Arrangement.spacedBy(3.dp)) {
              Text(text = nativeString("Providers & Models"), style = ClawTheme.type.display.copy(fontSize = 14.8.sp, lineHeight = 18.sp), color = ClawTheme.colors.text, maxLines = 1)
              Text(
                text = nativeString("Review provider readiness\nand configured models."),
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
            onRefresh = viewModel::refreshProviderModels,
            refreshing = refreshing,
          )
        }

        item {
          ProviderSectionLabel(title = nativeString("Providers and configured models"))
        }

        if (!isConnected && providerRows.isEmpty()) {
          item {
            ClawEmptyState(title = nativeString("Gateway offline"), body = nativeString("Connect your Gateway to load provider readiness."))
          }
        } else {
          providerListItems(rows = providerRows, refreshing = refreshing)
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
  val availability: ProviderAvailability,
  val modelCount: Int,
  val models: List<GatewayModelSummary> = emptyList(),
) {
  val ready: Boolean
    get() = availability == ProviderAvailability.Available
}

internal enum class ProviderAvailability {
  Available,
  Unavailable,
  Unknown,
}

/** Combines gateway auth-provider readiness with configured model providers. */
internal fun providerRows(
  providers: List<GatewayModelProviderSummary>,
  models: List<GatewayModelSummary>,
): List<ProviderRow> {
  val providersById = providers.associateBy { it.id.normalizedProviderId() }
  val modelsByProvider =
    models
      .groupBy { it.provider.normalizedProviderId() }
      .mapValues { (_, providerModels) -> providerModels.sortedWith(modelComparator) }
  val providerIds = providersById.keys + modelsByProvider.keys
  return providerIds
    .map { providerId ->
      val providerModels = modelsByProvider[providerId].orEmpty()
      val authProvider = providersById[providerId]
      val availability = providerAvailability(authProvider = authProvider, models = providerModels)
      val displayId = providerModels.firstOrNull()?.provider?.takeIf { it.isNotBlank() } ?: authProvider?.id ?: providerId
      ProviderRow(
        id = displayId,
        name = authProvider?.displayName ?: providerDisplayName(displayId),
        status = availability.label,
        availability = availability,
        modelCount = providerModels.size,
        models = providerModels,
      )
    }.sortedWith(compareBy(::providerPriority, { it.name.lowercase() }))
}

private val ProviderAvailability.label: String
  get() =
    when (this) {
      ProviderAvailability.Available -> nativeString("Ready")
      ProviderAvailability.Unavailable -> nativeString("Needs attention")
      ProviderAvailability.Unknown -> nativeString("Unknown")
    }

private fun providerAvailability(
  authProvider: GatewayModelProviderSummary?,
  models: List<GatewayModelSummary>,
): ProviderAvailability {
  if (models.any { it.available == true }) return ProviderAvailability.Available
  if (models.isNotEmpty()) {
    return if (models.all { it.available == false }) ProviderAvailability.Unavailable else ProviderAvailability.Unknown
  }
  return if (authProvider != null && modelProviderReady(authProvider.status)) {
    ProviderAvailability.Available
  } else {
    ProviderAvailability.Unavailable
  }
}

private fun String.normalizedProviderId(): String = trim().lowercase()

/** Normalizes gateway provider status strings into a ready/not-ready boolean. */
internal fun modelProviderReady(status: String): Boolean {
  val normalized = status.trim().lowercase()
  return normalized == "ok" ||
    normalized == "ready" ||
    normalized == "healthy" ||
    normalized == "configured" ||
    normalized == "static"
}

private val modelComparator = compareBy<GatewayModelSummary>({ it.name.lowercase() }, { it.id.lowercase() })

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

private fun LazyListScope.providerListItems(
  rows: List<ProviderRow>,
  refreshing: Boolean,
) {
  if (rows.isEmpty()) {
    item(key = "provider-catalog-empty") {
      ProviderListRow(
        row =
          ProviderRow(
            id = "loading",
            name = nativeString("Provider catalog"),
            status = if (refreshing) nativeString("Loading") else nativeString("No providers"),
            availability = ProviderAvailability.Unknown,
            modelCount = 0,
          ),
      )
    }
    return
  }
  rows.forEach { row ->
    item(key = "provider:${row.id}") {
      ProviderListRow(row = row)
    }
    items(
      count = row.models.size,
      key = { index -> "model:${row.id}:$index:${row.models[index].id}" },
    ) { index ->
      Box(modifier = Modifier.padding(horizontal = 10.dp)) {
        ProviderModelRow(model = row.models[index])
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
  val needsSetupCount = providerRows.count { it.availability == ProviderAvailability.Unavailable }
  val unknownCount = providerRows.count { it.availability == ProviderAvailability.Unknown }
  ClawPanel(contentPadding = PaddingValues(horizontal = 12.dp, vertical = 12.dp)) {
    Column(verticalArrangement = Arrangement.spacedBy(10.dp)) {
      Row(modifier = Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
        ProviderMetricTile(label = nativeString("Ready"), value = readyCount.toString(), modifier = Modifier.weight(1f))
        ProviderMetricTile(label = nativeString("Needs"), value = needsSetupCount.toString(), modifier = Modifier.weight(1f))
        ProviderMetricTile(label = nativeString("Unknown"), value = unknownCount.toString(), modifier = Modifier.weight(1f))
      }
      Text(
        text = if (isConnected) configuredModelsOverviewText(modelCount) else nativeString("Connect your Gateway to view provider readiness."),
        style = ClawTheme.type.body,
        color = ClawTheme.colors.textMuted,
      )
      ClawSecondaryButton(text = if (refreshing) nativeString("Refreshing") else nativeString("Refresh"), onClick = onRefresh, enabled = isConnected && !refreshing, modifier = Modifier.fillMaxWidth())
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
  ClawPanel(contentPadding = PaddingValues(horizontal = 10.dp, vertical = 8.dp)) {
    Row(modifier = Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(10.dp)) {
      ProviderBadge(text = row.name)
      Column(modifier = Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(1.dp)) {
        Text(text = row.name, style = ClawTheme.type.body, color = ClawTheme.colors.text, maxLines = 1, overflow = TextOverflow.Ellipsis)
        Text(text = configuredModelsCountText(row.modelCount), style = ClawTheme.type.caption.copy(fontSize = 12.5.sp, lineHeight = 16.sp), color = ClawTheme.colors.textMuted, maxLines = 1)
      }
      AvailabilityPill(availability = row.availability, label = row.status)
    }
  }
}

internal fun configuredModelsOverviewText(count: Int): String =
  when (count) {
    0 -> nativeString("No configured models. Refresh to recheck availability.")
    1 -> nativeString("1 configured model. Refresh to recheck availability.")
    else -> nativeString("\$count configured models. Refresh to recheck availability.", count)
  }

internal fun configuredModelsCountText(count: Int): String =
  when (count) {
    0 -> nativeString("No configured models")
    1 -> nativeString("1 configured model")
    else -> nativeString("\$count configured models", count)
  }

@Composable
private fun ProviderModelRow(model: GatewayModelSummary) {
  Surface(shape = RoundedCornerShape(ClawTheme.radii.row), color = ClawTheme.colors.surface, border = BorderStroke(1.dp, ClawTheme.colors.border)) {
    Column(modifier = Modifier.fillMaxWidth().padding(horizontal = 9.dp, vertical = 8.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
      Row(modifier = Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(8.dp), verticalAlignment = Alignment.Top) {
        Column(modifier = Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(2.dp)) {
          Text(text = model.name, style = ClawTheme.type.body, color = ClawTheme.colors.text, maxLines = 1, overflow = TextOverflow.Ellipsis)
          Text(text = model.id, style = ClawTheme.type.caption.copy(fontSize = 12.2.sp, lineHeight = 15.sp), color = ClawTheme.colors.textMuted, maxLines = 2, overflow = TextOverflow.Ellipsis)
        }
        val availability = model.available.toProviderAvailability()
        AvailabilityPill(availability = availability, label = availability.modelLabel)
      }
      modelCapabilities(model).takeIf { it.isNotEmpty() }?.let { capabilities ->
        Text(text = capabilities, style = ClawTheme.type.caption.copy(fontSize = 12.sp, lineHeight = 15.sp), color = ClawTheme.colors.textSubtle, maxLines = 2, overflow = TextOverflow.Ellipsis)
      }
    }
  }
}

@Composable
private fun AvailabilityPill(
  availability: ProviderAvailability,
  label: String,
) {
  Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(5.dp)) {
    Box(modifier = Modifier.size(4.5.dp).clip(CircleShape).background(availability.color()))
    Text(text = label, style = ClawTheme.type.caption.copy(fontSize = 12.2.sp, lineHeight = 15.sp), color = ClawTheme.colors.textMuted, maxLines = 1)
  }
}

@Composable
private fun ProviderAvailability.color(): Color =
  when (this) {
    ProviderAvailability.Available -> ClawTheme.colors.success
    ProviderAvailability.Unavailable -> ClawTheme.colors.warning
    ProviderAvailability.Unknown -> ClawTheme.colors.textSubtle
  }

private val ProviderAvailability.modelLabel: String
  get() =
    when (this) {
      ProviderAvailability.Available -> nativeString("Available")
      ProviderAvailability.Unavailable -> nativeString("Unavailable")
      ProviderAvailability.Unknown -> nativeString("Unknown")
    }

private fun Boolean?.toProviderAvailability(): ProviderAvailability =
  when (this) {
    true -> ProviderAvailability.Available
    false -> ProviderAvailability.Unavailable
    null -> ProviderAvailability.Unknown
  }

internal fun modelCapabilities(model: GatewayModelSummary): String =
  buildList {
    if (model.supportsReasoning) add(nativeString("reasoning"))
    if (model.supportsVision) add(nativeString("image"))
    if (model.supportsAudio) add(nativeString("audio"))
    if (model.supportsVideo) add(nativeString("video"))
    if (model.supportsDocuments) add(nativeString("document"))
    model.contextTokens?.let { add(nativeString("\$context context", formatContextTokens(it))) }
  }.joinToString(" / ")

private fun formatContextTokens(tokens: Long): String = if (tokens >= 1_000) "${tokens / 1_000}k" else tokens.toString()

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
    Text(
      text = localizedUppercase(title, currentAppLanguage().languageTag),
      style = ClawTheme.type.caption.copy(fontSize = 12.5.sp, lineHeight = 16.sp),
      color = ClawTheme.colors.textMuted,
    )
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
