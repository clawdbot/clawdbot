import Foundation
import OpenClawIPC
import Testing

struct CanvasIPCTests {
    @Test func `canvas present codable roundtrip`() throws {
        let placement = CanvasPlacement(x: 10, y: 20, width: 640, height: 480)
        let req: Request = .canvasPresent(session: "main", path: "/index.html", placement: placement)

        let data = try JSONEncoder().encode(req)
        let decoded = try JSONDecoder().decode(Request.self, from: data)

        switch decoded {
        case let .canvasPresent(session, path, placement):
            #expect(session == "main")
            #expect(path == "/index.html")
            #expect(placement?.x == 10)
            #expect(placement?.y == 20)
            #expect(placement?.width == 640)
            #expect(placement?.height == 480)
        default:
            Issue.record("expected canvasPresent, got \(decoded)")
        }
    }

    @Test func `canvas present decodes nil placement when missing`() throws {
        let json = """
        {"type":"canvasPresent","session":"s","path":"/"}
        """
        let decoded = try JSONDecoder().decode(Request.self, from: Data(json.utf8))

        switch decoded {
        case let .canvasPresent(session, path, placement):
            #expect(session == "s")
            #expect(path == "/")
            #expect(placement == nil)
        default:
            Issue.record("expected canvasPresent, got \(decoded)")
        }
    }
}
