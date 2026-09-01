package ai.openclaw.app.ui.chat

import ai.openclaw.app.GatewayModelSummary
import ai.openclaw.app.GatewayModelUnavailableReason
import ai.openclaw.app.i18n.NativeText
import ai.openclaw.app.i18n.nativeText

internal data class ChatModelPickerSections(
  val pinned: List<GatewayModelSummary>,
  val recent: List<GatewayModelSummary>,
  val remaining: List<GatewayModelSummary>,
)

internal enum class ChatModelPickerAction {
  Select,
  OpenProviders,
  Disabled,
}

internal fun GatewayModelSummary.providerQualifiedRef(): String {
  val trimmedProvider = provider.trim()
  if (trimmedProvider.isEmpty()) return id
  val providerPrefix = "$trimmedProvider/"
  return if (id.startsWith(providerPrefix)) id else "$providerPrefix$id"
}

internal fun thinkingSupportedForSelection(
  selectedModelRef: String?,
  catalog: List<GatewayModelSummary>,
): Boolean {
  val selected = selectedModelRef ?: return true
  return catalog.firstOrNull { it.providerQualifiedRef() == selected }?.supportsReasoning != false
}

internal fun selectedChatModelUnavailableReason(
  selectedModelRef: String?,
  catalog: List<GatewayModelSummary>,
): GatewayModelUnavailableReason? {
  val selected = selectedModelRef?.trim()?.takeIf { it.isNotEmpty() } ?: return null
  val matches = catalog.filter { it.providerQualifiedRef().equals(selected, ignoreCase = true) }
  if (matches.isEmpty() || matches.any { it.available != false || it.unavailableReason == null }) return null
  if (matches.any { it.unavailableReason == GatewayModelUnavailableReason.Cooldown }) {
    return GatewayModelUnavailableReason.Cooldown
  }
  return if (matches.any { it.unavailableReason == GatewayModelUnavailableReason.AuthFailed }) {
    GatewayModelUnavailableReason.AuthFailed
  } else {
    GatewayModelUnavailableReason.MissingAuth
  }
}

internal fun selectedChatModelSendUnavailableReason(
  selectedModelRef: String?,
  catalog: List<GatewayModelSummary>,
): GatewayModelUnavailableReason? =
  selectedChatModelUnavailableReason(selectedModelRef, catalog).takeIf {
    it == GatewayModelUnavailableReason.MissingAuth || it == GatewayModelUnavailableReason.AuthFailed
  }

internal fun selectedChatModelSendBlockingReason(
  gatewayReady: Boolean,
  selectedModelRef: String?,
  catalog: List<GatewayModelSummary>,
): GatewayModelUnavailableReason? = if (gatewayReady) selectedChatModelSendUnavailableReason(selectedModelRef, catalog) else null

internal fun chatModelSendBlocked(
  gatewayReady: Boolean,
  selectedModelRef: String?,
  catalog: List<GatewayModelSummary>,
): Boolean = selectedChatModelSendBlockingReason(gatewayReady, selectedModelRef, catalog) != null

internal fun chatModelPickerAction(model: GatewayModelSummary): ChatModelPickerAction =
  when {
    model.available != false -> ChatModelPickerAction.Select
    model.unavailableReason == GatewayModelUnavailableReason.MissingAuth ||
      model.unavailableReason == GatewayModelUnavailableReason.AuthFailed -> ChatModelPickerAction.OpenProviders
    else -> ChatModelPickerAction.Disabled
  }

internal fun chatModelUnavailableText(reason: GatewayModelUnavailableReason?): NativeText? =
  when (reason) {
    GatewayModelUnavailableReason.MissingAuth,
    GatewayModelUnavailableReason.AuthFailed,
    -> nativeText("Authentication needed")
    else -> null
  }

internal fun chatModelPickerSections(
  catalog: List<GatewayModelSummary>,
  favorites: List<String>,
  recents: List<String>,
): ChatModelPickerSections {
  val modelsByRef = catalog.associateBy { it.providerQualifiedRef() }
  val includedRefs = mutableSetOf<String>()
  val pinned =
    favorites.mapNotNull { ref ->
      modelsByRef[ref]?.takeIf { includedRefs.add(ref) }
    }
  val recent =
    recents.mapNotNull { ref ->
      modelsByRef[ref]?.takeIf { includedRefs.add(ref) }
    }
  val remaining = catalog.filter { model -> includedRefs.add(model.providerQualifiedRef()) }
  return ChatModelPickerSections(pinned = pinned, recent = recent, remaining = remaining)
}
