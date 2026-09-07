import Foundation
import Observation
import OpenClawKit
import UIKit
import UserNotifications
import WebKit

@MainActor
final class IOSDeviceSettingsBridge: NSObject, WKScriptMessageHandlerWithReply {
    private typealias RequestIdentity = IOSDeviceSettingsDocument.RequestIdentity
    static let messageHandlerName = "openclawDeviceSettings"

    private let appModel: NodeAppModel
    private let appearanceModel: AppAppearanceModel
    private let gatewayController: GatewayConnectionController
    private let openPanel: (DeviceSettingsPanel) -> Void
    private let onStatusRequest: (() -> Void)?
    private let producer: IOSDeviceSettingsSnapshotProducer
    private let permissions = IOSDeviceSettingsPermissions()
    private let requests = IOSDeviceSettingsRequestQueue()
    private let consent = IOSDeviceSettingsConsentPresenter()
    private weak var webView: WKWebView?
    private var gatewayURL: URL?
    private var connection: GatewayConnectConfig?
    private var document = IOSDeviceSettingsDocument()
    private var observedAuthorityGeneration: UInt64 = 0
    private var notificationStatus: UNAuthorizationStatus?
    private var locationServicesEnabled: Bool?
    private var locationAvailabilityTask: Task<Void, Never>?
    private var observers: [NSObjectProtocol] = []
    private var observationID = UUID()
    private var refreshTask: Task<Void, Never>?
    private var updateUserScripts: (() -> Void)?

    init(
        appModel: NodeAppModel,
        appearanceModel: AppAppearanceModel,
        gatewayController: GatewayConnectionController,
        openPanel: @escaping (DeviceSettingsPanel) -> Void,
        onStatusRequest: (() -> Void)? = nil)
    {
        self.appModel = appModel
        self.appearanceModel = appearanceModel
        self.gatewayController = gatewayController
        self.openPanel = openPanel
        self.onStatusRequest = onStatusRequest
        self.producer = IOSDeviceSettingsSnapshotProducer(appModel: appModel, appearanceModel: appearanceModel)
    }

    func attach(to webView: WKWebView, updateUserScripts: @escaping () -> Void) {
        self.detach()
        self.webView = webView
        self.connection = self.appModel.activeGatewayConnectConfig
        self.observedAuthorityGeneration = self.appModel.operatorAuthorityGeneration
        self.gatewayURL = AuthenticatedControlUI.pageURL(config: self.connection, path: "", queryItems: [])
        self.updateUserScripts = updateUserScripts
        let center = NotificationCenter.default
        for name in [
            UIApplication.didBecomeActiveNotification,
            UIScene.didActivateNotification,
            UserDefaults.didChangeNotification,
        ] {
            self.observers.append(center.addObserver(forName: name, object: nil, queue: .main) { [weak self] _ in
                Task { @MainActor [weak self] in
                    if name != UserDefaults.didChangeNotification { self?.refreshLocationAvailability() }
                    self?.refresh()
                }
            })
        }
        self.observeOwners()
        self.refreshLocationAvailability()
    }

    func detach() {
        self.retireDocument()
        self.observationID = UUID()
        self.locationAvailabilityTask?.cancel()
        self.locationAvailabilityTask = nil
        self.locationServicesEnabled = nil
        for observer in self.observers {
            NotificationCenter.default.removeObserver(observer)
        }
        self.observers.removeAll()
        self.webView = nil
        self.connection = nil
        self.gatewayURL = nil
        self.updateUserScripts = nil
    }

    func detach(from webView: WKWebView) {
        guard self.webView === webView else { return }
        self.detach()
    }

    func retireDocument(in webView: WKWebView) {
        guard self.webView === webView else { return }
        self.retireDocument()
    }

    func retireDocument() {
        self.document.retire()
        self.cancelRequests()
    }

    func willNavigate(in webView: WKWebView) {
        guard self.webView === webView else { return }
        self.document.startNavigation()
        self.cancelRequests()
    }

    func didFailProvisionalNavigation(in webView: WKWebView) {
        guard self.webView === webView else { return }
        self.document.failProvisionalNavigation()
        self.cancelRequests()
        self.refresh()
    }

    private func cancelRequests() {
        self.requests.cancel()
        self.consent.cancel()
        self.refreshTask?.cancel()
        self.refreshTask = nil
    }

    func didCommitDocument(in webView: WKWebView) {
        guard self.webView === webView else { return }
        self.document.commitNavigation()
        self.refresh()
    }

    func seedScript(for url: URL) -> String? {
        guard self.appModel.isOperatorGatewayConnected, self.appModel.hasOperatorAdminScope,
              !self.appModel.isAppleReviewDemoModeEnabled, !self.appModel.isScreenshotFixtureModeEnabled,
              self.webView == nil || self.hasCurrentOperator(),
              let script = try? self.producer.snapshot(
                  notificationStatus: self.notificationStatus,
                  locationServicesEnabled: self.locationServicesEnabled).javaScript()
        else {
            return nil
        }
        return Self.originGatedScript(script, url: url)
    }

    static func originGatedScript(_ script: String, url: URL) -> String? {
        guard let authority = GatewayTLSAuthority(url: url),
              let data = try? JSONEncoder().encode(authority.serialized),
              let origin = String(data: data, encoding: .utf8)
        else { return nil }
        return "(() => { if (location.origin !== \(origin)) return; \(script) })();"
    }

    static func isTrustedSource(
        _ sourceURL: URL?,
        webViewURL: URL?,
        gatewayURL: URL?,
        isMainFrame: Bool,
        isHostingWebView: Bool) -> Bool
    {
        guard isMainFrame, isHostingWebView, let sourceURL, let webViewURL, let gatewayURL,
              let authority = GatewayTLSAuthority(url: gatewayURL),
              GatewayTLSAuthority(url: sourceURL) == authority,
              GatewayTLSAuthority(url: webViewURL) == authority
        else { return false }
        let basePath = gatewayURL.path(percentEncoded: true).trimmingCharacters(in: CharacterSet(charactersIn: "/"))
        guard !basePath.isEmpty else { return true }
        let prefix = "/" + basePath
        return [sourceURL, webViewURL].allSatisfy {
            $0.path(percentEncoded: true) == prefix || $0.path(percentEncoded: true).hasPrefix(prefix + "/")
        }
    }

    func userContentController(
        _: WKUserContentController,
        didReceive message: WKScriptMessage,
        replyHandler: @escaping @MainActor (Any?, String?) -> Void)
    {
        guard message.name == Self.messageHandlerName,
              Self.isTrustedSource(
                  message.frameInfo.request.url,
                  webViewURL: self.webView?.url,
                  gatewayURL: self.gatewayURL,
                  isMainFrame: message.frameInfo.isMainFrame,
                  isHostingWebView: message.webView === self.webView),
              let request = DeviceSettingsRequest(body: message.body)
        else {
            replyHandler(nil, "Invalid device settings request.")
            return
        }
        self.synchronizeRequestAuthority()
        let sourceID = self.document.requestIdentity(authorityGeneration: self.appModel.operatorAuthorityGeneration)
        let reply = IOSDeviceSettingsReply(replyHandler)
        guard self.isCurrent(sourceID) else {
            reply.retire()
            return
        }
        if request == .status { self.onStatusRequest?() }
        self.requests.enqueue(operation: { [weak self] in
            guard let self, self.isCurrent(sourceID) else {
                reply.retire()
                return
            }
            do {
                let registrationChanged = try await self.apply(request, sourceID: sourceID)
                defer {
                    // Committed settings belong to the device; permission results retain their document's authority.
                    // Reply first because registration can reconnect the operator.
                    var needsRegistrationRefresh = registrationChanged
                    if case .requestPermission = request {
                        needsRegistrationRefresh = needsRegistrationRefresh && self.isCurrent(sourceID)
                    }
                    if needsRegistrationRefresh {
                        self.gatewayController.refreshActiveGatewayRegistrationFromSettings()
                    }
                }
                guard let snapshot = await self.readSnapshot(sourceID: sourceID) else {
                    reply.retire()
                    return
                }
                await self.publish(snapshot, sourceID: sourceID)
                guard self.isCurrent(sourceID) else {
                    reply.retire()
                    return
                }
                if case .set = request {
                    try reply.finish(JSONSerialization.jsonObject(with: JSONEncoder().encode(snapshot)))
                } else {
                    reply.finish(NSNull())
                }
            } catch {
                guard self.isCurrent(sourceID) else {
                    reply.retire()
                    return
                }
                self.refresh()
                reply.finish(error: "Device settings could not be updated. Try again.")
            }
        }, onCancel: { reply.retire() })
    }

    private func isCurrent(_ sourceID: RequestIdentity) -> Bool {
        guard !Task.isCancelled,
              self.document.accepts(sourceID, authorityGeneration: self.appModel.operatorAuthorityGeneration),
              self.hasCurrentOperator(), let webView
        else { return false }
        return Self.isTrustedSource(
            webView.url,
            webViewURL: webView.url,
            gatewayURL: self.gatewayURL,
            isMainFrame: true,
            isHostingWebView: true)
    }

    private func hasCurrentOperator() -> Bool {
        guard self.appModel.isOperatorGatewayConnected, self.appModel.hasOperatorAdminScope,
              !self.appModel.isAppleReviewDemoModeEnabled, !self.appModel.isScreenshotFixtureModeEnabled,
              let connection, let current = self.appModel.activeGatewayConnectConfig
        else { return false }
        return connection.hasSameControlUIInputs(as: current)
    }

    private func apply(_ request: DeviceSettingsRequest, sourceID: RequestIdentity) async throws -> Bool {
        let isCurrent: @MainActor @Sendable () -> Bool = { [weak self] in self?.isCurrent(sourceID) == true }
        switch request {
        case .status:
            self.refreshLocationAvailability()
        case .checkForUpdates, .installChromeExtension:
            break
        case let .set(key, value):
            return try await self.set(key, value: value, sourceID: sourceID)
        case let .requestPermission(permission):
            switch permission {
            case .notifications:
                _ = await IOSDeviceSettingsActions.requestNotificationPermission(
                    confirmDisclosure: { await self.confirm(.notificationEnrollment) },
                    isCurrent: isCurrent)
                return false
            case .location:
                let mode = self.locationMode == .off ? .whileUsing : self.locationMode
                _ = await self.appModel.requestLocationPermissions(mode: mode, isCurrent: isCurrent)
                return true
            default:
                try await self.permissions.request(permission, isCurrent: isCurrent)
                return [.camera, .microphone, .speechRecognition, .contacts, .calendars, .reminders, .photos]
                    .contains(permission)
            }
        case .openSystemSettings:
            if let url = URL(string: UIApplication.openSettingsURLString) { await UIApplication.shared.open(url) }
        case let .open(panel):
            switch panel {
            case .connection, .gateways, .watch, .diagnostics, .licenses, .about: self.openPanel(panel)
            default: break
            }
        }
        return false
    }

    private var locationMode: OpenClawLocationMode {
        UserDefaults.standard.string(forKey: "location.enabledMode")
            .flatMap(OpenClawLocationMode.init(rawValue:)) ?? .off
    }

    private func set(
        _ key: DeviceSettingKey,
        value: DeviceSettingValue,
        sourceID: RequestIdentity) async throws -> Bool
    {
        let required = IOSDeviceSettingsConsent.required(for: key, value: value, locationMode: self.locationMode)
        if let required {
            guard await self.confirm(required) else { return false }
        }
        guard self.isCurrent(sourceID),
              IOSDeviceSettingsConsent.required(for: key, value: value, locationMode: self.locationMode) == required
        else { return false }
        let isCurrent: @MainActor () -> Bool = { [weak self] in self?.isCurrent(sourceID) == true }
        switch (key, value) {
        case let (.appearance, .string(raw)):
            if let preference = AppAppearancePreference(rawValue: raw) { self.appearanceModel.select(preference) }
        case let (.notificationsEnabled, .boolean(enabled)):
            _ = await IOSDeviceSettingsActions.setNotificationsEnabled(
                enabled, confirmDisclosure: { await self.confirm(.notificationEnrollment) }, isCurrent: isCurrent)
        case let (.cameraEnabled, .boolean(enabled)):
            UserDefaults.standard.set(enabled, forKey: "camera.enabled")
            return true
        case let (.keepAwakeEnabled, .boolean(enabled)):
            UserDefaults.standard.set(enabled, forKey: "screen.preventSleep")
        case let (.healthSummaryEnabled, .boolean(enabled)):
            if enabled {
                try await HealthAuthorization.enable(isCurrent: isCurrent)
            } else {
                HealthAuthorization.disable()
            }
            return true
        case let (.wakeEnabled, .boolean(enabled)): self.appModel.setVoiceWakeEnabled(enabled)
        case let (.talkEnabled, .boolean(enabled)): self.appModel.setTalkEnabled(enabled)
        case let (.talkButtonEnabled, .boolean(enabled)):
            UserDefaults.standard.set(enabled, forKey: "talk.button.enabled")
        case let (.talkBackgroundEnabled, .boolean(enabled)):
            UserDefaults.standard.set(enabled, forKey: "talk.background.enabled")
        case let (.speakerphoneEnabled, .boolean(enabled)): self.appModel.setTalkSpeakerphoneEnabled(enabled)
        case let (.locationMode, .string(raw)):
            guard let mode = DeviceSettingsLocationMode(rawValue: raw) else { return false }
            return await IOSDeviceSettingsActions.applyLocationMode(
                mode.nativeMode,
                appModel: self.appModel,
                isCurrent: isCurrent)
        default:
            // Precision is system-owned on iOS; unsupported platform settings only republish current state.
            break
        }
        return false
    }

    private func confirm(_ request: IOSDeviceSettingsConsent) async -> Bool {
        await self.consent.confirm(request, from: self.webView)
    }

    private func readSnapshot(sourceID: RequestIdentity) async -> DeviceSettingsSnapshot? {
        guard self.isCurrent(sourceID) else { return nil }
        let settings = await UNUserNotificationCenter.current().notificationSettings()
        guard self.isCurrent(sourceID) else { return nil }
        self.notificationStatus = settings.authorizationStatus
        return self.producer.snapshot(
            notificationStatus: self.notificationStatus,
            locationServicesEnabled: self.locationServicesEnabled)
    }

    private func publish(_ snapshot: DeviceSettingsSnapshot, sourceID: RequestIdentity) async {
        guard self.isCurrent(sourceID), let script = try? snapshot.javaScript(), let webView else { return }
        self.updateUserScripts?()
        _ = try? await webView.evaluateJavaScript(script)
    }

    private func synchronizeRequestAuthority() {
        let generation = self.appModel.operatorAuthorityGeneration
        guard generation != self.observedAuthorityGeneration else { return }
        self.observedAuthorityGeneration = generation
        self.document.invalidateRequests()
        self.cancelRequests()
    }

    private func refreshLocationAvailability() {
        guard self.webView != nil, self.locationAvailabilityTask == nil else { return }
        let observationID = self.observationID
        // Slow system facts must not hold document creation or serialized request replies.
        self.locationAvailabilityTask = Task { [weak self] in
            let enabled = await LocationService.servicesEnabled()
            guard let self, !Task.isCancelled, self.observationID == observationID else { return }
            self.locationAvailabilityTask = nil
            self.locationServicesEnabled = enabled
            self.refresh()
        }
    }

    private func refresh() {
        self.synchronizeRequestAuthority()
        guard self.hasCurrentOperator() else {
            self.updateUserScripts?()
            return
        }
        self.refreshTask?.cancel()
        let sourceID = self.document.requestIdentity(authorityGeneration: self.appModel.operatorAuthorityGeneration)
        self.refreshTask = Task { [weak self] in
            guard let self, let snapshot = await self.readSnapshot(sourceID: sourceID) else { return }
            await self.publish(snapshot, sourceID: sourceID)
        }
    }

    private func observeOwners() {
        let observationID = self.observationID
        let locationAuthorization = self.appModel.locationAuthorizationSnapshot
        withObservationTracking {
            _ = self.appearanceModel.preference
            _ = self.appModel.locationAuthorizationSnapshot
            _ = self.appModel.voiceWake.isEnabled
            _ = self.appModel.talkMode.isEnabled
            _ = self.appModel.isOperatorGatewayConnected
            _ = self.appModel.hasOperatorAdminScope
            _ = self.appModel.activeGatewayConnectConfig
        } onChange: { [weak self] in
            Task { @MainActor [weak self] in
                guard let self, self.observationID == observationID, self.webView != nil else { return }
                if self.appModel.locationAuthorizationSnapshot != locationAuthorization {
                    self.refreshLocationAvailability()
                }
                self.refresh()
                self.observeOwners()
            }
        }
    }

    isolated deinit { self.detach() }
}
