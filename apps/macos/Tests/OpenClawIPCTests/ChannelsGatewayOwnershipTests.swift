import ConcurrencyExtras
import Foundation
import Testing
@testable import OpenClaw
@testable import OpenClawKit

private final class ChannelsReplyGate: @unchecked Sendable {
    let waiting = LockIsolated(false)
    private struct State {
        var released = false
        var continuation: CheckedContinuation<Void, Never>?
    }

    private let state = LockIsolated(State())

    func wait() async {
        await withCheckedContinuation { continuation in
            let released = self.state.withValue { state in
                guard !state.released else { return true }
                state.continuation = continuation
                return false
            }
            if released { continuation.resume() }
            self.waiting.setValue(true)
        }
    }

    func resume() {
        let continuation = self.state.withValue { state in
            state.released = true
            defer { state.continuation = nil }
            return state.continuation
        }
        continuation?.resume()
    }
}

private final class ChannelsGatewayFixture: @unchecked Sendable {
    struct Call: Sendable {
        let server: UInt64
        let method: String
        let channel: String?
        let qr: String?
        let sessionKey: String?
        let raw: String?
        let baseHash: String?
    }

    let revision = LockIsolated<UInt64>(1)
    let calls = LockIsolated<[Call]>([])
    let acceptedWrites = LockIsolated<[Call]>([])
    let gate = ChannelsReplyGate()
    let heldMethod: LockIsolated<String?>
    let gateway: GatewayConnection
    let session: GatewayTestWebSocketSession

    init(heldMethod: String? = nil, rejectedMethod: String? = nil, rejectionCode: String = "INVALID_REQUEST") {
        self.heldMethod = LockIsolated(heldMethod)
        let heldMethod = self.heldMethod
        let revision = self.revision
        let calls = self.calls
        let acceptedWrites = self.acceptedWrites
        let gate = self.gate
        let session = GatewayTestWebSocketSession {
            let server = revision.value
            return GatewayTestWebSocketTask(sendHook: { socket, message, index in
                guard index > 0 else { return }
                let data: Data
                switch message {
                case let .data(value): data = value
                case let .string(value): data = Data(value.utf8)
                @unknown default: return
                }
                guard let frame = try JSONSerialization.jsonObject(with: data) as? [String: Any],
                      let id = frame["id"] as? String, let method = frame["method"] as? String
                else { return }
                let params = frame["params"] as? [String: Any] ?? [:]
                let call = Call(
                    server: server,
                    method: method,
                    channel: params["channel"] as? String,
                    qr: params["currentQrDataUrl"] as? String,
                    sessionKey: params["sessionKey"] as? String,
                    raw: params["raw"] as? String,
                    baseHash: params["baseHash"] as? String)
                calls.withValue { $0.append(call) }
                if method == rejectedMethod {
                    try socket.emitReceiveSuccess(.data(Self.rejectionResponse(
                        id: id, method: method, code: rejectionCode)))
                    return
                }
                let payload: String
                switch method {
                case "channels.status":
                    payload = #"""
                    {"ts":\#(server),"channelOrder":["whatsapp"],"channelLabels":{"whatsapp":"WhatsApp"},
                     "channels":{},"channelAccounts":{},"channelDefaultAccountId":{}}
                    """#
                case "web.login.start":
                    payload = #"""
                    {"message":"Scan Gateway \#(server)","qrDataUrl":"data:image/png;base64,gateway-\#(server)",
                     "sessionKey":"opaque-gateway-\#(server)"}
                    """#
                case "web.login.wait":
                    payload = #"{"message":"Connected Gateway \#(server)","connected":true}"#
                case "config.get":
                    payload = ##"""
                    {"hash":"server-\##(server)","valid":true,"config":{"ui":{"seamColor":"#\##(server)11111"}}}
                    """##
                case "config.set":
                    guard call.baseHash == "server-\(server)" else {
                        socket.emitReceiveSuccess(.string(
                            #"""
                            {"type":"res","id":"\#(id)","ok":false,
                             "error":{"code":"INVALID_REQUEST","message":"base hash mismatch"}}
                            """#))
                        return
                    }
                    acceptedWrites.withValue { $0.append(call) }
                    payload = #"{"hash":"server-\#(server)"}"#
                default:
                    payload = #"{"ok":true}"#
                }
                let shouldHold = heldMethod.withValue { held in
                    guard held == method else { return false }
                    held = nil
                    return true
                }
                if shouldHold { await gate.wait() }
                socket.emitReceiveSuccess(.string(
                    #"{"type":"res","id":"\#(id)","ok":true,"payload":\#(payload)}"#))
            }, receiveHook: { socket, index in
                if index == 0 { return .data(GatewayWebSocketTestSupport.connectChallengeData()) }
                let id = socket.snapshotConnectRequestID() ?? "connect"
                if rejectedMethod == "connect" {
                    return .data(GatewayWebSocketTestSupport.connectAuthFailureData(
                        id: id, detailCode: "AUTH_TOKEN_MISMATCH", message: "unauthorized: gateway token mismatch"))
                }
                return .data(GatewayWebSocketTestSupport.connectOkData(id: id))
            })
        }
        self.session = session
        self.gateway = GatewayConnection(
            testEndpointProvider: {
                let value = revision.value
                return .init(
                    config: (URL(string: "ws://127.0.0.1:\(33000 + value)")!, nil, nil),
                    routeAuthority: value,
                    revision: value)
            },
            currentEndpointRevision: { revision.value },
            sessionBox: WebSocketSessionBox(session: session))
    }

    private static func rejectionResponse(id: String, method: String, code: String) throws -> Data {
        let scope = method == "config.set" ? "operator.admin" : "operator.read"
        let message = switch code {
        case "UNAVAILABLE": "gateway unavailable"
        case "FORBIDDEN": "missing scope: \(scope)"
        default: "unauthorized role: node"
        }
        var error: [String: Any] = ["code": code, "message": message]
        if code == "FORBIDDEN" {
            error["details"] = [
                "code": "MISSING_SCOPE", "missingScope": scope, "requiredScopes": [scope],
            ]
        }
        let response: [String: Any] = ["type": "res", "id": id, "ok": false, "error": error]
        return try JSONSerialization.data(withJSONObject: response)
    }
}

@Suite(.serialized)
@MainActor
struct ChannelsGatewayOwnershipTests {
    @Test(arguments: [false, true])
    func `channel status cannot publish after its Primary changes`(switchPrimary: Bool) async throws {
        try await self.withStore(heldMethod: "channels.status") { fixture, store in
            let refresh = Task { await store.refresh(probe: false) }
            defer { refresh.cancel() }
            try await self.waitUntil { fixture.gate.waiting.value }
            if switchPrimary { fixture.revision.setValue(2) }
            fixture.gate.resume()
            await refresh.value
            #expect(switchPrimary ? store.snapshot?.ts != 1 : store.snapshot?.ts == 1)
        }
    }

    @Test(arguments: [false, true])
    func `automatic QR wait remains owned by the login origin`(switchPrimary: Bool) async throws {
        try await self.withStore(heldMethod: "channels.status") { fixture, store in
            let login = Task { await store.startWhatsAppLogin(force: false) }
            defer { login.cancel() }
            try await self.waitUntil { fixture.gate.waiting.value }
            #expect(store.whatsappLoginQrDataUrl == "data:image/png;base64,gateway-1")
            #expect(store.whatsappLoginSessionKey == "opaque-gateway-1")
            if switchPrimary { fixture.revision.setValue(2) }
            fixture.gate.resume()
            await login.value
            if switchPrimary {
                try await Task.sleep(for: .milliseconds(200))
            } else {
                try await self.waitUntil { fixture.calls.value.contains { $0.method == "web.login.wait" } }
            }
            let waits = fixture.calls.value.filter { $0.method == "web.login.wait" }
            #expect(waits.allSatisfy { $0.server == 1 })
            if !switchPrimary {
                #expect(waits.count == 1)
                #expect(waits.first?.qr == "data:image/png;base64,gateway-1")
                #expect(waits.first?.sessionKey == "opaque-gateway-1")
                #expect(waits.first?.channel == "whatsapp")
            }
        }
    }

    @Test(arguments: [false, true])
    func `a config draft cannot be saved through another Gateway revision token`(switchPrimary: Bool) async throws {
        try await self.withStore { fixture, store in
            await store.loadConfig()
            store.updateConfigValue(path: [.key("ui"), .key("seamColor")], value: "#aabbcc")
            if switchPrimary { fixture.revision.setValue(2) }
            await store.saveConfigDraft()
            let writes = fixture.acceptedWrites.value
            #expect(writes.allSatisfy { $0.server == 1 })
            if !switchPrimary {
                #expect(writes.count == 1)
                #expect(writes.first?.raw?.contains("#aabbcc") == true)
            }
        }
    }

    @Test(arguments: [false, true])
    func `shared config documents preserve their read origin`(switchPrimary: Bool) async throws {
        try await self.withStore { fixture, _ in
            var document = await ConfigStore.load(gateway: fixture.gateway)
            document.root["browser"] = ["enabled": false]
            if switchPrimary { fixture.revision.setValue(2) }
            var didThrow = false
            do { try await ConfigStore.save(document) } catch { didThrow = true }
            #expect(didThrow == switchPrimary)
            #expect(fixture.acceptedWrites.value.count == (switchPrimary ? 0 : 1))
            #expect(fixture.acceptedWrites.value.allSatisfy { $0.server == 1 })
        }
    }

    @Test func `a config document keeps its revision across a same-route reconnect`() async throws {
        try await self.withStore { fixture, _ in
            var document = await ConfigStore.load(gateway: fixture.gateway)
            let lease = try await fixture.gateway.acquireServerLease()
            let socket = try #require(fixture.session.latestTask())
            socket.emitReceiveFailure()
            try await self.waitUntil { !fixture.gateway.serverLeaseMatchesCurrentState(lease) }
            document.root["browser"] = ["enabled": false]
            try await ConfigStore.save(document)
            #expect(document.isCurrent)
            #expect(fixture.session.snapshotMakeCount() == 2)
            let write = try #require(fixture.acceptedWrites.value.last)
            #expect(write.server == 1)
            #expect(write.baseHash == "server-1")
            #expect(write.raw?.contains("browser") == true)
        }
    }

    @Test func `automatic QR wait survives a same-route reconnect`() async throws {
        try await self.withStore(heldMethod: "channels.status") { fixture, store in
            let login = Task { await store.startWhatsAppLogin(force: false) }
            defer { login.cancel() }
            try await self.waitUntil { fixture.gate.waiting.value }
            let lease = try #require(await fixture.gateway.captureServerLease())
            let socket = try #require(fixture.session.latestTask())
            socket.emitReceiveFailure()
            try await self.waitUntil { !fixture.gateway.serverLeaseMatchesCurrentState(lease) }
            fixture.gate.resume()
            await login.value
            try await self.waitUntil { store.whatsappLoginConnected == true }
            #expect(fixture.session.snapshotMakeCount() == 2)
            let wait = try #require(fixture.calls.value.first { $0.method == "web.login.wait" })
            #expect(wait.server == 1)
            #expect(wait.qr == "data:image/png;base64,gateway-1")
            #expect(wait.sessionKey == "opaque-gateway-1")
            #expect(wait.channel == "whatsapp")
            #expect(store.whatsappLoginSessionKey == nil)
        }
    }

    @Test(arguments: ["connect", "config.get", "scope-get", "scope-set", "offline"])
    func `local config fallback cannot bypass Gateway rejection`(failure: String) async throws {
        let unavailable = failure == "offline"
        let method = switch failure {
        case "connect": "connect"
        case "scope-set": "config.set"
        default: "config.get"
        }
        let code = unavailable ? "UNAVAILABLE" : failure.hasPrefix("scope-") ? "FORBIDDEN" : "INVALID_REQUEST"
        try await self.withStore(rejectedMethod: method, rejectionCode: code) { fixture, _ in
            let (url, before) = try self.seedLocalConfig()
            await ConfigStore._testSetOverrides(.init(
                isRemoteMode: { false }, notificationCenter: NotificationCenter()))
            var document = await ConfigStore.load(gateway: fixture.gateway)
            document.root["browser"] = ["enabled": false]
            var didThrow = false
            do { try await ConfigStore.save(document) } catch { didThrow = true }
            let after = try Data(contentsOf: url)
            #expect(didThrow == !unavailable)
            #expect((after == before) == !unavailable)
        }
    }

    @Test(arguments: [false, true])
    func `local save fallback preserves disconnects but rejects route retirement`(retireRoute: Bool) async throws {
        try await self.withStore(heldMethod: "config.set") { fixture, _ in
            let (url, before) = try self.seedLocalConfig()
            await ConfigStore._testSetOverrides(.init(
                isRemoteMode: { false }, notificationCenter: NotificationCenter()))
            var document = await ConfigStore.load(gateway: fixture.gateway)
            document.root["browser"] = ["enabled": false]
            let lease = try #require(await fixture.gateway.captureServerLease())
            let save = Task { () -> Bool in
                do { try await ConfigStore.save(document)
                    return false
                } catch { return true }
            }
            defer { save.cancel() }
            try await self.waitUntil { fixture.gate.waiting.value }
            if retireRoute {
                await fixture.gateway.shutdown()
            } else {
                let socket = try #require(fixture.session.latestTask())
                socket.emitReceiveFailure()
                try await self.waitUntil { !fixture.gateway.serverLeaseMatchesCurrentState(lease) }
            }
            fixture.gate.resume()
            let didThrow = await save.value
            let after = try Data(contentsOf: url)
            #expect(didThrow == retireRoute)
            #expect((after == before) == retireRoute)
        }
    }

    @Test func `an interrupted automatic QR wait resumes on the same route`() async throws {
        try await self.withStore(heldMethod: "web.login.wait") { fixture, store in
            await store.startWhatsAppLogin(force: false)
            try await self.waitUntil { fixture.gate.waiting.value }
            let lease = try #require(await fixture.gateway.captureServerLease())
            let socket = try #require(fixture.session.latestTask())
            socket.emitReceiveFailure()
            try await self.waitUntil { !fixture.gateway.serverLeaseMatchesCurrentState(lease) }
            fixture.gate.resume()
            try await self.waitUntil { !store.whatsappBusy }
            let waits = fixture.calls.value.filter { $0.method == "web.login.wait" }
            #expect(store.whatsappLoginConnected == true)
            #expect(waits.count == 2)
            #expect(waits.allSatisfy { $0.server == 1 && $0.qr == "data:image/png;base64,gateway-1" })
            #expect(waits.allSatisfy { $0.channel == "whatsapp" && $0.sessionKey == "opaque-gateway-1" })
            #expect(store.whatsappLoginSessionKey == nil)
        }
    }

    @Test func `an authoritative QR wait rejection does not retry`() async throws {
        try await self.withStore(rejectedMethod: "web.login.wait") { fixture, store in
            await store.startWhatsAppLogin(force: false)
            try await self.waitUntil {
                fixture.calls.value.contains { $0.method == "web.login.wait" } && !store.whatsappBusy
            }
            #expect(fixture.calls.value.count { $0.method == "web.login.wait" } == 1)
            #expect(store.whatsappLoginMessage?.contains("unauthorized") == true)
        }
    }

    @Test func `interrupted QR wait cannot reconnect after Primary replacement`() async throws {
        try await self.withStore(heldMethod: "web.login.wait") { fixture, store in
            await store.startWhatsAppLogin(force: false)
            try await self.waitUntil { fixture.gate.waiting.value }
            let socket = try #require(fixture.session.latestTask())
            fixture.revision.setValue(2)
            socket.emitReceiveFailure()
            fixture.gate.resume()
            await store.refresh(probe: false)
            try await Task.sleep(for: .milliseconds(200))
            #expect(store.snapshot?.ts == 2)
            #expect(store.whatsappLoginQrDataUrl == nil)
            #expect(store.whatsappLoginSessionKey == nil)
            let waits = fixture.calls.value.filter { $0.method == "web.login.wait" }
            #expect(waits.count == 1)
            #expect(waits.allSatisfy { $0.server == 1 })
        }
    }

    private func seedLocalConfig() throws -> (URL, Data) {
        let url = OpenClawConfigFile.url()
        try FileManager.default.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
        let data = Data(#"{"gateway":{"mode":"local"},"browser":{"enabled":true}}"#.utf8)
        try data.write(to: url)
        return (url, data)
    }

    private func withStore(
        heldMethod: String? = nil,
        rejectedMethod: String? = nil,
        rejectionCode: String = "INVALID_REQUEST",
        operation: (ChannelsGatewayFixture, ChannelsStore) async throws -> Void) async throws
    {
        try await TestIsolation.withIsolatedState {
            let fixture = ChannelsGatewayFixture(
                heldMethod: heldMethod, rejectedMethod: rejectedMethod, rejectionCode: rejectionCode)
            let store = ChannelsStore(isPreview: true, gateway: fixture.gateway)
            await ConfigStore._testSetOverrides(.init(
                isRemoteMode: { true }, notificationCenter: NotificationCenter()))
            let result: Result<Void, Error>
            do { result = try await .success(operation(fixture, store)) } catch { result = .failure(error) }
            fixture.gate.resume()
            await fixture.gateway.shutdown()
            await ConfigStore._testClearOverrides()
            try result.get()
        }
    }

    private func waitUntil(_ predicate: @MainActor () -> Bool) async throws {
        let deadline = ContinuousClock.now + .seconds(3)
        while !predicate(), ContinuousClock.now < deadline {
            try await Task.sleep(for: .milliseconds(10))
        }
        try #require(predicate())
    }
}
