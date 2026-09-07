import AppKit
import Foundation
import Observation
import WebKit

@MainActor
final class DashboardDeviceSettingsMessageHandler: NSObject, WKScriptMessageHandlerWithReply {
    typealias ReplyHandler = @MainActor (Any?, String?) -> Void

    weak var owner: DashboardWindowController?
    private var observers: [NSObjectProtocol] = []
    private var observationGeneration = 0
    private let requests = DeviceSettingsRequestQueue()
    private let microphoneObserver = AudioInputDeviceObserver()
    private var refreshTask: Task<Void, Never>?
    private var consentAlert: NSAlert?

    func userContentController(
        _: WKUserContentController,
        didReceive message: WKScriptMessage,
        replyHandler: @escaping ReplyHandler)
    {
        guard let owner = self.owner else {
            replyHandler(nil, "The device settings window is no longer available.")
            return
        }
        owner.receiveDeviceSettingsMessage(message, replyHandler: replyHandler)
    }

    func startObserving() {
        guard self.observers.isEmpty else { return }
        // Refresh on activation, explicit status requests, and permission changes; never start a TCC poll.
        let center = NotificationCenter.default
        for name in [
            NSApplication.didBecomeActiveNotification,
            .openclawPermissionsChanged,
            .openclawDeviceSettingsChanged,
            .openclawCLIInstalled,
            UserDefaults.didChangeNotification,
        ] {
            self.observers.append(center.addObserver(forName: name, object: nil, queue: .main) { [weak self] _ in
                Task { @MainActor [weak self] in
                    self?.refresh(refreshAvailability: name == NSApplication.didBecomeActiveNotification)
                }
            })
        }
        MicRefreshSupport.startObserver(self.microphoneObserver) { [weak self] in
            self?.refresh()
        }
        self.observeBrowserChanges()
    }

    func stopObserving() {
        guard !self.observers.isEmpty else { return }
        self.observationGeneration += 1
        for observer in self.observers {
            NotificationCenter.default.removeObserver(observer)
        }
        self.observers.removeAll()
        self.cancelRequests()
        self.refreshTask?.cancel()
        self.refreshTask = nil
        self.microphoneObserver.stop()
    }

    func cancelRequests() {
        // Consent and queued changes belong to the displayed document, not its reusable window.
        self.requests.cancel()
        if let alert = self.consentAlert, let parent = alert.window.sheetParent {
            parent.endSheet(alert.window, returnCode: .cancel)
        }
    }

    isolated deinit {
        self.stopObserving()
    }

    func enqueue(
        _ request: DeviceSettingsRequest,
        sourceID: String,
        replyHandler: @escaping ReplyHandler)
    {
        // WebKit rejects the original Promise when cancellation drops an uncalled reply handler.
        // Keep it owned by this queued operation so retired documents cannot leave pending writes.
        self.requests.enqueue { [weak self] in
            guard let self, !self.observers.isEmpty, let owner = self.owner,
                  owner.canUseDeviceSettings(sourceID: sourceID)
            else {
                replyHandler(nil, "The device settings document is no longer available.")
                return
            }
            if request == .installChromeExtension {
                do {
                    let result = try await ChromeExtensionSetup.install {
                        owner.canUseDeviceSettings(sourceID: sourceID) && !Task.isCancelled
                    }
                    guard owner.canUseDeviceSettings(sourceID: sourceID), !Task.isCancelled else {
                        replyHandler(nil, "The device settings document is no longer available.")
                        return
                    }
                    try replyHandler(JSONSerialization.jsonObject(with: JSONEncoder().encode(result)), nil)
                } catch {
                    replyHandler(nil, error.localizedDescription)
                }
                return
            }
            await owner.applyDeviceSettingsRequest(request)
            let snapshot: DeviceSettingsSnapshot? = if case .set = request {
                await owner.readDeviceSettingsSnapshot(sourceID: sourceID)
            } else {
                nil
            }
            guard owner.canUseDeviceSettings(sourceID: sourceID) else {
                replyHandler(nil, "The device settings document is no longer available.")
                return
            }
            do {
                let reply: Any = try snapshot.map { try JSONSerialization.jsonObject(with: JSONEncoder().encode($0)) }
                    ?? NSNull()
                replyHandler(reply, nil)
            } catch {
                replyHandler(nil, "Device settings could not be read. Try again.")
            }
        }
    }

    func confirm(_ consent: DeviceSettingsConsent) async -> Bool {
        guard !Task.isCancelled, self.consentAlert == nil,
              let window = self.owner?.window, self.owner?.isWindowOpen == true,
              window.attachedSheet == nil
        else { return false }
        let alert = NSAlert()
        alert.alertStyle = .warning
        alert.messageText = consent.message
        alert.informativeText = consent.detail
        alert.addButton(withTitle: String(localized: "Cancel")).keyEquivalent = "\r"
        alert.addButton(withTitle: String(localized: "Allow")).keyEquivalent = ""
        self.consentAlert = alert
        defer { self.consentAlert = nil }
        let response = await alert.beginSheetModal(for: window)
        return !Task.isCancelled && response == .alertSecondButtonReturn
    }

    func refresh(refreshAvailability: Bool = false) {
        guard !self.observers.isEmpty else { return }
        self.refreshTask?.cancel()
        self.refreshTask = Task { [weak self] in
            guard !Task.isCancelled, let self else { return }
            await self.owner?.publishDeviceSettings()
            if refreshAvailability, !Task.isCancelled {
                await BrowserProfileImportModel.shared.refreshAvailability()
                guard !Task.isCancelled else { return }
                await self.owner?.publishDeviceSettings()
            }
        }
    }

    private func observeBrowserChanges() {
        let generation = self.observationGeneration
        withObservationTracking {
            _ = CookieSyncManager.shared.state
            _ = CookieSyncManager.shared.lastSummary
            _ = BrowserProfileImportModel.shared.importAvailable
            _ = AppStateStore.shared.connectionMode
        } onChange: { [weak self] in
            Task { @MainActor [weak self] in
                guard let self, self.observationGeneration == generation else { return }
                self.refresh()
                self.observeBrowserChanges()
            }
        }
    }
}
