import Foundation
import OpenClawKit
import Testing
@testable import OpenClaw

struct GatewayConnectionClawHubSkillsTests {
    @Test(arguments: [
        ("@publisher/fixture-skill", Optional("1.0.0")),
        ("skills-sh:publisher/skills/fixture-skill", nil),
    ])
    func `install sends only supported params and preserves Review audit`(slug: String, version: String?) async throws {
        try await withClawHubConnection(response: { id in
            Data("""
            {"type":"res","id":"\(id)","ok":true,"payload":{
              "ok":true,"message":"Installed fixture-skill","warning":"Outcome: Review\\nInspect the audit details."
            }}
            """.utf8)
        }, operation: { connection, recorder in
            let route = try await connection.captureRequiredRoute()
            let result = try await connection.skillsInstallClawHub(
                slug: slug,
                version: version,
                on: route)
            #expect(result.ok)
            #expect(result.message == "Installed fixture-skill")
            #expect(result.warning == "Outcome: Review\nInspect the audit details.")

            let requests = await recorder.snapshot()
            #expect(requests.count == 1)
            let request = try #require(requests.first)
            let frame = try #require(JSONSerialization.jsonObject(with: request) as? [String: Any])
            #expect(frame["method"] as? String == "skills.install")
            let params = try #require(frame["params"] as? [String: Any])
            let allowedKeys: Set<String> = version == nil
                ? ["source", "slug", "timeoutMs"]
                : ["source", "slug", "version", "timeoutMs"]
            #expect(Set(params.keys) == allowedKeys)
            #expect(params["source"] as? String == "clawhub")
            #expect(params["slug"] as? String == slug)
            #expect(params["version"] as? String == version)
            #expect(params["timeoutMs"] as? Int == 120_000)
        })
    }

    @Test(arguments: ["clawhub_download_blocked", "clawhub_security_unavailable"])
    func `trust failures remain terminal with warning details`(code: String) async throws {
        try await withClawHubConnection(response: { id in
            Data("""
            {"type":"res","id":"\(id)","ok":false,"error":{
              "code":"UNAVAILABLE","message":"Install was not started.",
              "details":{"clawhubTrustCode":"\(code)","version":"1.0.0","warning":"Audit details."}
            }}
            """.utf8)
        }, operation: { connection, recorder in
            let route = try await connection.captureRequiredRoute()
            do {
                _ = try await connection.skillsInstallClawHub(
                    slug: "@publisher/fixture-skill",
                    version: "1.0.0",
                    on: route)
                Issue.record("A rejected install must throw the Gateway error")
            } catch let error as GatewayResponseError {
                #expect(error.method == "skills.install")
                #expect(error.code == "UNAVAILABLE")
                #expect(error.message == "Install was not started.")
                #expect(error.details["clawhubTrustCode"]?.value as? String == code)
                #expect(error.details["warning"]?.value as? String == "Audit details.")
            }
            #expect(await recorder.snapshot().count == 1)
        })
    }
}

private actor ClawHubRequestRecorder {
    private var requests: [Data] = []

    func append(_ data: Data) {
        self.requests.append(data)
    }

    func snapshot() -> [Data] {
        self.requests
    }
}

private func withClawHubConnection(
    response: @escaping @Sendable (String) -> Data,
    operation: (GatewayConnection, ClawHubRequestRecorder) async throws -> Void) async throws
{
    let recorder = ClawHubRequestRecorder()
    let session = GatewayTestWebSocketSession(taskFactory: {
        GatewayTestWebSocketTask(sendHook: { task, message, sendIndex in
            guard sendIndex > 0 else { return }
            let data: Data = switch message {
            case let .data(data): data
            case let .string(text): Data(text.utf8)
            @unknown default: throw URLError(.cannotParseResponse)
            }
            await recorder.append(data)
            let id = try #require(GatewayWebSocketTestSupport.requestID(from: message))
            task.emitReceiveSuccess(.data(response(id)))
        })
    })
    let connection = GatewayConnection(
        configProvider: { (url: URL(string: "ws://127.0.0.1:1")!, token: nil, password: nil) },
        sessionBox: WebSocketSessionBox(session: session))
    do {
        try await operation(connection, recorder)
        await connection.shutdown()
    } catch {
        await connection.shutdown()
        throw error
    }
}
