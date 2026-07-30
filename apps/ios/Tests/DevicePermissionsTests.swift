import AVFoundation
import Contacts
import EventKit
import Photos
import Testing
import UserNotifications
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

    @Test func `capture microphone notification and location statuses map to shared grants`() {
        #expect(DevicePermissionStatusMap.capture(.authorized) == .granted)
        #expect(DevicePermissionStatusMap.capture(.notDetermined) == .notRequested)
        #expect(DevicePermissionStatusMap.capture(.denied) == .denied)

        #expect(DevicePermissionStatusMap.microphone(.granted) == .granted)
        #expect(DevicePermissionStatusMap.microphone(.undetermined) == .notRequested)
        #expect(DevicePermissionStatusMap.microphone(.denied) == .denied)

        #expect(DevicePermissionStatusMap.notifications(.authorized) == .granted)
        #expect(DevicePermissionStatusMap.notifications(.provisional) == .granted)
        #expect(DevicePermissionStatusMap.notifications(.notDetermined) == .notRequested)
        #expect(DevicePermissionStatusMap.notifications(.denied) == .denied)

        #expect(DevicePermissionStatusMap.location(.authorizedWhenInUse) == .granted)
        #expect(DevicePermissionStatusMap.location(.authorizedAlways) == .granted)
        #expect(DevicePermissionStatusMap.location(.notDetermined) == .notRequested)
        #expect(DevicePermissionStatusMap.location(.restricted) == .denied)
    }

    @Test func `first-run onboarding inserts permissions between intro and pairing`() {
        #expect(OnboardingStep.permissions.previous == .intro)
        #expect(OnboardingStep.welcome.previous == .permissions)
        #expect(!OnboardingStep.permissions.canGoBack)
        // Permissions is a first-run page, not part of the manual connect progress trail.
        #expect(OnboardingStep.permissions.manualProgressTitle.isEmpty)
    }
}
