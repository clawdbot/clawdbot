package ai.openclaw.app.ui.chat

import ai.openclaw.app.GatewayModelSummary

internal data class ChatModelPickerSections(
  val pinned: List<GatewayModelSummary>,
  val recent: List<GatewayModelSummary>,
  val remaining: List<GatewayModelSummary>,
)

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
