import AppKit
import MoltbotKit
import MoltbotProtocol
import Foundation
import Observation
import OSLog

@MainActor
@Observable
final class DevicePairingApprovalPrompter {
    static let shared = DevicePairingApprovalPrompter()

    private let logger = Logger(subsystem: "com.clawdbot", category: "device-pairing")
    private var task: Task<Void, Never>?
    private var isStopping = false
    private var isPresenting = false
    private var queue: [PendingRequest] = []
    var pendingCount: Int = 0
    var pendingRepairCount: Int = 0
    private var activeAlert: NSAlert?
    private var activeRequestId: String?
    private var alertHostWindow: NSWindow?
    private var resolvedByRequestId: Set<String> = []

    private final class AlertHostWindow: NSWindow {
        override var canBecomeKey: Bool { true }
        override var canBecomeMain: Bool { true }
    }

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

    private struct PendingRequest: Codable, Equatable, Identifiable {
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

        var id: String { self.requestId }
    }

    private struct PairingResolvedEvent: Codable {
        let requestId: String
        let deviceId: String
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
        self.queue.removeAll(keepingCapacity: false)
        self.updatePendingCounts()
        self.isPresenting = false
        self.activeRequestId = nil
        self.alertHostWindow?.orderOut(nil)
        self.alertHostWindow?.close()
        self.alertHostWindow = nil
        self.resolvedByRequestId.removeAll(keepingCapacity: false)
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
        NSApp.activate(ignoringOtherApps: true)

        let alert = NSAlert()
        alert.alertStyle = .warning
        alert.messageText = "Allow device to connect?"
        alert.informativeText = Self.describe(req)
        alert.addButton(withTitle: "Later")
        alert.addButton(withTitle: "Approve")
        alert.addButton(withTitle: "Reject")
        if #available(macOS 11.0, *), alert.buttons.indices.contains(2) {
            alert.buttons[2].hasDestructiveAction = true
        }

        self.activeAlert = alert
        self.activeRequestId = req.requestId
        let hostWindow = self.requireAlertHostWindow()

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
        var shouldRemove = response != .alertFirstButtonReturn
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
            shouldRemove = false
            if let idx = self.queue.firstIndex(of: request) {
                self.queue.remove(at: idx)
            }
            self.queue.append(request)
            return
        case .alertSecondButtonReturn:
            _ = await self.approve(requestId: request.requestId)
        case .alertThirdButtonReturn:
            await self.reject(requestId: request.requestId)
        default:
            return
        }
    }

    private func approve(requestId: String) async -> Bool {
        do {
            try await GatewayConnection.shared.devicePairApprove(requestId: requestId)
            self.logger.info("approved device pairing requestId=\(requestId, privacy: .public)")
            return true
        } catch {
            self.logger.error("approve failed requestId=\(requestId, privacy: .public)")
            self.logger.error("approve failed: \(error.localizedDescription, privacy: .public)")
            return false
        }
    }

    private func reject(requestId: String) async {
        do {
            try await GatewayConnection.shared.devicePairReject(requestId: requestId)
            self.logger.info("rejected device pairing requestId=\(requestId, privacy: .public)")
        } catch {
            self.logger.error("reject failed requestId=\(requestId, privacy: .public)")
            self.logger.error("reject failed: \(error.localizedDescription, privacy: .public)")
        }
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
        let resolution = resolved.decision == PairingResolution.approved.rawValue ? PairingResolution
            .approved : .rejected
        if let activeRequestId, activeRequestId == resolved.requestId {
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

    private static func describe(_ req: PendingRequest) -> String {
        var lines: [String] = []
        lines.append("Device: \(req.displayName ?? req.deviceId)")
        if let platform = req.platform {
            lines.append("Platform: \(platform)")
        }
        if let role = req.role {
            lines.append("Role: \(role)")
        }
        if let scopes = req.scopes, !scopes.isEmpty {
            lines.append("Scopes: \(scopes.joined(separator: ", "))")
        }
        if let remoteIp = req.remoteIp {
            lines.append("IP: \(remoteIp)")
        }
        if req.isRepair == true {
            lines.append("Repair: yes")
        }
        return lines.joined(separator: "\n")
    }
}
