import AppKit
import ClawdbotDiscovery
import ClawdbotIPC
import ClawdbotKit
import ClawdbotProtocol
import Foundation
import Observation
import OSLog
import UserNotifications

enum NodePairingReconcilePolicy {
    static let activeIntervalMs: UInt64 = 15000
    static let resyncDelayMs: UInt64 = 250

    static func shouldPoll(pendingCount: Int, isPresenting: Bool) -> Bool {
        pendingCount > 0 || isPresenting
    }
}

@MainActor
@Observable
final class NodePairingApprovalPrompter {
    static let shared = NodePairingApprovalPrompter()

    private let logger = Logger(subsystem: "com.clawdbot", category: "node-pairing")
    private var task: Task<Void, Never>?
    private var reconcileTask: Task<Void, Never>?
    private var reconcileOnceTask: Task<Void, Never>?
    private var reconcileInFlight = false
    private var isStopping = false
    private var isPresenting = false
    private var queue: [PendingRequest] = []
    var pendingCount: Int = 0
    var pendingRepairCount: Int = 0
    private var activeAlert: NSAlert?
    private var activeRequestId: String?
    private var alertHostWindow: NSWindow?
    private var remoteResolutionsByRequestId: [String: PairingResolution] = [:]
    private var autoApproveAttempts: Set<String> = []

    private final class AlertHostWindow: NSWindow {
        override var canBecomeKey: Bool { true }
        override var canBecomeMain: Bool { true }
    }

    private struct PairingList: Codable {
        let pending: [PendingRequest]
        let paired: [PairedNode]?
    }

    private struct PairedNode: Codable, Equatable {
        let nodeId: String
        let approvedAtMs: Double?
        let displayName: String?
        let platform: String?
        let version: String?
        let remoteIp: String?
    }

    private struct PendingRequest: Codable, Equatable, Identifiable {
        let requestId: String
        let nodeId: String
        let displayName: String?
        let platform: String?
        let version: String?
        let remoteIp: String?
        let isRepair: Bool?
        let silent: Bool?
        let ts: Double

        var id: String { self.requestId }
    }

    private struct PairingResolvedEvent: Codable {
        let requestId: String
        let nodeId: String
        let decision: String
        let ts: Double
    }

    private enum PairingResolution: String {
        case approved
        case rejected
    }

    func start() {
        guard self.task == nil else { return }
        self.isStopping = false
        self.reconcileTask?.cancel()
        self.reconcileTask = nil
        self.task = Task { [weak self] in
            guard let self else { return }
            _ = try? await GatewayConnection.shared.refresh()
            await self.loadPendingRequestsFromGateway()
            let stream = await GatewayConnection.shared.subscribe(bufferingNewest: 200)
            for await push in stream {
                if Task.isCancelled { return }
                await MainActor.run { [weak self] in self?.handle(push: push) }
            }
        }
    }

    func stop() {
        self.isStopping = true
        self.endActiveAlert()
        self.task?.cancel()
        self.task = nil
        self.reconcileTask?.cancel()
        self.reconcileTask = nil
        self.reconcileOnceTask?.cancel()
        self.reconcileOnceTask = nil
        self.queue.removeAll(keepingCapacity: false)
        self.updatePendingCounts()
        self.isPresenting = false
        self.activeRequestId = nil
        self.alertHostWindow?.orderOut(nil)
        self.alertHostWindow?.close()
        self.alertHostWindow = nil
        self.remoteResolutionsByRequestId.removeAll(keepingCapacity: false)
        self.autoApproveAttempts.removeAll(keepingCapacity: false)
    }

    private func loadPendingRequestsFromGateway() async {
        // The gateway process may start slightly after the app. Retry a bit so
        // pending pairing prompts are still shown on launch.
        var delayMs: UInt64 = 200
        for attempt in 1...8 {
            if Task.isCancelled { return }
            do {
                let data = try await GatewayConnection.shared.request(
                    method: "node.pair.list",
                    params: nil,
                    timeoutMs: 6000)
                guard !data.isEmpty else { return }
                let list = try JSONDecoder().decode(PairingList.self, from: data)
                let pendingCount = list.pending.count
                guard pendingCount > 0 else { return }
                self.logger.info(
                    "loaded \(pendingCount, privacy: .public) pending node pairing request(s) on startup")
                await self.apply(list: list)
                return
            } catch {
                if attempt == 8 {
                    self.logger
                        .error(
                            "failed to load pending pairing requests: \(error.localizedDescription, privacy: .public)")
                    return
                }
                try? await Task.sleep(nanoseconds: delayMs * 1_000_000)
                delayMs = min(delayMs * 2, 2000)
            }
        }
    }

    private func reconcileLoop() async {
        // Reconcile requests periodically so multiple running apps stay in sync
        // (e.g. close dialogs + notify if another machine approves/rejects via app or CLI).
        while !Task.isCancelled {
            if self.isStopping { break }
            if !self.shouldPoll {
                self.reconcileTask = nil
                return
            }
            await self.reconcileOnce(timeoutMs: 2500)
            try? await Task.sleep(
                nanoseconds: NodePairingReconcilePolicy.activeIntervalMs * 1_000_000)
        }
        self.reconcileTask = nil
    }

    private func fetchPairingList(timeoutMs: Double) async throws -> PairingList {
        let data = try await GatewayConnection.shared.request(
            method: "node.pair.list",
            params: nil,
            timeoutMs: timeoutMs)
        return try JSONDecoder().decode(PairingList.self, from: data)
    }

    private func apply(list: PairingList) async {
        if self.isStopping { return }

        let pendingById = Dictionary(
            uniqueKeysWithValues: list.pending.map { ($0.requestId, $0) })

        // Enqueue any missing requests (covers missed pushes while reconnecting).
        for req in list.pending.sorted(by: { $0.ts < $1.ts }) {
            self.enqueue(req)
        }

        // Detect resolved requests (approved/rejected elsewhere).
        let queued = self.queue
        for req in queued {
            if pendingById[req.requestId] != nil { continue }
            let resolution = self.inferResolution(for: req, list: list)

            if self.activeRequestId == req.requestId, self.activeAlert != nil {
                self.remoteResolutionsByRequestId[req.requestId] = resolution
                self.logger.info(
                    """
                    pairing request resolved elsewhere; closing dialog \
                    requestId=\(req.requestId, privacy: .public) \
                    resolution=\(resolution.rawValue, privacy: .public)
                    """)
                self.endActiveAlert()
                continue
            }

            self.logger.info(
                """
                pairing request resolved elsewhere requestId=\(req.requestId, privacy: .public) \
                resolution=\(resolution.rawValue, privacy: .public)
                """)
            self.queue.removeAll { $0 == req }
            Task { @MainActor in
                await self.notify(resolution: resolution, request: req, via: "remote")
            }
        }

        if self.queue.isEmpty {
            self.isPresenting = false
        }
        self.presentNextIfNeeded()
        self.updateReconcileLoop()
    }

    private func inferResolution(for request: PendingRequest, list: PairingList) -> PairingResolution {
        let paired = list.paired ?? []
        guard let node = paired.first(where: { $0.nodeId == request.nodeId }) else {
            return .rejected
        }
        if request.isRepair == true, let approvedAtMs = node.approvedAtMs {
            return approvedAtMs >= request.ts ? .approved : .rejected
        }
        return .approved
    }

    private func endActiveAlert() {
        guard let alert = self.activeAlert else { return }
        if let parent = alert.window.sheetParent {
            parent.endSheet(alert.window, returnCode: .abort)
        }
        self.activeAlert = nil
        self.activeRequestId = nil
    }

    private func requireAlertHostWindow() -> NSWindow {
        if let alertHostWindow {
            return alertHostWindow
        }

        let window = AlertHostWindow(
            contentRect: NSRect(x: 0, y: 0, width: 520, height: 1),
            styleMask: [.borderless],
            backing: .buffered,
            defer: false)
        window.title = ""
        window.isReleasedWhenClosed = false
        window.level = .floating
        window.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary]
        window.isOpaque = false
        window.hasShadow = false
        window.backgroundColor = .clear
        window.ignoresMouseEvents = true

        self.alertHostWindow = window
        return window
    }

    private func handle(push: GatewayPush) {
        switch push {
        case let .event(evt) where evt.event == "node.pair.requested":
            guard let payload = evt.payload else { return }
            do {
                let req = try GatewayPayloadDecoding.decode(payload, as: PendingRequest.self)
                self.enqueue(req)
            } catch {
                self.logger
                    .error("failed to decode pairing request: \(error.localizedDescription, privacy: .public)")
            }
        case let .event(evt) where evt.event == "node.pair.resolved":
            guard let payload = evt.payload else { return }
            do {
                let resolved = try GatewayPayloadDecoding.decode(payload, as: PairingResolvedEvent.self)
                self.handleResolved(resolved)
            } catch {
                self.logger
                    .error(
                        "failed to decode pairing resolution: \(error.localizedDescription, privacy: .public)")
            }
        case .snapshot:
            self.scheduleReconcileOnce(delayMs: 0)
        case .seqGap:
            self.scheduleReconcileOnce()
        default:
            return
        }
    }

    private func enqueue(_ req: PendingRequest) {
        if self.queue.contains(req) { return }
        self.queue.append(req)
        self.updatePendingCounts()
        self.presentNextIfNeeded()
        self.updateReconcileLoop()
    }

    private func presentNextIfNeeded() {
        guard !self.isStopping else { return }
        guard !self.isPresenting else { return }
        guard let next = self.queue.first else { return }
        self.isPresenting = true
        Task { @MainActor [weak self] in
            guard let self else { return }
            if await self.trySilentApproveIfPossible(next) {
                return
            }
            self.presentAlert(for: next)
        }
    }

    private func presentAlert(for req: PendingRequest) {
        self.logger.info("presenting node pairing alert requestId=\(req.requestId, privacy: .public)")
        NSApp.activate(ignoringOtherApps: true)

        let alert = NSAlert()
        alert.alertStyle = .warning
        alert.messageText = "Allow node to connect?"
        alert.informativeText = Self.describe(req)
        // Fail-safe ordering: if the dialog can't be presented, default to "Later".
        alert.addButton(withTitle: "Later")
        alert.addButton(withTitle: "Approve")
        alert.addButton(withTitle: "Reject")
        if #available(macOS 11.0, *), alert.buttons.indices.contains(2) {
            alert.buttons[2].hasDestructiveAction = true
        }

        self.activeAlert = alert
        self.activeRequestId = req.requestId
        let hostWindow = self.requireAlertHostWindow()

        // Position the hidden host window so the sheet appears centered on screen.
        // (Sheets attach to the top edge of their parent window; if the parent is tiny, it looks "anchored".)
        let sheetSize = alert.window.frame.size
        if let screen = hostWindow.screen ?? NSScreen.main {
            let bounds = screen.visibleFrame
            let x = bounds.midX - (sheetSize.width / 2)
            let sheetOriginY = bounds.midY - (sheetSize.height / 2)
            let hostY = sheetOriginY + sheetSize.height - hostWindow.frame.height
            hostWindow.setFrameOrigin(NSPoint(x: x, y: hostY))
        } else {
            hostWindow.center()
        }

        hostWindow.makeKeyAndOrderFront(nil)
        alert.beginSheetModal(for: hostWindow) { [weak self] response in
            Task { @MainActor [weak self] in
                guard let self else { return }
                self.activeRequestId = nil
                self.activeAlert = nil
                await self.handleAlertResponse(response, request: req)
                hostWindow.orderOut(nil)
            }
        }
    }

    private func handleAlertResponse(_ response: NSApplication.ModalResponse, request: PendingRequest) async {
        defer {
            if self.queue.first == request {
                self.queue.removeFirst()
            } else {
                self.queue.removeAll { $0 == request }
            }
            self.updatePendingCounts()
            self.isPresenting = false
            self.presentNextIfNeeded()
            self.updateReconcileLoop()
        }

        // Never approve/reject while shutting down (alerts can get dismissed during app termination).
        guard !self.isStopping else { return }

        if let resolved = self.remoteResolutionsByRequestId.removeValue(forKey: request.requestId) {
            await self.notify(resolution: resolved, request: request, via: "remote")
            return
        }

        switch response {
        case .alertFirstButtonReturn:
            // Later: leave as pending (CLI can approve/reject). Request will expire on the gateway TTL.
            return
        case .alertSecondButtonReturn:
            _ = await self.approve(requestId: request.requestId)
            await self.notify(resolution: .approved, request: request, via: "local")
        case .alertThirdButtonReturn:
            await self.reject(requestId: request.requestId)
            await self.notify(resolution: .rejected, request: request, via: "local")
        default:
            return
        }
    }

    private func approve(requestId: String) async -> Bool {
        do {
            try await GatewayConnection.shared.nodePairApprove(requestId: requestId)
            self.logger.info("approved node pairing requestId=\(requestId, privacy: .public)")
            return true
        } catch {
            self.logger.error("approve failed requestId=\(requestId, privacy: .public)")
            self.logger.error("approve failed: \(error.localizedDescription, privacy: .public)")
            return false
        }
    }

    private func reject(requestId: String) async {
        do {
            try await GatewayConnection.shared.nodePairReject(requestId: requestId)
            self.logger.info("rejected node pairing requestId=\(requestId, privacy: .public)")
        } catch {
            self.logger.error("reject failed requestId=\(requestId, privacy: .public)")
            self.logger.error("reject failed: \(error.localizedDescription, privacy: .public)")
        }
    }

    private static func describe(_ req: PendingRequest) -> String {
        let name = req.displayName?.trimmingCharacters(in: .whitespacesAndNewlines)
        let platform = self.prettyPlatform(req.platform)
        let version = req.version?.trimmingCharacters(in: .whitespacesAndNewlines)
        let ip = self.prettyIP(req.remoteIp)

        var lines: [String] = []
        lines.append("Name: \(name?.isEmpty == false ? name! : "Unknown")")
        lines.append("Node ID: \(req.nodeId)")
        if let platform, !platform.isEmpty { lines.append("Platform: \(platform)") }
        if let version, !version.isEmpty { lines.append("App: \(version)") }
        if let ip, !ip.isEmpty { lines.append("IP: \(ip)") }
        if req.isRepair == true { lines.append("Note: Repair request (token will rotate).") }
        return lines.joined(separator: "\n")
    }

    private static func prettyIP(_ ip: String?) -> String? {
        let trimmed = ip?.trimmingCharacters(in: .whitespacesAndNewlines)
        guard let trimmed, !trimmed.isEmpty else { return nil }
        return trimmed.replacingOccurrences(of: "::ffff:", with: "")
    }

    private static func prettyPlatform(_ platform: String?) -> String? {
        let raw = platform?.trimmingCharacters(in: .whitespacesAndNewlines)
        guard let raw, !raw.isEmpty else { return nil }
        if raw.lowercased() == "ios" { return "iOS" }
        if raw.lowercased() == "macos" { return "macOS" }
        return raw
    }

    private func notify(resolution: PairingResolution, request: PendingRequest, via: String) async {
        let center = UNUserNotificationCenter.current()
        let settings = await center.notificationSettings()
        guard settings.authorizationStatus == .authorized ||
            settings.authorizationStatus == .provisional
        else {
            return
        }

        let title = resolution == .approved ? "Node pairing approved" : "Node pairing rejected"
        let name = request.displayName?.trimmingCharacters(in: .whitespacesAndNewlines)
        let device = name?.isEmpty == false ? name! : request.nodeId
        let body = "\(device)\n(via \(via))"

        _ = await NotificationManager().send(
            title: title,
            body: body,
            sound: nil,
            priority: .active)
    }

    private struct SSHTarget {
        let host: String
        let port: Int
    }

    private func trySilentApproveIfPossible(_ req: PendingRequest) async -> Bool {
        guard req.silent == true else { return false }
        if self.autoApproveAttempts.contains(req.requestId) { return false }
        self.autoApproveAttempts.insert(req.requestId)

        guard let target = await self.resolveSSHTarget() else {
            self.logger.info("silent pairing skipped (no ssh target) requestId=\(req.requestId, privacy: .public)")
            return false
        }

        let user = NSUserName().trimmingCharacters(in: .whitespacesAndNewlines)
        guard !user.isEmpty else {
            self.logger.info("silent pairing skipped (missing local user) requestId=\(req.requestId, privacy: .public)")
            return false
        }

        let ok = await Self.probeSSH(user: user, host: target.host, port: target.port)
        if !ok {
            self.logger.info("silent pairing probe failed requestId=\(req.requestId, privacy: .public)")
            return false
        }

        guard await self.approve(requestId: req.requestId) else {
            self.logger.info("silent pairing approve failed requestId=\(req.requestId, privacy: .public)")
            return false
        }

        await self.notify(resolution: .approved, request: req, via: "silent-ssh")
        if self.queue.first == req {
            self.queue.removeFirst()
        } else {
            self.queue.removeAll { $0 == req }
        }

        self.updatePendingCounts()
        self.isPresenting = false
        self.presentNextIfNeeded()
        self.updateReconcileLoop()
        return true
    }

    private func resolveSSHTarget() async -> SSHTarget? {
        let settings = CommandResolver.connectionSettings()
        if !settings.target.isEmpty, let parsed = CommandResolver.parseSSHTarget(settings.target) {
            let user = NSUserName().trimmingCharacters(in: .whitespacesAndNewlines)
            if let targetUser = parsed.user,
               !targetUser.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty,
               targetUser != user
            {
                self.logger.info("silent pairing skipped (ssh user mismatch)")
                return nil
            }
            let host = parsed.host.trimmingCharacters(in: .whitespacesAndNewlines)
            guard !host.isEmpty else { return nil }
            let port = parsed.port > 0 ? parsed.port : 22
            return SSHTarget(host: host, port: port)
        }

        let model = GatewayDiscoveryModel(localDisplayName: InstanceIdentity.displayName)
        model.start()
        defer { model.stop() }

        let deadline = Date().addingTimeInterval(5.0)
        while model.gateways.isEmpty, Date() < deadline {
            try? await Task.sleep(nanoseconds: 200_000_000)
        }

        let preferred = GatewayDiscoveryPreferences.preferredStableID()
        let gateway = model.gateways.first { $0.stableID == preferred } ?? model.gateways.first
        guard let gateway else { return nil }
        let host = (gateway.tailnetDns?.trimmingCharacters(in: .whitespacesAndNewlines).nonEmpty ??
            gateway.lanHost?.trimmingCharacters(in: .whitespacesAndNewlines).nonEmpty)
        guard let host, !host.isEmpty else { return nil }
        let port = gateway.sshPort > 0 ? gateway.sshPort : 22
        return SSHTarget(host: host, port: port)
    }

    private static func probeSSH(user: String, host: String, port: Int) async -> Bool {
        await Task.detached(priority: .utility) {
            let process = Process()
            process.executableURL = URL(fileURLWithPath: "/usr/bin/ssh")

            let options = [
                "-o", "BatchMode=yes",
                "-o", "ConnectTimeout=5",
                "-o", "NumberOfPasswordPrompts=0",
                "-o", "PreferredAuthentications=publickey",
                "-o", "StrictHostKeyChecking=accept-new",
            ]
            guard let target = CommandResolver.makeSSHTarget(user: user, host: host, port: port) else {
                return false
            }
            let args = CommandResolver.sshArguments(
                target: target,
                identity: "",
                options: options,
                remoteCommand: ["/usr/bin/true"])
            process.arguments = args
            let pipe = Pipe()
            process.standardOutput = pipe
            process.standardError = pipe

            do {
                _ = try process.runAndReadToEnd(from: pipe)
            } catch {
                return false
            }
            return process.terminationStatus == 0
        }.value
    }

    private var shouldPoll: Bool {
        NodePairingReconcilePolicy.shouldPoll(
            pendingCount: self.queue.count,
            isPresenting: self.isPresenting)
    }

    private func updateReconcileLoop() {
        guard !self.isStopping else { return }
        if self.shouldPoll {
            if self.reconcileTask == nil {
                self.reconcileTask = Task { [weak self] in
                    await self?.reconcileLoop()
                }
            }
        } else {
            self.reconcileTask?.cancel()
            self.reconcileTask = nil
        }
    }

    private func updatePendingCounts() {
        // Keep a cheap observable summary for the menu bar status line.
        self.pendingCount = self.queue.count
        self.pendingRepairCount = self.queue.count(where: { $0.isRepair == true })
    }

    private func reconcileOnce(timeoutMs: Double) async {
        if self.isStopping { return }
        if self.reconcileInFlight { return }
        self.reconcileInFlight = true
        defer { self.reconcileInFlight = false }
        do {
            let list = try await self.fetchPairingList(timeoutMs: timeoutMs)
            await self.apply(list: list)
        } catch {
            // best effort: ignore transient connectivity failures
        }
    }

    private func scheduleReconcileOnce(delayMs: UInt64 = NodePairingReconcilePolicy.resyncDelayMs) {
        self.reconcileOnceTask?.cancel()
        self.reconcileOnceTask = Task { [weak self] in
            guard let self else { return }
            if delayMs > 0 {
                try? await Task.sleep(nanoseconds: delayMs * 1_000_000)
            }
            await self.reconcileOnce(timeoutMs: 2500)
        }
    }

    private func handleResolved(_ resolved: PairingResolvedEvent) {
        let resolution: PairingResolution =
            resolved.decision == PairingResolution.approved.rawValue ? .approved : .rejected

        if self.activeRequestId == resolved.requestId, self.activeAlert != nil {
            self.remoteResolutionsByRequestId[resolved.requestId] = resolution
            self.logger.info(
                """
                pairing request resolved elsewhere; closing dialog \
                requestId=\(resolved.requestId, privacy: .public) \
                resolution=\(resolution.rawValue, privacy: .public)
                """)
            self.endActiveAlert()
            return
        }

        guard let request = self.queue.first(where: { $0.requestId == resolved.requestId }) else {
            return
        }
        self.queue.removeAll { $0.requestId == resolved.requestId }
        self.updatePendingCounts()
        Task { @MainActor in
            await self.notify(resolution: resolution, request: request, via: "remote")
        }
        if self.queue.isEmpty {
            self.isPresenting = false
        }
        self.presentNextIfNeeded()
        self.updateReconcileLoop()
    }
}

#if DEBUG
@MainActor
extension NodePairingApprovalPrompter {
    static func exerciseForTesting() async {
        let prompter = NodePairingApprovalPrompter()
        let pending = PendingRequest(
            requestId: "req-1",
            nodeId: "node-1",
            displayName: "Node One",
            platform: "macos",
            version: "1.0.0",
            remoteIp: "127.0.0.1",
            isRepair: false,
            silent: true,
            ts: 1_700_000_000_000)
        let paired = PairedNode(
            nodeId: "node-1",
            approvedAtMs: 1_700_000_000_000,
            displayName: "Node One",
            platform: "macOS",
            version: "1.0.0",
            remoteIp: "127.0.0.1")
        let list = PairingList(pending: [pending], paired: [paired])

        _ = Self.describe(pending)
        _ = Self.prettyIP(pending.remoteIp)
        _ = Self.prettyPlatform(pending.platform)
        _ = prompter.inferResolution(for: pending, list: list)

        prompter.queue = [pending]
        _ = prompter.shouldPoll
        _ = await prompter.trySilentApproveIfPossible(pending)
        prompter.queue.removeAll()
    }
}
#endif
