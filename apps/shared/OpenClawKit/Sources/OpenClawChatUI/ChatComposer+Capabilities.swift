import SwiftUI

extension OpenClawChatComposer {
    @ViewBuilder
    var cleanComposerCapabilityItems: some View {
        if self.viewModel.supportsComposerCapabilities,
           self.viewModel.composerCapabilityControlsAvailable
        {
            Divider()
            Text("Tool changes apply to the next run.")
                .font(OpenClawChatTypography.caption)
            self.composerWebSearchButton
            self.composerSkillsMenu
            self.composerConnectorsMenu
            if self.viewModel.composerToolOverrides.overrideCount > 0 {
                Divider()
                Button {
                    self.viewModel.clearComposerToolOverrides()
                } label: {
                    Label {
                        Text("Clear tool overrides")
                            .font(OpenClawChatTypography.body)
                    } icon: {
                        Image(systemName: "xmark.circle")
                    }
                }
                .disabled(self.viewModel.composerClearToolOverridesDisabled)
                .accessibilityHint(
                    self.viewModel.composerToolOverrideMutationHint ?? "")
            }
            if !self.viewModel.composerCapabilitiesLoading,
               let reason = self.viewModel.composerPermissionMutationDisabledReason,
               !self.viewModel.composerCapabilityCatalog.permissionMutationAvailable
            {
                Text(reason)
                    .font(OpenClawChatTypography.caption)
            }
            if !self.viewModel.composerCapabilitiesLoading,
               let reason = self.viewModel.composerToolOverrideMutationDisabledReason,
               !self.viewModel.composerCapabilityCatalog.toolOverrideMutationAvailable
            {
                Text(reason)
                    .font(OpenClawChatTypography.caption)
            }
            if !self.viewModel.composerCapabilitiesLoading,
               !self.viewModel.composerCapabilityCatalog.webSearchAvailable,
               self.viewModel.composerCapabilityErrorMessage == nil
            {
                Text("Web Search is unavailable on this Gateway.")
                    .font(OpenClawChatTypography.caption)
            }
            if let errorMessage = self.viewModel.composerCapabilityErrorMessage {
                Text(errorMessage)
                    .font(OpenClawChatTypography.caption)
                Button {
                    Task { await self.viewModel.loadComposerCapabilities(force: true) }
                } label: {
                    Label {
                        Text("Retry capability loading")
                            .font(OpenClawChatTypography.body)
                    } icon: {
                        Image(systemName: "arrow.clockwise")
                    }
                }
            }
        }
    }

    @ViewBuilder
    var cleanInlinePermissionMenu: some View {
        if self.viewModel.composerCapabilityControlsAvailable {
            Menu {
                self.permissionButton(nil, title: String(localized: "Default (inherited)"))
                ForEach(OpenClawChatPermissionMode.allCases, id: \.rawValue) { mode in
                    self.permissionButton(mode, title: mode.displayName)
                        .disabled(mode == .full && !self.viewModel.composerCapabilityCatalog.canSelectFullPermission)
                }
                if !self.viewModel.composerCapabilityCatalog.canSelectFullPermission {
                    Text("Full permission requires operator.admin access.")
                        .font(OpenClawChatTypography.caption)
                }
            } label: {
                self.cleanInlinePermissionGlyph
                    .frame(
                        width: CleanChatComposerMetrics.controlTouchSize,
                        height: CleanChatComposerMetrics.controlTouchSize)
                    .contentShape(Rectangle())
            }
            .menuIndicator(.hidden)
            .tint(OpenClawChatTheme.muted)
            .disabled(
                !self.viewModel.composerCapabilityCatalog.permissionMutationAvailable ||
                    self.viewModel.composerCapabilityMutationDisabled)
            .accessibilityLabel("Session permissions")
            .accessibilityValue(
                self.viewModel.composerPermissionMode?.displayName ?? String(localized: "Default (inherited)"))
            .accessibilityHint(self.viewModel.composerPermissionMutationDisabledReason ?? "")
            .accessibilityIdentifier("chat-composer-inline-permissions")
        }
    }

    private var cleanInlinePermissionGlyph: some View {
        ZStack {
            Image(systemName: "shield")
                .font(OpenClawChatTypography.display(size: 18, weight: .semibold, relativeTo: .body))
            Image(systemName: self.cleanInlinePermissionOverlaySymbol)
                .font(OpenClawChatTypography.display(size: 7, weight: .bold, relativeTo: .caption2))
                .offset(y: -1)
        }
        .foregroundStyle(.secondary)
    }

    private var cleanInlinePermissionOverlaySymbol: String {
        switch self.viewModel.composerPermissionMode {
        case .readOnly: "ellipsis"
        case .guarded: "lock.fill"
        case .workspace: "gearshape.fill"
        case .full: "exclamationmark"
        case nil: "checkmark"
        }
    }

    private func permissionButton(
        _ mode: OpenClawChatPermissionMode?,
        title: String) -> some View
    {
        let isSelected = self.viewModel.composerPermissionMode == mode
        return Button {
            self.viewModel.selectComposerPermissionMode(mode)
        } label: {
            Label {
                Text(title)
                    .font(OpenClawChatTypography.body)
            } icon: {
                Image(systemName: isSelected
                    ? "checkmark.circle.fill"
                    : "circle")
            }
        }
        .accessibilityValue(isSelected ? String(localized: "Selected") : String(localized: "Not selected"))
        .accessibilityAddTraits(isSelected ? .isSelected : [])
        .accessibilityHint(self.viewModel.composerPermissionDisabledReason(mode) ?? "")
    }

    private var composerWebSearchButton: some View {
        let isEnabled = self.viewModel.composerWebSearchEnabled
        return Button {
            self.viewModel.toggleComposerWebSearch()
        } label: {
            Label {
                Text("Web Search")
                    .font(OpenClawChatTypography.body)
            } icon: {
                Image(systemName: isEnabled
                    ? "checkmark.circle.fill"
                    : "circle")
            }
        }
        .disabled(
            !self.viewModel.composerCapabilityCatalog.webSearchAvailable ||
                !self.viewModel.composerCapabilityCatalog.webSearchBaseEnabled ||
                !self.viewModel.composerCapabilityCatalog.toolOverrideMutationAvailable ||
                self.viewModel.composerCapabilityMutationDisabled)
        .accessibilityValue(isEnabled ? String(localized: "On") : String(localized: "Off"))
        .accessibilityAddTraits(isEnabled ? .isSelected : [])
        .accessibilityHint(self.viewModel.composerWebSearchMutationHint ?? "")
        .accessibilityIdentifier("chat-composer-web-search")
    }

    private var composerSkillsMenu: some View {
        Menu {
            if self.viewModel.composerCapabilitiesLoading {
                Text("Loading skills…")
                    .font(OpenClawChatTypography.body)
            } else if !self.viewModel.composerCapabilityCatalog.skillsAvailable {
                Text("Skills unavailable")
                    .font(OpenClawChatTypography.body)
            } else if self.viewModel.composerCapabilityCatalog.skills.isEmpty {
                Text("No skills configured")
                    .font(OpenClawChatTypography.body)
            } else {
                ForEach(self.viewModel.composerCapabilityCatalog.skills) { skill in
                    let isEnabled = self.viewModel.composerSkillEnabled(skill)
                    let statusMessage = self.viewModel.composerSkillStatusMessage(skill)
                    Button {
                        self.viewModel.toggleComposerSkill(skill)
                    } label: {
                        Label {
                            Text(statusMessage.map { "\(skill.name) — \($0)" } ?? skill.name)
                                .font(OpenClawChatTypography.body)
                        } icon: {
                            Image(systemName: isEnabled
                                ? "checkmark.circle.fill"
                                : "circle")
                        }
                    }
                    .disabled(
                        !skill.baseEnabled || skill.missingDependencies || skill.blocked ||
                            !self.viewModel.composerCapabilityCatalog.toolOverrideMutationAvailable ||
                            self.viewModel.composerCapabilityMutationDisabled)
                    .accessibilityValue(isEnabled ? String(localized: "On") : String(localized: "Off"))
                    .accessibilityAddTraits(isEnabled ? .isSelected : [])
                    .accessibilityHint(
                        statusMessage ?? self.viewModel.composerToolOverrideMutationHint ?? "")
                }
            }
        } label: {
            Label {
                Text("Skills")
                    .font(OpenClawChatTypography.body)
            } icon: {
                Image(systemName: "book.closed")
            }
        }
        .accessibilityIdentifier("chat-composer-skills")
    }

    private var composerConnectorsMenu: some View {
        Menu {
            if self.viewModel.composerCapabilitiesLoading {
                Text("Loading connectors…")
                    .font(OpenClawChatTypography.body)
            } else if !self.viewModel.composerCapabilityCatalog.connectorsAvailable {
                Text("Connectors unavailable")
                    .font(OpenClawChatTypography.body)
            } else if self.viewModel.composerCapabilityCatalog.connectors.isEmpty {
                Text("No connectors configured")
                    .font(OpenClawChatTypography.body)
            } else {
                ForEach(self.viewModel.composerCapabilityCatalog.connectors) { connector in
                    self.composerConnectorMenu(connector)
                }
            }
        } label: {
            Label {
                Text("Connectors")
                    .font(OpenClawChatTypography.body)
            } icon: {
                Image(systemName: "puzzlepiece.extension")
            }
        }
        .accessibilityIdentifier("chat-composer-connectors")
    }

    private func composerConnectorMenu(_ connector: OpenClawChatComposerConnector) -> some View {
        let isEnabled = self.viewModel.composerConnectorEnabled(connector)
        return Menu {
            Button {
                self.viewModel.toggleComposerConnector(connector)
            } label: {
                Label {
                    Text("Enabled for this session")
                        .font(OpenClawChatTypography.body)
                } icon: {
                    Image(systemName: isEnabled
                        ? "checkmark.circle.fill"
                        : "circle")
                }
            }
            .disabled(
                !self.viewModel.composerCapabilityCatalog.toolOverrideMutationAvailable ||
                    self.viewModel.composerCapabilityMutationDisabled)
            .accessibilityValue(isEnabled ? String(localized: "On") : String(localized: "Off"))
            .accessibilityAddTraits(isEnabled ? .isSelected : [])
            .accessibilityHint(self.viewModel.composerToolOverrideMutationHint ?? "")

            if let notice = connector.notice {
                Text(notice)
                    .font(OpenClawChatTypography.caption)
            }
            if !connector.tools.isEmpty {
                Divider()
                Menu {
                    ForEach(connector.tools) { tool in
                        let toolIsEnabled = self.viewModel.composerToolEnabled(
                            server: connector.name,
                            tool: tool.name)
                        Button {
                            self.viewModel.toggleComposerTool(server: connector.name, tool: tool.name)
                        } label: {
                            Label {
                                Text(tool.label)
                                    .font(OpenClawChatTypography.body)
                            } icon: {
                                Image(systemName: toolIsEnabled ? "checkmark.circle.fill" : "circle")
                            }
                        }
                        .disabled(
                            !self.viewModel.composerCapabilityCatalog.toolAccessAvailable ||
                                !self.viewModel.composerCapabilityCatalog.toolOverrideMutationAvailable ||
                                self.viewModel.composerCapabilityMutationDisabled)
                        .accessibilityValue(toolIsEnabled ? String(localized: "On") : String(localized: "Off"))
                        .accessibilityAddTraits(toolIsEnabled ? .isSelected : [])
                        .accessibilityHint(self.viewModel.composerToolOverrideMutationHint ?? "")
                    }
                } label: {
                    Label {
                        Text("Tool Access")
                            .font(OpenClawChatTypography.body)
                    } icon: {
                        Image(systemName: "wrench.and.screwdriver")
                    }
                }
            }
        } label: {
            Label {
                Text(connector.name)
                    .font(OpenClawChatTypography.body)
            } icon: {
                Image(systemName: isEnabled
                    ? "checkmark.circle.fill"
                    : "circle")
            }
        }
        .accessibilityValue(isEnabled ? String(localized: "On") : String(localized: "Off"))
        .accessibilityAddTraits(isEnabled ? .isSelected : [])
    }

    @ViewBuilder
    var composerCapabilityNoticeRow: some View {
        if let notice = self.viewModel.composerCapabilityNotice {
            HStack(alignment: .center, spacing: 8) {
                Image(systemName: "info.circle.fill")
                    .foregroundStyle(OpenClawChatTheme.accent)
                    .accessibilityHidden(true)
                Text(notice)
                    .font(OpenClawChatTypography.caption)
                    .foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
                Spacer(minLength: 4)
                Button {
                    self.viewModel.dismissComposerCapabilityNotice()
                } label: {
                    Image(systemName: "xmark.circle.fill")
                        .foregroundStyle(.secondary)
                        .frame(width: 28, height: 28)
                }
                .buttonStyle(.plain)
                .frame(
                    width: CleanChatComposerMetrics.controlTouchSize,
                    height: CleanChatComposerMetrics.controlTouchSize)
                .contentShape(Rectangle())
                .accessibilityLabel("Dismiss capability notice")
                .accessibilityIdentifier("chat-composer-dismiss-capability-notice")
            }
            .padding(.horizontal, 8)
            .padding(.top, 6)
            .accessibilityElement(children: .contain)
            .accessibilityIdentifier("chat-composer-capability-notice")
        }
    }
}
