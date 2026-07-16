package ai.openclaw.app.ui

import ai.openclaw.app.GatewayAgentSummary
import ai.openclaw.app.GatewaySkillWorkshopProposal
import ai.openclaw.app.GatewaySkillWorkshopSummary
import ai.openclaw.app.MainViewModel
import ai.openclaw.app.i18n.nativeString
import ai.openclaw.app.ui.design.ClawPanel
import ai.openclaw.app.ui.design.ClawPrimaryButton
import ai.openclaw.app.ui.design.ClawSecondaryButton
import ai.openclaw.app.ui.design.ClawSegmentedControl
import ai.openclaw.app.ui.design.ClawStatus
import ai.openclaw.app.ui.design.ClawStatusPill
import ai.openclaw.app.ui.design.ClawTextField
import ai.openclaw.app.ui.design.ClawTheme
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.ArrowDropDown
import androidx.compose.material.icons.filled.Refresh
import androidx.compose.material.icons.filled.Settings
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.HorizontalDivider
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
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp

private val skillWorkshopFilterLabels = listOf("Pending", "Held", "Applied", "Rejected", "All")

@Composable
internal fun SkillWorkshopSettingsScreen(
  viewModel: MainViewModel,
  onBack: () -> Unit,
) {
  val summary by viewModel.skillWorkshopSummary.collectAsState()
  val refreshing by viewModel.skillWorkshopRefreshing.collectAsState()
  val errorText by viewModel.skillWorkshopErrorText.collectAsState()
  val noticeText by viewModel.skillWorkshopNoticeText.collectAsState()
  val inspectingProposalId by viewModel.skillWorkshopInspectingProposalId.collectAsState()
  val mutatingProposalId by viewModel.skillWorkshopMutatingProposalId.collectAsState()
  val isConnected by viewModel.isConnected.collectAsState()
  val operatorAdminScopeAvailable by viewModel.operatorAdminScopeAvailable.collectAsState()
  val agents by viewModel.gatewayAgents.collectAsState()
  val defaultAgentId by viewModel.gatewayDefaultAgentId.collectAsState()

  var statusFilter by rememberSaveable { mutableStateOf("pending") }
  var query by rememberSaveable { mutableStateOf("") }
  var selectedAgentId by rememberSaveable { mutableStateOf("") }
  var selectedProposalId by rememberSaveable { mutableStateOf<String?>(null) }
  var pendingAction by remember { mutableStateOf<SkillWorkshopPendingAction?>(null) }
  val selectedAgentParam = selectedAgentId.trim().takeIf { it.isNotEmpty() }
  val visibleProposals = skillWorkshopVisibleProposals(summary, selectedAgentParam)
  val filteredProposals = skillWorkshopFilteredProposals(visibleProposals, statusFilter, query)
  val selectedProposal =
    filteredProposals.firstOrNull { it.id == selectedProposalId }
      ?: filteredProposals.firstOrNull()

  LaunchedEffect(isConnected, selectedAgentParam) {
    if (isConnected) {
      viewModel.refreshSkillWorkshopProposals(agentId = selectedAgentParam)
    }
  }

  LaunchedEffect(filteredProposals.map { it.id }) {
    if (selectedProposalId == null || filteredProposals.none { it.id == selectedProposalId }) {
      selectedProposalId = filteredProposals.firstOrNull()?.id
    }
  }

  LaunchedEffect(selectedProposal?.id, selectedProposal?.content, isConnected, selectedAgentParam) {
    if (isConnected && selectedProposal != null && selectedProposal.content == null) {
      viewModel.inspectSkillWorkshopProposal(proposalId = selectedProposal.id, agentId = selectedAgentParam)
    }
  }

  LaunchedEffect(selectedProposal?.id, pendingAction?.proposalId) {
    if (pendingAction != null && selectedProposal?.id != pendingAction?.proposalId) {
      pendingAction = null
    }
  }

  pendingAction?.let { action ->
    SkillWorkshopActionConfirmDialog(
      action = action,
      onDismiss = { pendingAction = null },
      onConfirm = {
        pendingAction = null
        when (action.action) {
          SkillWorkshopProposalAction.Apply ->
            viewModel.applySkillWorkshopProposal(
              proposalId = action.proposalId,
              agentId = selectedAgentParam,
            )
          SkillWorkshopProposalAction.Reject ->
            viewModel.rejectSkillWorkshopProposal(
              proposalId = action.proposalId,
              agentId = selectedAgentParam,
            )
          SkillWorkshopProposalAction.Quarantine ->
            viewModel.quarantineSkillWorkshopProposal(
              proposalId = action.proposalId,
              agentId = selectedAgentParam,
            )
        }
      },
    )
  }

  SettingsDetailFrame(
    title = nativeString("Skill Workshop"),
    subtitle = nativeString("Review generated skill proposals before they become live skills."),
    icon = Icons.Default.Settings,
    onBack = onBack,
  ) {
    SettingsMetricPanel(
      rows =
        listOf(
          SettingsMetric(nativeString("Pending"), visibleProposals.count { it.status == "pending" }.toString()),
          SettingsMetric(
            nativeString("Held"),
            visibleProposals.count { skillWorkshopStatusMatchesFilter(it.status, "held") }.toString(),
          ),
          SettingsMetric(nativeString("Applied"), visibleProposals.count { it.status == "applied" }.toString()),
          SettingsMetric(nativeString("Rejected"), visibleProposals.count { it.status == "rejected" }.toString()),
        ),
    )

    SkillWorkshopControls(
      agents = agents,
      defaultAgentId = defaultAgentId,
      selectedAgentId = selectedAgentId,
      onAgentChange = { agentId ->
        selectedAgentId = agentId
        selectedProposalId = null
        viewModel.resetSkillWorkshopAgentScope(agentId = agentId.takeIf { it.isNotBlank() })
      },
      statusFilter = statusFilter,
      onStatusFilterChange = { filter ->
        statusFilter = filter
        selectedProposalId = null
      },
      query = query,
      onQueryChange = { value ->
        query = value
        selectedProposalId = null
      },
      refreshing = refreshing,
      isConnected = isConnected,
      onRefresh = { viewModel.refreshSkillWorkshopProposals(agentId = selectedAgentParam) },
    )

    noticeText?.let { message ->
      ClawPanel {
        Text(text = message, style = ClawTheme.type.body, color = ClawTheme.colors.success)
      }
    }
    errorText?.let { message ->
      ClawPanel {
        Text(text = message, style = ClawTheme.type.body, color = ClawTheme.colors.warning)
      }
    }

    when {
      !isConnected ->
        SkillWorkshopEmptyPanel(
          title = nativeString("Gateway offline"),
          detail = nativeString("Connect to a Gateway to load Skill Workshop proposals."),
        )
      filteredProposals.isEmpty() ->
        SkillWorkshopEmptyPanel(
          title = nativeString("No proposals"),
          detail = nativeString("Matching proposals will appear here after agents create reusable skill drafts."),
        )
      else -> {
        SkillWorkshopProposalList(
          proposals = filteredProposals,
          selectedProposalId = selectedProposal?.id,
          inspectingProposalId = inspectingProposalId,
          mutatingProposalId = mutatingProposalId,
          onSelect = { proposal ->
            selectedProposalId = proposal.id
            viewModel.inspectSkillWorkshopProposal(proposalId = proposal.id, agentId = selectedAgentParam)
          },
        )
        selectedProposal?.let { proposal ->
          SkillWorkshopProposalDetail(
            proposal = proposal,
            inspecting = inspectingProposalId == proposal.id,
            mutating = mutatingProposalId == proposal.id,
            isConnected = isConnected,
            operatorAdminScopeAvailable = operatorAdminScopeAvailable,
            onInspect = {
              viewModel.inspectSkillWorkshopProposal(proposalId = proposal.id, agentId = selectedAgentParam)
            },
            onApply = {
              pendingAction =
                SkillWorkshopPendingAction(
                  action = SkillWorkshopProposalAction.Apply,
                  proposalId = proposal.id,
                  title = proposal.title,
                )
            },
            onReject = {
              pendingAction =
                SkillWorkshopPendingAction(
                  action = SkillWorkshopProposalAction.Reject,
                  proposalId = proposal.id,
                  title = proposal.title,
                )
            },
            onQuarantine = {
              pendingAction =
                SkillWorkshopPendingAction(
                  action = SkillWorkshopProposalAction.Quarantine,
                  proposalId = proposal.id,
                  title = proposal.title,
                )
            },
          )
        }
      }
    }
  }
}

private enum class SkillWorkshopProposalAction(
  val label: String,
) {
  Apply("Apply"),
  Reject("Reject"),
  Quarantine("Quarantine"),
}

private data class SkillWorkshopPendingAction(
  val action: SkillWorkshopProposalAction,
  val proposalId: String,
  val title: String,
)

@Composable
private fun SkillWorkshopActionConfirmDialog(
  action: SkillWorkshopPendingAction,
  onDismiss: () -> Unit,
  onConfirm: () -> Unit,
) {
  val dialogTitle =
    when (action.action) {
      SkillWorkshopProposalAction.Apply -> nativeString("Apply proposal?")
      SkillWorkshopProposalAction.Reject -> nativeString("Reject proposal?")
      SkillWorkshopProposalAction.Quarantine -> nativeString("Quarantine proposal?")
    }
  val dialogBody =
    when (action.action) {
      SkillWorkshopProposalAction.Apply ->
        nativeString("This will apply \"\$proposalTitle\" and refresh Skill Workshop state from the gateway.", action.title)
      SkillWorkshopProposalAction.Reject ->
        nativeString("This will reject \"\$proposalTitle\" and refresh Skill Workshop state from the gateway.", action.title)
      SkillWorkshopProposalAction.Quarantine ->
        nativeString("This will quarantine \"\$proposalTitle\" and refresh Skill Workshop state from the gateway.", action.title)
    }
  AlertDialog(
    onDismissRequest = onDismiss,
    title = { Text(dialogTitle) },
    text = {
      Text(text = dialogBody)
    },
    confirmButton = {
      TextButton(onClick = onConfirm) {
        Text(nativeString(action.action.label))
      }
    },
    dismissButton = {
      TextButton(onClick = onDismiss) {
        Text(nativeString("Cancel"))
      }
    },
  )
}

@Composable
private fun SkillWorkshopControls(
  agents: List<GatewayAgentSummary>,
  defaultAgentId: String?,
  selectedAgentId: String,
  onAgentChange: (String) -> Unit,
  statusFilter: String,
  onStatusFilterChange: (String) -> Unit,
  query: String,
  onQueryChange: (String) -> Unit,
  refreshing: Boolean,
  isConnected: Boolean,
  onRefresh: () -> Unit,
) {
  ClawPanel {
    Column(verticalArrangement = Arrangement.spacedBy(10.dp)) {
      Row(
        modifier = Modifier.fillMaxWidth(),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(8.dp),
      ) {
        SkillWorkshopAgentMenu(
          agents = agents,
          defaultAgentId = defaultAgentId,
          selectedAgentId = selectedAgentId,
          onAgentChange = onAgentChange,
          modifier = Modifier.weight(1f),
        )
        ClawSecondaryButton(
          text = if (refreshing) nativeString("Refreshing") else nativeString("Refresh"),
          onClick = onRefresh,
          enabled = isConnected && !refreshing,
          icon = Icons.Default.Refresh,
        )
      }
      ClawSegmentedControl(
        options = skillWorkshopFilterLabels.map(::nativeString),
        selected = skillWorkshopFilterLabel(statusFilter),
        onSelect = { label -> onStatusFilterChange(skillWorkshopFilterFromLabel(label)) },
        maxOptionsPerRow = 4,
      )
      ClawTextField(
        value = query,
        onValueChange = onQueryChange,
        placeholder = nativeString("Search proposals"),
      )
    }
  }
}

@Composable
private fun SkillWorkshopAgentMenu(
  agents: List<GatewayAgentSummary>,
  defaultAgentId: String?,
  selectedAgentId: String,
  onAgentChange: (String) -> Unit,
  modifier: Modifier = Modifier,
) {
  var expanded by remember { mutableStateOf(false) }
  val label =
    skillWorkshopAgentLabel(
      agents = agents,
      defaultAgentId = defaultAgentId,
      selectedAgentId = selectedAgentId,
    )
  Box(modifier = modifier) {
    ClawSecondaryButton(
      text = label,
      onClick = { expanded = true },
      icon = Icons.Default.ArrowDropDown,
      modifier = Modifier.fillMaxWidth(),
      enabled = agents.isNotEmpty(),
    )
    DropdownMenu(expanded = expanded, onDismissRequest = { expanded = false }) {
      DropdownMenuItem(
        text = { Text(nativeString("Default agent")) },
        onClick = {
          expanded = false
          onAgentChange("")
        },
      )
      agents
        .filter { agent -> agent.id.trim().isNotEmpty() && agent.id != defaultAgentId }
        .sortedBy { it.name ?: it.id }
        .forEach { agent ->
          DropdownMenuItem(
            text = { Text(agent.name?.takeIf { it.isNotBlank() } ?: agent.id) },
            onClick = {
              expanded = false
              onAgentChange(agent.id)
            },
          )
        }
    }
  }
}

@Composable
private fun SkillWorkshopProposalList(
  proposals: List<GatewaySkillWorkshopProposal>,
  selectedProposalId: String?,
  inspectingProposalId: String?,
  mutatingProposalId: String?,
  onSelect: (GatewaySkillWorkshopProposal) -> Unit,
) {
  Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
    proposals.forEach { proposal ->
      SkillWorkshopProposalRow(
        proposal = proposal,
        selected = proposal.id == selectedProposalId,
        busy = proposal.id == inspectingProposalId || proposal.id == mutatingProposalId,
        onClick = { onSelect(proposal) },
      )
    }
  }
}

@Composable
private fun SkillWorkshopProposalRow(
  proposal: GatewaySkillWorkshopProposal,
  selected: Boolean,
  busy: Boolean,
  onClick: () -> Unit,
) {
  ClawPanel {
    Row(
      modifier = Modifier.fillMaxWidth(),
      verticalAlignment = Alignment.CenterVertically,
      horizontalArrangement = Arrangement.spacedBy(9.dp),
    ) {
      Column(modifier = Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(3.dp)) {
        Text(
          text = proposal.title,
          style = ClawTheme.type.body,
          color = if (selected) ClawTheme.colors.primary else ClawTheme.colors.text,
          maxLines = 1,
          overflow = TextOverflow.Ellipsis,
        )
        Text(
          text = proposal.description ?: proposal.skillKey,
          style = ClawTheme.type.caption,
          color = ClawTheme.colors.textSubtle,
          maxLines = 2,
          overflow = TextOverflow.Ellipsis,
        )
      }
      Column(horizontalAlignment = Alignment.End, verticalArrangement = Arrangement.spacedBy(4.dp)) {
        ClawStatusPill(
          text = skillWorkshopStatusLabel(if (busy) "loading" else proposal.status),
          status = skillWorkshopStatusPill(proposal.status),
        )
        Text(
          text = skillWorkshopDateLabel(proposal.updatedAt),
          style = ClawTheme.type.caption,
          color = ClawTheme.colors.textSubtle,
          maxLines = 1,
        )
      }
    }
    ClawSecondaryButton(
      text = if (selected) nativeString("Selected") else nativeString("Open"),
      onClick = onClick,
      modifier = Modifier.fillMaxWidth(),
      enabled = !selected,
    )
  }
}

@Composable
private fun SkillWorkshopProposalDetail(
  proposal: GatewaySkillWorkshopProposal,
  inspecting: Boolean,
  mutating: Boolean,
  isConnected: Boolean,
  operatorAdminScopeAvailable: Boolean,
  onInspect: () -> Unit,
  onApply: () -> Unit,
  onReject: () -> Unit,
  onQuarantine: () -> Unit,
) {
  ClawPanel {
    Column(verticalArrangement = Arrangement.spacedBy(10.dp)) {
      Row(
        modifier = Modifier.fillMaxWidth(),
        verticalAlignment = Alignment.Top,
        horizontalArrangement = Arrangement.spacedBy(8.dp),
      ) {
        Column(modifier = Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(4.dp)) {
          Text(
            text = proposal.title,
            style = ClawTheme.type.title,
            color = ClawTheme.colors.text,
            maxLines = 2,
            overflow = TextOverflow.Ellipsis,
          )
          Text(
            text = proposal.skillKey,
            style = ClawTheme.type.caption,
            color = ClawTheme.colors.textSubtle,
            maxLines = 1,
            overflow = TextOverflow.Ellipsis,
          )
        }
        ClawStatusPill(
          text = skillWorkshopStatusLabel(proposal.status),
          status = skillWorkshopStatusPill(proposal.status),
        )
      }
      proposal.description?.let { description ->
        Text(text = description, style = ClawTheme.type.body, color = ClawTheme.colors.textMuted)
      }
      SettingsMetricPanel(
        rows =
          listOf(
            SettingsMetric(nativeString("Kind"), proposal.kind),
            SettingsMetric(nativeString("Updated"), skillWorkshopDateLabel(proposal.updatedAt)),
            SettingsMetric(nativeString("Support Files"), proposal.supportFiles.size.toString()),
          ),
      )
      Text(
        text = proposal.content ?: nativeString("Inspect this proposal to load its markdown."),
        style = ClawTheme.type.body,
        color = if (proposal.content == null) ClawTheme.colors.textSubtle else ClawTheme.colors.text,
      )
      if (!operatorAdminScopeAvailable) {
        Text(
          text = nativeString("Apply, reject, and quarantine require operator.admin scope. Reconnect with shared gateway auth or approve an operator.admin device scope upgrade to enable lifecycle actions."),
          style = ClawTheme.type.caption,
          color = ClawTheme.colors.warning,
        )
      }
      if (proposal.supportFiles.isNotEmpty()) {
        HorizontalDivider(color = ClawTheme.colors.border)
        proposal.supportFiles.forEach { file ->
          Text(
            text = file.path,
            style = ClawTheme.type.caption,
            color = ClawTheme.colors.textMuted,
            maxLines = 1,
            overflow = TextOverflow.Ellipsis,
          )
        }
      }
      Row(
        modifier =
          Modifier
            .fillMaxWidth()
            .semantics { contentDescription = nativeString("Skill Workshop inspect and apply actions") },
        horizontalArrangement = Arrangement.spacedBy(8.dp),
      ) {
        ClawSecondaryButton(
          text = if (inspecting) nativeString("Inspecting") else nativeString("Inspect"),
          onClick = onInspect,
          enabled = isConnected && !inspecting && !mutating,
          modifier = Modifier.weight(1f),
        )
        ClawPrimaryButton(
          text = if (mutating) nativeString("Working") else nativeString("Apply"),
          onClick = onApply,
          enabled =
            skillWorkshopProposalActionEnabled(
              isConnected = isConnected,
              operatorAdminScopeAvailable = operatorAdminScopeAvailable,
              busy = inspecting || mutating,
              status = proposal.status,
            ),
          modifier = Modifier.weight(1f),
        )
      }
      Row(
        modifier =
          Modifier
            .fillMaxWidth()
            .semantics { contentDescription = nativeString("Skill Workshop reject and quarantine actions") },
        horizontalArrangement = Arrangement.spacedBy(8.dp),
      ) {
        ClawSecondaryButton(
          text = nativeString("Reject"),
          onClick = onReject,
          enabled =
            skillWorkshopProposalActionEnabled(
              isConnected = isConnected,
              operatorAdminScopeAvailable = operatorAdminScopeAvailable,
              busy = inspecting || mutating,
              status = proposal.status,
            ),
          modifier = Modifier.weight(1f),
        )
        ClawSecondaryButton(
          text = nativeString("Quarantine"),
          onClick = onQuarantine,
          enabled =
            skillWorkshopProposalActionEnabled(
              isConnected = isConnected,
              operatorAdminScopeAvailable = operatorAdminScopeAvailable,
              busy = inspecting || mutating,
              status = proposal.status,
            ),
          modifier = Modifier.weight(1f),
        )
      }
    }
  }
}

@Composable
private fun SkillWorkshopEmptyPanel(
  title: String,
  detail: String,
) {
  ClawPanel {
    Column(verticalArrangement = Arrangement.spacedBy(4.dp)) {
      Text(text = title, style = ClawTheme.type.title, color = ClawTheme.colors.text)
      Text(text = detail, style = ClawTheme.type.body, color = ClawTheme.colors.textMuted)
    }
  }
}

internal fun skillWorkshopVisibleProposals(
  summary: GatewaySkillWorkshopSummary,
  selectedAgentId: String?,
): List<GatewaySkillWorkshopProposal> =
  when {
    summary.agentId == skillWorkshopAgentScope(selectedAgentId) -> summary.proposals
    else -> emptyList()
  }

internal fun skillWorkshopAgentScope(agentId: String?): String = agentId?.trim().orEmpty()

internal fun skillWorkshopFilteredProposals(
  proposals: List<GatewaySkillWorkshopProposal>,
  statusFilter: String,
  query: String,
): List<GatewaySkillWorkshopProposal> {
  val normalizedQuery = query.trim().lowercase()
  val matchingStatus =
    proposals.filter { proposal -> skillWorkshopStatusMatchesFilter(proposal.status, statusFilter) }
  val matchingQuery =
    matchingStatus.filter { proposal ->
      if (normalizedQuery.isEmpty()) return@filter true
      val pieces =
        listOf(proposal.title, proposal.description.orEmpty(), proposal.skillName, proposal.skillKey)
      val haystack = pieces.joinToString(" ").lowercase()
      haystack.contains(normalizedQuery)
    }
  return matchingQuery.sortedByDescending { it.updatedAt }
}

internal fun skillWorkshopStatusMatchesFilter(
  status: String,
  filter: String,
): Boolean =
  when (filter) {
    "all" -> true
    "held" -> status == "quarantined" || status == "stale"
    else -> status == filter
  }

internal fun skillWorkshopProposalActionEnabled(
  isConnected: Boolean,
  operatorAdminScopeAvailable: Boolean,
  busy: Boolean,
  status: String,
): Boolean = isConnected && operatorAdminScopeAvailable && !busy && status == "pending"

internal fun skillWorkshopStatusLabel(status: String): String =
  when (status) {
    "pending" -> nativeString("Pending")
    "quarantined", "stale" -> nativeString("Held")
    "applied" -> nativeString("Applied")
    "rejected" -> nativeString("Rejected")
    "loading" -> nativeString("Loading")
    else -> status
  }

private fun skillWorkshopFilterLabel(filter: String): String =
  when (filter) {
    "pending" -> nativeString("Pending")
    "held" -> nativeString("Held")
    "applied" -> nativeString("Applied")
    "rejected" -> nativeString("Rejected")
    else -> nativeString("All")
  }

private fun skillWorkshopFilterFromLabel(label: String): String =
  when (label) {
    nativeString("Pending") -> "pending"
    nativeString("Held") -> "held"
    nativeString("Applied") -> "applied"
    nativeString("Rejected") -> "rejected"
    else -> "all"
  }

private fun skillWorkshopAgentLabel(
  agents: List<GatewayAgentSummary>,
  defaultAgentId: String?,
  selectedAgentId: String,
): String {
  val selected = selectedAgentId.trim()
  if (selected.isNotEmpty()) {
    return agents.firstOrNull { it.id == selected }?.name?.takeIf { it.isNotBlank() } ?: selected
  }
  val defaultId = defaultAgentId?.trim().orEmpty()
  if (defaultId.isNotEmpty()) {
    return agents.firstOrNull { it.id == defaultId }?.name?.takeIf { it.isNotBlank() }
      ?: nativeString("Default agent")
  }
  return nativeString("Default agent")
}

private fun skillWorkshopStatusPill(status: String): ClawStatus =
  when (status) {
    "pending", "quarantined", "stale" -> ClawStatus.Warning
    "applied" -> ClawStatus.Success
    "rejected" -> ClawStatus.Neutral
    else -> ClawStatus.Neutral
  }

private fun skillWorkshopDateLabel(value: String): String = value.trim().takeIf { it.isNotEmpty() }?.take(10) ?: nativeString("Unknown")
