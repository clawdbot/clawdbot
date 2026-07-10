import Cocoa
import Foundation
import OSLog

@MainActor
final class PresenceReporter {
    static let shared = PresenceReporter()

    private let logger = Logger(subsystem: "ai.openclaw", category: "presence")
    private var task: Task<Void, Never>?
    private let interval: TimeInterval = 180 // a few minutes
    private let instanceId: String = InstanceIdentity.instanceId

    func start() {
        guard self.task == nil else { return }
        self.task = Task.detached { [weak self] in
            guard let self else { return }
            await self.push(reason: "launch")
            while !Task.isCancelled {
                try? await Task.sleep(nanoseconds: UInt64(self.interval * 1_000_000_000))
                await self.push(reason: "periodic")
            }
        }
    }

    func stop() {
        self.task?.cancel()
        self.task = nil
    }

    @Sendable
    private func push(reason: String) async {
        let mode = await MainActor.run { AppStateStore.shared.connectionMode.rawValue }
        let host = InstanceIdentity.displayName
        let ip = SystemPresenceInfo.primaryIPv4Address() ?? "ip-unknown"
        let version = Self.appVersionString()
        let platform = Self.platformString()
        let lastInput = SystemPresenceInfo.lastInputSeconds()
        let text = Self.composePresenceSummary(mode: mode, reason: reason)
        var params: [String: AnyHashable] = [
            "instanceId": AnyHashable(self.instanceId),
            "host": AnyHashable(host),
            "ip": AnyHashable(ip),
            "mode": AnyHashable(mode),
            "version": AnyHashable(version),
            "platform": AnyHashable(platform),
            "deviceFamily": AnyHashable("Mac"),
            "reason": AnyHashable(reason),
        ]
        if let model = InstanceIdentity.modelIdentifier { params["modelIdentifier"] = AnyHashable(model) }
        if let lastInput { params["lastInputSeconds"] = AnyHashable(lastInput) }
        do {
            try await ControlChannel.shared.sendSystemEvent(text, params: params)
        } catch {
            self.logger.error("presence send failed: \(error.localizedDescription, privacy: .public)")
        }
    }

    /// Fire an immediate presence beacon (e.g., right after connecting).
    func sendImmediate(reason: String = "connect") {
        Task { await self.push(reason: reason) }
    }

    private static func composePresenceSummary(mode: String, reason: String) -> String {
        let host = InstanceIdentity.displayName
        let ip = SystemPresenceInfo.primaryIPv4Address() ?? "ip-unknown"
        let version = Self.appVersionString()
        let lastInput = SystemPresenceInfo.lastInputSeconds()
        let lastLabel = lastInput.map { "last input \($0)s ago" } ?? "last input unknown"
        return "Node: \(host) (\(ip)) · app \(version) · \(lastLabel) · mode \(mode) · reason \(reason)"
    }

    private static func appVersionString() -> String {
        let version = Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String ?? "dev"
        if let build = Bundle.main.object(forInfoDictionaryKey: "CFBundleVersion") as? String {
            let trimmed = build.trimmingCharacters(in: .whitespacesAndNewlines)
            if !trimmed.isEmpty, trimmed != version {
                return "\(version) (\(trimmed))"
            }
        }
        return version
    }

    private static func platformString() -> String {
        let v = ProcessInfo.processInfo.operatingSystemVersion
        return "macos \(v.majorVersion).\(v.minorVersion).\(v.patchVersion)"
    }

    // (SystemPresenceInfo) last input + primary IPv4.
}

#if DEBUG
extension PresenceReporter {
    static func _testComposePresenceSummary(mode: String, reason: String) -> String {
        self.composePresenceSummary(mode: mode, reason: reason)
    }

    static func _testAppVersionString() -> String {
        self.appVersionString()
    }

    static func _testPlatformString() -> String {
        self.platformString()
    }

    static func _testLastInputSeconds() -> Int? {
        SystemPresenceInfo.lastInputSeconds()
    }

    static func _testPrimaryIPv4Address() -> String? {
        SystemPresenceInfo.primaryIPv4Address()
    }
}
#endif
