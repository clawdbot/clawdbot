import Foundation

#if canImport(UIKit) && !os(watchOS)
import UIKit
#endif

public struct OpenClawChatHaptics: Sendable {
    public enum Event: Sendable, Equatable {
        case messageSent
        case runCompleted
        case runFailed
    }

    private let performer: @Sendable (Event) -> Void

    public init() {
        self.performer = Self.defaultPerformer
    }

    // periphery:ignore - package tests inject a recorder; app consumers use the live performer.
    public init(performer: @escaping @Sendable (Event) -> Void) {
        self.performer = performer
    }

    public func perform(_ event: Event) {
        self.performer(event)
    }

    private static let defaultPerformer: @Sendable (Event) -> Void = { event in
        #if canImport(UIKit) && !os(watchOS)
        Task { @MainActor in
            switch event {
            case .messageSent:
                UIImpactFeedbackGenerator(style: .light).impactOccurred()
            case .runCompleted:
                UINotificationFeedbackGenerator().notificationOccurred(.success)
            case .runFailed:
                UINotificationFeedbackGenerator().notificationOccurred(.error)
            }
        }
        #else
        // NSHapticFeedbackManager only fires reliably from gesture contexts, so macOS is a no-op.
        _ = event
        #endif
    }
}
