import AppKit
import ApplicationServices
import Foundation
import OSLog

enum AppleEventPermissionState: Equatable, Sendable {
    case authorized
    case notDetermined
    case denied
    case targetNotRunning
    case targetNotAccessible
    case failed(OSStatus)
}

struct AppleEventPermissionProbe: Sendable {
    typealias DeterminePermission = @Sendable (_ askUserIfNeeded: Bool) -> OSStatus

    private let determinePermission: DeterminePermission

    init(determinePermission: @escaping DeterminePermission) {
        self.determinePermission = determinePermission
    }

    static var live: Self {
        Self(determinePermission: { askUserIfNeeded in
            Self.determineTerminalPermission(askUserIfNeeded: askUserIfNeeded)
        })
    }

    func state(askUserIfNeeded: Bool) async -> AppleEventPermissionState {
        let determinePermission = self.determinePermission
        let status = await Task.detached(priority: .userInitiated) {
            determinePermission(askUserIfNeeded)
        }.value
        return Self.state(for: status)
    }

    static func state(for status: OSStatus) -> AppleEventPermissionState {
        switch status {
        case noErr:
            .authorized
        case OSStatus(errAEEventWouldRequireUserConsent):
            .notDetermined
        case OSStatus(errAEEventNotPermitted):
            .denied
        case OSStatus(procNotFound):
            .targetNotRunning
        case OSStatus(errAETargetAddressNotPermitted):
            .targetNotAccessible
        default:
            .failed(status)
        }
    }

    private static func determineTerminalPermission(askUserIfNeeded: Bool) -> OSStatus {
        let bundleID = Data("com.apple.Terminal".utf8)
        var target = AEAddressDesc()
        let createStatus = bundleID.withUnsafeBytes { bytes in
            AECreateDesc(
                typeApplicationBundleID,
                bytes.baseAddress,
                bundleID.count,
                &target)
        }
        guard createStatus == noErr else { return OSStatus(createStatus) }
        defer { AEDisposeDesc(&target) }

        return AEDeterminePermissionToAutomateTarget(
            &target,
            typeWildCard,
            typeWildCard,
            askUserIfNeeded)
    }
}

enum TerminalAutomationPermission {
    typealias LaunchTerminal = @MainActor () async -> Bool
    typealias OpenAutomationSettings = @MainActor () -> Void

    private static let logger = Logger(subsystem: "ai.openclaw", category: "TerminalAutomationPermission")
    private static let terminalBundleID = "com.apple.Terminal"

    static func authorizationStatus(
        probe: AppleEventPermissionProbe = .live) async -> CapabilityAuthorizationStatus
    {
        let state = await probe.state(askUserIfNeeded: false)
        return self.authorizationStatus(for: state)
    }

    static func authorizationStatus(for state: AppleEventPermissionState) -> CapabilityAuthorizationStatus {
        switch state {
        case .authorized:
            .granted
        case .notDetermined, .denied:
            .notGranted
        case .targetNotRunning, .targetNotAccessible, .failed:
            .unknown
        }
    }

    static func isAuthorized(probe: AppleEventPermissionProbe = .live) async -> Bool {
        await self.authorizationStatus(probe: probe).isGranted
    }

    @MainActor
    static func requestAuthorization(
        probe: AppleEventPermissionProbe = .live,
        launchTerminal: @escaping LaunchTerminal = Self.launchTerminal,
        openAutomationSettings: @escaping OpenAutomationSettings = Self.openAutomationSettings) async -> Bool
    {
        var state = await probe.state(askUserIfNeeded: false)
        if state == .authorized { return true }

        if state == .targetNotRunning {
            guard await launchTerminal() else { return false }
            state = await probe.state(askUserIfNeeded: false)
        }

        switch state {
        case .authorized:
            return true
        case .notDetermined:
            return await probe.state(askUserIfNeeded: true) == .authorized
        case .denied:
            openAutomationSettings()
            return false
        case .targetNotRunning:
            Self.logger.error("Terminal did not become available for Automation permission")
            return false
        case .targetNotAccessible:
            Self.logger.error("Terminal Automation target is not accessible")
            return false
        case let .failed(status):
            Self.logger.error("Terminal Automation permission check failed status=\(status, privacy: .public)")
            return false
        }
    }

    @MainActor
    private static func launchTerminal() async -> Bool {
        if !NSRunningApplication.runningApplications(withBundleIdentifier: self.terminalBundleID).isEmpty {
            return true
        }
        guard let terminalURL = NSWorkspace.shared.urlForApplication(withBundleIdentifier: self.terminalBundleID) else {
            return false
        }

        let configuration = NSWorkspace.OpenConfiguration()
        configuration.activates = false
        configuration.addsToRecentItems = false
        configuration.hides = true
        return await withCheckedContinuation { continuation in
            NSWorkspace.shared.openApplication(at: terminalURL, configuration: configuration) { application, error in
                continuation.resume(returning: application != nil && error == nil)
            }
        }
    }

    @MainActor
    private static func openAutomationSettings() {
        SystemSettingsURLSupport.openFirst([
            "x-apple.systempreferences:com.apple.preference.security?Privacy_Automation",
            "x-apple.systempreferences:com.apple.preference.security",
        ])
    }
}
