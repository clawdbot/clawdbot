import Foundation
import OpenClawIPC
import Testing
@testable import OpenClaw

@Suite(.serialized)
@MainActor
struct MacControlRequestHandlerTests {
    @Test func `status removes credentials and raw connection errors from JSON`() async throws {
        let owner = FakeMacControlOwner()
        let sensitiveURL = "wss://operator:password-value@gateway.example/path?token=query-secret#fragment-secret"
        owner.primary.url = sensitiveURL
        owner.primary.connection.error = "Authorization failed with token error-secret"
        owner.profiles = [Self.profile(id: "one", name: "Research", url: sensitiveURL)]
        let handler = MacControlRequestHandler(owner: owner)
        let data = await handler.handle(MacControlRequest(operation: "status"))
        let response = try JSONDecoder().decode(MacControlResponse<MacControlStatus>.self, from: data)
        let status = try #require(response.result)
        #expect(response.ok)
        #expect(status.primary.url == "wss://gateway.example/path")
        #expect(status.gateways.first?.url == "wss://gateway.example/path")
        let json = String(decoding: data, as: UTF8.self)
        for secret in ["password-value", "query-secret", "fragment-secret", "error-secret"] {
            #expect(!json.contains(secret))
        }
        #expect(status.primary.connection.error != nil)
        #expect(owner.removedIDs.isEmpty)
    }

    @Test func `name resolution prefers exact IDs and rejects ambiguous names before removal`() async throws {
        let owner = FakeMacControlOwner()
        owner.profiles = [
            Self.profile(id: "first", name: "Research"),
            Self.profile(id: "second", name: "research"),
            Self.profile(id: "Research", name: "Production"),
        ]
        let handler = MacControlRequestHandler(owner: owner)
        var request = MacControlRequest(operation: "gateway.remove")
        request.idOrName = "RESEARCH"
        let ambiguous = try await Self.error(handler, request)
        #expect(ambiguous.code == "ambiguous_name")
        #expect(ambiguous.message.contains("first"))
        #expect(ambiguous.message.contains("second"))
        #expect(owner.removedIDs.isEmpty)
        request.idOrName = "Research"
        _ = await handler.handle(request)
        #expect(owner.removedIDs == ["Research"])
        request.idOrName = "missing"
        #expect(try await Self.error(handler, request).code == "not_found")
        request.idOrName = "production"
        _ = await handler.handle(request)
        #expect(owner.removedIDs == ["Research", "Research"])
    }

    @Test func `primary set passes the complete request to its owner and returns only status`() async throws {
        let owner = FakeMacControlOwner()
        let handler = MacControlRequestHandler(owner: owner)
        var request = MacControlRequest(operation: "primary.set")
        request.transport = "ssh"
        request.sshTarget = "alice@gateway.example:2222"
        request.remotePort = 18789
        request.localPort = 19089
        request.identityPath = "/keys/gateway"
        request.hostKeyPolicy = "openssh"
        request.token = "submitted-secret"
        let data = await handler.handle(request)
        let response = try JSONDecoder().decode(MacControlResponse<MacControlPrimaryStatus>.self, from: data)
        #expect(response.ok)
        #expect(!String(decoding: data, as: UTF8.self).contains("submitted-secret"))
        guard case let .ssh(target, remotePort, localPort, identity, hostKeyPolicy, token, password) = owner.selection
        else {
            Issue.record("Primary selection was not passed to its owner")
            return
        }
        #expect(target == "alice@gateway.example:2222")
        #expect(remotePort == 18789)
        #expect(localPort == 19089)
        #expect(identity == "/keys/gateway")
        #expect(hostKeyPolicy == .openssh)
        #expect(token == "submitted-secret")
        #expect(password == nil)
    }

    @Test func `invalid operations and mixed configuration do not reach mutation owners`() async throws {
        let owner = FakeMacControlOwner()
        let handler = MacControlRequestHandler(owner: owner)
        var request = MacControlRequest(operation: "primary.set")
        request.mode = "local"
        request.transport = "ssh"
        #expect(try await Self.error(handler, request).code == "invalid_request")
        #expect(owner.selection == nil)
        var add = MacControlRequest(operation: "gateway.add")
        add.name = "Research"
        add.url = "https://gateway.example"
        #expect(try await Self.error(handler, add).code == "invalid_request")
        #expect(owner.addCount == 0)
        #expect(try await Self.error(handler, MacControlRequest(operation: "exec")).code == "invalid_request")
    }

    @Test func `in flight browser sign in rejects another mutation but permits status`() async throws {
        let owner = FakeMacControlOwner()
        owner.holdSignIn = true
        let handler = MacControlRequestHandler(owner: owner)
        var add = MacControlRequest(operation: "gateway.add")
        add.name = "Research"
        add.url = "https://gateway.example"
        add.browser = true
        let first = Task { await handler.handle(add) }
        while owner.signInContinuation == nil {
            await Task.yield()
        }
        let blocked = try await Self.error(handler, MacControlRequest(operation: "primary.clear"))
        #expect(blocked.code == "busy")
        let statusData = await handler.handle(MacControlRequest(operation: "status"))
        #expect(try JSONDecoder().decode(MacControlResponse<MacControlStatus>.self, from: statusData).ok)
        owner.signInContinuation?.resume()
        owner.signInContinuation = nil
        let data = await first.value
        #expect(try JSONDecoder().decode(MacControlResponse<MacControlGatewayStatus>.self, from: data).ok)
        _ = await handler.handle(MacControlRequest(operation: "primary.clear"))
        guard case .clear = owner.selection else {
            Issue.record("Mutation admission did not reopen after browser sign-in")
            return
        }
    }

    @Test func `underlying failures never echo submitted secrets and release mutation admission`() async throws {
        let owner = FakeMacControlOwner()
        owner.failure = NSError(
            domain: "test",
            code: 1,
            userInfo: [NSLocalizedDescriptionKey: "token submitted-secret"])
        let handler = MacControlRequestHandler(owner: owner)
        var request = MacControlRequest(operation: "gateway.add")
        request.name = "Research"
        request.url = "https://gateway.example"
        request.token = "submitted-secret"
        let error = try await Self.error(handler, request)
        #expect(error.code == "operation_failed")
        #expect(!error.message.contains("submitted-secret"))
        owner.failure = nil
        let data = await handler.handle(request)
        #expect(try JSONDecoder().decode(MacControlResponse<MacControlGatewayStatus>.self, from: data).ok)
    }

    private static func error(
        _ handler: MacControlRequestHandler,
        _ request: MacControlRequest) async throws -> MacControlError
    {
        let data = await handler.handle(request)
        let response = try JSONDecoder().decode(MacControlResponse<String>.self, from: data)
        #expect(!response.ok)
        return try #require(response.error)
    }

    fileprivate static func profile(
        id: String, name: String, url: String = "wss://gateway.example/") -> MacControlGatewayStatus
    {
        MacControlGatewayStatus(
            id: id, name: name, url: url, auth: "token", connection: MacControlConnectionStatus(state: "disconnected"))
    }
}

@MainActor
private final class FakeMacControlOwner: MacControlOwner {
    var primary = MacControlPrimaryStatus(
        mode: "unconfigured", transport: nil, url: "",
        tunnel: MacControlTunnelStatus(running: false), connection: MacControlConnectionStatus(state: "disconnected"))
    var profiles: [MacControlGatewayStatus] = []
    var selection: PrimaryGatewayControlConfiguration?
    var removedIDs: [String] = []
    var addCount = 0
    var failure: Error?
    var holdSignIn = false
    var signInContinuation: CheckedContinuation<Void, Never>?

    func status() async throws -> MacControlStatus {
        MacControlStatus(
            primary: self.primary, gateways: self.profiles,
            app: MacControlAppStatus(version: "1", build: "1", profile: "test"))
    }

    func setPrimary(_ configuration: PrimaryGatewayControlConfiguration) async throws -> MacControlPrimaryStatus {
        self.selection = configuration
        return self.primary
    }

    func gateways() async throws -> [MacControlGatewayStatus] {
        self.profiles
    }

    func addGateway(_ request: MacControlRequest) async throws -> MacControlGatewayStatus {
        self.addCount += 1
        if let failure { throw failure }
        if self.holdSignIn {
            await withCheckedContinuation { self.signInContinuation = $0 }
        }
        return MacControlRequestHandlerTests.profile(id: "saved", name: request.name ?? "")
    }

    func removeGateway(id: String) async throws {
        self.removedIDs.append(id)
    }

    func reconnectGateway(id: String) async throws -> MacControlGatewayStatus {
        MacControlRequestHandlerTests.profile(id: id, name: "Research")
    }
}
