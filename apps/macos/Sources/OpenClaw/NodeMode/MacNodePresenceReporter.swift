import ApplicationServices
import Foundation

@MainActor
final class MacNodePresenceReporter {
    typealias Sender = @MainActor @Sendable (_ event: String, _ payloadJSON: String) async -> Bool
    typealias Clearer = @MainActor @Sendable () async -> ClearDeliveryResult
    typealias UnsupportedClearHandler = @MainActor @Sendable () -> Void
    typealias IdleSecondsProvider = @MainActor @Sendable () -> Int?

    enum ClearDeliveryResult: Equatable, Sendable {
        case cleared
        case retry
        case unsupported
    }

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
    private var sender: Sender?
    private var clearer: Clearer?
    private var unsupportedClearHandler: UnsupportedClearHandler?
    private var delivery: DeliveryState?
    private var reportingEnabled: Bool
    private var clearPending = false
    private var hasDeliveredActivity = false
    private var unsupportedClearHandled = false
    private var generation: UInt64 = 0
    private var routeGeneration: UInt64 = 0
    private let idleSecondsProvider: IdleSecondsProvider

    init(
        reportingEnabled: Bool = UserDefaults.standard.bool(forKey: activeComputerPresenceEnabledKey),
        idleSecondsProvider: @escaping IdleSecondsProvider = {
            guard AXIsProcessTrusted() else { return nil }
            return SystemPresenceInfo.lastHardwareInputSeconds()
        })
    {
        self.reportingEnabled = reportingEnabled
        self.idleSecondsProvider = idleSecondsProvider
    }

    func start(
        sender: @escaping Sender,
        clearer: @escaping Clearer,
        onUnsupportedClear: @escaping UnsupportedClearHandler)
    {
        self.stop()
        self.sender = sender
        self.clearer = clearer
        self.unsupportedClearHandler = onUnsupportedClear
        self.generation &+= 1
        // Registration creates a fresh server-side node session. Starting disabled
        // therefore needs no clear and cannot turn a legacy reconnect into a loop.
        self.clearPending = false
        self.hasDeliveredActivity = false
        self.unsupportedClearHandled = false
        self.task = Task {
            while !Task.isCancelled {
                await self.reportCurrentState()
                try? await Task.sleep(for: Self.sampleInterval)
            }
        }
    }

    func stop() {
        self.generation &+= 1
        self.routeGeneration &+= 1
        self.task?.cancel()
        self.task = nil
        self.sender = nil
        self.clearer = nil
        self.unsupportedClearHandler = nil
        self.delivery = nil
        self.clearPending = false
        self.hasDeliveredActivity = false
        self.unsupportedClearHandled = false
    }

    func setReportingEnabled(_ enabled: Bool) async {
        if self.reportingEnabled == enabled {
            if !enabled, self.clearPending {
                await self.sendPendingClear()
            }
            return
        }

        self.reportingEnabled = enabled
        self.generation &+= 1
        self.delivery = nil
        if enabled {
            self.clearPending = false
            self.unsupportedClearHandled = false
            await self.reportCurrentState()
        } else {
            self.clearPending = self.hasDeliveredActivity
            await self.sendPendingClear()
        }
    }

    private func reportCurrentState() async {
        guard self.reportingEnabled else {
            await self.sendPendingClear()
            return
        }
        guard let seconds = self.idleSecondsProvider() else { return }
        let sample = Self.idleSample(seconds: seconds)
        guard Self.shouldSend(
            idleSeconds: sample.seconds,
            saturated: sample.saturated,
            nowMs: Self.nowMs(),
            delivery: self.delivery)
        else { return }

        let nowMs = Self.nowMs()
        let lastActiveAtMs = max(0, nowMs - Int64(sample.seconds) * 1000)
        let payload = Payload(
            idleSeconds: sample.seconds,
            saturated: sample.saturated ? true : nil)
        guard let sender = self.sender,
              let data = try? JSONEncoder().encode(payload),
              let payloadJSON = String(data: data, encoding: .utf8)
        else { return }
        let generation = self.generation
        let routeGeneration = self.routeGeneration
        guard await sender(Self.eventName, payloadJSON) else { return }
        // Setting changes can cross this await and still belong to this route.
        // A stop/start cannot transfer the old route's delivery into the new one.
        guard routeGeneration == self.routeGeneration else { return }
        self.hasDeliveredActivity = true
        guard generation == self.generation else {
            self.delivery = nil
            if self.reportingEnabled {
                await self.reportCurrentState()
            } else {
                self.clearPending = self.hasDeliveredActivity
                await self.sendPendingClear()
            }
            return
        }
        guard self.reportingEnabled else {
            self.clearPending = self.hasDeliveredActivity
            await self.sendPendingClear()
            return
        }
        self.delivery = DeliveryState(sentAtMs: nowMs, lastActiveAtMs: lastActiveAtMs)
    }

    private func sendPendingClear() async {
        guard self.clearPending,
              let clearer = self.clearer
        else { return }
        let generation = self.generation
        let routeGeneration = self.routeGeneration
        let result = await clearer()
        guard routeGeneration == self.routeGeneration else { return }
        guard generation == self.generation else {
            if self.reportingEnabled {
                self.clearPending = false
                self.delivery = nil
                await self.reportCurrentState()
            } else {
                self.clearPending = self.hasDeliveredActivity
                await self.sendPendingClear()
            }
            return
        }
        guard !self.reportingEnabled else {
            self.clearPending = false
            self.delivery = nil
            await self.reportCurrentState()
            return
        }
        switch result {
        case .cleared:
            self.clearPending = false
            self.hasDeliveredActivity = false
        case .retry:
            break
        case .unsupported:
            self.clearPending = false
            self.hasDeliveredActivity = false
            guard !self.unsupportedClearHandled else { return }
            self.unsupportedClearHandled = true
            self.unsupportedClearHandler?()
        }
    }

    private static func idleSample(seconds: Int) -> IdleSample {
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
