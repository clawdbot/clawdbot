import ConcurrencyExtras
import Foundation
import Testing
@testable import OpenClaw
@testable import OpenClawKit

final class CronSourceFixture: @unchecked Sendable {
    struct Request: Sendable {
        let gateway: String
        let id: String
        let method: String
        let socket: GatewayTestWebSocketTask
    }

    let endpoint = LockIsolated(CronSourceFixture.endpoint(revision: 1))
    let requests = LockIsolated<[Request]>([])
    let emptyJobLists = LockIsolated(false)
    let gateway: GatewayConnection

    init(
        holding method: String? = nil,
        beforeEndpointLookup: (@Sendable () async throws -> Void)? = nil)
    {
        let endpoint = self.endpoint
        let requests = self.requests
        let emptyJobLists = self.emptyJobLists
        let session = GatewayTestWebSocketSession(taskFactory: {
            let owner = endpoint.value.revision == 1 ? "A" : "B"
            return GatewayTestWebSocketTask(sendHook: { socket, message, sendIndex in
                guard sendIndex > 0,
                      let data = Self.data(message),
                      let frame = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
                      let id = frame["id"] as? String,
                      let requestMethod = frame["method"] as? String
                else { return }
                let request = Request(
                    gateway: owner,
                    id: id,
                    method: requestMethod,
                    socket: socket)
                requests.withValue { $0.append(request) }
                if requestMethod != method { Self.respond(request, emptyJobList: emptyJobLists.value) }
            })
        })
        self.gateway = GatewayConnection(
            testEndpointProvider: {
                try await beforeEndpointLookup?()
                return endpoint.value
            },
            currentEndpointRevision: { endpoint.value.revision! },
            sessionBox: WebSocketSessionBox(session: session))
    }

    func adoptB() {
        self.endpoint.setValue(Self.endpoint(revision: 2))
    }

    static func configuration(revision: UInt64) -> [String: Any] {
        ["gateway": ["mode": "remote", "remote": ["transport": "direct", "url": "ws://127.0.0.1:\(49300 + revision)"]]]
    }

    private static func endpoint(revision: UInt64) -> GatewayConnection.EndpointSnapshot {
        GatewayConnection.EndpointSnapshot(
            config: (URL(string: "ws://127.0.0.1:\(49300 + revision)")!, nil, nil),
            routeAuthority: nil,
            deviceAuthGatewayID: GatewayDiscoveryPreferences.deviceAuthGatewayID(
                root: self.configuration(revision: revision)),
            revision: revision)
    }

    private static func data(_ message: URLSessionWebSocketTask.Message) -> Data? {
        switch message {
        case let .data(data): data
        case let .string(text): text.data(using: .utf8)
        @unknown default: nil
        }
    }

    static func fail(_ request: Request, message: String) {
        let response = #"{"type":"res","id":"\#(request.id)","ok":false,"# +
            #""error":{"code":"INVALID_REQUEST","message":"\#(message)"}}"#
        request.socket.emitReceiveSuccess(.data(Data(response.utf8)))
    }

    static func respond(_ request: Request, emptyJobList: Bool = false) {
        let payload = switch request.method {
        case "cron.list":
            emptyJobList ? #"{"jobs":[]}"# : #"""
            {"jobs":[{"id":"shared-job","name":"Gateway \#(request.gateway)","enabled":true,
            "createdAtMs":0,"updatedAtMs":0,"schedule":{"kind":"every","everyMs":1000},
            "sessionTarget":"isolated","wakeMode":"now","payload":{"kind":"systemEvent","text":"fixture"},"state":{}}]}
            """#
        default:
            #"{"ok":true}"#
        }
        request.socket.emitReceiveSuccess(.data(Data(
            #"{"type":"res","id":"\#(request.id)","ok":true,"payload":\#(payload)}"#.utf8)))
    }
}

@Suite(.serialized)
@MainActor
struct CronGatewayOwnershipTests {
    @Test(arguments: ["active replacement", "inactive replacement", "inactive same route"])
    func `unavailable selections keep Cron data scoped across active and stopped consumers`(
        scenario: String) async throws
    {
        try await TestIsolation.withIsolatedState {
            AppStateStore.shared.connectionMode = .unconfigured
            let unavailable = LockIsolated(false)
            let fixture = CronSourceFixture(beforeEndpointLookup: {
                if unavailable.value { throw URLError(.cannotConnectToHost) }
            })
            let store = CronJobsStore(gateway: fixture.gateway)
            var control: ControlChannel? = ControlChannel(
                gateway: fixture.gateway, endpointRevision: { fixture.endpoint.value.revision! })
            @MainActor func cleanup() async {
                control = nil
                store.stop()
                await fixture.gateway.shutdown()
            }
            do {
                let inactive = scenario.hasPrefix("inactive")
                let replacePrimary = scenario != "inactive same route"
                store.start()
                try await self
                    .waitUntil { store.jobs.count == 1 && control?.state == .connected }
                #expect(store.jobs.first?.name == "Gateway A")
                let requestCount = fixture.requests.value.count

                if inactive {
                    store.stop()
                    #expect(store.jobs.first?.name == "Gateway A")
                }
                unavailable.setValue(true)
                if replacePrimary { fixture.adoptB() }
                control?.endpointDidChange(.unavailable(
                    mode: .remote,
                    reason: "Synthetic Gateway unavailable",
                    routeRevision: fixture.endpoint.value.revision!))
                if inactive {
                    // The connection retires while the menu is not subscribed. Reopening
                    // must not display a foreign cache before its failed acquisition ends.
                    try await fixture.gateway.adoptSelectedEndpoint()
                    store.start()
                    #expect(store.jobs.isEmpty == replacePrimary)
                }

                #expect(store.jobs.isEmpty == replacePrimary)
                #expect(fixture.requests.value.dropFirst(requestCount).allSatisfy { $0.gateway == "A" })
            } catch {
                await cleanup()
                throw error
            }
            await cleanup()
        }
    }

    @Test func `source adoption rejects a late Cron list before socket replacement`() async throws {
        let fixture = CronSourceFixture(holding: "cron.list")
        let store = CronJobsStore(gateway: fixture.gateway)
        let refresh = Task { await store.refreshJobs() }
        do {
            try await self.waitUntil { fixture.requests.value.contains { $0.method == "cron.list" } }
            let held = try #require(fixture.requests.value.first { $0.method == "cron.list" })
            fixture.adoptB()
            CronSourceFixture.respond(held)
            await refresh.value
            #expect(store.jobs.isEmpty)
        } catch {
            store.stop()
            refresh.cancel()
            await fixture.gateway.shutdown()
            await refresh.value
            throw error
        }
        store.stop()
        await fixture.gateway.shutdown()
    }

    @Test(arguments: ["local", "direct", "ssh"])
    func `supported Primary routes retain distinct auth and existing cache identities`(transport: String) async {
        await TestIsolation.withIsolatedState {
            let root: [String: Any] = switch transport {
            case "local": ["gateway": ["mode": "local"]]
            case "direct": CronSourceFixture.configuration(revision: 1)
            default:
                [
                    "gateway": [
                        "mode": "remote",
                        "remote": ["transport": "ssh", "sshTarget": "user@gateway.test", "remotePort": 49311],
                    ],
                ]
            }
            #expect(GatewayDiscoveryPreferences.deviceAuthGatewayID(root: root) != nil)
            let expected = MacChatTranscriptCache.gatewayID(
                mode: transport == "local" ? .local : .remote,
                localStateDir: OpenClawConfigFile.stateDirURL(),
                remoteTransport: transport == "direct" ? .direct : .ssh,
                directURL: URL(string: "ws://127.0.0.1:49301"),
                sshTarget: "user@gateway.test",
                sshRemotePort: 49311)
            #expect(MacChatTranscriptCache.gatewayID(root: root) == expected)
        }
    }

    private func waitUntil(_ condition: () -> Bool) async throws {
        let deadline = ContinuousClock.now + .seconds(2)
        while !condition(), ContinuousClock.now < deadline {
            try await Task.sleep(for: .milliseconds(2))
        }
        try #require(condition())
    }
}
