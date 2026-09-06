import Observation
import OpenClawChatUI
import SwiftUI

enum ChatActionMenuMetric {
    static let horizontalPadding: CGFloat = 14
    static let iconWidth: CGFloat = 24
    static let rowHeight: CGFloat = 44
}

struct ChatActionSystemRow: View {
    let title: String
    let systemImage: String
    var isSelected = false

    var body: some View {
        HStack(spacing: 12) {
            Image(systemName: self.systemImage)
                .foregroundStyle(OpenClawBrand.accentForeground)
                .frame(width: ChatActionMenuMetric.iconWidth, alignment: .leading)
                .accessibilityHidden(true)
            Text(self.title)
                .font(OpenClawType.body)
                .multilineTextAlignment(.leading)
            Spacer(minLength: 12)
            if self.isSelected {
                Image(systemName: "checkmark")
                    .font(OpenClawType.body)
                    .foregroundStyle(OpenClawBrand.accentForeground)
                    .accessibilityIdentifier("chat-menu-selection-checkmark")
            }
        }
        .frame(maxWidth: .infinity, minHeight: ChatActionMenuMetric.rowHeight, alignment: .leading)
        .padding(.horizontal, ChatActionMenuMetric.horizontalPadding)
        .contentShape(Rectangle())
    }
}

struct ChatActionMenuSectionHeader: View {
    let title: String
    var detail: String?
    var resetAccessibilityIdentifier: String?
    var resetAction: (() -> Void)?

    var body: some View {
        HStack(spacing: 12) {
            Color.clear
                .frame(width: ChatActionMenuMetric.iconWidth, height: 1)
            Text(self.title)
                .font(OpenClawType.caption)
            if let detail {
                Text(detail)
                    .font(OpenClawType.caption)
                    .foregroundStyle(.tertiary)
            }
            Spacer(minLength: 0)
            if let resetAction, let resetAccessibilityIdentifier {
                Button(action: resetAction) {
                    Image(systemName: "arrow.uturn.backward")
                        .frame(width: ChatActionMenuMetric.rowHeight, height: ChatActionMenuMetric.rowHeight)
                        .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .foregroundStyle(OpenClawBrand.accentForeground)
                .accessibilityLabel(String(localized: "Use default"))
                .accessibilityIdentifier(resetAccessibilityIdentifier)
            }
        }
        .foregroundStyle(.secondary)
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(.horizontal, ChatActionMenuMetric.horizontalPadding)
        .padding(.top, 9)
        .padding(.bottom, 3)
    }
}

enum ChatModelProviderPalette: Equatable {
    case openAI
    case anthropic
    case google
    case adaptiveMonochrome
}

enum ChatModelMenuPresentation {
    static func providerID(for model: OpenClawChatModelChoice) -> String? {
        let metadataProvider = self.normalizedProviderID(model.provider)
        if let metadataProvider {
            return metadataProvider
        }
        let qualifiedID = model.modelID.split(separator: "/", maxSplits: 1).map(String.init)
        guard qualifiedID.count == 2 else { return nil }
        return self.normalizedProviderID(qualifiedID[0])
    }

    static func iconAssetName(providerID: String?) -> String? {
        switch self.normalizedProviderID(providerID) {
        case "anthropic", "claude-cli": "ProviderIconAnthropic"
        case "google", "google-gemini-cli": "ProviderIconGoogle"
        case "minimax", "minimax-portal": "ProviderIconMiniMax"
        case "openai": "ProviderIconOpenAI"
        case "openrouter": "ProviderIconOpenRouter"
        case "xai": "ProviderIconXAI"
        default: nil
        }
    }

    static func brandPalette(providerID: String?) -> ChatModelProviderPalette {
        switch self.normalizedProviderID(providerID) {
        case "openai": .openAI
        case "anthropic", "claude-cli": .anthropic
        case "google", "google-gemini-cli": .google
        default: .adaptiveMonochrome
        }
    }

    static func providerID(forModelReference modelReference: String?) -> String? {
        guard let modelReference = trimmedValue(modelReference) else { return nil }
        let parts = modelReference.split(separator: "/", maxSplits: 1).map(String.init)
        guard parts.count == 2 else { return nil }
        return self.normalizedProviderID(parts[0])
    }

    static func qualifiedModelReference(modelID: String?, providerID: String?) -> String? {
        guard let modelID = trimmedValue(modelID) else { return nil }
        if self.providerID(forModelReference: modelID) != nil {
            return modelID
        }
        guard let providerID = normalizedProviderID(providerID) else { return modelID }
        return "\(providerID)/\(modelID)"
    }

    static func resolvedDefaultLabel(sessionDefaultLabel: String, agentModelReference: String?) -> String {
        guard sessionDefaultLabel.trimmingCharacters(in: .whitespacesAndNewlines) == "Default",
              let agentModelReference = trimmedValue(agentModelReference)
        else {
            return sessionDefaultLabel
        }
        return "Default: \(agentModelReference)"
    }

    static func fallbackMonogram(providerID: String?) -> String {
        guard let providerID = normalizedProviderID(providerID), let first = providerID.first else { return "?" }
        return String(first).uppercased()
    }

    private static func normalizedProviderID(_ providerID: String?) -> String? {
        let normalized = providerID?.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        guard let normalized, !normalized.isEmpty else { return nil }
        return normalized
    }

    private static func trimmedValue(_ value: String?) -> String? {
        let trimmed = value?.trimmingCharacters(in: .whitespacesAndNewlines)
        guard let trimmed, !trimmed.isEmpty else { return nil }
        return trimmed
    }
}

enum ChatThinkingSliderPresentation {
    static func index(
        selectionID: String,
        effectiveLevelID: String,
        options: [OpenClawChatThinkingLevelOption]) -> Int
    {
        let resolvedID = selectionID == OpenClawChatViewModel.inheritedThinkingSelectionID
            ? effectiveLevelID
            : selectionID
        return options.firstIndex { $0.id == resolvedID } ?? 0
    }

    static func selectionID(index: Int, options: [OpenClawChatThinkingLevelOption]) -> String? {
        guard options.indices.contains(index) else { return nil }
        return options[index].id
    }

    static func notchIndices(options: [OpenClawChatThinkingLevelOption]) -> [Int] {
        Array(options.indices)
    }

    static func valueLabel(
        selectionID: String,
        effectiveLevelID: String,
        options: [OpenClawChatThinkingLevelOption]) -> String
    {
        if selectionID == OpenClawChatViewModel.inheritedThinkingSelectionID {
            let label = options.first { $0.id == effectiveLevelID }?.label ?? effectiveLevelID
            return "Default (\(label.capitalized))"
        }
        return (options.first { $0.id == selectionID }?.label ?? selectionID).capitalized
    }
}

enum ChatFastModeControlPresentation {
    static func isOn(selectionID: String, effectiveIsEnabled: Bool) -> Bool {
        switch selectionID {
        case "on": true
        case "off": false
        default: effectiveIsEnabled
        }
    }

    static func selectionID(isOn: Bool) -> String {
        isOn ? "on" : "off"
    }
}

enum ChatVerbosityControlPresentation {
    static let levelIDs = ["off", "on", "full"]

    static func label(levelID: String) -> String {
        switch levelID {
        case "on": "Activity"
        case "full": "Full"
        default: "Off"
        }
    }

    static func resolvedSelectionID(selectionID: String, inheritedLevelID: String) -> String {
        if self.levelIDs.contains(selectionID) {
            return selectionID
        }
        return self.levelIDs.contains(inheritedLevelID) ? inheritedLevelID : "off"
    }
}

private struct ChatModelProviderIcon: View {
    let providerID: String?

    var body: some View {
        Group {
            if let assetName = ChatModelMenuPresentation.iconAssetName(providerID: self.providerID) {
                Image(assetName)
                    .resizable()
                    .scaledToFit()
            } else {
                Text(ChatModelMenuPresentation.fallbackMonogram(providerID: self.providerID))
                    .font(OpenClawType.caption)
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
                    .background(.secondary.opacity(0.16), in: Circle())
            }
        }
        .foregroundStyle(self.brandColor)
        .frame(width: 18, height: 18)
        .accessibilityIdentifier("chat-model-provider-icon-\(self.providerID ?? "unknown")")
        .accessibilityLabel(String(
            format: String(localized: "%@ provider"),
            self.providerID ?? String(localized: "Unknown")))
    }

    private var brandColor: Color {
        switch ChatModelMenuPresentation.brandPalette(providerID: self.providerID) {
        case .openAI: OpenClawBrand.providerOpenAI
        case .anthropic: OpenClawBrand.providerAnthropic
        case .google: OpenClawBrand.providerGoogle
        case .adaptiveMonochrome: .primary
        }
    }
}

@MainActor
struct ChatModelControlsMenuItems: View {
    @Bindable var viewModel: OpenClawChatViewModel
    let agentModelReference: String?
    let onSelection: @MainActor () -> Void
    @State private var expandedProviderIDs: Set<String> = []

    init(
        viewModel: OpenClawChatViewModel,
        agentModelReference: String? = nil,
        onSelection: @escaping @MainActor () -> Void = {})
    {
        self.viewModel = viewModel
        self.agentModelReference = agentModelReference
        self.onSelection = onSelection
    }

    var body: some View {
        if self.viewModel.showsModelPicker {
            self.modelPicker
        }
        if self.viewModel.showsThinkingPicker {
            self.thinkingOptions
        }
        if self.viewModel.selectedModelSupportsFastMode {
            self.fastModeOptions
        }
        self.verbosityOptions
    }

    private var modelPicker: some View {
        let sections = self.viewModel.modelPickerSections
        return Group {
            ChatActionMenuSectionHeader(
                title: "Model",
                detail: self.viewModel.modelSelectionTargetDescription)
            self.modelOption(
                title: self.defaultModelLabel,
                providerID: self.defaultProviderID,
                selectionID: OpenClawChatViewModel.defaultModelSelectionID)
            if !sections.pinned.isEmpty {
                ChatActionMenuSectionHeader(title: "Pinned")
                self.modelOptions(sections.pinned)
            }
            if !sections.recent.isEmpty {
                ChatActionMenuSectionHeader(title: "Recent")
                self.modelOptions(sections.recent)
            }
            ForEach(sections.providers) { provider in
                self.providerDrawer(provider)
            }
        }
    }

    @ViewBuilder
    private var thinkingOptions: some View {
        let options = self.viewModel.thinkingLevelOptions
        if options.count > 1 {
            self.thinkingSlider(options: options)
        } else if let option = options.first {
            let selectionID = self.viewModel.thinkingSelectionID
            VStack(spacing: 0) {
                ChatActionMenuSectionHeader(
                    title: "Thinking",
                    resetAccessibilityIdentifier: selectionID == OpenClawChatViewModel.inheritedThinkingSelectionID
                        ? nil
                        : "chat-thinking-use-default",
                    resetAction: selectionID == OpenClawChatViewModel.inheritedThinkingSelectionID
                        ? nil
                        : { self.viewModel.selectThinkingLevel(OpenClawChatViewModel.inheritedThinkingSelectionID) })
                self.settingsOption(
                    title: option.label,
                    systemImage: "brain.head.profile",
                    selectionID: option.id,
                    selectedID: selectionID,
                    select: self.viewModel.selectThinkingLevel)
            }
        }
    }

    private func thinkingSlider(options: [OpenClawChatThinkingLevelOption]) -> some View {
        let selectionID = self.viewModel.thinkingSelectionID
        let committedIndex = ChatThinkingSliderPresentation.index(
            selectionID: selectionID,
            effectiveLevelID: self.viewModel.thinkingLevel,
            options: options)
        let valueLabel = ChatThinkingSliderPresentation.valueLabel(
            selectionID: selectionID,
            effectiveLevelID: self.viewModel.thinkingLevel,
            options: options)
        return VStack(alignment: .leading, spacing: 4) {
            ChatActionMenuSectionHeader(
                title: "Thinking",
                detail: valueLabel,
                resetAccessibilityIdentifier: selectionID == OpenClawChatViewModel.inheritedThinkingSelectionID
                    ? nil
                    : "chat-thinking-use-default",
                resetAction: selectionID == OpenClawChatViewModel.inheritedThinkingSelectionID
                    ? nil
                    : { self.viewModel.selectThinkingLevel(OpenClawChatViewModel.inheritedThinkingSelectionID) })
            ZStack {
                Slider(
                    value: Binding(
                        get: { Double(committedIndex) },
                        set: { value in
                            guard let selectionID = ChatThinkingSliderPresentation.selectionID(
                                index: Int(value.rounded()),
                                options: options),
                                selectionID != self.viewModel.thinkingSelectionID
                            else { return }
                            self.viewModel.selectThinkingLevel(selectionID)
                        }),
                    in: 0...Double(options.count - 1),
                    step: 1)
                    .tint(OpenClawBrand.accentForeground)
                    .disabled(self.viewModel.isUpdatingSessionSettings)
                    .accessibilityIdentifier("chat-thinking-slider")
                    .accessibilityLabel(String(localized: "Thinking level"))
                    .accessibilityValue(valueLabel)
                HStack(spacing: 0) {
                    ForEach(ChatThinkingSliderPresentation.notchIndices(options: options), id: \.self) { index in
                        Circle()
                            .fill(index == committedIndex ? Color.clear : Color.secondary.opacity(0.62))
                            .frame(width: 5, height: 5)
                        if index != options.indices.last {
                            Spacer(minLength: 0)
                        }
                    }
                }
                .padding(.horizontal, 15)
                .allowsHitTesting(false)
                .accessibilityElement(children: .ignore)
                .accessibilityIdentifier("chat-thinking-notches")
                .accessibilityLabel(String(localized: "Thinking stops"))
                .accessibilityValue("\(options.count) stops")
            }
            .frame(height: ChatActionMenuMetric.rowHeight)
            .contentShape(Rectangle())
            .accessibilityElement(children: .contain)
            .accessibilityIdentifier("chat-thinking-slider-hit-target")
            .padding(.horizontal, ChatActionMenuMetric.horizontalPadding)
            HStack {
                Text("Faster")
                    .font(OpenClawType.caption)
                Spacer(minLength: 8)
                Text("Smarter")
                    .font(OpenClawType.caption)
            }
            .foregroundStyle(.secondary)
            .padding(.horizontal, ChatActionMenuMetric.horizontalPadding)
            .padding(.bottom, 8)
        }
    }

    @ViewBuilder
    private var fastModeOptions: some View {
        let selectionID = self.viewModel.fastModeSelectionID
        let isOn = ChatFastModeControlPresentation.isOn(
            selectionID: selectionID,
            effectiveIsEnabled: self.viewModel.fastModeIsEnabled)
        VStack(alignment: .leading, spacing: 8) {
            HStack(spacing: 12) {
                Image(systemName: "bolt.fill")
                    .foregroundStyle(OpenClawBrand.accentForeground)
                    .frame(width: ChatActionMenuMetric.iconWidth, alignment: .leading)
                    .accessibilityHidden(true)
                VStack(alignment: .leading, spacing: 2) {
                    Text("Fast mode")
                        .font(OpenClawType.body)
                    Text("Faster responses, higher usage of limits.")
                        .font(OpenClawType.caption)
                        .foregroundStyle(.secondary)
                }
                Spacer(minLength: 8)
                if selectionID != OpenClawChatViewModel.inheritedThinkingSelectionID {
                    Button {
                        self.viewModel.selectFastMode(OpenClawChatViewModel.inheritedThinkingSelectionID)
                    } label: {
                        Image(systemName: "arrow.uturn.backward")
                            .frame(width: ChatActionMenuMetric.rowHeight, height: ChatActionMenuMetric.rowHeight)
                            .contentShape(Rectangle())
                    }
                    .buttonStyle(.plain)
                    .foregroundStyle(OpenClawBrand.accentForeground)
                    .disabled(self.viewModel.isUpdatingSessionSettings)
                    .accessibilityLabel(String(localized: "Use default"))
                    .accessibilityIdentifier("chat-fast-mode-use-default")
                }
                Toggle(isOn: Binding(
                    get: { isOn },
                    set: { isOn in
                        self.viewModel.selectFastMode(
                            ChatFastModeControlPresentation.selectionID(isOn: isOn))
                    })) {
                        Text("Fast mode")
                            .font(OpenClawType.body)
                    }
                    .labelsHidden()
                        .frame(
                            minWidth: ChatActionMenuMetric.rowHeight,
                            minHeight: ChatActionMenuMetric.rowHeight)
                        .contentShape(Rectangle())
                        .accessibilityElement(children: .combine)
                        // A labels-hidden switch retains its compact native hit region in a popover.
                        // Own the tap on the 44-point wrapper so the exposed control is fully actionable.
                        .highPriorityGesture(TapGesture().onEnded {
                            self.viewModel.selectFastMode(
                                ChatFastModeControlPresentation.selectionID(isOn: !isOn))
                        })
                        .tint(OpenClawBrand.accentForeground)
                        .disabled(self.viewModel.isUpdatingSessionSettings)
                        .accessibilityIdentifier("chat-fast-mode-toggle")
            }
            .frame(minHeight: ChatActionMenuMetric.rowHeight)
            .contentShape(Rectangle())
            .accessibilityElement(children: .contain)
            .accessibilityIdentifier("chat-fast-mode-hit-target")
        }
        .padding(.horizontal, ChatActionMenuMetric.horizontalPadding)
        .padding(.vertical, 6)
    }

    @ViewBuilder
    private var verbosityOptions: some View {
        let selectionID = self.viewModel.verboseLevel
        let resolvedSelectionID = ChatVerbosityControlPresentation.resolvedSelectionID(
            selectionID: selectionID,
            inheritedLevelID: self.viewModel.preferredVerboseLevel)
        VStack(alignment: .leading, spacing: 8) {
            HStack(spacing: 12) {
                Image(systemName: "text.alignleft")
                    .foregroundStyle(OpenClawBrand.accentForeground)
                    .frame(width: ChatActionMenuMetric.iconWidth, alignment: .leading)
                    .accessibilityHidden(true)
                VStack(alignment: .leading, spacing: 2) {
                    Text("Tool details")
                        .font(OpenClawType.body)
                    Text("Choose how much tool activity to show.")
                        .font(OpenClawType.caption)
                        .foregroundStyle(.secondary)
                }
                Spacer(minLength: 8)
                if selectionID != OpenClawChatViewModel.inheritedThinkingSelectionID {
                    Button {
                        self.viewModel.selectVerboseLevel(OpenClawChatViewModel.inheritedThinkingSelectionID)
                    } label: {
                        Image(systemName: "arrow.uturn.backward")
                            .frame(width: ChatActionMenuMetric.rowHeight, height: ChatActionMenuMetric.rowHeight)
                            .contentShape(Rectangle())
                    }
                    .buttonStyle(.plain)
                    .foregroundStyle(OpenClawBrand.accentForeground)
                    .disabled(self.viewModel.isUpdatingSessionSettings)
                    .accessibilityLabel(String(localized: "Use default"))
                    .accessibilityIdentifier("chat-verbosity-use-default")
                }
            }
            VStack(spacing: 0) {
                Picker("Tool details", selection: Binding(
                    get: { resolvedSelectionID },
                    set: { self.viewModel.selectVerboseLevel($0) }))
                {
                    ForEach(ChatVerbosityControlPresentation.levelIDs, id: \.self) { level in
                        Text(ChatVerbosityControlPresentation.label(levelID: level))
                            .font(OpenClawType.caption)
                            .tag(level)
                    }
                }
                .pickerStyle(.segmented)
                .labelsHidden()
                .disabled(self.viewModel.isUpdatingSessionSettings)
                .accessibilityIdentifier("chat-verbosity-control")
            }
            .frame(minHeight: ChatActionMenuMetric.rowHeight)
            .contentShape(Rectangle())
            .accessibilityElement(children: .contain)
            .accessibilityIdentifier("chat-verbosity-hit-target")
        }
        .padding(.horizontal, ChatActionMenuMetric.horizontalPadding)
        .padding(.bottom, 10)
    }

    private func modelOptions(_ models: [OpenClawChatModelChoice]) -> some View {
        ForEach(models) { model in
            self.modelOption(
                title: model.displayLabel,
                providerID: ChatModelMenuPresentation.providerID(for: model),
                selectionID: model.selectionID,
                showsDefaultBadge: self.viewModel.isDefaultModel(model),
                unavailableDescription: self.viewModel.modelUnavailableDescription(model))
        }
    }

    private var defaultProviderID: String? {
        self.viewModel.modelChoices
            .first(where: self.viewModel.isDefaultModel)
            .flatMap(ChatModelMenuPresentation.providerID)
            ?? ChatModelMenuPresentation.providerID(forModelReference: self.agentModelReference)
    }

    private var defaultModelLabel: String {
        ChatModelMenuPresentation.resolvedDefaultLabel(
            sessionDefaultLabel: self.viewModel.defaultModelLabel,
            agentModelReference: self.agentModelReference)
    }

    private func providerDrawer(_ provider: ChatModelProviderSection) -> some View {
        let isExpanded = self.expandedProviderIDs.contains(provider.id)
        let isDefaultProvider = provider.isDefaultProvider || provider.id == self.defaultProviderID
        return Group {
            Button {
                if isExpanded {
                    self.expandedProviderIDs.remove(provider.id)
                } else {
                    self.expandedProviderIDs.insert(provider.id)
                }
            } label: {
                HStack(spacing: 12) {
                    ChatModelProviderIcon(providerID: provider.id)
                        .frame(width: ChatActionMenuMetric.iconWidth, alignment: .leading)
                    Text(provider.displayName)
                        .font(OpenClawType.body)
                    Text(verbatim: provider.models.count.formatted())
                        .font(OpenClawType.caption)
                        .foregroundStyle(.secondary)
                    if isDefaultProvider {
                        Text("Default")
                            .font(OpenClawType.caption)
                            .foregroundStyle(.secondary)
                    }
                    Spacer(minLength: 12)
                    Image(systemName: isExpanded ? "chevron.down" : "chevron.right")
                        .font(OpenClawType.caption)
                        .foregroundStyle(OpenClawBrand.accentForeground)
                        .accessibilityHidden(true)
                }
                .frame(maxWidth: .infinity, minHeight: ChatActionMenuMetric.rowHeight, alignment: .leading)
                .padding(.horizontal, ChatActionMenuMetric.horizontalPadding)
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .accessibilityIdentifier("chat-model-provider-drawer-\(provider.id)")
            .accessibilityLabel(String(
                format: String(localized: "%@ models"),
                provider.displayName))
            .accessibilityValue(isExpanded ? String(localized: "Expanded") : String(localized: "Collapsed"))
            .accessibilityAddTraits(.isButton)

            if isExpanded {
                self.modelOptions(provider.models)
            }
        }
    }

    private func modelOption(
        title: String,
        providerID: String?,
        selectionID: String,
        showsDefaultBadge: Bool = false,
        unavailableDescription: String? = nil) -> some View
    {
        let isSelected = self.viewModel.isSelectedModel(selectionID)
        return Button {
            self.viewModel.selectModel(selectionID)
            self.onSelection()
        } label: {
            HStack(spacing: 12) {
                ChatModelProviderIcon(providerID: providerID)
                    .frame(width: ChatActionMenuMetric.iconWidth, alignment: .leading)
                VStack(alignment: .leading, spacing: 2) {
                    Text(title)
                        .font(OpenClawType.body)
                        .multilineTextAlignment(.leading)
                    if let unavailableDescription {
                        Text(unavailableDescription)
                            .font(OpenClawType.caption)
                            .foregroundStyle(.secondary)
                    }
                }
                if showsDefaultBadge {
                    Text("Default")
                        .font(OpenClawType.caption)
                        .foregroundStyle(.secondary)
                }
                Spacer(minLength: 12)
                if isSelected {
                    Image(systemName: "checkmark")
                        .font(OpenClawType.body)
                        .foregroundStyle(OpenClawBrand.accentForeground)
                        .accessibilityIdentifier("chat-menu-selection-checkmark")
                }
            }
            .frame(maxWidth: .infinity, minHeight: ChatActionMenuMetric.rowHeight, alignment: .leading)
            .padding(.horizontal, ChatActionMenuMetric.horizontalPadding)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .disabled(self.viewModel.isUpdatingSessionSettings || unavailableDescription != nil)
        .accessibilityLabel(title)
        .accessibilityValue(isSelected ? String(localized: "Selected") : "")
        .accessibilityHint(unavailableDescription ?? "")
        .accessibilityAddTraits(isSelected ? .isSelected : [])
    }

    private func settingsOption(
        title: String,
        systemImage: String,
        selectionID: String,
        selectedID: String,
        select: @escaping (String) -> Void) -> some View
    {
        let isSelected = selectedID == selectionID
        return Button {
            select(selectionID)
            self.onSelection()
        } label: {
            ChatActionSystemRow(title: title, systemImage: systemImage, isSelected: isSelected)
        }
        .buttonStyle(.plain)
        .disabled(self.viewModel.isUpdatingSessionSettings)
        .accessibilityLabel(title)
        .accessibilityValue(isSelected ? String(localized: "Selected") : "")
        .accessibilityAddTraits(isSelected ? .isSelected : [])
    }
}
