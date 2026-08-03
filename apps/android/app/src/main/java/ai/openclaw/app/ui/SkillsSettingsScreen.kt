package ai.openclaw.app.ui

import ai.openclaw.app.CLAWHUB_SKILL_GATEWAY_UNAVAILABLE
import ai.openclaw.app.GatewayClawHubInstallReview
import ai.openclaw.app.GatewayClawHubSkillSearchState
import ai.openclaw.app.GatewayClawHubSkillSummary
import ai.openclaw.app.GatewaySkillSummary
import ai.openclaw.app.MainViewModel
import ai.openclaw.app.i18n.nativeString
import ai.openclaw.app.isClawHubSkillInstalled
import ai.openclaw.app.isClawHubSkillOperationActive
import ai.openclaw.app.ui.design.ClawDetailRow
import ai.openclaw.app.ui.design.ClawIconButton
import ai.openclaw.app.ui.design.ClawListPanel
import ai.openclaw.app.ui.design.ClawPanel
import ai.openclaw.app.ui.design.ClawPill
import ai.openclaw.app.ui.design.ClawPrimaryButton
import ai.openclaw.app.ui.design.ClawSecondaryButton
import ai.openclaw.app.ui.design.ClawSegmentedControl
import ai.openclaw.app.ui.design.ClawStatus
import ai.openclaw.app.ui.design.ClawStatusPill
import ai.openclaw.app.ui.design.ClawTextBadge
import ai.openclaw.app.ui.design.ClawTextField
import ai.openclaw.app.ui.design.ClawTheme
import ai.openclaw.app.uppercaseFirstGraphemeOrNull
import androidx.activity.compose.BackHandler
import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Refresh
import androidx.compose.material.icons.filled.Search
import androidx.compose.material.icons.filled.Settings
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Surface
import androidx.compose.material3.Switch
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.unit.dp

private enum class SkillsTab {
  Installed,
  Browse,
}

private enum class InstalledSkillFilter {
  All,
  Ready,
  Setup,
  Off,
}

/** Settings screen for gateway skills and their readiness state. */
@Composable
internal fun SkillsSettingsScreen(
  viewModel: MainViewModel,
  onBack: () -> Unit,
) {
  val skillsSummary by viewModel.skillsSummary.collectAsState()
  val skillsRefreshing by viewModel.skillsRefreshing.collectAsState()
  val skillsErrorText by viewModel.skillsErrorText.collectAsState()
  val skillMutationKeys by viewModel.skillMutationKeys.collectAsState()
  val clawHubState by viewModel.clawHubSkillSearchState.collectAsState()
  val clawHubMethodsAvailable by viewModel.clawHubSkillMethodsAvailable.collectAsState()
  val isConnected by viewModel.isConnected.collectAsState()
  val operatorAdminScopeAvailable by viewModel.operatorAdminScopeAvailable.collectAsState()
  val canManageSkills = isConnected && operatorAdminScopeAvailable
  val skills = skillsSummary.skills
  val readyCount = skills.count { skillReady(it) }
  val needsSetupCount = skills.count { skillNeedsSetup(it) }
  val disabledCount = skills.count { it.disabled }
  var selectedSkillKey by remember { mutableStateOf<String?>(null) }
  var selectedTabName by rememberSaveable { mutableStateOf(SkillsTab.Installed.name) }
  var installedSearch by rememberSaveable { mutableStateOf("") }
  var installedFilterName by rememberSaveable { mutableStateOf(InstalledSkillFilter.All.name) }
  var clawHubQuery by rememberSaveable { mutableStateOf("") }
  val selectedTab = SkillsTab.entries.firstOrNull { it.name == selectedTabName } ?: SkillsTab.Installed
  val installedFilter =
    InstalledSkillFilter.entries.firstOrNull { it.name == installedFilterName }
      ?: InstalledSkillFilter.All
  val visibleSkills =
    remember(skills, installedSearch, installedFilter) {
      filterInstalledSkills(skills, installedSearch, installedFilter)
    }

  LaunchedEffect(isConnected) {
    if (isConnected) {
      viewModel.refreshSkills()
    }
  }

  selectedSkillKey?.let { skillKey ->
    val selectedSkill = skills.firstOrNull { it.skillKey == skillKey }
    SkillDetailSettingsScreen(
      skill = selectedSkill,
      skillKey = skillKey,
      isConnected = isConnected,
      canManageSkills = canManageSkills,
      isMutating = skillKey in skillMutationKeys,
      onSkillEnabledChange = viewModel::setSkillEnabled,
      onBack = { selectedSkillKey = null },
    )
    return
  }

  SettingsDetailFrame(
    title = nativeString("Skills"),
    subtitle = nativeString("Manage installed skills and add trusted releases from ClawHub."),
    icon = Icons.Default.Settings,
    onBack = onBack,
  ) {
    SkillsOverviewPanel(
      installedCount = skills.size,
      readyCount = readyCount,
      needsSetupCount = needsSetupCount,
      disabledCount = disabledCount,
      refreshing = skillsRefreshing,
      canRefresh = isConnected,
      onRefresh = viewModel::refreshSkills,
    )
    val installedTabLabel = nativeString("Installed")
    val browseTabLabel = nativeString("Browse")
    ClawSegmentedControl(
      options = listOf(installedTabLabel, browseTabLabel),
      selected = if (selectedTab == SkillsTab.Installed) installedTabLabel else browseTabLabel,
      onSelect = { selected ->
        selectedTabName =
          if (selected == installedTabLabel) SkillsTab.Installed.name else SkillsTab.Browse.name
      },
      modifier = Modifier.fillMaxWidth(),
    )
    skillsErrorText?.let { errorText ->
      ClawPanel {
        Text(text = errorText, style = ClawTheme.type.body, color = ClawTheme.colors.warning)
      }
    }
    if (isConnected && !operatorAdminScopeAvailable) {
      ClawPanel {
        Text(
          text = nativeString("Skill changes require operator.admin. Reconnect with an admin-capable gateway token."),
          style = ClawTheme.type.body,
          color = ClawTheme.colors.warning,
        )
      }
    }
    when (selectedTab) {
      SkillsTab.Installed ->
        InstalledSkillsPane(
          skills = skills,
          visibleSkills = visibleSkills,
          query = installedSearch,
          filter = installedFilter,
          isConnected = isConnected,
          canManageSkills = canManageSkills,
          mutatingSkillKeys = skillMutationKeys,
          onQueryChange = { installedSearch = it },
          onFilterChange = { installedFilterName = it.name },
          onSkillClick = { selectedSkillKey = it.skillKey },
          onSkillEnabledChange = viewModel::setSkillEnabled,
        )
      SkillsTab.Browse ->
        ClawHubSkillSearchPanel(
          state = clawHubState,
          installedSkills = skills,
          query = clawHubQuery,
          isConnected = isConnected,
          methodsAvailable = clawHubMethodsAvailable,
          canManageSkills = canManageSkills,
          onQueryChange = { clawHubQuery = it },
          onSearch = { viewModel.searchClawHubSkills(clawHubQuery) },
          onReviewInstall = viewModel::reviewClawHubSkillInstall,
          onAcknowledgeInstall = { slug, version ->
            viewModel.installClawHubSkill(slug, acknowledgeClawHubRisk = true, version = version)
          },
          onClearMessage = viewModel::clearClawHubSkillMessage,
        )
    }
  }
  clawHubState.installReview?.let { review ->
    ClawHubInstallReviewDialog(
      review = review,
      canInstall = canManageSkills && clawHubMethodsAvailable && review.slug !in clawHubState.installingSlugs,
      onDismiss = viewModel::dismissClawHubSkillInstallReview,
      onInstall = {
        viewModel.dismissClawHubSkillInstallReview()
        viewModel.installClawHubSkill(review.slug, version = review.version)
      },
    )
  }
}

@Composable
private fun SkillDetailSettingsScreen(
  skill: GatewaySkillSummary?,
  skillKey: String,
  isConnected: Boolean,
  canManageSkills: Boolean,
  isMutating: Boolean,
  onSkillEnabledChange: (String, Boolean) -> Unit,
  onBack: () -> Unit,
) {
  BackHandler(onBack = onBack)

  SettingsDetailFrame(
    title = skill?.name ?: skillKey,
    subtitle = nativeString("Inspect and manage installed skill state."),
    icon = Icons.Default.Settings,
    onBack = onBack,
  ) {
    skill?.let { summary ->
      SettingsMetricPanel(
        rows =
          listOf(
            SettingsMetric(nativeString("Status"), skillStatusText(summary)),
            SettingsMetric(nativeString("Source"), skillSourceLabel(summary)),
            SettingsMetric(nativeString("Missing"), summary.missingCount.toString()),
          ),
      )
      SkillSwitchPanel(
        skill = summary,
        canManageSkills = canManageSkills,
        isMutating = isMutating,
        onSkillEnabledChange = onSkillEnabledChange,
      )
      SkillSetupPanel(summary)
    }
    SkillDetailPanel(skill = skill, isConnected = isConnected)
  }
}

@Composable
private fun SkillsOverviewPanel(
  installedCount: Int,
  readyCount: Int,
  needsSetupCount: Int,
  disabledCount: Int,
  refreshing: Boolean,
  canRefresh: Boolean,
  onRefresh: () -> Unit,
) {
  ClawPanel(contentPadding = PaddingValues(14.dp)) {
    Column(verticalArrangement = Arrangement.spacedBy(12.dp)) {
      Row(
        modifier = Modifier.fillMaxWidth(),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(12.dp),
      ) {
        Column(modifier = Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(1.dp)) {
          Text(text = installedCount.toString(), style = ClawTheme.type.display, color = ClawTheme.colors.text)
          Text(text = nativeString("Installed"), style = ClawTheme.type.caption, color = ClawTheme.colors.textMuted)
        }
        ClawIconButton(
          icon = Icons.Default.Refresh,
          contentDescription = if (refreshing) nativeString("Refreshing") else nativeString("Refresh"),
          onClick = onRefresh,
          enabled = canRefresh && !refreshing,
        )
      }
      SkillDistributionBar(
        readyCount = readyCount,
        needsSetupCount = needsSetupCount,
        disabledCount = disabledCount,
      )
      Row(modifier = Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(12.dp)) {
        SkillCountLegend(
          label = nativeString("Ready"),
          count = readyCount,
          color = ClawTheme.colors.success,
          modifier = Modifier.weight(1f),
        )
        SkillCountLegend(
          label = nativeString("Needs Setup"),
          count = needsSetupCount,
          color = ClawTheme.colors.warning,
          modifier = Modifier.weight(1f),
        )
        SkillCountLegend(
          label = nativeString("Off"),
          count = disabledCount,
          color = ClawTheme.colors.textSubtle,
          modifier = Modifier.weight(1f),
        )
      }
    }
  }
}

@Composable
private fun SkillDistributionBar(
  readyCount: Int,
  needsSetupCount: Int,
  disabledCount: Int,
) {
  val total = readyCount + needsSetupCount + disabledCount
  Row(
    modifier =
      Modifier
        .fillMaxWidth()
        .height(6.dp)
        .clip(RoundedCornerShape(ClawTheme.radii.pill))
        .background(ClawTheme.colors.surfacePressed),
  ) {
    if (total > 0) {
      if (readyCount > 0) {
        Box(modifier = Modifier.weight(readyCount.toFloat()).fillMaxHeight().background(ClawTheme.colors.success))
      }
      if (needsSetupCount > 0) {
        Box(modifier = Modifier.weight(needsSetupCount.toFloat()).fillMaxHeight().background(ClawTheme.colors.warning))
      }
      if (disabledCount > 0) {
        Box(modifier = Modifier.weight(disabledCount.toFloat()).fillMaxHeight().background(ClawTheme.colors.textSubtle))
      }
    }
  }
}

@Composable
private fun SkillCountLegend(
  label: String,
  count: Int,
  color: Color,
  modifier: Modifier = Modifier,
) {
  Column(modifier = modifier, verticalArrangement = Arrangement.spacedBy(3.dp)) {
    Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(6.dp)) {
      Box(modifier = Modifier.size(6.dp).clip(CircleShape).background(color))
      Text(text = label, style = ClawTheme.type.caption, color = ClawTheme.colors.textMuted, maxLines = 1)
    }
    Text(text = count.toString(), style = ClawTheme.type.section, color = ClawTheme.colors.text)
  }
}

@Composable
private fun InstalledSkillsPane(
  skills: List<GatewaySkillSummary>,
  visibleSkills: List<GatewaySkillSummary>,
  query: String,
  filter: InstalledSkillFilter,
  isConnected: Boolean,
  canManageSkills: Boolean,
  mutatingSkillKeys: Set<String>,
  onQueryChange: (String) -> Unit,
  onFilterChange: (InstalledSkillFilter) -> Unit,
  onSkillClick: (GatewaySkillSummary) -> Unit,
  onSkillEnabledChange: (String, Boolean) -> Unit,
) {
  ClawPanel {
    Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
      ClawTextField(value = query, onValueChange = onQueryChange, placeholder = nativeString("Search installed skills"))
      Row(
        modifier = Modifier.fillMaxWidth().horizontalScroll(rememberScrollState()),
        horizontalArrangement = Arrangement.spacedBy(6.dp),
      ) {
        InstalledSkillFilter.entries.forEach { option ->
          ClawPill(
            text = installedSkillFilterLabel(option),
            selected = option == filter,
            onClick = { onFilterChange(option) },
          )
        }
      }
    }
  }
  when {
    !isConnected ->
      ClawPanel {
        Text(text = nativeString("Connect the gateway to load skills."), style = ClawTheme.type.body, color = ClawTheme.colors.textMuted)
      }
    skills.isEmpty() ->
      ClawPanel {
        Column(verticalArrangement = Arrangement.spacedBy(3.dp)) {
          Text(text = nativeString("No skills installed."), style = ClawTheme.type.section, color = ClawTheme.colors.text)
          Text(text = nativeString("Skills installed on the gateway will appear here."), style = ClawTheme.type.body, color = ClawTheme.colors.textMuted)
        }
      }
    visibleSkills.isEmpty() ->
      ClawPanel {
        Text(text = nativeString("No installed skills match this search."), style = ClawTheme.type.body, color = ClawTheme.colors.textMuted)
      }
    else ->
      SkillsPanel(
        skills = visibleSkills,
        canManageSkills = canManageSkills,
        mutatingSkillKeys = mutatingSkillKeys,
        onSkillClick = onSkillClick,
        onSkillEnabledChange = onSkillEnabledChange,
      )
  }
}

@Composable
private fun SkillSwitchPanel(
  skill: GatewaySkillSummary,
  canManageSkills: Boolean,
  isMutating: Boolean,
  onSkillEnabledChange: (String, Boolean) -> Unit,
) {
  ClawPanel {
    Row(
      modifier = Modifier.fillMaxWidth(),
      verticalAlignment = Alignment.CenterVertically,
      horizontalArrangement = Arrangement.spacedBy(10.dp),
    ) {
      Column(modifier = Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(4.dp)) {
        Text(text = nativeString("Gateway switch"), style = ClawTheme.type.section, color = ClawTheme.colors.text)
        Text(
          text = if (skill.disabled) nativeString("Disabled for all agents.") else nativeString("Enabled for eligible agents."),
          style = ClawTheme.type.body,
          color = ClawTheme.colors.textMuted,
        )
      }
      Switch(
        checked = !skill.disabled,
        onCheckedChange = { onSkillEnabledChange(skill.skillKey, it) },
        enabled = canManageSkills && !isMutating,
      )
    }
  }
}

@Composable
private fun SkillSetupPanel(skill: GatewaySkillSummary) {
  ClawPanel {
    Column(verticalArrangement = Arrangement.spacedBy(6.dp)) {
      Text(text = nativeString("Setup"), style = ClawTheme.type.section, color = ClawTheme.colors.text)
      Text(text = skillConfigurationText(skill), style = ClawTheme.type.body, color = ClawTheme.colors.textMuted)
    }
  }
}

@Composable
private fun SkillDetailPanel(
  skill: GatewaySkillSummary?,
  isConnected: Boolean,
) {
  if (!isConnected) {
    ClawPanel {
      Text(text = nativeString("Connect the gateway to load skill details."), style = ClawTheme.type.body, color = ClawTheme.colors.textMuted)
    }
    return
  }
  if (skill == null) {
    ClawPanel {
      Text(text = nativeString("Skill detail is not available in the current skills status."), style = ClawTheme.type.body, color = ClawTheme.colors.textMuted)
    }
    return
  }
  SettingsMetricPanel(
    rows =
      listOf(
        SettingsMetric(nativeString("Skill Key"), skill.skillKey),
        SettingsMetric(nativeString("Display"), skill.name),
        SettingsMetric(nativeString("Source"), skillSourceLabel(skill)),
        SettingsMetric(nativeString("Install Options"), skill.installCount.toString()),
      ),
  )
  skill.description?.let { description ->
    ClawPanel {
      Column(verticalArrangement = Arrangement.spacedBy(6.dp)) {
        Text(text = nativeString("Description"), style = ClawTheme.type.section, color = ClawTheme.colors.text)
        Text(text = description, style = ClawTheme.type.body, color = ClawTheme.colors.textMuted)
      }
    }
  }
}

@Composable
private fun SkillsPanel(
  skills: List<GatewaySkillSummary>,
  canManageSkills: Boolean,
  mutatingSkillKeys: Set<String>,
  onSkillClick: (GatewaySkillSummary) -> Unit,
  onSkillEnabledChange: (String, Boolean) -> Unit,
) {
  ClawListPanel(items = skills) { skill ->
    SkillListRow(
      skill = skill,
      canManageSkills = canManageSkills,
      isMutating = skill.skillKey in mutatingSkillKeys,
      onClick = { onSkillClick(skill) },
      onSkillEnabledChange = onSkillEnabledChange,
    )
  }
}

@Composable
private fun SkillListRow(
  skill: GatewaySkillSummary,
  canManageSkills: Boolean,
  isMutating: Boolean,
  onClick: () -> Unit,
  onSkillEnabledChange: (String, Boolean) -> Unit,
) {
  ClawDetailRow(
    title = skill.name,
    subtitle = skillSubtitle(skill),
    modifier = Modifier.clickable(onClickLabel = nativeString("Open skill detail"), onClick = onClick),
    leading = { ClawTextBadge(text = skillBadge(skill)) },
    trailing = {
      Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(6.dp)) {
        ClawStatusPill(text = skillStatusText(skill), status = skillStatus(skill))
        Switch(
          checked = !skill.disabled,
          onCheckedChange = { onSkillEnabledChange(skill.skillKey, it) },
          enabled = canManageSkills && !isMutating,
        )
      }
    },
  )
}

@Composable
private fun ClawHubSkillSearchPanel(
  state: GatewayClawHubSkillSearchState,
  installedSkills: List<GatewaySkillSummary>,
  query: String,
  isConnected: Boolean,
  methodsAvailable: Boolean,
  canManageSkills: Boolean,
  onQueryChange: (String) -> Unit,
  onSearch: () -> Unit,
  onReviewInstall: (GatewayClawHubSkillSummary) -> Unit,
  onAcknowledgeInstall: (String, String?) -> Unit,
  onClearMessage: () -> Unit,
) {
  ClawPanel {
    Column(verticalArrangement = Arrangement.spacedBy(10.dp)) {
      Text(text = nativeString("Find on ClawHub"), style = ClawTheme.type.section, color = ClawTheme.colors.text)
      Text(
        text = nativeString("Search registry metadata. The Gateway verifies trust again before any download."),
        style = ClawTheme.type.body,
        color = ClawTheme.colors.textMuted,
      )
      if (isConnected && !methodsAvailable) {
        Text(
          text = nativeString(CLAWHUB_SKILL_GATEWAY_UNAVAILABLE),
          style = ClawTheme.type.body,
          color = ClawTheme.colors.warning,
        )
      }
      Row(
        modifier = Modifier.fillMaxWidth(),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(8.dp),
      ) {
        ClawTextField(
          value = query,
          onValueChange = onQueryChange,
          placeholder = nativeString("Search ClawHub"),
          modifier = Modifier.weight(1f),
        )
        ClawIconButton(
          icon = Icons.Default.Search,
          contentDescription = if (state.searching) nativeString("Searching") else nativeString("Search"),
          onClick = onSearch,
          enabled = isConnected && methodsAvailable && !state.searching,
        )
      }
    }
  }
  if (state.errorText != null || state.messageText != null) {
    ClawHubNoticeCard(
      errorText = state.errorText,
      messageText = state.messageText,
      acknowledgeSlug = state.acknowledgeSlug,
      acknowledgeVersion = state.acknowledgeVersion,
      canAcknowledge = methodsAvailable && canManageSkills,
      installingSlugs = state.installingSlugs,
      onAcknowledgeInstall = onAcknowledgeInstall,
      onDismiss = onClearMessage,
    )
  }
  if (state.results.isNotEmpty()) {
    ClawListPanel(items = state.results) { skill ->
      val installed =
        skill.version?.let { version -> isClawHubSkillInstalled(installedSkills, skill.slug, version) }
          ?: isClawHubSkillInstalled(installedSkills, skill.slug)
      ClawDetailRow(
        title = skill.displayName,
        subtitle = listOfNotNull(skill.summary, skill.version?.let { nativeString("Version \$it", it) }).joinToString(" · "),
        leading = { ClawTextBadge(text = skillBadge(skill.displayName)) },
        trailing = {
          val reviewing = state.reviewingSlug == skill.slug
          val installing = isClawHubSkillOperationActive(state.installingSlugs, skill.slug)
          ClawSecondaryButton(
            text =
              when {
                installed -> nativeString("Installed")
                installing -> nativeString("Installing")
                reviewing -> nativeString("Loading")
                else -> nativeString("Review")
              },
            onClick = { onReviewInstall(skill) },
            enabled = isConnected && methodsAvailable && !installed && !reviewing && !installing,
          )
        },
      )
    }
  }
}

@Composable
private fun ClawHubNoticeCard(
  errorText: String?,
  messageText: String?,
  acknowledgeSlug: String?,
  acknowledgeVersion: String?,
  canAcknowledge: Boolean,
  installingSlugs: Set<String>,
  onAcknowledgeInstall: (String, String?) -> Unit,
  onDismiss: () -> Unit,
) {
  val requiresAcknowledgement = acknowledgeSlug != null
  val status =
    when {
      requiresAcknowledgement -> ClawStatus.Warning
      errorText != null -> ClawStatus.Danger
      else -> ClawStatus.Success
    }
  val rawText = errorText ?: messageText.orEmpty()
  val summary =
    if (requiresAcknowledgement) {
      nativeString("The Gateway will verify this exact release with ClawHub before download. If the release needs explicit risk acknowledgement, Android will show the Gateway warning before retrying.")
    } else {
      rawText.substringBefore("\n\n").trim()
    }
  val details =
    when {
      requiresAcknowledgement -> rawText.takeIf(String::isNotBlank)
      "\n\n" in rawText -> rawText.substringAfter("\n\n").trim().takeIf(String::isNotBlank)
      else -> null
    }
  var detailsExpanded by rememberSaveable(rawText) { mutableStateOf(false) }
  val accent =
    when (status) {
      ClawStatus.Success -> ClawTheme.colors.success
      ClawStatus.Warning -> ClawTheme.colors.warning
      ClawStatus.Danger -> ClawTheme.colors.danger
      ClawStatus.Neutral -> ClawTheme.colors.textSubtle
    }
  val background =
    when (status) {
      ClawStatus.Success -> ClawTheme.colors.successSoft
      ClawStatus.Warning -> ClawTheme.colors.warningSoft
      ClawStatus.Danger -> ClawTheme.colors.dangerSoft
      ClawStatus.Neutral -> ClawTheme.colors.surfaceRaised
    }
  val title =
    when {
      requiresAcknowledgement -> nativeString("Needs attention")
      errorText != null -> nativeString("Blocked")
      else -> nativeString("Installed")
    }

  Surface(
    modifier = Modifier.fillMaxWidth(),
    shape = RoundedCornerShape(ClawTheme.radii.panel),
    color = background,
    border = BorderStroke(1.dp, accent.copy(alpha = 0.45f)),
  ) {
    Column(modifier = Modifier.padding(14.dp), verticalArrangement = Arrangement.spacedBy(10.dp)) {
      Row(
        modifier = Modifier.fillMaxWidth(),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(8.dp),
      ) {
        Box(modifier = Modifier.size(8.dp).clip(CircleShape).background(accent))
        Text(text = title, style = ClawTheme.type.section, color = ClawTheme.colors.text, modifier = Modifier.weight(1f))
      }
      Text(text = summary, style = ClawTheme.type.body, color = ClawTheme.colors.textMuted)
      if (detailsExpanded && details != null) {
        Surface(
          modifier = Modifier.fillMaxWidth(),
          shape = RoundedCornerShape(ClawTheme.radii.control),
          color = ClawTheme.colors.surface.copy(alpha = 0.72f),
        ) {
          Text(
            text = details,
            modifier = Modifier.padding(10.dp),
            style = ClawTheme.type.mono,
            color = ClawTheme.colors.textMuted,
          )
        }
      }
      Row(modifier = Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
        if (details != null && !detailsExpanded) {
          ClawSecondaryButton(
            text = nativeString("Review"),
            onClick = { detailsExpanded = true },
            modifier = Modifier.weight(1f),
          )
        }
        ClawSecondaryButton(
          text = nativeString("Dismiss"),
          onClick = onDismiss,
          modifier = Modifier.weight(1f),
        )
      }
      acknowledgeSlug?.let { slug ->
        ClawPrimaryButton(
          text = nativeString("Acknowledge Gateway warning and install"),
          onClick = { onAcknowledgeInstall(slug, acknowledgeVersion) },
          enabled = canAcknowledge && slug !in installingSlugs && (details == null || detailsExpanded),
          modifier = Modifier.fillMaxWidth(),
        )
      }
    }
  }
}

@Composable
private fun ClawHubInstallReviewDialog(
  review: GatewayClawHubInstallReview,
  canInstall: Boolean,
  onDismiss: () -> Unit,
  onInstall: () -> Unit,
) {
  AlertDialog(
    onDismissRequest = onDismiss,
    title = { Text(text = nativeString("Review ClawHub skill")) },
    text = {
      Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
        Text(text = review.displayName, style = ClawTheme.type.section, color = ClawTheme.colors.text)
        review.summary?.let {
          Text(text = it, style = ClawTheme.type.body, color = ClawTheme.colors.textMuted)
        }
        ReviewLine(label = nativeString("Version"), value = review.version)
        ReviewLine(label = nativeString("Publisher"), value = review.author)
        Text(
          text = nativeString("The Gateway will verify this exact release with ClawHub before download. If the release needs explicit risk acknowledgement, Android will show the Gateway warning before retrying."),
          style = ClawTheme.type.body,
          color = ClawTheme.colors.textMuted,
        )
      }
    },
    confirmButton = {
      TextButton(onClick = onInstall, enabled = canInstall) {
        Text(text = nativeString("Verify and install"))
      }
    },
    dismissButton = {
      TextButton(onClick = onDismiss) {
        Text(text = nativeString("Cancel"))
      }
    },
  )
}

@Composable
private fun ReviewLine(
  label: String,
  value: String,
) {
  Column(verticalArrangement = Arrangement.spacedBy(2.dp)) {
    Text(text = label, style = ClawTheme.type.caption, color = ClawTheme.colors.textMuted)
    Text(text = value, style = ClawTheme.type.body, color = ClawTheme.colors.text)
  }
}

private fun filterInstalledSkills(
  skills: List<GatewaySkillSummary>,
  query: String,
  filter: InstalledSkillFilter,
): List<GatewaySkillSummary> {
  val normalizedQuery = query.trim()
  return skills.filter { skill ->
    val matchesQuery =
      normalizedQuery.isEmpty() ||
        skill.name.contains(normalizedQuery, ignoreCase = true) ||
        skill.skillKey.contains(normalizedQuery, ignoreCase = true) ||
        skill.description?.contains(normalizedQuery, ignoreCase = true) == true
    val matchesFilter =
      when (filter) {
        InstalledSkillFilter.All -> true
        InstalledSkillFilter.Ready -> skillReady(skill)
        InstalledSkillFilter.Setup -> skillNeedsSetup(skill)
        InstalledSkillFilter.Off -> skill.disabled
      }
    matchesQuery && matchesFilter
  }
}

private fun installedSkillFilterLabel(filter: InstalledSkillFilter): String =
  when (filter) {
    InstalledSkillFilter.All -> nativeString("All")
    InstalledSkillFilter.Ready -> nativeString("Ready")
    InstalledSkillFilter.Setup -> nativeString("Needs Setup")
    InstalledSkillFilter.Off -> nativeString("Off")
  }

private fun skillReady(skill: GatewaySkillSummary): Boolean =
  !skill.disabled &&
    skill.eligible &&
    !skill.blockedByAllowlist &&
    !skill.blockedByAgentFilter &&
    skill.missingCount == 0

private fun skillNeedsSetup(skill: GatewaySkillSummary): Boolean =
  !skill.disabled &&
    (skill.blockedByAllowlist || skill.blockedByAgentFilter || !skill.eligible || skill.missingCount > 0)

private fun skillStatusText(skill: GatewaySkillSummary): String =
  when {
    skill.disabled -> nativeString("Off")
    skillNeedsSetup(skill) -> nativeString("Setup")
    else -> nativeString("Ready")
  }

private fun skillStatus(skill: GatewaySkillSummary): ClawStatus =
  when {
    skill.disabled -> ClawStatus.Neutral
    skillNeedsSetup(skill) -> ClawStatus.Warning
    else -> ClawStatus.Success
  }

private fun skillSubtitle(skill: GatewaySkillSummary): String {
  val issue =
    when {
      skill.disabled -> nativeString("Disabled")
      skill.blockedByAllowlist -> nativeString("Blocked")
      skill.blockedByAgentFilter -> nativeString("Not available to this agent")
      skill.missingCount > 0 -> skillMissingItemsText(skill.missingCount)
      !skill.eligible -> nativeString("Needs setup")
      else -> null
    }
  return listOfNotNull(skill.description, skillSourceLabel(skill), issue).joinToString(" · ")
}

private fun skillConfigurationText(skill: GatewaySkillSummary): String =
  when {
    skill.disabled -> nativeString("This skill is disabled on the gateway. Enable it here when the current connection has operator.admin.")
    skill.blockedByAllowlist -> nativeString("This skill is blocked by the gateway allowlist. Allowlist changes stay on desktop or CLI.")
    skill.blockedByAgentFilter -> nativeString("This skill is installed but not available to the current agent. Agent filters stay on desktop or CLI.")
    skill.missingCount > 0 -> skillMissingConfigurationText(skill.missingCount)
    !skill.eligible -> nativeString("This skill is installed but not currently eligible to run. Use desktop or CLI for configuration changes.")
    else -> nativeString("Ready on this gateway. Android can enable or disable it globally; setup and configuration stay on desktop or CLI.")
  }

internal fun skillMissingItemsText(count: Int): String =
  when (count) {
    0 -> nativeString("No missing items")
    1 -> nativeString("1 missing item")
    else -> nativeString("\$count missing items", count)
  }

internal fun skillMissingConfigurationText(count: Int): String =
  when (count) {
    1 -> nativeString("This skill needs 1 setup item. Android shows what is installed; setup/config changes stay on desktop or CLI.")
    else -> nativeString("This skill needs \$count setup items. Android shows what is installed; setup/config changes stay on desktop or CLI.", count)
  }

private fun skillSourceLabel(skill: GatewaySkillSummary): String =
  when (skill.source) {
    "openclaw-bundled" -> if (skill.bundled) nativeString("Built-in") else nativeString("Bundled")
    "openclaw-managed" -> nativeString("Installed")
    "openclaw-workspace" -> nativeString("Workspace")
    "openclaw-extra" -> nativeString("Extra")
    else -> nativeString("Skill")
  }

private fun skillBadge(skill: GatewaySkillSummary): String {
  skill.emoji?.let { return it }
  return skillBadge(skill.name)
}

private fun skillBadge(name: String): String =
  name
    .split(' ', '-', '_')
    .filter { it.isNotBlank() }
    .take(2)
    .mapNotNull { it.uppercaseFirstGraphemeOrNull() }
    .joinToString("")
    .ifBlank { "S" }
