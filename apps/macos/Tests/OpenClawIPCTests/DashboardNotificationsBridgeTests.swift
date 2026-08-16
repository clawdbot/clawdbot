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
}
