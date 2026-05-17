import AppKit
import Foundation
import Observation
import OpenClawKit
import OpenClawProtocol
import OSLog

@MainActor
@Observable
final class DevicePairingApprovalPrompter {
    static let shared = DevicePairingApprovalPrompter()

    private let logger = Logger(subsystem: "ai.openclaw", category: "device-pairing")
    private var task: Task<Void, Never>?
    private var isStopping = false
    private var isPresenting = false
    private var queue: [PendingRequest] = []
    var pendingCount: Int = 0
    var pendingRepairCount: Int = 0
    private let alertState = PairingAlertState()
    private var resolvedByRequestId: Set<String> = []

    private struct PairingList: Codable {
        let pending: [PendingRequest]
        let paired: [PairedDevice]?
    }

    private struct PairedDevice: Codable, Equatable {
        let deviceId: String
        let approvedAtMs: Double?
        let displayName: String?
        let platform: String?
        let remoteIp: String?
    }

    struct PendingRequest: Codable, Equatable, Identifiable {
        let requestId: String
        let deviceId: String
        let publicKey: String
        let displayName: String?
        let platform: String?
        let clientId: String?
        let clientMode: String?
        let role: String?
        let scopes: [String]?
        let remoteIp: String?
        let silent: Bool?
        let isRepair: Bool?
        let ts: Double

        var id: String {
            self.requestId
        }
    }

    private typealias PairingResolvedEvent = PairingAlertSupport.PairingResolvedEvent

    func start() {
        self.startPushTask()
    }

    private func startPushTask() {
        PairingAlertSupport.startPairingPushTask(
            task: &self.task,
            isStopping: &self.isStopping,
            loadPending: self.loadPendingRequestsFromGateway,
            handlePush: self.handle(push:))
    }

    func stop() {
        self.stopPushTask()
        self.updatePendingCounts()
        self.resolvedByRequestId.removeAll(keepingCapacity: false)
    }

    private func stopPushTask() {
        PairingAlertSupport.stopPairingPrompter(
            isStopping: &self.isStopping,
            task: &self.task,
            queue: &self.queue,
            isPresenting: &self.isPresenting,
            state: self.alertState)
    }

    private func loadPendingRequestsFromGateway() async {
        do {
            let list: PairingList = try await GatewayConnection.shared.requestDecoded(method: .devicePairList)
            await self.apply(list: list)
        } catch {
            self.logger.error("failed to load device pairing requests: \(error.localizedDescription, privacy: .public)")
        }
    }

    private func apply(list: PairingList) async {
        self.queue = list.pending.sorted(by: { $0.ts > $1.ts })
        self.updatePendingCounts()
        self.presentNextIfNeeded()
    }

    private func updatePendingCounts() {
        self.pendingCount = self.queue.count
        self.pendingRepairCount = self.queue.count(where: { $0.isRepair == true })
    }

    private func presentNextIfNeeded() {
        guard !self.isStopping else { return }
        guard !self.isPresenting else { return }
        guard let next = self.queue.first else { return }
        self.isPresenting = true
        self.presentAlert(for: next)
    }

    private func presentAlert(for req: PendingRequest) {
        self.logger.info("presenting device pairing alert requestId=\(req.requestId, privacy: .public)")
        PairingAlertSupport.presentPairingAlert(
            request: req,
            requestId: req.requestId,
            messageText: Self.alertTitle(for: req),
            informativeText: Self.alertSummary(for: req),
            buttonTitles: PairingAlertSupport.ButtonTitles(approve: Self.approveButtonTitle(for: req)),
            accessoryView: Self.buildAccessoryView(for: req),
            state: self.alertState,
            onResponse: self.handleAlertResponse)
    }

    private func handleAlertResponse(_ response: NSApplication.ModalResponse, request: PendingRequest) async {
        var shouldRemove = response != .alertSecondButtonReturn
        defer {
            if shouldRemove {
                if self.queue.first == request {
                    self.queue.removeFirst()
                } else {
                    self.queue.removeAll { $0 == request }
                }
            }
            self.updatePendingCounts()
            self.isPresenting = false
            self.presentNextIfNeeded()
        }

        guard !self.isStopping else { return }

        if self.resolvedByRequestId.remove(request.requestId) != nil {
            return
        }

        switch response {
        case .alertFirstButtonReturn:
            _ = await self.approve(requestId: request.requestId)
        case .alertSecondButtonReturn:
            shouldRemove = false
            if let idx = self.queue.firstIndex(of: request) {
                self.queue.remove(at: idx)
            }
            self.queue.append(request)
            return
        case .alertThirdButtonReturn:
            await self.reject(requestId: request.requestId)
        default:
            return
        }
    }

    private func approve(requestId: String) async -> Bool {
        await PairingAlertSupport.approveRequest(
            requestId: requestId,
            kind: "device",
            logger: self.logger)
        {
            try await GatewayConnection.shared.devicePairApprove(requestId: requestId)
        }
    }

    private func reject(requestId: String) async {
        await PairingAlertSupport.rejectRequest(
            requestId: requestId,
            kind: "device",
            logger: self.logger)
        {
            try await GatewayConnection.shared.devicePairReject(requestId: requestId)
        }
    }

    private func endActiveAlert() {
        PairingAlertSupport.endActiveAlert(state: self.alertState)
    }

    private func handle(push: GatewayPush) {
        switch push {
        case let .event(evt) where evt.event == "device.pair.requested":
            guard let payload = evt.payload else { return }
            do {
                let req = try GatewayPayloadDecoding.decode(payload, as: PendingRequest.self)
                self.enqueue(req)
            } catch {
                self.logger
                    .error("failed to decode device pairing request: \(error.localizedDescription, privacy: .public)")
            }
        case let .event(evt) where evt.event == "device.pair.resolved":
            guard let payload = evt.payload else { return }
            do {
                let resolved = try GatewayPayloadDecoding.decode(payload, as: PairingResolvedEvent.self)
                self.handleResolved(resolved)
            } catch {
                self.logger
                    .error(
                        "failed to decode device pairing resolution: \(error.localizedDescription, privacy: .public)")
            }
        default:
            break
        }
    }

    private func enqueue(_ req: PendingRequest) {
        guard !self.queue.contains(req) else { return }
        self.queue.append(req)
        self.updatePendingCounts()
        self.presentNextIfNeeded()
    }

    private func handleResolved(_ resolved: PairingResolvedEvent) {
        let resolution = resolved.decision == PairingAlertSupport.PairingResolution.approved.rawValue
            ? PairingAlertSupport.PairingResolution.approved
            : PairingAlertSupport.PairingResolution.rejected
        if let activeRequestId = self.alertState.activeRequestId, activeRequestId == resolved.requestId {
            self.resolvedByRequestId.insert(resolved.requestId)
            self.endActiveAlert()
            let decision = resolution.rawValue
            self.logger.info(
                "device pairing resolved while active requestId=\(resolved.requestId, privacy: .public) " +
                    "decision=\(decision, privacy: .public)")
            return
        }
        self.queue.removeAll { $0.requestId == resolved.requestId }
        self.updatePendingCounts()
    }

    static func alertTitle(for req: PendingRequest) -> String {
        self.isMac(req.platform) ? "New Mac wants to connect" : "New device wants to connect"
    }

    static func alertSummary(for req: PendingRequest) -> String {
        let subject = self.isMac(req.platform) ? "this Mac app" : "this device"
        return "Approve \(subject) to control OpenClaw. Only approve if this is yours; you can remove it later in Settings."
    }

    static func approveButtonTitle(for req: PendingRequest) -> String {
        self.isMac(req.platform) ? "Approve Mac" : "Approve Device"
    }

    static func buildAccessoryView(for req: PendingRequest) -> NSView {
        let stack = NSStackView()
        stack.orientation = .vertical
        stack.alignment = .leading
        stack.spacing = 8
        stack.edgeInsets = NSEdgeInsets(top: 2, left: 0, bottom: 0, right: 0)

        stack.addArrangedSubview(self.makeValueRow(label: "Device", value: self.deviceName(for: req)))
        if let platform = self.prettyPlatform(req.platform) {
            stack.addArrangedSubview(self.makeValueRow(label: "Platform", value: platform))
        }
        if let role = self.prettyRole(req.role) {
            stack.addArrangedSubview(self.makeValueRow(label: "Role", value: role))
        }
        let accessItems = self.friendlyScopeNames(req.scopes)
        if !accessItems.isEmpty {
            stack.addArrangedSubview(self.makeSectionLabel("Access requested"))
            for item in accessItems {
                stack.addArrangedSubview(self.makeBullet(item))
            }
        }
        stack.addArrangedSubview(self.makeDetailLine(req))

        let fitting = stack.fittingSize
        stack.frame = NSRect(x: 0, y: 0, width: 420, height: fitting.height)
        return stack
    }

    static func deviceName(for req: PendingRequest) -> String {
        let trimmedName = req.displayName?.trimmingCharacters(in: .whitespacesAndNewlines)
        if let trimmedName, !trimmedName.isEmpty, trimmedName != req.deviceId {
            return trimmedName
        }
        return self.isMac(req.platform) ? "OpenClaw Mac app" : "New device"
    }

    static func prettyPlatform(_ raw: String?) -> String? {
        let platform = raw?.trimmingCharacters(in: .whitespacesAndNewlines)
        guard let platform, !platform.isEmpty else { return nil }
        switch platform.lowercased() {
        case "macintel", "x86_64-apple-darwin":
            return "Mac (Intel)"
        case "macarm", "macarm64", "arm64-apple-darwin", "aarch64-apple-darwin":
            return "Mac (Apple silicon)"
        case "darwin":
            return "Mac"
        default:
            if platform.lowercased().contains("mac") {
                return "Mac"
            }
            return platform
        }
    }

    static func prettyRole(_ raw: String?) -> String? {
        let role = raw?.trimmingCharacters(in: .whitespacesAndNewlines)
        guard let role, !role.isEmpty else { return nil }
        return role == "operator" ? "Operator" : role
    }

    static func friendlyScopeNames(_ scopes: [String]?) -> [String] {
        guard let scopes else { return [] }
        var seen = Set<String>()
        return scopes.compactMap { scope in
            let normalized = scope.trimmingCharacters(in: .whitespacesAndNewlines)
            guard !normalized.isEmpty, seen.insert(normalized).inserted else { return nil }
            switch normalized {
            case "operator.admin":
                return "Admin access"
            case "operator.read":
                return "Read OpenClaw data"
            case "operator.write":
                return "Send messages and make changes"
            case "operator.approvals":
                return "Manage approvals"
            case "operator.pairing":
                return "Pair and repair devices"
            case "operator.talk.secrets":
                return "Use Talk credentials"
            default:
                return normalized
            }
        }
    }

    static func shortIdentifier(_ id: String) -> String {
        let trimmed = id.trimmingCharacters(in: .whitespacesAndNewlines)
        guard trimmed.count > 20 else { return trimmed }
        return "\(trimmed.prefix(8))...\(trimmed.suffix(7))"
    }

    private static func isMac(_ platform: String?) -> Bool {
        guard let platform else { return false }
        let lower = platform.lowercased()
        return lower.contains("mac") || lower.contains("darwin")
    }

    private static func makeValueRow(label: String, value: String) -> NSView {
        let row = NSStackView()
        row.orientation = .horizontal
        row.alignment = .firstBaseline
        row.spacing = 8

        let labelField = self.makeLabel("\(label):", font: .systemFont(ofSize: 12, weight: .semibold))
        labelField.textColor = .secondaryLabelColor
        labelField.setContentHuggingPriority(.required, for: .horizontal)
        let valueField = self.makeLabel(value, font: .systemFont(ofSize: 12, weight: .regular))
        valueField.maximumNumberOfLines = 2

        row.addArrangedSubview(labelField)
        row.addArrangedSubview(valueField)
        return row
    }

    private static func makeSectionLabel(_ text: String) -> NSTextField {
        let label = self.makeLabel(text, font: .systemFont(ofSize: 12, weight: .semibold))
        label.textColor = .secondaryLabelColor
        return label
    }

    private static func makeBullet(_ text: String) -> NSTextField {
        let label = self.makeLabel("• \(text)", font: .systemFont(ofSize: 12, weight: .regular))
        label.maximumNumberOfLines = 2
        return label
    }

    private static func makeDetailLine(_ req: PendingRequest) -> NSTextField {
        var parts = ["ID \(self.shortIdentifier(req.deviceId))"]
        if let remoteIp = req.remoteIp?.trimmingCharacters(in: .whitespacesAndNewlines), !remoteIp.isEmpty {
            parts.append("IP \(remoteIp.replacingOccurrences(of: "::ffff:", with: ""))")
        }
        if req.isRepair == true {
            parts.append("repair request")
        }
        let label = self.makeLabel(
            parts.joined(separator: " · "),
            font: .monospacedSystemFont(ofSize: 11, weight: .regular))
        label.textColor = .tertiaryLabelColor
        label.maximumNumberOfLines = 2
        return label
    }

    private static func makeLabel(_ text: String, font: NSFont) -> NSTextField {
        let label = NSTextField(labelWithString: text)
        label.font = font
        label.lineBreakMode = .byWordWrapping
        label.textColor = .labelColor
        return label
    }
}
