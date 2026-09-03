import Foundation
import Testing
import UserNotifications
import WebKit
@testable import OpenClaw

@MainActor
struct DashboardNotificationsBridgeTests {
    @Test func `parses notification requests`() {
        #expect(DashboardWindowController.notificationsRequest(from: ["type": "status"]) == .status)
        #expect(DashboardWindowController.notificationsRequest(
            from: ["type": "request-permission"]) == .requestPermission)
        #expect(DashboardWindowController.notificationsRequest(
            from: ["type": "send-test"]) == .sendTest)
        #expect(DashboardWindowController.notificationsRequest(
            from: ["type": "background-session-completed"]) == .backgroundSessionCompleted)
    }

    @Test func `completion request preserves its exact session route without notification text`() throws {
        let completion = try #require(DashboardBackgroundSessionCompletion(body: [
            "runId": "run-1", "path": "/chat/research", "search": "?session=global",
        ]))
        #expect(completion.runId == "run-1")
        #expect(completion.path == "/chat/research")
        #expect(completion.search == "?session=global")
    }

    @Test func `completion request rejects malformed or external destinations`() {
        let invalid: [[String: Any]] = [
            ["runId": "", "path": "/chat/main"],
            ["runId": String(repeating: "r", count: 129), "path": "/chat/main"],
            ["runId": "run-1", "path": "https://other.example/chat/main"],
            ["runId": "run-1", "path": "/chat/main#token=value"],
            ["runId": "run-1", "path": "/settings"],
            ["runId": "run-1", "path": "/chat/main", "search": true],
            ["runId": "run-1", "path": "/chat/main", "search": "?session=%"],
            ["runId": "run-1", "path": "/chat/main", "search": "?session=main#token=value"],
        ]
        for body in invalid {
            #expect(DashboardBackgroundSessionCompletion(body: body) == nil)
        }
    }

    @Test func `notification navigation keeps the originating Gateway and mount after auth refresh`() throws {
        var components = try #require(URLComponents(string: "https://gateway.example/openclaw/"))
        components.user = "test-user"
        components.password = "test-password"
        components.query = "token=before"
        components.fragment = "token=before"
        let original = try #require(components.url)
        let refreshed = try #require(URL(string: "https://gateway.example/openclaw/#token=after"))
        let otherGateway = try #require(URL(string: "https://other.example/openclaw/"))
        let otherMount = try #require(URL(string: "https://gateway.example/other/"))
        let route = try #require(DashboardManager.notificationRoute(original))
        #expect(route.absoluteString == "https://gateway.example/openclaw/")
        #expect(route == DashboardManager.notificationRoute(refreshed))
        #expect(route != DashboardManager.notificationRoute(otherGateway))
        #expect(route != DashboardManager.notificationRoute(otherMount))
    }

    @Test func `late enqueue cleanup cannot retire a replacement for the same background run`() throws {
        var actions = BackgroundSessionNotificationActions()
        let originalAdmission = actions.begin(sourceIdentifier: "source/run", open: {})
        let original = try #require(originalAdmission)
        #expect(actions.begin(sourceIdentifier: "source/run", open: {}) == nil)
        #expect(actions.stop() == [original.identifier])
        let replacementAdmission = actions.begin(sourceIdentifier: "source/run", open: {})
        let replacement = try #require(replacementAdmission)

        #expect(replacement.identifier != original.identifier)
        #expect(actions.finish(
            identifier: original.identifier, sent: true, sourceIsCurrent: true) == [original.identifier])
        #expect(actions.contains(replacement.identifier))
        #expect(actions.finish(identifier: replacement.identifier, sent: true, sourceIsCurrent: true).isEmpty)
    }

    @Test func `a document retired during enqueue removes its delivered notice and action`() throws {
        var actions = BackgroundSessionNotificationActions()
        let pendingAdmission = actions.begin(sourceIdentifier: "source/run", open: {})
        let admission = try #require(pendingAdmission)

        #expect(actions.finish(
            identifier: admission.identifier, sent: true, sourceIsCurrent: false) == [admission.identifier])
        #expect(!actions.contains(admission.identifier))
        #expect(actions.openAction(for: admission.identifier) == nil)
    }

    @Test func `bounded notification actions evict only the oldest OS request`() throws {
        var actions = BackgroundSessionNotificationActions()
        let firstAdmission = actions.begin(sourceIdentifier: "first", open: {})
        let first = try #require(firstAdmission)
        for index in 1..<64 {
            let pendingAdmission = actions.begin(sourceIdentifier: "run-\(index)", open: {})
            let admission = try #require(pendingAdmission)
            #expect(admission.retired.isEmpty)
        }
        let nextAdmission = actions.begin(sourceIdentifier: "next", open: {})
        let next = try #require(nextAdmission)
        #expect(next.retired == [first.identifier])
        #expect(!actions.contains(first.identifier))
        #expect(actions.contains(next.identifier))
    }

    @Test func `same URL document commit retires the notification source without changing the route`() throws {
        let url = try #require(URL(string: "about:blank"))
        let controller = DashboardWindowController(
            url: url,
            auth: DashboardWindowAuth(gatewayUrl: nil, token: nil, password: nil),
            websiteDataStore: .nonPersistent(),
            windowAutosaveName: "DashboardNotificationDocument-\(UUID().uuidString)",
            requestBrowserProfileImportOffer: { _ in false })
        defer { controller.close() }
        let sourceID = controller.notificationSourceID

        controller.webView(controller.webView, didCommit: nil)

        #expect(controller.currentURL == url)
        #expect(controller.notificationSourceID != sourceID)
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
