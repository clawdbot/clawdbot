import Foundation
import Testing
import UserNotifications
@testable import OpenClaw

@MainActor
struct DashboardNotificationsBridgeTests {
    @Test func `parses notification requests`() {
        #expect(DashboardWindowController.notificationsRequest(from: ["type": "status"]) == .status)
        #expect(DashboardWindowController.notificationsRequest(
            from: ["type": "request-permission"]) == .requestPermission)
        #expect(DashboardWindowController.notificationsRequest(
            from: ["type": "send-test"]) == .sendTest)
    }

    @Test func `rejects invalid notification requests`() {
        #expect(DashboardWindowController.notificationsRequest(from: ["type": "unknown"]) == nil)
        #expect(DashboardWindowController.notificationsRequest(from: "status") == nil)
    }

    @Test func `maps notification permission labels`() throws {
        #expect(DashboardWindowController.notificationsPermissionLabel(for: .authorized) == "granted")
        #expect(DashboardWindowController.notificationsPermissionLabel(for: .provisional) == "granted")
        // Ephemeral (unavailable by name on macOS, raw value 4) cannot occur here
        // and maps to notDetermined with the rest of the default branch.
        let ephemeral = try #require(UNAuthorizationStatus(rawValue: 4))
        #expect(DashboardWindowController.notificationsPermissionLabel(
            for: ephemeral) == "notDetermined")
        #expect(DashboardWindowController.notificationsPermissionLabel(for: .denied) == "denied")
        #expect(DashboardWindowController.notificationsPermissionLabel(
            for: .notDetermined) == "notDetermined")
    }

    @Test func `permission and test send outcome remain independent bridge facts`() {
        let failed = DashboardWindowController.notificationsSnapshot(
            permission: "granted",
            testOutcome: .error("Open System Settings and try again."))
        let refreshed = DashboardWindowController.notificationsSnapshot(
            permission: "granted",
            testOutcome: .error("Open System Settings and try again."))

        #expect(failed.permission == "granted")
        #expect(failed.test == .error("Open System Settings and try again."))
        #expect(refreshed == failed)
    }

    @Test func `bridge exposes pending and queued test send states`() {
        #expect(DashboardWindowController.notificationsSnapshot(
            permission: "granted",
            testOutcome: .pending).test == .pending)
        #expect(DashboardWindowController.notificationsSnapshot(
            permission: "granted",
            testOutcome: .sent).test == .sent)
    }

    @Test func `bridge encodes closed wire states and error-only messages`() throws {
        let pending = try self.testSnapshotJSON(.pending)
        let error = try self.testSnapshotJSON(.error("Open System Settings and try again."))

        #expect(pending["state"] as? String == "pending")
        #expect(pending["message"] == nil)
        #expect(error["state"] as? String == "error")
        #expect(error["message"] as? String == "Open System Settings and try again.")
    }

    private func testSnapshotJSON(_ snapshot: TestNotificationOutcome) throws -> [String: Any] {
        let data = try JSONEncoder().encode(snapshot)
        return try #require(JSONSerialization.jsonObject(with: data) as? [String: Any])
    }
}
