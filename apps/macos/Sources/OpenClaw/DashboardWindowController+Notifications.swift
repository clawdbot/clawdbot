import Foundation
import OpenClawProtocol
import UserNotifications
import WebKit

enum DashboardNotificationsRequest: String {
    case status
    case requestPermission = "request-permission"
    case sendTest = "send-test"
    case preferencesGet = "preferences-get"
    case preferencesSet = "preferences-set"

    var startsAttempt: Bool {
        self == .requestPermission || self == .sendTest
    }
}

@MainActor
struct DashboardNotificationsState {
    var permission = "unknown"
    var testOutcome: TestNotificationOutcome?
    var documentGeneration: UInt64 = 0
    var requests: [UUID: Task<Void, Never>] = [:]

    mutating func invalidateDocument() {
        self.documentGeneration &+= 1
        if self.testOutcome == .pending {
            self.testOutcome = .error("The notification test was interrupted. Send another test.")
        }
        // Cancellation reaches GatewayChannel's send gate even during an actor
        // hop after the document predicate was checked by the bridge owner.
        for request in self.requests.values {
            request.cancel()
        }
        self.requests.removeAll()
    }
}

struct DashboardNotificationsSnapshot: Encodable, Equatable {
    let permission: String
    var test: TestNotificationOutcome?
    var supported = false
    var preferences: [String: AnyCodable]?
    var error: String?
    var replyTo: String?
}

@MainActor
final class DashboardNotificationsMessageHandler: NSObject, WKScriptMessageHandler {
    weak var owner: DashboardWindowController?
    private var statusObserver: NSObjectProtocol?

    override init() {
        super.init()
        self.statusObserver = NotificationCenter.default.addObserver(
            forName: NativeGatewayNotifications.statusDidChange, object: nil, queue: .main)
        { [weak self] notification in
            guard let binding = notification.object as? NativeGatewayNotifications.Binding else { return }
            Task { @MainActor [weak self] in
                await self?.owner?.publishNotificationStatus(binding: binding)
            }
        }
    }

    @MainActor deinit {
        if let statusObserver { NotificationCenter.default.removeObserver(statusObserver) }
    }

    func userContentController(_: WKUserContentController, didReceive message: WKScriptMessage) {
        self.owner?.receiveNotificationsMessage(message)
    }
}

extension DashboardWindowController {
    static let notificationsMessageHandlerName = "openclawNotifications"
    static let nativeNotificationsCapabilityScript = """
    window.__OPENCLAW_NATIVE_WEB_CHROME__ = true;
    (() => {
      const document = String(Date.now()) + ':' + Math.random().toString(36);
      const handler = window.webkit.messageHandlers.openclawNotifications;
      Object.defineProperty(window, '__OPENCLAW_NATIVE_NOTIFICATIONS_DOCUMENT__', {value: document});
      Object.defineProperty(window, '__OPENCLAW_NATIVE_NOTIFICATIONS_BRIDGE__', {
        value: Object.freeze({postMessage(message) { handler.postMessage({...message, document}); }})
      });
    })();
    """

    static func notificationsRequest(from body: Any) -> DashboardNotificationsRequest? {
        guard let payload = body as? [String: Any],
              let type = payload["type"] as? String
        else { return nil }
        return DashboardNotificationsRequest(rawValue: type)
    }

    static func notificationsRequestID(from body: Any) -> String? {
        guard let payload = body as? [String: Any], let id = payload["requestId"] as? String,
              !id.isEmpty, id.utf16.count <= 64
        else { return nil }
        return id
    }

    static func notificationsDocumentID(from body: Any) -> String? {
        guard let payload = body as? [String: Any], let document = payload["document"] as? String,
              !document.isEmpty, document.utf16.count <= 64
        else { return nil }
        return document
    }

    static func notificationsPreferenceParams(from body: Any) -> [String: AnyCodable]? {
        guard let payload = body as? [String: Any],
              let scope = payload["scope"] as? String, scope == "user" || scope == "device",
              let preferences = payload["preferences"] as? [String: Any],
              JSONSerialization.isValidJSONObject(preferences),
              let data = try? JSONSerialization.data(withJSONObject: preferences), data.count <= 16384,
              let decoded = try? JSONDecoder().decode([String: AnyCodable].self, from: data)
        else { return nil }
        return ["scope": AnyCodable(scope), "preferences": AnyCodable(decoded)]
    }

    static func notificationsPermissionLabel(for status: UNAuthorizationStatus) -> String {
        switch status {
        case .authorized, .provisional: "granted"
        case .denied: "denied"
        case .notDetermined: "notDetermined"
        default: "notDetermined"
        }
    }

    private func notificationDocumentCurrentness() -> @MainActor () -> Bool {
        let sourceURL = self.currentURL
        let sourceAuth = self.auth
        let generation = self.notificationState.documentGeneration
        return { [weak self] in
            guard let self else { return false }
            return !Task.isCancelled && self.isWindowOpen && self.currentURL == sourceURL &&
                self.auth == sourceAuth && self.notificationState.documentGeneration == generation
        }
    }

    private func requestNotificationPermission(isCurrent: @MainActor () -> Bool) async {
        _ = await PermissionManager.ensureNotifications(interactive: true, isCurrent: isCurrent)
        guard isCurrent() else { return }
        NotificationCenter.default.post(name: .openclawPermissionsChanged, object: nil)
    }

    private func sendTestNotification(
        binding: NativeGatewayNotifications.Binding,
        isCurrent: @MainActor () -> Bool) async throws
    {
        self.notificationState.testOutcome = .pending
        _ = try await NativeGatewayNotifications.shared.perform(
            binding: binding, method: "notifications.test", isCurrent: isCurrent)
        guard isCurrent() else { return }
        self.notificationState.testOutcome = .sent
    }

    func receiveNotificationsMessage(_ message: WKScriptMessage) {
        guard message.name == Self.notificationsMessageHandlerName,
              message.webView === self.webView,
              message.frameInfo.isMainFrame,
              Self.isTrustedLinkSource(message.frameInfo.request.url, dashboardURL: self.currentURL),
              let request = Self.notificationsRequest(from: message.body),
              let document = Self.notificationsDocumentID(from: message.body)
        else { return }
        let replyTo = Self.notificationsRequestID(from: message.body)
        if let payload = message.body as? [String: Any], payload["requestId"] != nil, replyTo == nil { return }
        let preferenceParams = Self.notificationsPreferenceParams(from: message.body)
        let isCurrent = self.notificationDocumentCurrentness()
        let taskID = UUID()
        self.notificationState.requests[taskID] = Task {
            defer { self.notificationState.requests[taskID] = nil }
            guard let currentDocument = try? await self.webView.evaluateJavaScript(
                "window.__OPENCLAW_NATIVE_NOTIFICATIONS_DOCUMENT__") as? String,
                currentDocument == document, isCurrent()
            else { return }
            var actionError: String?
            let binding: NativeGatewayNotifications.Binding?
            do {
                guard let target = self.notificationTarget else {
                    throw NativeGatewayNotifications.ConnectionError.unavailable
                }
                binding = try await NativeGatewayNotifications.shared.bind(target: target)
            } catch {
                binding = nil
                actionError = error.localizedDescription
            }
            guard isCurrent() else { return }
            if let binding, request.startsAttempt {
                NativeGatewayNotifications.shared.beginAttempt(binding: binding)
            }
            if request == .requestPermission {
                await self.requestNotificationPermission(isCurrent: isCurrent)
            }
            guard isCurrent() else { return }
            if PermissionManager.notificationCenterAvailable {
                let settings = await UNUserNotificationCenter.current().notificationSettings()
                self.notificationState.permission = Self.notificationsPermissionLabel(for: settings.authorizationStatus)
            } else {
                self.notificationState.permission = "unknown"
            }
            guard isCurrent() else { return }
            let status: NativeGatewayNotifications.Status
            if let binding {
                do {
                    switch request {
                    case .preferencesSet:
                        guard let preferenceParams else {
                            throw NSError(domain: "OpenClawNotifications", code: 1, userInfo: [
                                NSLocalizedDescriptionKey:
                                    "Invalid notification preferences. Reload Settings and retry.",
                            ])
                        }
                        _ = try await NativeGatewayNotifications.shared.perform(
                            binding: binding,
                            method: "notifications.preferences.set",
                            params: preferenceParams,
                            isCurrent: isCurrent)
                    case .sendTest:
                        try await self.sendTestNotification(binding: binding, isCurrent: isCurrent)
                    case .status, .requestPermission, .preferencesGet: break
                    }
                } catch {
                    actionError = error.localizedDescription
                }
                status = await NativeGatewayNotifications.shared.status(binding: binding, isCurrent: isCurrent)
            } else {
                status = NativeGatewayNotifications.Status(
                    supported: false, preferences: nil, error: actionError, errorRevision: 0)
            }
            guard isCurrent() else { return }
            if let error = actionError ?? status.error, request == .sendTest {
                self.notificationState.testOutcome = .error(error)
            }
            let snapshot = DashboardNotificationsSnapshot(
                permission: self.notificationState.permission,
                test: self.notificationState.testOutcome,
                supported: status.supported,
                preferences: status.preferences,
                error: actionError ?? status.error,
                replyTo: replyTo)
            await self.publishNotificationsStatus(snapshot, document: document, errorRevision: status.errorRevision)
        }
    }

    func publishNotificationStatus(binding: NativeGatewayNotifications.Binding) async {
        guard let target = self.notificationTarget,
              NativeGatewayNotifications.shared.isCurrent(binding, target: target)
        else { return }
        let isCurrent = self.notificationDocumentCurrentness()
        guard let document = try? await self.webView.evaluateJavaScript(
            "window.__OPENCLAW_NATIVE_NOTIFICATIONS_DOCUMENT__") as? String
        else { return }
        let status = await NativeGatewayNotifications.shared.status(binding: binding, isCurrent: isCurrent)
        guard isCurrent(),
              NativeGatewayNotifications.shared.isCurrent(binding, target: target)
        else { return }
        if let error = status.error {
            self.notificationState.testOutcome = .error(error)
        }
        let snapshot = DashboardNotificationsSnapshot(
            permission: self.notificationState.permission,
            test: self.notificationState.testOutcome,
            supported: status.supported,
            preferences: status.preferences,
            error: status.error)
        await self.publishNotificationsStatus(snapshot, document: document, errorRevision: status.errorRevision)
    }

    private func publishNotificationsStatus(
        _ snapshot: DashboardNotificationsSnapshot,
        document: String,
        errorRevision: UInt64) async
    {
        guard let data = try? JSONEncoder().encode(snapshot),
              let json = String(data: data, encoding: .utf8) else { return }
        _ = try? await self.webView.evaluateJavaScript(
            """
            if (window.__OPENCLAW_NATIVE_NOTIFICATIONS_DOCUMENT__ === \(Self.jsStringLiteral(document))) {
              const next = \(json);
              if ((window.__OPENCLAW_NATIVE_NOTIFICATIONS_ERROR_REVISION__ ?? 0) > \(errorRevision)) {
                const current = window.__OPENCLAW_NATIVE_NOTIFICATIONS__;
                next.error = current?.error ?? null;
                next.test = current?.test ?? null;
              } else {
                window.__OPENCLAW_NATIVE_NOTIFICATIONS_ERROR_REVISION__ = \(errorRevision);
              }
              window.__OPENCLAW_NATIVE_NOTIFICATIONS__ = next;
              window.dispatchEvent(new CustomEvent('openclaw:native-notifications-status', {detail:next}));
            }
            """)
    }
}
