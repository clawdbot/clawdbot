import Foundation
import Observation
import SwabbleKit
import SwiftUI

@MainActor
@Observable
final class DeviceMicrophoneTestModel {
    var testState: VoiceWakeTestState = .idle
    var isTesting = false
    var meterLevel: Double = 0
    var meterError: String?
    private let state: AppState
    private let tester = VoiceWakeTester()
    private let meter = MicLevelMonitor()
    private let micObserver = AudioInputDeviceObserver()
    private var isActive = false
    private var testTask: Task<Void, Never>?
    private var meterTask: Task<Void, Never>?

    init(state: AppState) {
        self.state = state
    }

    func start() {
        guard !self.isActive, voiceWakeSupported else { return }
        self.isActive = true
        MicRefreshSupport.startObserver(self.micObserver) { [weak self] in
            guard let self, self.isActive else { return }
            MicRefreshSupport.schedule(refreshTask: &self.meterTask) { [weak self] in
                await self?.restartMeter()
            }
        }
        self.meterTask = Task { await self.restartMeter() }
    }

    func stop() {
        guard self.isActive else { return }
        self.isActive = false
        self.testTask?.cancel()
        self.testTask = nil
        self.meterTask?.cancel()
        self.meterTask = nil
        self.tester.stop()
        self.micObserver.stop()
        self.isTesting = false
        self.state.voiceWakeMeterActive = false
        Task { await self.meter.stop() }
    }

    func toggleTest() {
        guard self.isActive else { return }
        self.testTask?.cancel()
        if self.isTesting {
            self.tester.finalize()
            self.isTesting = false
            self.testState = .finalizing
            self.testTask = Task { @MainActor in
                try? await Task.sleep(for: .seconds(2))
                guard !Task.isCancelled, self.isActive, self.testState == .finalizing else { return }
                self.tester.stop()
                self.testState = .failed(String(localized: "Stopped"))
            }
            return
        }

        let triggers = sanitizeVoiceWakeTriggers(self.state.swabbleTriggerWords)
        self.tester.stop()
        self.isTesting = true
        self.testState = .requesting
        self.testTask = Task { @MainActor [self] in
            do {
                try await self.tester.start(
                    triggers: triggers,
                    micID: self.state.voiceWakeMicID.isEmpty ? nil : self.state.voiceWakeMicID,
                    localeID: self.state.voiceWakeLocaleID,
                    onUpdate: { [weak self] newState in
                        Task { @MainActor in self?.acceptTestState(newState) }
                    })
                guard !Task.isCancelled, self.isActive else {
                    self.tester.stop()
                    return
                }
                try await Task.sleep(for: .seconds(10))
                guard !Task.isCancelled, self.isActive, self.isTesting else { return }
                self.tester.stop()
                if case let .hearing(text) = self.testState,
                   let command = VoiceWakeTextUtils.textOnlyCommand(
                       transcript: text,
                       triggers: triggers,
                       minCommandLength: 1,
                       trimWake: { WakeWordGate.stripWake(text: $0, triggers: $1) })
                {
                    self.testState = .detected(command)
                } else {
                    self.testState = .failed(String(localized: "Timeout: no trigger heard"))
                }
                self.isTesting = false
            } catch is CancellationError {
                // Stop/finalize owns cancellation; do not replace its visible result.
            } catch {
                guard self.isActive else { return }
                self.tester.stop()
                self.testState = .failed(error.localizedDescription)
                self.isTesting = false
            }
        }
    }

    private func acceptTestState(_ newState: VoiceWakeTestState) {
        guard self.isActive else { return }
        self.testState = newState
        switch newState {
        case .detected, .failed:
            self.isTesting = false
            self.tester.stop()
            self.testTask?.cancel()
        default:
            break
        }
    }

    private func restartMeter() async {
        guard self.isActive else { return }
        self.meterError = nil
        await self.meter.stop()
        guard !Task.isCancelled, self.isActive else { return }
        do {
            try await self.meter.start { [weak self] level in
                Task { @MainActor in
                    guard let self, self.isActive else { return }
                    self.meterLevel = level
                }
            }
            guard !Task.isCancelled, self.isActive else {
                await self.meter.stop()
                return
            }
            self.state.voiceWakeMeterActive = true
        } catch {
            self.state.voiceWakeMeterActive = false
            self.meterError = error.localizedDescription
        }
    }
}

struct DeviceMicrophoneTestView: View {
    @Bindable var model: DeviceMicrophoneTestModel

    var body: some View {
        VStack(alignment: .leading, spacing: 16) {
            if voiceWakeSupported {
                HStack {
                    Text("Live level")
                    Spacer()
                    MicLevelBar(level: self.model.meterLevel)
                    Text(verbatim: String(format: "%.0f dB", (self.model.meterLevel * 50) - 50))
                        .font(.callout.monospacedDigit())
                        .foregroundStyle(.secondary)
                        .frame(width: 60, alignment: .trailing)
                }
                if let meterError = self.model.meterError {
                    Text(verbatim: meterError)
                        .font(.footnote)
                        .foregroundStyle(.secondary)
                }
                VoiceWakeTestCard(
                    testState: self.$model.testState,
                    isTesting: self.$model.isTesting,
                    onToggle: self.model.toggleTest)
            } else {
                Text("Voice Wake requires macOS 26 or newer")
                    .foregroundStyle(.secondary)
            }
        }
    }
}
