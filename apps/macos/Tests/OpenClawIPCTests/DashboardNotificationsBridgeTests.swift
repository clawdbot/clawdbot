import AppKit
import Foundation
import Testing
import UserNotifications
@testable import OpenClaw

@MainActor
struct DashboardNotificationsBridgeTests {
    @Test(arguments: ["reload", "commit", "replace", "close"])
    func `retiring a Dashboard cancels a suspended notification action before its effect`(
        transition: String) async throws
    {
        let controller = try DashboardWindowController(
            url: #require(URL(string: "https://gateway.example/control/")),
            auth: DashboardWindowAuth(gatewayUrl: nil, token: nil, password: nil),
            websiteDataStore: .nonPersistent(),
            windowAutosaveName: "",
            requestBrowserProfileImportOffer: { _ in false })
        defer { controller.closeDashboard() }
        let entered = AsyncStream<Void>.makeStream()
        let resume = AsyncStream<Void>.makeStream()
        var effects = 0
        let request = Task {
            entered.continuation.yield(())
            var iterator = resume.stream.makeAsyncIterator()
            _ = await iterator.next()
            // GatewayChannel uses the same cancellation check before socket send.
            guard !Task.isCancelled else { return }
            effects += 1
        }
        controller.notificationState.requests[UUID()] = request
        controller.notificationState.testOutcome = .pending
        var enteredIterator = entered.stream.makeAsyncIterator()
        _ = await enteredIterator.next()

        switch transition {
        case "reload": controller.webView(controller.webView, didStartProvisionalNavigation: nil)
        case "commit": controller.webView(controller.webView, didCommit: nil)
        case "replace": controller.detachWindowForReplacement()?.close()
        default: controller.windowWillClose(Notification(name: NSWindow.willCloseNotification))
        }
        resume.continuation.yield(())
        await request.value

        #expect(request.isCancelled)
        #expect(effects == 0)
        #expect(controller.notificationState.testOutcome != .pending)
    }

    @Test func `parses notification requests`() {
        #expect(DashboardWindowController.notificationsRequest(from: ["type": "status"]) == .status)
        #expect(DashboardWindowController.notificationsRequest(
            from: ["type": "request-permission"]) == .requestPermission)
        #expect(DashboardWindowController.notificationsRequest(
            from: ["type": "send-test"]) == .sendTest)
        #expect(DashboardWindowController.notificationsRequest(
            from: ["type": "preferences-get"]) == .preferencesGet)
        #expect(DashboardWindowController.notificationsRequest(
            from: ["type": "preferences-set"]) == .preferencesSet)
    }

    @Test func `preference bridge forwards only scope and preferences`() throws {
        let params = try #require(DashboardWindowController.notificationsPreferenceParams(from: [
            "type": "preferences-set", "requestId": "notifications-1-2", "scope": "device",
            "preferences": ["muted": true], "gateway": "https://other.invalid", "title": "untrusted",
        ]))
        let data = try JSONEncoder().encode(params)
        let json = try #require(JSONSerialization.jsonObject(with: data) as? [String: Any])
        #expect(Set(json.keys) == ["scope", "preferences"])
        #expect(json["scope"] as? String == "device")
        #expect((json["preferences"] as? [String: Any])?["muted"] as? Bool == true)
        #expect(DashboardWindowController.notificationsPreferenceParams(from: [
            "scope": "gateway", "preferences": ["muted": true],
        ]) == nil)
        #expect(DashboardWindowController.notificationsPreferenceParams(from: [
            "scope": "device", "preferences": ["label": String(repeating: "x", count: 16385)],
        ]) == nil)
    }

    @Test func `native action completion preserves permission and correlates its result`() throws {
        let requestID = "notifications-1-2"
        #expect(DashboardWindowController.notificationsRequestID(from: ["requestId": requestID]) == requestID)
        #expect(DashboardWindowController.notificationsRequestID(from: ["requestId": ""]) == nil)
        #expect(DashboardWindowController.notificationsDocumentID(from: ["document": "originating-document"]) ==
            "originating-document")
        #expect(DashboardWindowController.notificationsDocumentID(from: ["requestId": requestID]) == nil)
        #expect(DashboardWindowController.notificationsDocumentID(from: ["document": ""]) == nil)
        #expect(DashboardWindowController.notificationsDocumentID(from: [
            "document": String(repeating: "x", count: 65),
        ]) == nil)
        #expect(DashboardWindowController.notificationsRequestID(from: ["requestId": String(
            repeating: "x",
            count: 65)]) == nil)
        let snapshot = DashboardNotificationsSnapshot(
            permission: "granted",
            test: nil,
            supported: false,
            error: "Update this Gateway.",
            replyTo: requestID)
        let json = try #require(JSONSerialization.jsonObject(with: JSONEncoder().encode(snapshot)) as? [String: Any])
        #expect(json["permission"] as? String == "granted")
        #expect(json["supported"] as? Bool == false)
        #expect(json["error"] as? String == "Update this Gateway.")
        #expect(json["replyTo"] as? String == requestID)
        #expect(json["preferences"] == nil)
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
        let failed = DashboardNotificationsSnapshot(
            permission: "granted",
            test: .error("Open System Settings and try again."))
        let refreshed = DashboardNotificationsSnapshot(
            permission: "granted",
            test: .error("Open System Settings and try again."))

        #expect(failed.permission == "granted")
        #expect(failed.test == .error("Open System Settings and try again."))
        #expect(refreshed == failed)
    }

    @Test func `bridge exposes pending and queued test send states`() {
        #expect(DashboardNotificationsSnapshot(
            permission: "granted",
            test: .pending).test == .pending)
        #expect(DashboardNotificationsSnapshot(
            permission: "granted",
            test: .sent).test == .sent)
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
