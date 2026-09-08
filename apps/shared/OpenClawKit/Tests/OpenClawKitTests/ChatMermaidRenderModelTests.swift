import Foundation
import Testing
@testable import OpenClawChatUI

struct ChatMermaidRenderModelTests {
    private let theme = ChatMermaidTheme(
        background: "#ffffff", foreground: "#111111", muted: "#666666",
        border: "#aaaaaa", accent: "#cc3333", fontFamily: "system-ui", darkMode: false)

    @Test func `source admission uses the shared UTF16 limit`() {
        let source = String(repeating: "😀", count: 10000)
        #expect(self.request(source: source).isValid)
        #expect(!self.request(source: source + "x").isValid)
        #expect(!self.request(source: " \n ").isValid)
    }

    @Test func `request identity includes all bitmap inputs`() {
        let request = self.request()
        #expect(request != self.request(width: 300))
        #expect(request != self.request(scale: 3))
        #expect(!self.request(scale: .infinity).isValid)
        #expect(!self.request(width: 8192, scale: 2).isValid)
    }

    @Test func `old bridge responses cannot settle a newer job`() throws {
        let body = try self.message(id: UUID(), width: 320, height: 120)
        #expect(try ChatMermaidResponse(body: body, expectedID: UUID(), request: self.request()) == nil)
    }

    @Test func `bridge dimensions must match the current viewport before allocation`() throws {
        let id = UUID()
        let request = self.request()
        for (width, height) in [(319.0, 120.0), (320, 0), (320, 120.5), (320, 8193)] {
            let body = try self.message(id: id, width: width, height: height)
            #expect(throws: ChatMermaidFailure.invalidResult) {
                try ChatMermaidResponse(body: body, expectedID: id, request: request)
            }
        }
        let large = try self.message(id: id, width: 320, height: 4000)
        #expect(throws: ChatMermaidFailure.tooLarge) {
            try ChatMermaidResponse(body: large, expectedID: id, request: request)
        }
    }

    @Test func `physical bitmap caps include display scale and round partial pixels up`() {
        #expect(ChatMermaidResponse.isSafeBitmap(size: CGSize(width: 1024, height: 1024), scale: 2))
        #expect(!ChatMermaidResponse.isSafeBitmap(size: CGSize(width: 1024, height: 1024.1), scale: 2))
        #expect(!ChatMermaidResponse.isSafeBitmap(size: CGSize(width: CGFloat.infinity, height: 1), scale: 1))
        #expect(!ChatMermaidResponse.isSafeBitmap(size: CGSize(width: 1, height: 1), scale: .nan))
    }

    @Test func `valid response preserves sanitized vector and CSS dimensions`() throws {
        let id = UUID()
        let body = try self.message(id: id, width: 320, height: 120)
        let response = try #require(try ChatMermaidResponse(body: body, expectedID: id, request: self.request()))
        #expect(response.svg == "<svg xmlns=\"http://www.w3.org/2000/svg\"/>")
        #expect(response.size == CGSize(width: 320, height: 120))
    }

    @Test(arguments: [false, true])
    func `bridge failure keeps producer retryability independent of error text`(retryable: Bool) throws {
        let id = UUID()
        let error = "Diagram could not be rendered."
        let data = try JSONSerialization.data(withJSONObject: [
            "id": id.uuidString, "success": false, "error": error, "retryable": retryable,
        ])
        #expect(throws: ChatMermaidFailure.rendering(error, retryable: retryable)) {
            try ChatMermaidResponse(
                body: String(decoding: data, as: UTF8.self), expectedID: id, request: self.request())
        }
    }

    @Test func `failed bridge results require both error and retryability`() throws {
        let id = UUID()
        let missingFields: [[String: Any]] = [["error": "Unavailable"], ["retryable": true]]
        for fields in missingFields {
            let data = try JSONSerialization.data(withJSONObject: fields.merging([
                "id": id.uuidString, "success": false,
            ], uniquingKeysWith: { current, _ in current }))
            #expect(throws: ChatMermaidFailure.invalidResult) {
                try ChatMermaidResponse(
                    body: String(decoding: data, as: UTF8.self), expectedID: id, request: self.request())
            }
        }
    }

    private func request(
        source: String = "flowchart LR\nA-->B",
        width: Int = 320,
        scale: Double = 2) -> ChatMermaidRequest
    {
        ChatMermaidRequest(source: source, width: width, displayScale: scale, theme: self.theme)
    }

    private func message(id: UUID, width: Double, height: Double) throws -> String {
        let data = try JSONSerialization.data(withJSONObject: [
            "id": id.uuidString, "success": true,
            "svg": "<svg xmlns=\"http://www.w3.org/2000/svg\"/>",
            "widthCssPx": width, "heightCssPx": height,
        ])
        return String(decoding: data, as: UTF8.self)
    }
}
