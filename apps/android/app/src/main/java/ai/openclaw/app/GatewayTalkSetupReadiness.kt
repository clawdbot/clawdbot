package ai.openclaw.app

import ai.openclaw.app.i18n.NativeText
import ai.openclaw.app.i18n.nativeString
import ai.openclaw.app.i18n.nativeText
import ai.openclaw.app.i18n.resolveNativeText
import ai.openclaw.app.i18n.verbatimText
import ai.openclaw.app.node.asObjectOrNull
import ai.openclaw.app.node.asStringOrNull
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.booleanOrNull

data class GatewayTalkSetupReadiness(
  val realtimeTalk: GatewayTalkSetupState,
  val dictation: GatewayTalkSetupState,
) {
  companion object {
    fun unverified(
      issue: GatewayTalkSetupIssue = GatewayTalkSetupIssue.CatalogNotLoaded,
    ): GatewayTalkSetupReadiness =
      GatewayTalkSetupReadiness(
        realtimeTalk = GatewayTalkSetupState.Unverified(issue),
        dictation = GatewayTalkSetupState.Unverified(issue),
      )
  }
}

sealed interface GatewayTalkSetupState {
  data class Ready(
    val provider: GatewayTalkProvider,
  ) : GatewayTalkSetupState

  data class NeedsSetup(
    val issue: GatewayTalkSetupIssue,
    val provider: GatewayTalkProvider? = null,
  ) : GatewayTalkSetupState

  /** Catalog failures must not disable a startup path that the Gateway still validates. */
  data class Unverified(
    val issue: GatewayTalkSetupIssue,
  ) : GatewayTalkSetupState
}

enum class GatewayTalkSetupTarget(
  val title: NativeText,
) {
  REALTIME_TALK(nativeText("Realtime Talk")),
  DICTATION(nativeText("Dictation")),
}

sealed interface GatewayTalkSetupIssue {
  data object CatalogNotLoaded : GatewayTalkSetupIssue

  data object CatalogLoadFailed : GatewayTalkSetupIssue

  data class GroupMissing(
    val target: GatewayTalkSetupTarget,
  ) : GatewayTalkSetupIssue

  data class NoProvider(
    val target: GatewayTalkSetupTarget,
  ) : GatewayTalkSetupIssue

  data class UnknownProvider(
    val target: GatewayTalkSetupTarget,
    val providerId: String,
  ) : GatewayTalkSetupIssue

  data class MissingReadiness(
    val target: GatewayTalkSetupTarget,
  ) : GatewayTalkSetupIssue

  data class ConfigureProvider(
    val target: GatewayTalkSetupTarget,
  ) : GatewayTalkSetupIssue

  data class MissingActiveProvider(
    val target: GatewayTalkSetupTarget,
  ) : GatewayTalkSetupIssue

  data class UnsupportedProvider(
    val target: GatewayTalkSetupTarget,
  ) : GatewayTalkSetupIssue

  data class ConfigureSelectedProvider(
    val providerLabel: String,
  ) : GatewayTalkSetupIssue
}

data class GatewayTalkProvider(
  val id: String,
  val label: String,
)

val GatewayTalkSetupState.isReady: Boolean
  get() = this is GatewayTalkSetupState.Ready

val GatewayTalkSetupState.requiresSetup: Boolean
  get() = this is GatewayTalkSetupState.NeedsSetup

fun gatewayTalkSetupStatusText(state: GatewayTalkSetupState): String =
  when (state) {
    is GatewayTalkSetupState.Ready -> nativeString("Ready")
    is GatewayTalkSetupState.NeedsSetup -> nativeString("Needs setup")
    is GatewayTalkSetupState.Unverified -> nativeString("Unverified")
  }

fun gatewayTalkSetupDescription(state: GatewayTalkSetupState): String = gatewayTalkSetupDescriptionText(state).resolveNativeText()

internal fun gatewayTalkSetupDescriptionText(state: GatewayTalkSetupState): NativeText =
  when (state) {
    is GatewayTalkSetupState.Ready ->
      nativeText("\${state.provider.label} via Gateway relay", verbatimText(state.provider.label))
    is GatewayTalkSetupState.NeedsSetup -> gatewayTalkSetupIssueDescriptionText(state.issue)
    is GatewayTalkSetupState.Unverified -> gatewayTalkSetupIssueDescriptionText(state.issue)
  }

internal fun gatewayTalkSetupIssueDescriptionText(issue: GatewayTalkSetupIssue): NativeText =
  when (issue) {
    GatewayTalkSetupIssue.CatalogNotLoaded -> nativeText("Gateway talk catalog not loaded")
    GatewayTalkSetupIssue.CatalogLoadFailed -> nativeText("Could not load Gateway talk catalog")
    is GatewayTalkSetupIssue.GroupMissing ->
      nativeText("Gateway did not return \${issue.target.title} setup", issue.target.title)
    is GatewayTalkSetupIssue.NoProvider ->
      nativeText("No \${issue.target.title} provider is configured on the Gateway", issue.target.title)
    is GatewayTalkSetupIssue.UnknownProvider ->
      nativeText("Gateway selected unknown provider \${issue.providerId}", verbatimText(issue.providerId))
    is GatewayTalkSetupIssue.MissingReadiness ->
      nativeText("Gateway did not return \${issue.target.title} readiness", issue.target.title)
    is GatewayTalkSetupIssue.ConfigureProvider ->
      nativeText("Configure a \${issue.target.title} provider on the Gateway", issue.target.title)
    is GatewayTalkSetupIssue.MissingActiveProvider ->
      nativeText("Gateway did not identify the active \${issue.target.title} provider", issue.target.title)
    is GatewayTalkSetupIssue.UnsupportedProvider ->
      nativeText("Choose a supported \${issue.target.title} provider on the Gateway", issue.target.title)
    is GatewayTalkSetupIssue.ConfigureSelectedProvider ->
      nativeText("Configure \${issue.providerLabel} on the Gateway", verbatimText(issue.providerLabel))
  }

internal fun parseGatewayTalkSetupReadiness(catalog: JsonObject?): GatewayTalkSetupReadiness {
  if (catalog == null) return GatewayTalkSetupReadiness.unverified()
  return GatewayTalkSetupReadiness(
    realtimeTalk =
      parseTalkCatalogGroup(catalog = catalog, key = "realtime", target = GatewayTalkSetupTarget.REALTIME_TALK),
    dictation =
      parseTalkCatalogGroup(catalog = catalog, key = "transcription", target = GatewayTalkSetupTarget.DICTATION),
  )
}

private fun parseTalkCatalogGroup(
  catalog: JsonObject,
  key: String,
  target: GatewayTalkSetupTarget,
): GatewayTalkSetupState {
  val group =
    catalog[key].asObjectOrNull()
      ?: return GatewayTalkSetupState.Unverified(GatewayTalkSetupIssue.GroupMissing(target))
  val providers =
    (group["providers"] as? JsonArray)
      ?.mapNotNull(::parseTalkCatalogProvider)
      .orEmpty()
  val ready = (group["ready"] as? JsonPrimitive)?.booleanOrNull
  val activeProviderId = group["activeProvider"].asStringOrNull()?.trim()?.takeIf(String::isNotEmpty)
  if (providers.isEmpty()) {
    return when {
      ready == false -> GatewayTalkSetupState.NeedsSetup(GatewayTalkSetupIssue.NoProvider(target))
      activeProviderId != null ->
        GatewayTalkSetupState.Unverified(GatewayTalkSetupIssue.UnknownProvider(target, activeProviderId))
      else -> GatewayTalkSetupState.Unverified(GatewayTalkSetupIssue.MissingReadiness(target))
    }
  }

  if (activeProviderId == null) {
    if (ready == false) {
      return GatewayTalkSetupState.NeedsSetup(GatewayTalkSetupIssue.ConfigureProvider(target))
    }
    // Older Gateways can omit the selected provider and report alias-backed rows as unconfigured
    // even though session startup resolves them. Only an explicit readiness result is authoritative.
    return GatewayTalkSetupState.Unverified(GatewayTalkSetupIssue.MissingActiveProvider(target))
  }
  val selected =
    // Match Gateway registry precedence: canonical ids win before alias fallback.
    providers.firstOrNull { it.matchesId(activeProviderId) }
      ?: providers.firstOrNull { it.matchesAlias(activeProviderId) }
      ?: return if (ready == false) {
        GatewayTalkSetupState.NeedsSetup(GatewayTalkSetupIssue.UnsupportedProvider(target))
      } else {
        GatewayTalkSetupState.Unverified(GatewayTalkSetupIssue.UnknownProvider(target, activeProviderId))
      }
  val provider = GatewayTalkProvider(id = selected.id, label = selected.label)
  return when (ready) {
    true -> GatewayTalkSetupState.Ready(provider)
    false ->
      GatewayTalkSetupState.NeedsSetup(
        issue = GatewayTalkSetupIssue.ConfigureSelectedProvider(selected.label),
        provider = provider,
      )
    null -> GatewayTalkSetupState.Unverified(GatewayTalkSetupIssue.MissingReadiness(target))
  }
}

private data class TalkCatalogProvider(
  val id: String,
  val label: String,
  val configured: Boolean,
  val aliases: List<String>,
) {
  fun matchesId(candidate: String): Boolean = id.equals(candidate, ignoreCase = true)

  fun matchesAlias(candidate: String): Boolean = aliases.any { it.equals(candidate, ignoreCase = true) }
}

private fun parseTalkCatalogProvider(item: JsonElement): TalkCatalogProvider? {
  val value = item.asObjectOrNull() ?: return null
  val id = value["id"].asStringOrNull()?.trim()?.takeIf(String::isNotEmpty) ?: return null
  val label = value["label"].asStringOrNull()?.trim()?.takeIf(String::isNotEmpty) ?: id
  val aliases =
    (value["aliases"] as? JsonArray)
      ?.mapNotNull { it.asStringOrNull()?.trim()?.takeIf(String::isNotEmpty) }
      .orEmpty()
  return TalkCatalogProvider(
    id = id,
    label = label,
    configured = (value["configured"] as? JsonPrimitive)?.booleanOrNull == true,
    aliases = aliases,
  )
}
