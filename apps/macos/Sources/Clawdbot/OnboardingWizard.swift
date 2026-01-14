import ClawdbotProtocol
import Foundation
import Observation
import OSLog
import SwiftUI

private let onboardingWizardLogger = Logger(subsystem: "com.clawdbot", category: "onboarding.wizard")

// MARK: - Swift 6 AnyCodable Bridging Helpers

// Bridge between ClawdbotProtocol.AnyCodable and the local module to avoid
// Swift 6 strict concurrency type conflicts.

private typealias ProtocolAnyCodable = ClawdbotProtocol.AnyCodable

private func bridgeToLocal(_ value: ProtocolAnyCodable) -> AnyCodable {
    if let data = try? JSONEncoder().encode(value),
       let decoded = try? JSONDecoder().decode(AnyCodable.self, from: data)
    {
        return decoded
    }
    return AnyCodable(value.value)
}

private func bridgeToLocal(_ value: ProtocolAnyCodable?) -> AnyCodable? {
    value.map(bridgeToLocal)
}

@MainActor
@Observable
final class OnboardingWizardModel {
    private(set) var sessionId: String?
    private(set) var currentStep: WizardStep?
    private(set) var status: String?
    private(set) var errorMessage: String?
    var isStarting = false
    var isSubmitting = false
    private var lastStartMode: AppState.ConnectionMode?
    private var lastStartWorkspace: String?
    private var restartAttempts = 0
    private let maxRestartAttempts = 1

    var isComplete: Bool { self.status == "done" }
    var isRunning: Bool { self.status == "running" }

    func reset() {
        self.sessionId = nil
        self.currentStep = nil
        self.status = nil
        self.errorMessage = nil
        self.isStarting = false
        self.isSubmitting = false
        self.restartAttempts = 0
        self.lastStartMode = nil
        self.lastStartWorkspace = nil
    }

    func startIfNeeded(mode: AppState.ConnectionMode, workspace: String? = nil) async {
        guard self.sessionId == nil, !self.isStarting else { return }
        guard mode == .local else { return }
        self.isStarting = true
        self.errorMessage = nil
        self.lastStartMode = mode
        self.lastStartWorkspace = workspace
        defer { self.isStarting = false }

        do {
            GatewayProcessManager.shared.setActive(true)
            if await GatewayProcessManager.shared.waitForGatewayReady(timeout: 12) == false {
                throw NSError(
                    domain: "Gateway",
                    code: 1,
                    userInfo: [NSLocalizedDescriptionKey: "Gateway did not become ready. Check that it is running."])
            }
            var params: [String: AnyCodable] = ["mode": AnyCodable("local")]
            if let workspace, !workspace.isEmpty {
                params["workspace"] = AnyCodable(workspace)
            }
            let res: WizardStartResult = try await GatewayConnection.shared.requestDecoded(
                method: .wizardStart,
                params: params)
            self.applyStartResult(res)
        } catch {
            self.status = "error"
            self.errorMessage = error.localizedDescription
            onboardingWizardLogger.error("start failed: \(error.localizedDescription, privacy: .public)")
        }
    }

    func submit(step: WizardStep, value: AnyCodable?) async {
        guard let sessionId, !self.isSubmitting else { return }
        self.isSubmitting = true
        self.errorMessage = nil
        defer { self.isSubmitting = false }

        do {
            var params: [String: AnyCodable] = ["sessionId": AnyCodable(sessionId)]
            var answer: [String: AnyCodable] = ["stepId": AnyCodable(step.id)]
            if let value {
                answer["value"] = value
            }
            params["answer"] = AnyCodable(answer)
            let res: WizardNextResult = try await GatewayConnection.shared.requestDecoded(
                method: .wizardNext,
                params: params)
            self.applyNextResult(res)
        } catch {
            if self.restartIfSessionLost(error: error) {
                return
            }
            self.status = "error"
            self.errorMessage = error.localizedDescription
            onboardingWizardLogger.error("submit failed: \(error.localizedDescription, privacy: .public)")
        }
    }

    func cancelIfRunning() async {
        guard let sessionId, self.isRunning else { return }
        do {
            let res: WizardStatusResult = try await GatewayConnection.shared.requestDecoded(
                method: .wizardCancel,
                params: ["sessionId": AnyCodable(sessionId)])
            self.applyStatusResult(res)
        } catch {
            self.status = "error"
            self.errorMessage = error.localizedDescription
            onboardingWizardLogger.error("cancel failed: \(error.localizedDescription, privacy: .public)")
        }
    }

    private func applyStartResult(_ res: WizardStartResult) {
        self.sessionId = res.sessionid
        self.status = wizardStatusString(res.status) ?? (res.done ? "done" : "running")
        self.errorMessage = res.error
        self.currentStep = decodeWizardStep(res.step)
        if self.currentStep == nil, res.step != nil {
            onboardingWizardLogger.error("wizard step decode failed")
        }
        if res.done { self.currentStep = nil }
        self.restartAttempts = 0
    }

    private func applyNextResult(_ res: WizardNextResult) {
        let status = wizardStatusString(res.status)
        self.status = status ?? self.status
        self.errorMessage = res.error
        self.currentStep = decodeWizardStep(res.step)
        if self.currentStep == nil, res.step != nil {
            onboardingWizardLogger.error("wizard step decode failed")
        }
        if res.done { self.currentStep = nil }
        if res.done || status == "done" || status == "cancelled" || status == "error" {
            self.sessionId = nil
        }
    }

    private func applyStatusResult(_ res: WizardStatusResult) {
        self.status = wizardStatusString(res.status) ?? "unknown"
        self.errorMessage = res.error
        self.currentStep = nil
        self.sessionId = nil
    }

    private func restartIfSessionLost(error: Error) -> Bool {
        guard let gatewayError = error as? GatewayResponseError else { return false }
        guard gatewayError.code == ErrorCode.invalidRequest.rawValue else { return false }
        let message = gatewayError.message.lowercased()
        guard message.contains("wizard not found") || message.contains("wizard not running") else { return false }
        guard let mode = self.lastStartMode, self.restartAttempts < self.maxRestartAttempts else {
            return false
        }
        self.restartAttempts += 1
        self.sessionId = nil
        self.currentStep = nil
        self.status = nil
        self.errorMessage = "Wizard session lost. Restarting…"
        Task { await self.startIfNeeded(mode: mode, workspace: self.lastStartWorkspace) }
        return true
    }
}

struct OnboardingWizardStepView: View {
    let step: WizardStep
    let isSubmitting: Bool
    let onSubmit: (AnyCodable?) -> Void

    @State private var textValue: String
    @State private var confirmValue: Bool
    @State private var selectedIndex: Int
    @State private var selectedIndices: Set<Int>

    private let optionItems: [WizardOptionItem]

    init(step: WizardStep, isSubmitting: Bool, onSubmit: @escaping (AnyCodable?) -> Void) {
        self.step = step
        self.isSubmitting = isSubmitting
        self.onSubmit = onSubmit
        let options = parseWizardOptions(step.options).enumerated().map { index, option in
            WizardOptionItem(index: index, option: option)
        }
        self.optionItems = options
        let initialText = anyCodableString(step.initialvalue)
        let initialConfirm = anyCodableBool(step.initialvalue)
        let initialIndex = options.firstIndex(where: { anyCodableEqual($0.option.value, step.initialvalue) }) ?? 0
        let initialMulti = Set(
            options.filter { option in
                anyCodableArray(step.initialvalue).contains { anyCodableEqual($0, option.option.value) }
            }.map(\.index))

        _textValue = State(initialValue: initialText)
        _confirmValue = State(initialValue: initialConfirm)
        _selectedIndex = State(initialValue: initialIndex)
        _selectedIndices = State(initialValue: initialMulti)
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            if let title = step.title, !title.isEmpty {
                Text(title)
                    .font(.title2.weight(.semibold))
            }
            if let message = step.message, !message.isEmpty {
                Text(message)
                    .font(.body)
                    .foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
            }

            switch wizardStepType(self.step) {
            case "note":
                EmptyView()
            case "text":
                self.textField
            case "confirm":
                Toggle("", isOn: self.$confirmValue)
                    .toggleStyle(.switch)
            case "select":
                self.selectOptions
            case "multiselect":
                self.multiselectOptions
            case "progress":
                ProgressView()
                    .controlSize(.small)
            case "action":
                EmptyView()
            default:
                Text("Unsupported step type")
                    .foregroundStyle(.secondary)
            }

            Button(action: self.submit) {
                Text(wizardStepType(self.step) == "action" ? "Run" : "Continue")
                    .frame(minWidth: 120)
            }
            .buttonStyle(.borderedProminent)
            .disabled(self.isSubmitting || self.isBlocked)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    @ViewBuilder
    private var textField: some View {
        let isSensitive = self.step.sensitive == true
        if isSensitive {
            SecureField(self.step.placeholder ?? "", text: self.$textValue)
                .textFieldStyle(.roundedBorder)
                .frame(maxWidth: 360)
        } else {
            TextField(self.step.placeholder ?? "", text: self.$textValue)
                .textFieldStyle(.roundedBorder)
                .frame(maxWidth: 360)
        }
    }

    private var selectOptions: some View {
        VStack(alignment: .leading, spacing: 8) {
            ForEach(self.optionItems, id: \.index) { item in
                self.selectOptionRow(item)
            }
        }
    }

    private var multiselectOptions: some View {
        VStack(alignment: .leading, spacing: 8) {
            ForEach(self.optionItems, id: \.index) { item in
                self.multiselectOptionRow(item)
            }
        }
    }

    private func selectOptionRow(_ item: WizardOptionItem) -> some View {
        Button {
            self.selectedIndex = item.index
        } label: {
            HStack(alignment: .top, spacing: 8) {
                Image(systemName: self.selectedIndex == item.index ? "largecircle.fill.circle" : "circle")
                    .foregroundStyle(Color.accentColor)
                VStack(alignment: .leading, spacing: 2) {
                    Text(item.option.label)
                        .foregroundStyle(.primary)
                    if let hint = item.option.hint, !hint.isEmpty {
                        Text(hint)
                            .font(.caption)
                            .foregroundStyle(.secondary)
                    }
                }
            }
        }
        .buttonStyle(.plain)
    }

    private func multiselectOptionRow(_ item: WizardOptionItem) -> some View {
        Toggle(isOn: self.bindingForOption(item)) {
            VStack(alignment: .leading, spacing: 2) {
                Text(item.option.label)
                if let hint = item.option.hint, !hint.isEmpty {
                    Text(hint)
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
            }
        }
    }

    private func bindingForOption(_ item: WizardOptionItem) -> Binding<Bool> {
        Binding(get: {
            self.selectedIndices.contains(item.index)
        }, set: { newValue in
            if newValue {
                self.selectedIndices.insert(item.index)
            } else {
                self.selectedIndices.remove(item.index)
            }
        })
    }

    private var isBlocked: Bool {
        let type = wizardStepType(step)
        if type == "select" { return self.optionItems.isEmpty }
        if type == "multiselect" { return self.optionItems.isEmpty }
        return false
    }

    private func submit() {
        switch wizardStepType(self.step) {
        case "note", "progress":
            self.onSubmit(nil)
        case "text":
            self.onSubmit(AnyCodable(self.textValue))
        case "confirm":
            self.onSubmit(AnyCodable(self.confirmValue))
        case "select":
            guard self.optionItems.indices.contains(self.selectedIndex) else {
                self.onSubmit(nil)
                return
            }
            let option = self.optionItems[self.selectedIndex].option
            self.onSubmit(bridgeToLocal(option.value) ?? AnyCodable(option.label))
        case "multiselect":
            let values = self.optionItems
                .filter { self.selectedIndices.contains($0.index) }
                .map { bridgeToLocal($0.option.value) ?? AnyCodable($0.option.label) }
            self.onSubmit(AnyCodable(values))
        case "action":
            self.onSubmit(AnyCodable(true))
        default:
            self.onSubmit(nil)
        }
    }
}

private struct WizardOptionItem: Identifiable {
    let index: Int
    let option: WizardOption

    var id: Int { self.index }
}
