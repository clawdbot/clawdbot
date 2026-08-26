import AppKit
import ApplicationServices
import AVFoundation
import CoreGraphics
import CoreLocation
import Foundation
import Observation
import OpenClawIPC
import Speech
import UserNotifications

extension Notification.Name {
    static let openclawPermissionsChanged = Notification.Name("openclaw.permissions.changed")
}

enum CapabilityAuthorizationStatus: Equatable, Sendable {
    case granted
    case notGranted
    case unknown

    var isGranted: Bool {
        self == .granted
    }
}

enum PermissionManager {
    /// UNUserNotificationCenter.current() aborts with NSInternalInconsistencyException
    /// ("bundleProxyForCurrentProcess is nil") in unbundled processes such as
    /// `swift build` dev binaries. Every notification-center call must check this
    /// first so unbundled invocations degrade to not-granted instead of crashing.
    static var notificationCenterAvailable: Bool {
        Bundle.main.bundleIdentifier != nil
    }

    static func isNotificationAuthorized(status: UNAuthorizationStatus) -> Bool {
        status == .authorized || status == .provisional
    }

    static func shouldOpenSpeechRecognitionSettings(
        status: SFSpeechRecognizerAuthorizationStatus,
        interactive: Bool) -> Bool
    {
        interactive && (status == .denied || status == .restricted)
    }

    static func isLocationAuthorized(status: CLAuthorizationStatus, requireAlways: Bool) -> Bool {
        if requireAlways { return status == .authorizedAlways }
        switch status {
        case .authorizedAlways, .authorizedWhenInUse:
            return true
        case .authorized: // deprecated, but still shows up on some macOS versions
            return true
        default:
            return false
        }
    }

    static func ensure(_ caps: [Capability], interactive: Bool) async -> [Capability: Bool] {
        var results: [Capability: Bool] = [:]
        for cap in caps {
            results[cap] = await self.ensureCapability(cap, interactive: interactive)
        }
        if interactive {
            await MainActor.run {
                NotificationCenter.default.post(name: .openclawPermissionsChanged, object: nil)
            }
        }
        return results
    }

    private static func ensureCapability(_ cap: Capability, interactive: Bool) async -> Bool {
        switch cap {
        case .notifications:
            await self.ensureNotifications(interactive: interactive)
        case .appleScript:
            await self.ensureAppleScript(interactive: interactive)
        case .accessibility:
            await self.ensureAccessibility(interactive: interactive)
        case .screenRecording:
            await self.ensureScreenRecording(interactive: interactive)
        case .microphone:
            await self.ensureMicrophone(interactive: interactive)
        case .speechRecognition:
            await self.ensureSpeechRecognition(interactive: interactive)
        case .camera:
            await self.ensureCamera(interactive: interactive)
        case .location:
            await self.ensureLocation(interactive: interactive)
        }
    }

    private static func ensureNotifications(interactive: Bool) async -> Bool {
        guard self.notificationCenterAvailable else { return false }
        let center = UNUserNotificationCenter.current()
        let settings = await center.notificationSettings()
        if self.isNotificationAuthorized(status: settings.authorizationStatus) {
            return true
        }
        if settings.authorizationStatus == .notDetermined {
            guard interactive else { return false }
            let granted = await (try? center.requestAuthorization(options: [.alert, .sound, .badge])) ?? false
            let updated = await center.notificationSettings()
            return granted && self.isNotificationAuthorized(status: updated.authorizationStatus)
        }
        if settings.authorizationStatus == .denied, interactive {
            SystemSettingsURLSupport.openFirst([
                "x-apple.systempreferences:com.apple.Notifications-Settings.extension",
                "x-apple.systempreferences:com.apple.preference.notifications",
            ])
        }
        return false
    }

    private static func ensureAppleScript(interactive: Bool) async -> Bool {
        if interactive {
            return await TerminalAutomationPermission.requestAuthorization()
        }
        return await TerminalAutomationPermission.isAuthorized()
    }

    private static func ensureAccessibility(interactive: Bool) async -> Bool {
        let trusted = await MainActor.run { AXIsProcessTrusted() }
        if interactive, !trusted {
            await MainActor.run {
                let opts: NSDictionary = ["AXTrustedCheckOptionPrompt": true]
                _ = AXIsProcessTrustedWithOptions(opts)
            }
        }
        return await MainActor.run { AXIsProcessTrusted() }
    }

    private static func ensureScreenRecording(interactive: Bool) async -> Bool {
        let granted = ScreenRecordingProbe.isAuthorized()
        if interactive, !granted {
            await ScreenRecordingProbe.requestAuthorization()
        }
        return ScreenRecordingProbe.isAuthorized()
    }

    private static func ensureMicrophone(interactive: Bool) async -> Bool {
        let status = AVCaptureDevice.authorizationStatus(for: .audio)
        switch status {
        case .authorized:
            return true
        case .notDetermined:
            guard interactive else { return false }
            return await AVCaptureDevice.requestAccess(for: .audio)
        case .denied, .restricted:
            if interactive {
                SystemSettingsURLSupport.openPrivacySettings(for: .microphone)
            }
            return false
        @unknown default:
            return false
        }
    }

    private static func ensureSpeechRecognition(interactive: Bool) async -> Bool {
        let status = SFSpeechRecognizer.authorizationStatus()
        if self.shouldOpenSpeechRecognitionSettings(status: status, interactive: interactive) {
            SystemSettingsURLSupport.openPrivacySettings(for: .speechRecognition)
        }
        if status == .notDetermined, interactive {
            await withUnsafeContinuation { (cont: UnsafeContinuation<Void, Never>) in
                SFSpeechRecognizer.requestAuthorization { _ in
                    DispatchQueue.main.async { cont.resume() }
                }
            }
        }
        return SFSpeechRecognizer.authorizationStatus() == .authorized
    }

    private static func ensureCamera(interactive: Bool) async -> Bool {
        let status = AVCaptureDevice.authorizationStatus(for: .video)
        switch status {
        case .authorized:
            return true
        case .notDetermined:
            guard interactive else { return false }
            return await AVCaptureDevice.requestAccess(for: .video)
        case .denied, .restricted:
            if interactive {
                SystemSettingsURLSupport.openPrivacySettings(for: .camera)
            }
            return false
        @unknown default:
            return false
        }
    }

    private static func ensureLocation(interactive: Bool) async -> Bool {
        guard CLLocationManager.locationServicesEnabled() else {
            if interactive {
                await MainActor.run { SystemSettingsURLSupport.openPrivacySettings(for: .location) }
            }
            return false
        }
        let status = await self.locationAuthorizationStatus()
        switch status {
        case .authorizedAlways, .authorizedWhenInUse, .authorized:
            return true
        case .notDetermined:
            guard interactive else { return false }
            let updated = await LocationPermissionRequester.shared.request(always: false)
            return self.isLocationAuthorized(status: updated, requireAlways: false)
        case .denied, .restricted:
            if interactive {
                await MainActor.run { SystemSettingsURLSupport.openPrivacySettings(for: .location) }
            }
            return false
        @unknown default:
            return false
        }
    }

    static func voiceWakePermissionsGranted() -> Bool {
        let mic = AVCaptureDevice.authorizationStatus(for: .audio) == .authorized
        let speech = SFSpeechRecognizer.authorizationStatus() == .authorized
        return mic && speech
    }

    static func locationAuthorizationStatus() async -> CLAuthorizationStatus {
        await LocationPermissionRequester.shared.authorizationStatus
    }

    static func ensureVoiceWakePermissions(interactive: Bool) async -> Bool {
        let results = await self.ensure([.microphone, .speechRecognition], interactive: interactive)
        return results[.microphone] == true && results[.speechRecognition] == true
    }

    static func authorizationStatus(
        _ caps: [Capability] = Capability.allCases) async -> [Capability: CapabilityAuthorizationStatus]
    {
        var results: [Capability: CapabilityAuthorizationStatus] = [:]
        for cap in caps {
            switch cap {
            case .notifications:
                guard self.notificationCenterAvailable else {
                    results[cap] = .notGranted
                    break
                }
                let center = UNUserNotificationCenter.current()
                let settings = await center.notificationSettings()
                results[cap] = self.isNotificationAuthorized(status: settings.authorizationStatus)
                    ? .granted : .notGranted

            case .appleScript:
                results[cap] = await TerminalAutomationPermission.authorizationStatus()

            case .accessibility:
                results[cap] = await MainActor.run { AXIsProcessTrusted() } ? .granted : .notGranted

            case .screenRecording:
                if #available(macOS 10.15, *) {
                    results[cap] = CGPreflightScreenCaptureAccess() ? .granted : .notGranted
                } else {
                    results[cap] = .granted
                }

            case .microphone:
                results[cap] = AVCaptureDevice.authorizationStatus(for: .audio) == .authorized
                    ? .granted : .notGranted

            case .speechRecognition:
                results[cap] = SFSpeechRecognizer.authorizationStatus() == .authorized
                    ? .granted : .notGranted

            case .camera:
                results[cap] = AVCaptureDevice.authorizationStatus(for: .video) == .authorized
                    ? .granted : .notGranted

            case .location:
                let status = await self.locationAuthorizationStatus()
                results[cap] = CLLocationManager.locationServicesEnabled()
                    && self.isLocationAuthorized(status: status, requireAlways: false) ? .granted : .notGranted
            }
        }
        return results
    }

    static func grantedStatus(_ caps: [Capability] = Capability.allCases) async -> [Capability: Bool] {
        let statuses = await self.authorizationStatus(caps)
        return statuses.mapValues(\.isGranted)
    }
}

@MainActor
final class LocationPermissionRequestCoordinator {
    private var continuations: [CheckedContinuation<CLAuthorizationStatus, Never>] = []

    var hasPendingRequests: Bool {
        !self.continuations.isEmpty
    }

    var pendingRequestCount: Int {
        self.continuations.count
    }

    func wait(onEnqueue: (_ isFirstRequest: Bool) -> Void) async -> CLAuthorizationStatus {
        await withCheckedContinuation { continuation in
            let isFirstRequest = self.continuations.isEmpty
            self.continuations.append(continuation)
            onEnqueue(isFirstRequest)
        }
    }

    func finish(status: CLAuthorizationStatus) {
        let continuations = self.continuations
        self.continuations.removeAll()
        for continuation in continuations {
            continuation.resume(returning: status)
        }
    }
}

@MainActor
final class LocationPermissionRequester: NSObject, CLLocationManagerDelegate {
    static let shared = LocationPermissionRequester()
    private let manager = CLLocationManager()
    private let requests = LocationPermissionRequestCoordinator()
    private var timeoutTask: Task<Void, Never>?
    private var requestedAlways = false

    override init() {
        super.init()
        self.manager.delegate = self
    }

    var authorizationStatus: CLAuthorizationStatus {
        // Core Location retains per-manager framework state, so status polling must reuse this process-lifetime owner.
        self.manager.authorizationStatus
    }

    func request(always: Bool) async -> CLAuthorizationStatus {
        let current = self.manager.authorizationStatus
        if PermissionManager.isLocationAuthorized(status: current, requireAlways: always) {
            return current
        }

        return await self.requests.wait { isFirstRequest in
            if isFirstRequest {
                self.requestedAlways = always
                self.scheduleTimeout()
                self.requestAuthorization(always: always)
                // On macOS, requesting an actual fix makes the prompt more reliable.
                self.manager.requestLocation()
            } else if always, !self.requestedAlways {
                self.requestedAlways = true
                self.manager.requestAlwaysAuthorization()
            }
        }
    }

    private func requestAuthorization(always: Bool) {
        if always {
            self.manager.requestAlwaysAuthorization()
        } else {
            self.manager.requestWhenInUseAuthorization()
        }
    }

    private func scheduleTimeout() {
        self.timeoutTask?.cancel()
        self.timeoutTask = Task { [weak self] in
            do {
                try await Task.sleep(nanoseconds: 3_000_000_000)
            } catch {
                return
            }
            guard !Task.isCancelled, let self, self.requests.hasPendingRequests else { return }
            SystemSettingsURLSupport.openPrivacySettings(for: .location)
            self.finish(status: self.manager.authorizationStatus)
        }
    }

    private func finish(status: CLAuthorizationStatus) {
        self.timeoutTask?.cancel()
        self.timeoutTask = nil
        self.requestedAlways = false
        self.requests.finish(status: status)
    }

    /// nonisolated for Swift 6 strict concurrency compatibility
    nonisolated func locationManagerDidChangeAuthorization(_ manager: CLLocationManager) {
        let status = manager.authorizationStatus
        Task { @MainActor in
            self.finish(status: status)
        }
    }

    /// Legacy callback (still used on some macOS versions / configurations).
    nonisolated func locationManager(
        _ manager: CLLocationManager,
        didChangeAuthorization status: CLAuthorizationStatus)
    {
        Task { @MainActor in
            self.finish(status: status)
        }
    }

    nonisolated func locationManager(_ manager: CLLocationManager, didFailWithError error: Error) {
        let status = manager.authorizationStatus
        Task { @MainActor in
            if status == .denied || status == .restricted {
                SystemSettingsURLSupport.openPrivacySettings(for: .location)
            }
            self.finish(status: status)
        }
    }

    nonisolated func locationManager(_ manager: CLLocationManager, didUpdateLocations locations: [CLLocation]) {
        let status = manager.authorizationStatus
        Task { @MainActor in
            self.finish(status: status)
        }
    }
}

@MainActor
@Observable
final class PermissionMonitor {
    static let shared = PermissionMonitor()

    private(set) var status: [Capability: CapabilityAuthorizationStatus] = [:]

    private var monitorTimer: Timer?
    private var isChecking = false
    private var registrations = 0
    private var lastCheck: Date?
    private let minimumCheckInterval: TimeInterval = 0.5

    func register() {
        self.registrations += 1
        if self.registrations == 1 {
            self.startMonitoring()
        }
    }

    func unregister() {
        guard self.registrations > 0 else { return }
        self.registrations -= 1
        if self.registrations == 0 {
            self.stopMonitoring()
        }
    }

    func refreshNow() async {
        await self.checkStatus(force: true)
    }

    private func startMonitoring() {
        Task { await self.checkStatus(force: true) }

        if ProcessInfo.processInfo.isRunningTests { return }
        self.monitorTimer = Timer.scheduledTimer(withTimeInterval: 1.0, repeats: true) { [weak self] _ in
            guard let self else { return }
            Task { @MainActor in
                await self.checkStatus(force: false)
            }
        }
    }

    private func stopMonitoring() {
        self.monitorTimer?.invalidate()
        self.monitorTimer = nil
        self.lastCheck = nil
    }

    private func checkStatus(force: Bool) async {
        if self.isChecking { return }
        let now = Date()
        if !force, let lastCheck, now.timeIntervalSince(lastCheck) < self.minimumCheckInterval {
            return
        }

        self.isChecking = true

        let latest = await PermissionManager.authorizationStatus()
        if latest != self.status {
            self.status = latest
            NotificationCenter.default.post(name: .openclawPermissionsChanged, object: nil)
        }
        self.lastCheck = Date()

        self.isChecking = false
    }
}

enum ScreenRecordingProbe {
    static func isAuthorized() -> Bool {
        if #available(macOS 10.15, *) {
            return CGPreflightScreenCaptureAccess()
        }
        return true
    }

    @MainActor
    static func requestAuthorization() async {
        if #available(macOS 10.15, *) {
            _ = CGRequestScreenCaptureAccess()
        }
    }
}
