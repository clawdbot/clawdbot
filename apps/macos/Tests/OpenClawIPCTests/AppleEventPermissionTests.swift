import ApplicationServices
import Foundation
import Testing
@testable import OpenClaw

@Suite(.serialized)
@MainActor
struct AppleEventPermissionTests {
    @Test func `maps Apple Event permission statuses`() {
        #expect(AppleEventPermissionProbe.state(for: noErr) == .authorized)
        #expect(AppleEventPermissionProbe.state(for: OSStatus(errAEEventWouldRequireUserConsent)) == .notDetermined)
        #expect(AppleEventPermissionProbe.state(for: OSStatus(errAEEventNotPermitted)) == .denied)
        #expect(AppleEventPermissionProbe.state(for: OSStatus(procNotFound)) == .targetNotRunning)
        #expect(AppleEventPermissionProbe.state(for: OSStatus(errAETargetAddressNotPermitted)) == .targetNotAccessible)
        #expect(AppleEventPermissionProbe.state(for: -1) == .failed(-1))
    }

    @Test func `passive status never asks and runs off main thread`() async {
        let recorder = PermissionProbeRecorder(statuses: [noErr])
        let probe = AppleEventPermissionProbe(determinePermission: recorder.determine)

        #expect(await TerminalAutomationPermission.isAuthorized(probe: probe))
        #expect(recorder.snapshot().asks == [false])
        #expect(recorder.snapshot().mainThreadCalls == [false])
    }

    @Test func `target not running is an unknown capability state`() {
        #expect(TerminalAutomationPermission.authorizationStatus(for: .authorized) == .granted)
        #expect(TerminalAutomationPermission.authorizationStatus(for: .notDetermined) == .notGranted)
        #expect(TerminalAutomationPermission.authorizationStatus(for: .denied) == .notGranted)
        #expect(TerminalAutomationPermission.authorizationStatus(for: .targetNotRunning) == .unknown)
        #expect(TerminalAutomationPermission.authorizationStatus(for: .targetNotAccessible) == .unknown)
        #expect(TerminalAutomationPermission.authorizationStatus(for: .failed(-1)) == .unknown)
    }

    @Test func `not determined request prompts once`() async {
        let recorder = PermissionProbeRecorder(statuses: [OSStatus(errAEEventWouldRequireUserConsent), noErr])
        let probe = AppleEventPermissionProbe(determinePermission: recorder.determine)
        let ui = PermissionUIRecorder()

        #expect(await TerminalAutomationPermission.requestAuthorization(
            probe: probe,
            launchTerminal: ui.launch,
            openAutomationSettings: ui.openSettings))
        #expect(recorder.snapshot().asks == [false, true])
        #expect(ui.launchCount == 0)
        #expect(ui.settingsCount == 0)
    }

    @Test func `authorized request does not prompt`() async {
        let recorder = PermissionProbeRecorder(statuses: [noErr])
        let probe = AppleEventPermissionProbe(determinePermission: recorder.determine)
        let ui = PermissionUIRecorder()

        #expect(await TerminalAutomationPermission.requestAuthorization(
            probe: probe,
            launchTerminal: ui.launch,
            openAutomationSettings: ui.openSettings))
        #expect(recorder.snapshot().asks == [false])
        #expect(ui.launchCount == 0)
        #expect(ui.settingsCount == 0)
    }

    @Test func `denied request opens settings without prompting`() async {
        let recorder = PermissionProbeRecorder(statuses: [OSStatus(errAEEventNotPermitted)])
        let probe = AppleEventPermissionProbe(determinePermission: recorder.determine)
        let ui = PermissionUIRecorder()

        let authorized = await TerminalAutomationPermission.requestAuthorization(
            probe: probe,
            launchTerminal: ui.launch,
            openAutomationSettings: ui.openSettings)
        #expect(!authorized)
        #expect(recorder.snapshot().asks == [false])
        #expect(ui.launchCount == 0)
        #expect(ui.settingsCount == 1)
    }

    @Test func `missing Terminal launches before prompting`() async {
        let recorder = PermissionProbeRecorder(statuses: [
            OSStatus(procNotFound),
            OSStatus(errAEEventWouldRequireUserConsent),
            noErr,
        ])
        let probe = AppleEventPermissionProbe(determinePermission: recorder.determine)
        let ui = PermissionUIRecorder(launchResult: true)

        #expect(await TerminalAutomationPermission.requestAuthorization(
            probe: probe,
            launchTerminal: ui.launch,
            openAutomationSettings: ui.openSettings))
        #expect(recorder.snapshot().asks == [false, false, true])
        #expect(ui.launchCount == 1)
        #expect(ui.settingsCount == 0)
    }

    @Test func `failed Terminal launch stops without prompting`() async {
        let recorder = PermissionProbeRecorder(statuses: [OSStatus(procNotFound)])
        let probe = AppleEventPermissionProbe(determinePermission: recorder.determine)
        let ui = PermissionUIRecorder(launchResult: false)

        let authorized = await TerminalAutomationPermission.requestAuthorization(
            probe: probe,
            launchTerminal: ui.launch,
            openAutomationSettings: ui.openSettings)
        #expect(!authorized)
        #expect(recorder.snapshot().asks == [false])
        #expect(ui.launchCount == 1)
        #expect(ui.settingsCount == 0)
    }

    @Test func `first prompt denial does not force settings`() async {
        let recorder = PermissionProbeRecorder(statuses: [
            OSStatus(errAEEventWouldRequireUserConsent),
            OSStatus(errAEEventNotPermitted),
        ])
        let probe = AppleEventPermissionProbe(determinePermission: recorder.determine)
        let ui = PermissionUIRecorder()

        let authorized = await TerminalAutomationPermission.requestAuthorization(
            probe: probe,
            launchTerminal: ui.launch,
            openAutomationSettings: ui.openSettings)
        #expect(!authorized)
        #expect(recorder.snapshot().asks == [false, true])
        #expect(ui.launchCount == 0)
        #expect(ui.settingsCount == 0)
    }
}

private final class PermissionProbeRecorder: @unchecked Sendable {
    struct Snapshot {
        let asks: [Bool]
        let mainThreadCalls: [Bool]
    }

    private let lock = NSLock()
    private var statuses: [OSStatus]
    private var asks: [Bool] = []
    private var mainThreadCalls: [Bool] = []

    init(statuses: [OSStatus]) {
        self.statuses = statuses
    }

    func determine(askUserIfNeeded: Bool) -> OSStatus {
        self.lock.withLock {
            self.asks.append(askUserIfNeeded)
            self.mainThreadCalls.append(Thread.isMainThread)
            return self.statuses.isEmpty ? -1 : self.statuses.removeFirst()
        }
    }

    func snapshot() -> Snapshot {
        self.lock.withLock {
            Snapshot(asks: self.asks, mainThreadCalls: self.mainThreadCalls)
        }
    }
}

@MainActor
private final class PermissionUIRecorder {
    let launchResult: Bool
    private(set) var launchCount = 0
    private(set) var settingsCount = 0

    init(launchResult: Bool = true) {
        self.launchResult = launchResult
    }

    func launch() async -> Bool {
        self.launchCount += 1
        return self.launchResult
    }

    func openSettings() {
        self.settingsCount += 1
    }
}
