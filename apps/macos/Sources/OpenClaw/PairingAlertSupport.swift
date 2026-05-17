import AppKit
import OpenClawKit
import OSLog

final class PairingAlertHostWindow: NSWindow {
    override var canBecomeKey: Bool {
        true
    }

    override var canBecomeMain: Bool {
        true
    }
}

@MainActor
final class PairingAlertState {
    var activeAlert: NSAlert?
    var activeRequestId: String?
    var alertHostWindow: NSWindow?
}

@MainActor
enum PairingAlertSupport {
    enum PairingResolution: String {
        case approved
        case rejected
    }

    struct ButtonTitles {
        var approve: String = "Approve"
        var postpone: String = "Not Now"
        var reject: String = "Reject"

        init(approve: String = "Approve", postpone: String = "Not Now", reject: String = "Reject") {
            self.approve = approve
            self.postpone = postpone
            self.reject = reject
        }
    }

    struct PairingResolvedEvent: Codable {
        let requestId: String
        let decision: String
        let ts: Double
    }

    static func endActiveAlert(activeAlert: inout NSAlert?, activeRequestId: inout String?) {
        guard let alert = activeAlert else { return }
        if let parent = alert.window.sheetParent {
            parent.endSheet(alert.window, returnCode: .abort)
        }
        activeAlert = nil
        activeRequestId = nil
    }

    static func endActiveAlert(state: PairingAlertState) {
        self.endActiveAlert(activeAlert: &state.activeAlert, activeRequestId: &state.activeRequestId)
    }

    static func requireAlertHostWindow(alertHostWindow: inout NSWindow?) -> NSWindow {
        if let alertHostWindow {
            return alertHostWindow
        }

        let window = PairingAlertHostWindow(
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

        alertHostWindow = window
        return window
    }

    static func configureDefaultPairingAlert(
        _ alert: NSAlert,
        messageText: String,
        informativeText: String,
        buttonTitles: ButtonTitles = ButtonTitles(),
        accessoryView: NSView? = nil)
    {
        alert.alertStyle = .informational
        alert.messageText = messageText
        alert.informativeText = informativeText
        alert.accessoryView = accessoryView
        alert.addButton(withTitle: buttonTitles.approve)
        alert.addButton(withTitle: buttonTitles.postpone)
        alert.addButton(withTitle: buttonTitles.reject)
        if #available(macOS 11.0, *), alert.buttons.indices.contains(2) {
            alert.buttons[2].hasDestructiveAction = true
        }
    }

    static func beginCenteredSheet(
        alert: NSAlert,
        hostWindow: NSWindow,
        completionHandler: @escaping (NSApplication.ModalResponse) -> Void)
    {
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
        alert.beginSheetModal(for: hostWindow, completionHandler: completionHandler)
    }

    static func runPairingPushTask(
        bufferingNewest: Int = 200,
        loadPending: @escaping @MainActor () async -> Void,
        handlePush: @escaping @MainActor (GatewayPush) -> Void) async
    {
        _ = try? await GatewayConnection.shared.refresh()
        await loadPending()
        await GatewayPushSubscription.consume(bufferingNewest: bufferingNewest, onPush: handlePush)
    }

    static func startPairingPushTask(
        task: inout Task<Void, Never>?,
        isStopping: inout Bool,
        bufferingNewest: Int = 200,
        loadPending: @escaping @MainActor () async -> Void,
        handlePush: @escaping @MainActor (GatewayPush) -> Void)
    {
        guard task == nil else { return }
        isStopping = false
        task = Task {
            await self.runPairingPushTask(
                bufferingNewest: bufferingNewest,
                loadPending: loadPending,
                handlePush: handlePush)
        }
    }

    static func beginPairingAlert(
        messageText: String,
        informativeText: String,
        buttonTitles: ButtonTitles = ButtonTitles(),
        accessoryView: NSView? = nil,
        alertHostWindow: inout NSWindow?,
        completion: @escaping (NSApplication.ModalResponse, NSWindow) -> Void) -> NSAlert
    {
        NSApp.activate(ignoringOtherApps: true)

        let alert = NSAlert()
        self.configureDefaultPairingAlert(
            alert,
            messageText: messageText,
            informativeText: informativeText,
            buttonTitles: buttonTitles,
            accessoryView: accessoryView)

        let hostWindow = self.requireAlertHostWindow(alertHostWindow: &alertHostWindow)
        self.beginCenteredSheet(alert: alert, hostWindow: hostWindow) { response in
            completion(response, hostWindow)
        }
        return alert
    }

    static func presentPairingAlert(
        requestId: String,
        messageText: String,
        informativeText: String,
        buttonTitles: ButtonTitles = ButtonTitles(),
        accessoryView: NSView? = nil,
        activeAlert: inout NSAlert?,
        activeRequestId: inout String?,
        alertHostWindow: inout NSWindow?,
        completion: @escaping (NSApplication.ModalResponse, NSWindow) -> Void)
    {
        activeRequestId = requestId
        activeAlert = self.beginPairingAlert(
            messageText: messageText,
            informativeText: informativeText,
            buttonTitles: buttonTitles,
            accessoryView: accessoryView,
            alertHostWindow: &alertHostWindow,
            completion: completion)
    }

    static func presentPairingAlert<Request>(
        request: Request,
        requestId: String,
        messageText: String,
        informativeText: String,
        buttonTitles: ButtonTitles = ButtonTitles(),
        accessoryView: NSView? = nil,
        state: PairingAlertState,
        onResponse: @escaping @MainActor (NSApplication.ModalResponse, Request) async -> Void)
    {
        self.presentPairingAlert(
            requestId: requestId,
            messageText: messageText,
            informativeText: informativeText,
            buttonTitles: buttonTitles,
            accessoryView: accessoryView,
            activeAlert: &state.activeAlert,
            activeRequestId: &state.activeRequestId,
            alertHostWindow: &state.alertHostWindow,
            completion: { response, hostWindow in
                Task { @MainActor in
                    self.clearActivePairingAlert(state: state, hostWindow: hostWindow)
                    await onResponse(response, request)
                }
            })
    }

    static func clearActivePairingAlert(
        activeAlert: inout NSAlert?,
        activeRequestId: inout String?,
        hostWindow: NSWindow)
    {
        activeRequestId = nil
        activeAlert = nil
        hostWindow.orderOut(nil)
    }

    static func clearActivePairingAlert(state: PairingAlertState, hostWindow: NSWindow) {
        self.clearActivePairingAlert(
            activeAlert: &state.activeAlert,
            activeRequestId: &state.activeRequestId,
            hostWindow: hostWindow)
    }

    static func stopPairingPrompter(
        isStopping: inout Bool,
        activeAlert: inout NSAlert?,
        activeRequestId: inout String?,
        task: inout Task<Void, Never>?,
        queue: inout [some Any],
        isPresenting: inout Bool,
        alertHostWindow: inout NSWindow?)
    {
        isStopping = true
        self.endActiveAlert(activeAlert: &activeAlert, activeRequestId: &activeRequestId)
        task?.cancel()
        task = nil
        queue.removeAll(keepingCapacity: false)
        isPresenting = false
        activeRequestId = nil
        alertHostWindow?.orderOut(nil)
        alertHostWindow?.close()
        alertHostWindow = nil
    }

    static func stopPairingPrompter(
        isStopping: inout Bool,
        task: inout Task<Void, Never>?,
        queue: inout [some Any],
        isPresenting: inout Bool,
        state: PairingAlertState)
    {
        self.stopPairingPrompter(
            isStopping: &isStopping,
            activeAlert: &state.activeAlert,
            activeRequestId: &state.activeRequestId,
            task: &task,
            queue: &queue,
            isPresenting: &isPresenting,
            alertHostWindow: &state.alertHostWindow)
    }

    static func approveRequest(
        requestId: String,
        kind: String,
        logger: Logger,
        action: @escaping () async throws -> Void) async -> Bool
    {
        do {
            try await action()
            logger.info("approved \(kind, privacy: .public) pairing requestId=\(requestId, privacy: .public)")
            return true
        } catch {
            logger.error("approve failed requestId=\(requestId, privacy: .public)")
            logger.error("approve failed: \(error.localizedDescription, privacy: .public)")
            return false
        }
    }

    static func rejectRequest(
        requestId: String,
        kind: String,
        logger: Logger,
        action: @escaping () async throws -> Void) async
    {
        do {
            try await action()
            logger.info("rejected \(kind, privacy: .public) pairing requestId=\(requestId, privacy: .public)")
        } catch {
            logger.error("reject failed requestId=\(requestId, privacy: .public)")
            logger.error("reject failed: \(error.localizedDescription, privacy: .public)")
        }
    }
}
