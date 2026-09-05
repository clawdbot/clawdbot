import SwiftUI

extension OpenClawChatComposer {
    var thinkingPicker: some View {
        Picker(selection: Binding(
            get: { self.viewModel.thinkingSelectionID },
            set: { next in self.viewModel.selectThinkingLevel(next) }))
        {
            Text(String(localized: "Default (inherited)"))
                .font(OpenClawChatTypography.captionSemiBold)
                .tag(OpenClawChatViewModel.inheritedThinkingSelectionID)
            ForEach(self.viewModel.thinkingLevelOptions) { option in
                Text(String(
                    format: String(localized: "%@ (override)"),
                    option.label))
                    .font(OpenClawChatTypography.captionSemiBold)
                    .tag(option.id)
            }
        } label: {
            Text("Thinking")
                .font(OpenClawChatTypography.captionSemiBold)
        }
        .pickerStyle(.menu)
        .controlSize(.small)
        .frame(maxWidth: 140, alignment: .leading)
        .disabled(self.viewModel.isUpdatingSessionSettings)
    }

    var verbosityPicker: some View {
        Picker(selection: Binding(
            get: { self.viewModel.verboseLevel },
            set: { self.viewModel.selectVerboseLevel($0) }))
        {
            Text(String(localized: "Default (inherited)"))
                .font(OpenClawChatTypography.captionSemiBold)
                .tag(OpenClawChatViewModel.inheritedThinkingSelectionID)
            Text(String(localized: "Off"))
                .font(OpenClawChatTypography.captionSemiBold)
                .tag("off")
            Text(String(localized: "On"))
                .font(OpenClawChatTypography.captionSemiBold)
                .tag("on")
            Text(String(localized: "Full"))
                .font(OpenClawChatTypography.captionSemiBold)
                .tag("full")
        } label: {
            Text(String(localized: "Verbosity"))
                .font(OpenClawChatTypography.captionSemiBold)
        }
        .pickerStyle(.menu)
        .controlSize(.small)
        .help(String(localized: "Verbosity"))
        .disabled(self.viewModel.isUpdatingSessionSettings)
    }

    var fastModeToggle: some View {
        Picker(selection: Binding(
            get: { self.viewModel.fastModeSelectionID },
            set: { self.viewModel.selectFastMode($0) }))
        {
            Text(String(localized: "Default (inherited)"))
                .font(OpenClawChatTypography.captionSemiBold)
                .tag(OpenClawChatViewModel.inheritedThinkingSelectionID)
            Text(String(localized: "On"))
                .font(OpenClawChatTypography.captionSemiBold)
                .tag("on")
            Text(String(localized: "Off"))
                .font(OpenClawChatTypography.captionSemiBold)
                .tag("off")
        } label: {
            Label(String(localized: "Fast"), systemImage: "bolt.fill")
                .font(OpenClawChatTypography.captionSemiBold)
        }
        .pickerStyle(.menu)
        .controlSize(.small)
        .help(String(localized: "Fast responses"))
        .disabled(self.viewModel.isUpdatingSessionSettings)
    }

    var modelPicker: some View {
        // Sections come from an O(n) recompute over the catalog; bind once per body eval.
        let sections = self.viewModel.modelPickerSections
        return Picker(selection: Binding(
            get: { self.viewModel.modelSelectionID },
            set: { next in self.viewModel.selectModel(next) }))
        {
            Text(self.viewModel.defaultModelLabel)
                .font(OpenClawChatTypography.captionSemiBold)
                .tag(OpenClawChatViewModel.defaultModelSelectionID)
            if !sections.pinned.isEmpty {
                Section {
                    self.modelOptions(sections.pinned)
                } header: {
                    Text("Pinned")
                        .font(OpenClawChatTypography.captionSemiBold)
                }
            }
            if !sections.recent.isEmpty {
                Section {
                    self.modelOptions(sections.recent)
                } header: {
                    Text("Recent")
                        .font(OpenClawChatTypography.captionSemiBold)
                }
            }
            ForEach(sections.providers) { provider in
                Section {
                    self.modelOptions(provider.models)
                } header: {
                    HStack(spacing: 4) {
                        Text(provider.displayName)
                        if provider.isDefaultProvider {
                            Text(String(localized: "Default"))
                                .font(OpenClawChatTypography.caption)
                                .foregroundStyle(.secondary)
                        }
                    }
                }
            }
        } label: {
            Text("Model")
                .font(OpenClawChatTypography.captionSemiBold)
        }
        .pickerStyle(.menu)
        .controlSize(.small)
        .frame(maxWidth: 240, alignment: .leading)
        .help("Model")
        .disabled(self.viewModel.isUpdatingSessionSettings)
    }

    private func modelOptions(_ models: [OpenClawChatModelChoice]) -> some View {
        ForEach(models) { model in
            HStack(spacing: 4) {
                Text(model.displayLabel)
                    .font(OpenClawChatTypography.captionSemiBold)
                if self.viewModel.isDefaultModel(model) {
                    Text(String(localized: "Default"))
                        .font(OpenClawChatTypography.caption)
                        .foregroundStyle(.secondary)
                }
            }
            .tag(model.selectionID)
        }
    }

    var modelPinButton: some View {
        Button {
            self.viewModel.toggleSelectedModelPinned()
        } label: {
            Image(systemName: self.viewModel.isSelectedModelPinned ? "star.fill" : "star")
                .font(.system(size: 12, weight: .semibold))
        }
        .buttonStyle(.plain)
        .accessibilityLabel(self.viewModel.isSelectedModelPinned ? "Unpin model" : "Pin model")
    }

    var sessionPicker: some View {
        Picker(selection: Binding(
            get: { self.viewModel.sessionKey },
            set: { next in self.viewModel.switchSession(to: next) }))
        {
            ForEach(self.viewModel.sessionChoices, id: \.key) { session in
                Text(session.displayName ?? session.key)
                    .font(OpenClawChatTypography.mono(size: 12, relativeTo: .caption))
                    .tag(session.key)
            }
        } label: {
            Text("Thread")
                .font(OpenClawChatTypography.captionSemiBold)
        }
        .labelsHidden()
        .pickerStyle(.menu)
        .controlSize(.small)
        .frame(maxWidth: 160, alignment: .leading)
        .help("Thread")
    }

    var branchMenu: some View {
        Menu {
            ForEach(self.viewModel.sessionBranches) { branch in
                Button {
                    guard !branch.active else { return }
                    Task { await self.viewModel.switchToBranch(branch.leafEntryId) }
                } label: {
                    HStack(spacing: 6) {
                        VStack(alignment: .leading, spacing: 2) {
                            Text(self.branchTitle(branch))
                                .font(OpenClawChatTypography.captionSemiBold)
                            Text(self.branchMetadata(branch))
                                .font(OpenClawChatTypography.caption)
                                .foregroundStyle(.secondary)
                        }
                        if branch.active {
                            Image(systemName: "checkmark")
                        }
                    }
                }
                .disabled(branch.active)
            }
            .task {
                await self.viewModel.refreshSessionBranchesForMenuPresentation()
            }
        } label: {
            Image(systemName: "arrow.triangle.branch")
        }
        .buttonStyle(.bordered)
        .controlSize(.small)
        .help("Branches")
        .accessibilityLabel("Branches")
        .disabled(!self.viewModel.canSwitchSessionBranch)
    }

    private func branchTitle(_ branch: OpenClawChatSessionBranch) -> String {
        let headline = branch.headline.trimmingCharacters(in: .whitespacesAndNewlines)
        return headline.isEmpty ? String(localized: "Untitled branch") : headline
    }

    private func branchMetadata(_ branch: OpenClawChatSessionBranch) -> String {
        var parts = [Self.branchMessageCount(branch.messageCount)]
        if let updatedAt = branch.updatedAt,
           let date = try? Date(updatedAt, strategy: .iso8601)
        {
            parts.append(date.formatted(.relative(presentation: .named, unitsStyle: .abbreviated)))
        }
        return parts.joined(separator: " · ")
    }

    static func branchMessageCount(_ count: Int) -> String {
        String(AttributedString(localized: "^[\(count) message](inflect: true)").characters)
    }
}
