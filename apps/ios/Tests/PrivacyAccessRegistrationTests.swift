import Contacts
import EventKit
import Foundation
import Photos
import Testing
@testable import OpenClaw

struct PrivacyAccessRegistrationTests {
    @Test func `refresh all reconnects once for advertised permission changes`() throws {
        let source = try String(contentsOf: Self.sourceURL(), encoding: .utf8)
        let start = try #require(source.range(of: "private func refreshAll()"))
        let end = try #require(
            source.range(of: "private func updatePhotosStatus(", range: start.upperBound..<source.endIndex))
        let refreshAll = String(source[start.lowerBound..<end.lowerBound])
        let refreshCall = "self.gatewayController.refreshActiveGatewayRegistrationFromSettings()"

        #expect(refreshAll.contains("let previousPermissions = PrivacyGatewayPermissionSnapshot("))
        #expect(refreshAll.contains("let currentPermissions = PrivacyGatewayPermissionSnapshot("))
        #expect(refreshAll.contains("if previousPermissions != currentPermissions"))
        #expect(refreshAll.components(separatedBy: refreshCall).count == 2)
        #expect(!refreshAll.contains("self.updatePhotosStatus("))
    }

    @Test func `advertised permissions include granted system access`() {
        let snapshot = PrivacyGatewayPermissionSnapshot(
            contactsStatus: .limited,
            photosStatus: .limited,
            calendarStatus: .fullAccess,
            remindersStatus: .fullAccess)

        #expect(snapshot.contacts)
        #expect(snapshot.photos)
        #expect(snapshot.calendar)
        #expect(snapshot.reminders)
    }

    @Test func `advertised permissions exclude unavailable system access`() {
        let snapshot = PrivacyGatewayPermissionSnapshot(
            contactsStatus: .denied,
            photosStatus: .restricted,
            calendarStatus: .notDetermined,
            remindersStatus: .denied)

        #expect(!snapshot.contacts)
        #expect(!snapshot.photos)
        #expect(!snapshot.calendar)
        #expect(!snapshot.reminders)
    }

    @Test func `write only event access is not advertised as readable`() {
        let snapshot = PrivacyGatewayPermissionSnapshot(
            contactsStatus: .authorized,
            photosStatus: .authorized,
            calendarStatus: .writeOnly,
            remindersStatus: .writeOnly)

        #expect(!snapshot.calendar)
        #expect(!snapshot.reminders)
    }

    @Test func `equivalent authorization states do not change advertised snapshot`() {
        let first = PrivacyGatewayPermissionSnapshot(
            contactsStatus: .denied,
            photosStatus: .denied,
            calendarStatus: .writeOnly,
            remindersStatus: .notDetermined)
        let second = PrivacyGatewayPermissionSnapshot(
            contactsStatus: .restricted,
            photosStatus: .restricted,
            calendarStatus: .denied,
            remindersStatus: .writeOnly)

        #expect(first == second)
    }

    @Test func `permission grant changes advertised snapshot`() {
        let denied = PrivacyGatewayPermissionSnapshot(
            contactsStatus: .notDetermined,
            photosStatus: .notDetermined,
            calendarStatus: .notDetermined,
            remindersStatus: .notDetermined)
        let granted = PrivacyGatewayPermissionSnapshot(
            contactsStatus: .authorized,
            photosStatus: .authorized,
            calendarStatus: .fullAccess,
            remindersStatus: .fullAccess)

        #expect(denied != granted)
    }

    private static func sourceURL() -> URL {
        URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent()
            .deletingLastPathComponent()
            .appendingPathComponent("Sources/Settings/PrivacyAccessSectionView.swift")
    }
}
