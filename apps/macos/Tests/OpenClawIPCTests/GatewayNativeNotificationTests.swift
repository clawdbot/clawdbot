import Foundation
import Testing
@testable import OpenClaw

struct GatewayNativeNotificationTests {
    @Test(arguments: [
        "approval-requested", "agent-finished", "agent-question", "scheduled-task-failed", "background-task-failed",
    ])
    func `prepared notification preserves Gateway copy and passive replay`(category: String) throws {
        let notification = try self.decode(category: category, path: "/chat?session=agent%3Amain%3Amain")
        guard case let .show(presentation) = notification else {
            Issue.record("Expected a presentation")
            return
        }
        #expect(presentation.id == "request-1")
        #expect(presentation.category.rawValue == category)
        #expect(presentation.title == "Prepared title")
        #expect(presentation.body == "Prepared body")
        #expect(!presentation.alert)
        let location = try #require(GatewayNativeNotification.location(presentation.path))
        #expect(location.path == "/chat")
        #expect(location.search == "?session=agent%3Amain%3Amain")
    }

    @Test(arguments: ["https://other.invalid/approve/1", "//other.invalid/approve/1", "/approve/1#token", "approve/1"])
    func `notification navigation rejects destinations outside this app`(path: String) {
        #expect(throws: DecodingError.self) { try self.decode(path: path) }
    }

    @Test(arguments: ["id", "title", "body", "path", "category", "action"])
    func `notification decoder enforces the prepared payload contract`(field: String) throws {
        var payload = self.payload()
        switch field {
        case "id": payload[field] = String(repeating: "x", count: 201)
        case "title": payload[field] = String(repeating: "🐾", count: 81)
        case "body": payload[field] = String(repeating: "x", count: 321)
        case "path": payload[field] = "/" + String(repeating: "x", count: 1024)
        default: payload[field] = "unknown"
        }
        let data = try JSONSerialization.data(withJSONObject: payload)
        #expect(throws: DecodingError.self) { try JSONDecoder().decode(GatewayNativeNotification.self, from: data) }
    }

    @Test func `terminal notification carries only the owned removal ID`() throws {
        let data = Data(#"{"action":"remove","id":"request-1"}"#.utf8)
        let notification = try JSONDecoder().decode(GatewayNativeNotification.self, from: data)
        guard case let .remove(id) = notification else {
            Issue.record("Expected removal")
            return
        }
        #expect(id == "request-1")
    }

    @Test(arguments: [-1.0, 1.5, 1e100])
    func `notification expiry rejects invalid integer timestamps before scheduling`(expiry: Double) throws {
        var payload = self.payload()
        payload["expiresAtMs"] = expiry
        let data = try JSONSerialization.data(withJSONObject: payload)
        #expect(throws: DecodingError.self) { try JSONDecoder().decode(GatewayNativeNotification.self, from: data) }
    }

    private func decode(
        category: String = "approval-requested",
        path: String = "/approve/request-1") throws -> GatewayNativeNotification
    {
        let data = try JSONSerialization.data(withJSONObject: self.payload(category: category, path: path))
        return try JSONDecoder().decode(GatewayNativeNotification.self, from: data)
    }

    private func payload(
        category: String = "approval-requested",
        path: String = "/approve/request-1") -> [String: Any]
    {
        [
            "action": "show", "id": "request-1", "category": category,
            "title": "Prepared title", "body": "Prepared body", "path": path,
            "expiresAtMs": 1_900_000_000_000, "alert": false,
        ]
    }
}
