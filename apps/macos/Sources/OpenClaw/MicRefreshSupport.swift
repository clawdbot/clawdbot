import Foundation
import SwiftUI

enum MicRefreshSupport {
    private static let refreshDelayNs: UInt64 = 300_000_000

    static func startObserver(_ observer: AudioInputDeviceObserver, triggerRefresh: @escaping @MainActor () -> Void) {
        observer.start {
            Task { @MainActor in
                triggerRefresh()
            }
        }
    }

    @MainActor
    static func schedule(
        refreshTask: inout Task<Void, Never>?,
        action: @escaping @MainActor () async -> Void)
    {
        refreshTask?.cancel()
        refreshTask = Task { @MainActor in
            try? await Task.sleep(nanoseconds: self.refreshDelayNs)
            guard !Task.isCancelled else { return }
            await action()
        }
    }

    static func selectedMicName<T>(
        selectedID: String,
        in devices: [T],
        uid: KeyPath<T, String>,
        name: KeyPath<T, String>) -> String
    {
        guard !selectedID.isEmpty else { return "" }
        return devices.first(where: { $0[keyPath: uid] == selectedID })?[keyPath: name] ?? ""
    }

    @MainActor
    static func voiceWakeBinding(for state: AppState) -> Binding<Bool> {
        Binding(
            get: { state.swabbleEnabled },
            set: { newValue in
                Task { await state.setVoiceWakeEnabled(newValue) }
            })
    }
}
