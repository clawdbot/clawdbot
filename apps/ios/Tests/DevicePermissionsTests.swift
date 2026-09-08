import Contacts
import EventKit
import Foundation
import Photos
import Testing
@testable import OpenClaw

struct DevicePermissionsTests {
    @Test func `contacts statuses map to shared grants`() {
        #expect(DevicePermissionStatusMap.contacts(.authorized) == .granted)
        #expect(DevicePermissionStatusMap.contacts(.limited) == .limited)
        #expect(DevicePermissionStatusMap.contacts(.notDetermined) == .notRequested)
        #expect(DevicePermissionStatusMap.contacts(.denied) == .denied)
        #expect(DevicePermissionStatusMap.contacts(.restricted) == .denied)
    }

    @Test func `photos statuses map to shared grants`() {
        #expect(DevicePermissionStatusMap.photos(.authorized) == .granted)
        #expect(DevicePermissionStatusMap.photos(.limited) == .limited)
        #expect(DevicePermissionStatusMap.photos(.notDetermined) == .notRequested)
        #expect(DevicePermissionStatusMap.photos(.denied) == .denied)
    }

    @Test func `event kit write-only is limited for read but granted for add`() {
        #expect(DevicePermissionStatusMap.eventKitRead(.writeOnly) == .limited)
        #expect(DevicePermissionStatusMap.eventKitWrite(.writeOnly) == .granted)
        #expect(DevicePermissionStatusMap.eventKitRead(.fullAccess) == .granted)
        #expect(DevicePermissionStatusMap.eventKitWrite(.fullAccess) == .granted)
        #expect(DevicePermissionStatusMap.eventKitRead(.notDetermined) == .notRequested)
        #expect(DevicePermissionStatusMap.eventKitRead(.denied) == .denied)
    }

    @Test func `first-run onboarding moves directly from intro to pairing`() {
        #expect(OnboardingStep.intro.previous == nil)
        #expect(OnboardingStep.welcome.previous == .intro)
        #expect(!OnboardingStep.welcome.canGoBack)
        #expect(OnboardingStep.welcome.manualProgressTitle.isEmpty)
    }

    @Test func `onboarding has no aggregate system permission prompt`() throws {
        let onboardingDirectory = Self.sourceRoot()
            .appending(path: "Onboarding", directoryHint: .isDirectory)
        let wizard = try String(
            contentsOf: onboardingDirectory.appending(path: "OnboardingWizardView.swift"),
            encoding: .utf8)

        #expect(!FileManager.default.fileExists(
            atPath: onboardingDirectory.appending(path: "OnboardingPermissionsStep.swift").path))
        #expect(!wizard.contains("OnboardingPermissionsStep"))
        #expect(!wizard.contains("navigate(to: .permissions)"))
    }

    private static func sourceRoot() -> URL {
        URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent()
            .deletingLastPathComponent()
            .appending(path: "Sources", directoryHint: .isDirectory)
    }
}
