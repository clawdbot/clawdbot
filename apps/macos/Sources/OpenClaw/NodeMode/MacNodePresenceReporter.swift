import ApplicationServices
import Foundation

@MainActor
final class MacNodePresenceReporter {
    typealias Sender = @MainActor @Sendable (_ event: String, _ payloadJSON: String) async -> Bool

    private struct Payload: Codable {
        let idleSeconds: Int
        let saturated: Bool?
    }

    private struct IdleSample {
        let seconds: Int
        let saturated: Bool
    }

    private struct DeliveryState {
        let sentAtMs: Int64
        let lastActiveAtMs: Int64
    }

    private static let eventName = "node.presence.activity"
    private static let sampleInterval = Duration.seconds(2)
    private static let activeReportIntervalMs: Int64 = 15000
    private static let keepaliveIntervalMs: Int64 = 180_000
    private static let maximumIdleSeconds = 30 * 24 * 60 * 60

    private var task: Task<Void, Never>?

    func start(sender: @escaping Sender) {
        self.stop()
        self.task = Task { [weak self] in
            guard let self else { return }
            var delivery: DeliveryState?
            while !Task.isCancelled {
                if let sample = Self.currentIdleSample(),
                   Self.shouldSend(
                       idleSeconds: sample.seconds,
                       saturated: sample.saturated,
                       nowMs: Self.nowMs(),
                       delivery: delivery)
                {
                    let nowMs = Self.nowMs()
                    let lastActiveAtMs = max(0, nowMs - Int64(sample.seconds) * 1000)
                    let payload = Payload(
                        idleSeconds: sample.seconds,
                        saturated: sample.saturated ? true : nil)
                    if let data = try? JSONEncoder().encode(payload),
                       let payloadJSON = String(data: data, encoding: .utf8),
                       await sender(Self.eventName, payloadJSON)
                    {
                        delivery = DeliveryState(sentAtMs: nowMs, lastActiveAtMs: lastActiveAtMs)
                    }
                }
                try? await Task.sleep(for: Self.sampleInterval)
            }
        }
    }

    func stop() {
        self.task?.cancel()
        self.task = nil
    }

    private static func currentIdleSample() -> IdleSample? {
        // Presence is intentionally opt-in through the app's existing Accessibility grant.
        guard AXIsProcessTrusted(), let seconds = SystemPresenceInfo.lastHardwareInputSeconds() else { return nil }
        let bounded = min(max(0, seconds), self.maximumIdleSeconds)
        return IdleSample(seconds: bounded, saturated: seconds > self.maximumIdleSeconds)
    }

    private static func shouldSend(
        idleSeconds: Int,
        saturated: Bool,
        nowMs: Int64,
        delivery: DeliveryState?) -> Bool
    {
        guard let delivery else { return true }
        let elapsedMs = nowMs - delivery.sentAtMs
        if elapsedMs >= self.keepaliveIntervalMs {
            return true
        }
        if saturated {
            return false
        }
        let lastActiveAtMs = max(0, nowMs - Int64(idleSeconds) * 1000)
        return lastActiveAtMs > delivery.lastActiveAtMs && elapsedMs >= self.activeReportIntervalMs
    }

    private static func nowMs() -> Int64 {
        Int64(Date().timeIntervalSince1970 * 1000)
    }
}

#if DEBUG
extension MacNodePresenceReporter {
    static func _testShouldSend(
        idleSeconds: Int,
        nowMs: Int64,
        lastSentAtMs: Int64?,
        lastSentActiveAtMs: Int64?,
        saturated: Bool = false) -> Bool
    {
        let delivery: DeliveryState? = if let lastSentAtMs, let lastSentActiveAtMs {
            DeliveryState(sentAtMs: lastSentAtMs, lastActiveAtMs: lastSentActiveAtMs)
        } else {
            nil
        }
        return self.shouldSend(
            idleSeconds: idleSeconds,
            saturated: saturated,
            nowMs: nowMs,
            delivery: delivery)
    }
}
#endif
