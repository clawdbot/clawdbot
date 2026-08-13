import Observation
import OpenClawChatUI
import SwiftUI

@MainActor
struct ChatModelControlsMenuItems: View {
    @Bindable var viewModel: OpenClawChatViewModel

    var body: some View {
        if self.viewModel.showsModelPicker {
            self.modelPicker
        }
        if self.viewModel.showsThinkingPicker {
            self.thinkingPicker
        }
        if self.viewModel.selectedModelSupportsFastMode {
            self.fastModePicker
        }
        self.verbosityPicker
    }

    private var modelPicker: some View {
        let sections = self.viewModel.modelPickerSections
        return Picker(selection: Binding(
            get: { self.viewModel.modelSelectionID },
            set: { self.viewModel.selectModel($0) }))
        {
            Text(self.viewModel.defaultModelLabel)
                .font(OpenClawType.body)
                .tag(OpenClawChatViewModel.defaultModelSelectionID)
            if !sections.pinned.isEmpty {
                Section("Pinned") {
                    self.modelOptions(sections.pinned)
                }
            }
            if !sections.recent.isEmpty {
                Section("Recent") {
                    self.modelOptions(sections.recent)
                }
            }
            ForEach(sections.providers) { provider in
                Section {
                    self.modelOptions(provider.models)
                } header: {
                    HStack(spacing: 4) {
                        Text(provider.displayName)
                            .font(OpenClawType.body)
                        if provider.isDefaultProvider {
                            Text("Default")
                                .font(OpenClawType.caption)
                                .foregroundStyle(.secondary)
                        }
                    }
                }
            }
        } label: {
            Text("Model")
                .font(OpenClawType.body)
        }
        .disabled(self.viewModel.isUpdatingSessionSettings)
    }

    private var thinkingPicker: some View {
        Picker(selection: Binding(
            get: { self.viewModel.thinkingSelectionID },
            set: { self.viewModel.selectThinkingLevel($0) }))
        {
            Text("Default (inherited)")
                .font(OpenClawType.body)
                .tag(OpenClawChatViewModel.inheritedThinkingSelectionID)
            ForEach(self.viewModel.thinkingLevelOptions) { option in
                Text(verbatim: option.label)
                    .font(OpenClawType.body)
                    .tag(option.id)
            }
        } label: {
            Text("Thinking")
                .font(OpenClawType.body)
        }
        .disabled(self.viewModel.isUpdatingSessionSettings)
    }

    private var fastModePicker: some View {
        Picker(selection: Binding(
            get: { self.viewModel.fastModeSelectionID },
            set: { self.viewModel.selectFastMode($0) }))
        {
            Text("Default (inherited)")
                .font(OpenClawType.body)
                .tag(OpenClawChatViewModel.inheritedThinkingSelectionID)
            Text("On")
                .font(OpenClawType.body)
                .tag("on")
            Text("Off")
                .font(OpenClawType.body)
                .tag("off")
        } label: {
            Label {
                Text("Fast")
                    .font(OpenClawType.body)
            } icon: {
                Image(systemName: "bolt.fill")
            }
        }
        .disabled(self.viewModel.isUpdatingSessionSettings)
    }

    private var verbosityPicker: some View {
        Picker(selection: Binding(
            get: { self.viewModel.verboseLevel },
            set: { self.viewModel.selectVerboseLevel($0) }))
        {
            Text("Default (inherited)")
                .font(OpenClawType.body)
                .tag(OpenClawChatViewModel.inheritedThinkingSelectionID)
            Text("Off")
                .font(OpenClawType.body)
                .tag("off")
            Text("On")
                .font(OpenClawType.body)
                .tag("on")
            Text("Full")
                .font(OpenClawType.body)
                .tag("full")
        } label: {
            Text("Verbosity")
                .font(OpenClawType.body)
        }
        .disabled(self.viewModel.isUpdatingSessionSettings)
    }

    private func modelOptions(_ models: [OpenClawChatModelChoice]) -> some View {
        ForEach(models) { model in
            HStack(spacing: 4) {
                Text(model.displayLabel)
                    .font(OpenClawType.body)
                if self.viewModel.isDefaultModel(model) {
                    Text("Default")
                        .font(OpenClawType.caption)
                        .foregroundStyle(.secondary)
                }
            }
            .tag(model.selectionID)
        }
    }
}
