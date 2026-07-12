import CoreGraphics
import Foundation
import OpenClawKit

enum SystemPresenceInfo {
    static func lastInputSeconds() -> Int? {
        self.lastInputSeconds(state: .combinedSessionState)
    }

    static func lastHardwareInputSeconds() -> Int? {
        self.lastInputSeconds(state: .hidSystemState)
    }

    private static func lastInputSeconds(state: CGEventSourceStateID) -> Int? {
        let anyEvent = CGEventType(rawValue: UInt32.max) ?? .null
        let seconds = CGEventSource.secondsSinceLastEventType(state, eventType: anyEvent)
        if seconds.isNaN || seconds.isInfinite || seconds < 0 {
            return nil
        }
        return Int(seconds.rounded())
    }

    static func primaryIPv4Address() -> String? {
        NetworkInterfaces.primaryIPv4Address()
    }
}
