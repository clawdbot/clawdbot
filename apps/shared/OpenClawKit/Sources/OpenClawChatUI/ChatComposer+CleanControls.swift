import SwiftUI

extension OpenClawChatComposer {
    @ViewBuilder
    var cleanAttachmentMenu: some View {
        #if os(macOS)
        Button {
            self.pickFilesMac()
        } label: {
            CompactChatAttachmentLabel()
        }
        .buttonStyle(.plain)
        .controlSize(.small)
        .help("Add Attachment")
        .accessibilityLabel("Attachments")
        .accessibilityIdentifier("chat-attachment-picker")
        .disabled(!self.isAttachmentInputEnabled)
        #else
        OpenClawChatAttachmentMenu(
            showsPhotoPicker: self.photoPickerPresentation,
            showsFileImporter: self.fileImporterPresentation,
            showsCameraPicker: self.cameraPickerPresentation,
            isAttachmentInputEnabled: self.isAttachmentInputEnabled)
        {
            if self.viewModel.sessionBranches.count > 1 {
                self.branchMenu
            }
            self.verbosityPicker
                .disabled(!self.viewModel.composerEffortMutationAvailable)
            self.cleanComposerCapabilityItems
        }
        .task(id: self.viewModel.composerCapabilityOwnerID) {
            await self.viewModel.loadComposerCapabilities()
        }
        #endif
    }

    var sendButtonAccessibilityLabel: String {
        "Send message"
    }

    #if os(iOS)
    var cleanDraftRow: some View {
        self.editorOverlay
            .frame(maxWidth: .infinity, minHeight: self.textMinHeight, alignment: .topLeading)
            .padding(.horizontal, CleanChatComposerMetrics.editorInlineInset)
            .padding(.top, CleanChatComposerMetrics.editorBlockInset)
    }
    #endif

    @ViewBuilder
    var cleanLeadingControls: some View {
        #if os(macOS)
        Menu {
            Button {
                self.pickFilesMac()
            } label: {
                Label("Add Attachment", systemImage: "paperclip")
            }
            .disabled(!self.isAttachmentInputEnabled)
            Divider()
            if self.viewModel.sessionBranches.count > 1 {
                self.branchMenu
            }
            self.verbosityPicker
                .disabled(!self.viewModel.composerEffortMutationAvailable)
        } label: {
            CompactChatAttachmentLabel()
        }
        .menuIndicator(.hidden)
        .fixedSize()
        .help("Composer options")
        .accessibilityLabel("Composer options")
        .accessibilityIdentifier("chat-attachment-picker")
        #else
        self.cleanAttachmentMenu
        #if os(iOS)
        if self.viewModel.supportsComposerCapabilities {
            self.cleanInlinePermissionMenu
        }
        #endif
        #endif
    }

    @ViewBuilder
    var cleanContextUsageMenu: some View {
        if let usage = self.viewModel.contextUsage {
            let tokensLine = self.cleanContextUsageTokensLine(usage)
            Menu {
                Text(tokensLine)
                    .font(OpenClawChatTypography.body)
                if let cost = usage.totalCost {
                    Text(verbatim: String(
                        format: String(localized: "Thread cost %@"),
                        ChatContextUsageFormatter.cost(cost)))
                        .font(OpenClawChatTypography.body)
                }
                Divider()
                Button {
                    self.viewModel.requestSessionCompact()
                } label: {
                    Text("Compact Thread")
                        .font(OpenClawChatTypography.body)
                }
                .disabled(!self.viewModel.canRequestSessionCompact)
            } label: {
                CleanChatContextUsageLabel(usage: usage)
            }
            #if os(macOS)
            .fixedSize()
            #endif
            .menuIndicator(.hidden)
            .help(tokensLine)
            .accessibilityIdentifier("chat-context-usage")
        }
    }

    private func cleanContextUsageTokensLine(_ usage: OpenClawChatContextUsage) -> String {
        let used = ChatContextUsageFormatter.tokens(usage.usedTokens)
        guard let window = usage.contextWindowTokens else {
            return String(
                format: String(localized: "%@ tokens used"),
                used)
        }
        return String(
            format: String(localized: "%@ of %@ tokens used"),
            used,
            ChatContextUsageFormatter.tokens(window))
    }

    var cleanTrailingControls: some View {
        ViewThatFits(in: .horizontal) {
            self.cleanInlineControls(compactModel: false)
            self.cleanInlineControls(compactModel: true)
        }
    }

    private func cleanInlineControls(compactModel: Bool) -> some View {
        HStack(spacing: CleanChatComposerMetrics.footerControlGap) {
            self.cleanContextUsageMenu
            // Camera switching only displaces settings in the compact iOS footer.
            #if os(macOS)
            if self.viewModel.showsModelPicker {
                self.cleanInlineModelPicker(compact: compactModel)
            }
            self.cleanInlineEffortMenu
            #else
            if !self.cleanShowsCameraFlip {
                self.cleanInlineModelPicker(compact: compactModel)
                self.cleanInlineEffortMenu
            }
            #endif
            self.cleanCaptureAndPrimaryControls
        }
    }

    private func cleanInlineModelPicker(compact: Bool) -> some View {
        let sections = self.viewModel.modelPickerSections
        return Menu {
            if let target = self.viewModel.modelSelectionTargetDescription {
                Text(target)
                    .font(OpenClawChatTypography.caption)
                    .accessibilityIdentifier("chat-composer-model-selection-target")
                Divider()
            }
            Picker(
                "Model",
                selection: Binding(
                    get: { self.viewModel.canonicalModelSelectionID },
                    set: { self.viewModel.selectModel($0) }))
            {
                Text(self.viewModel.defaultModelLabel)
                    .font(OpenClawChatTypography.captionSemiBold)
                    .tag(OpenClawChatViewModel.defaultModelSelectionID)
                if !sections.pinned.isEmpty {
                    Section("Pinned") {
                        self.cleanInlineModelOptions(sections.pinned)
                    }
                }
                if !sections.recent.isEmpty {
                    Section("Recent") {
                        self.cleanInlineModelOptions(sections.recent)
                    }
                }
                ForEach(sections.providers) { provider in
                    Section(provider.displayName) {
                        self.cleanInlineModelOptions(provider.models)
                    }
                }
            }
            .labelsHidden()
            #if os(macOS)
            .pickerStyle(.inline)
            #endif
            .disabled(
                !self.viewModel.composerModelMutationAvailable ||
                    self.viewModel.isUpdatingSessionSettings)
            #if os(macOS)
            if self.viewModel.modelSelectionID != OpenClawChatViewModel.defaultModelSelectionID {
                Divider()
                Button {
                    self.viewModel.toggleSelectedModelPinned()
                } label: {
                    Label(
                        self.viewModel.isSelectedModelPinned ? "Unpin model" : "Pin model",
                        systemImage: self.viewModel.isSelectedModelPinned ? "star.slash" : "star")
                }
            }
            #endif
        } label: {
            self.cleanInlineModelLabel(compact: compact)
        }
        .menuIndicator(.hidden)
        .tint(OpenClawChatTheme.muted)
        #if os(macOS)
        // Mac session settings remain editable during a response; pinning is
        // local and stays available while a Gateway settings save is pending.
        .fixedSize()
        #else
        .disabled(
            !self.viewModel.showsModelPicker ||
                !self.viewModel.composerModelMutationAvailable ||
                self.viewModel.isUpdatingSessionSettings ||
                self.viewModel.hasActiveRunForComposerSettings)
        #endif
        .help(self.cleanInlineModelDisabledHint ?? self.viewModel.composerInlineModelLabel)
        .accessibilityLabel("Model")
        .accessibilityValue(self.viewModel.composerInlineModelLabel)
        .accessibilityHint(self.cleanInlineModelDisabledHint ?? "")
        .accessibilityIdentifier("chat-composer-inline-model")
        .layoutPriority(1)
    }

    @ViewBuilder
    private func cleanInlineModelLabel(compact: Bool) -> some View {
        #if os(macOS)
        HStack(spacing: 6) {
            Text(self.viewModel.composerInlineModelLabel)
                .lineLimit(1)
                .truncationMode(.middle)
            Image(systemName: "chevron.down")
                .font(.system(size: 9, weight: .semibold))
                .accessibilityHidden(true)
        }
        .font(OpenClawChatTypography.captionSemiBold)
        .foregroundStyle(.secondary)
        .padding(.horizontal, 8)
        .frame(width: compact ? 104 : 180, height: CleanChatComposerMetrics.controlTouchSize)
        .contentShape(Rectangle())
        #else
        if compact {
            Image(systemName: "cpu")
                .font(OpenClawChatTypography.display(size: 16, weight: .semibold, relativeTo: .body))
                .foregroundStyle(.secondary)
                .frame(
                    width: CleanChatComposerMetrics.compactModelWidth,
                    height: CleanChatComposerMetrics.controlTouchSize)
                .contentShape(Rectangle())
        } else {
            Text(self.viewModel.composerInlineModelLabel)
                .font(OpenClawChatTypography.captionSemiBold)
                .foregroundStyle(.secondary)
                .lineLimit(1)
                .truncationMode(.middle)
                .frame(
                    width: CleanChatComposerMetrics.regularModelWidth,
                    height: CleanChatComposerMetrics.controlTouchSize)
                .contentShape(Rectangle())
        }
        #endif
    }

    private func cleanInlineModelOptions(_ models: [OpenClawChatModelChoice]) -> some View {
        ForEach(models) { model in
            let unavailable = self.viewModel.modelUnavailableDescription(model)
            Text(verbatim: [model.displayLabel, unavailable].compactMap(\.self).joined(separator: " — "))
                .font(OpenClawChatTypography.captionSemiBold)
                .tag(model.selectionID)
                .disabled(unavailable != nil)
                .accessibilityHint(unavailable ?? "")
        }
    }

    private var cleanInlineEffortMenu: some View {
        Menu {
            if self.viewModel.showsThinkingPicker {
                self.thinkingPicker
            }
            if self.viewModel.selectedModelSupportsFastMode {
                self.fastModeToggle
            }
        } label: {
            ZStack(alignment: .topTrailing) {
                ZStack {
                    Circle()
                        .trim(from: 0.12, to: 0.88)
                        .stroke(.secondary, style: StrokeStyle(lineWidth: 1.5, lineCap: .round))
                        .rotationEffect(.degrees(90))
                    Capsule()
                        .fill(.secondary)
                        .frame(width: 1.5, height: 7)
                        .offset(y: -3.5)
                        .rotationEffect(.degrees(self.viewModel.composerInlineEffortAngle))
                }
                .frame(width: 18, height: 18)
                if self.viewModel.fastModeSelectionID == "on" {
                    Image(systemName: "bolt.fill")
                        .font(OpenClawChatTypography.caption)
                        .foregroundStyle(OpenClawChatTheme.accent)
                        .offset(x: 7, y: -6)
                }
            }
            .frame(
                width: CleanChatComposerMetrics.controlTouchSize,
                height: CleanChatComposerMetrics.controlTouchSize)
            .contentShape(Rectangle())
        }
        .menuIndicator(.hidden)
        .tint(OpenClawChatTheme.muted)
        .disabled(
            !self.viewModel.composerEffortMutationAvailable ||
                self.viewModel.isUpdatingSessionSettings)
        #if os(macOS)
        .fixedSize()
        #else
        .disabled(self.viewModel.hasActiveRunForComposerSettings)
        #endif
        .help(self.cleanInlineEffortDisabledHint ?? self.viewModel.composerInlineEffortLabel)
        .accessibilityLabel("Effort")
        .accessibilityValue(self.viewModel.composerInlineEffortLabel)
        .accessibilityHint(self.cleanInlineEffortDisabledHint ?? "")
        .accessibilityIdentifier("chat-composer-inline-effort")
    }

    private var cleanInlineModelDisabledHint: String? {
        #if os(iOS)
        if self.viewModel.hasActiveRunForComposerSettings {
            return String(localized: "Available after the current response finishes.")
        }
        #endif
        if !self.viewModel.composerModelMutationAvailable {
            return String(localized: "Changing the model requires operator.write or operator.admin access.")
        }
        if self.viewModel.isUpdatingSessionSettings {
            return String(localized: "Saving session settings.")
        }
        return nil
    }

    private var cleanInlineEffortDisabledHint: String? {
        #if os(iOS)
        if self.viewModel.hasActiveRunForComposerSettings {
            return String(localized: "Available after the current response finishes.")
        }
        #endif
        if !self.viewModel.composerEffortMutationAvailable {
            return String(localized: "Thinking and Fast controls require operator.admin access.")
        }
        if self.viewModel.isUpdatingSessionSettings {
            return String(localized: "Saving session settings.")
        }
        return nil
    }

    @ViewBuilder
    var cleanCaptureAndPrimaryControls: some View {
        if self.dictationControl != nil || self.voiceNoteControl != nil {
            OpenClawChatMicButton(
                dictationControl: self.dictationControl,
                voiceNoteControl: self.voiceNoteControl,
                isDictationPending: self.dictationTask != nil,
                isRealtimeTalkActive: self.talkControl?.isEnabled == true,
                isComposerEnabled: self.isComposerEnabled,
                isAttachmentInputEnabled: self.isAttachmentInputEnabled,
                onCancelDictation: {
                    ChatDictationActions.cancel(task: self.$dictationTask, control: self.dictationControl)
                },
                onStartDictation: {
                    if let dictationControl = self.dictationControl {
                        ChatDictationActions.start(
                            dictationControl,
                            task: self.$dictationTask,
                            viewModel: self.viewModel)
                    }
                })
        }

        if let talkControl, self.cleanShowsCameraFlip {
            ChatCameraFlipButton(
                control: talkControl,
                controlHeight: self.cleanControlHeight,
                visualSize: self.cleanIconControlSize)
        }

        self.cleanTrailingControl
    }

    private var cleanShowsCameraFlip: Bool {
        guard let talkControl = self.talkControl else { return false }
        return ChatCameraFlipButton.isAvailable(for: talkControl)
    }
}
