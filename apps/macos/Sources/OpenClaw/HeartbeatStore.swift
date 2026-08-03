import Foundation
import Observation
import SwiftUI

@MainActor
@Observable
final class HeartbeatStore {
    static let shared = HeartbeatStore()

    private(set) var lastEvent: ControlHeartbeatEvent?

    private var observer: NSObjectProtocol?

    private init() {
        self.observer = NotificationCenter.default.addObserver(
            forName: .controlHeartbeat,
            object: nil,
            queue: .main)
        { [weak self] note in
            guard let data = note.object as? Data else { return }
            if let decoded = try? JSONDecoder().decode(ControlHeartbeatEvent.self, from: data) {
                Task { @MainActor in self?.lastEvent = decoded }
            }
        }

        Task {
            if self.lastEvent == nil {
                if let evt = try? await ControlChannel.shared.lastHeartbeat() {
                    self.lastEvent = evt
                }
            }
        }
    }

    @MainActor
    deinit {
        if let observer { NotificationCenter.default.removeObserver(observer) }
    }
}
