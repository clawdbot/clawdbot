import ConcurrencyExtras
import Foundation
import Observation
import OpenClawKit
import Testing
@testable import OpenClaw

private enum SkillsFixtureMutation: String, CaseIterable {
    case apiKey
    case environment
    case enabled
}

private enum SkillsGatewayTransition: String, CaseIterable {
    case unchanged
    case reconnect
    case replacement
}

private struct SkillsFixtureRequest: Sendable {
    let url: URL
    let method: String
    let skillKey: String?
    let apiKey: String?
    let environment: [String: String]?
    let enabled: Bool?
    let reference: String?
}

private final class SkillsGatewayFixture: Sendable {
    let source: LockIsolated<URL>
    let requests: LockIsolated<[SkillsFixtureRequest]>
    let rejectedMethods: LockIsolated<Set<String>>
    let gateway: GatewayConnection
    let session: GatewayTestWebSocketSession

    init(
        installOnly: Bool = false,
        rejectedMethods: Set<String> = [],
        beforeConnect: @escaping @Sendable () throws -> Void = {},
        beforeEndpointLookup: @escaping @Sendable (URL) async -> Void = { _ in },
        beforeResponse: @escaping @Sendable (SkillsFixtureRequest) async -> Void = { _ in })
    {
        let source = LockIsolated(URL(string: "ws://127.0.0.1:49340/")!)
        let requests = LockIsolated<[SkillsFixtureRequest]>([])
        let rejectedMethods = LockIsolated(rejectedMethods)
        self.source = source
        self.requests = requests
        self.rejectedMethods = rejectedMethods
        let installed = LockIsolated<[URL: String]>([:])
        let session = GatewayTestWebSocketSession(taskFactory: {
            let url = source.value
            return GatewayTestWebSocketTask(sendHook: { socket, message, sendIndex in
                guard sendIndex > 0 else {
                    try beforeConnect()
                    return
                }
                let data: Data = switch message {
                case let .data(data): data
                case let .string(text): Data(text.utf8)
                @unknown default: throw URLError(.cannotParseResponse)
                }
                let frame = try #require(JSONSerialization.jsonObject(with: data) as? [String: Any])
                let id = try #require(frame["id"] as? String)
                let method = try #require(frame["method"] as? String)
                let params = frame["params"] as? [String: Any]
                let request = SkillsFixtureRequest(
                    url: url,
                    method: method,
                    skillKey: params?["skillKey"] as? String,
                    apiKey: params?["apiKey"] as? String,
                    environment: params?["env"] as? [String: String],
                    enabled: params?["enabled"] as? Bool,
                    reference: params?["slug"] as? String)
                requests.withValue { $0.append(request) }
                await beforeResponse(request)
                if rejectedMethods.value.contains(method) {
                    socket.emitReceiveSuccess(.data(Data("""
                    {"type":"res","id":"\(id)","ok":false,
                    "error":{"code":"UNAVAILABLE","message":"Synthetic Gateway A read failure"}}
                    """.utf8)))
                    return
                }
                if method == "skills.install", let reference = params?["slug"] as? String {
                    installed.withValue { $0[url] = reference }
                }
                let payload: Data = if method == "skills.status" {
                    try JSONEncoder().encode(Self.report(
                        gateway: url.port == 49340 ? "A" : "B",
                        installedReference: installed.value[url]))
                } else if method == "skills.update" {
                    Data(#"{"ok":true,"skillKey":"shared-skill"}"#.utf8)
                } else if method == "skills.search", params?["query"] as? String == "missing-skill" {
                    Data(#"{"results":[]}"#.utf8)
                } else if method == "skills.search" {
                    try JSONSerialization.data(withJSONObject: ["results": [[
                        "slug": "fixture-skill",
                        "installRef": installOnly ? "skills-sh:fixture/skills/fixture-skill" : "@fixture/fixture-skill",
                        "installOnly": installOnly,
                        "displayName": "Fixture skill",
                        "version": "1.0.0",
                    ]]])
                } else if method == "skills.detail" {
                    Data("""
                    {"skill":{"slug":"fixture-skill","displayName":"Fixture skill"},
                    "latestVersion":{"version":"1.0.0"},"owner":{"handle":"fixture"}}
                    """.utf8)
                } else if method == "skills.install" {
                    Data("""
                    {"ok":true,"message":"Installed fixture skill","warning":"Synthetic install audit warning"}
                    """.utf8)
                } else {
                    Data(#"{"ok":true}"#.utf8)
                }
                let json = try #require(String(data: payload, encoding: .utf8))
                socket.emitReceiveSuccess(.data(Data(
                    #"{"type":"res","id":"\#(id)","ok":true,"payload":\#(json)}"#.utf8)))
            })
        })
        self.session = session
        self.gateway = GatewayConnection(
            testEndpointProvider: {
                let url = source.value
                await beforeEndpointLookup(url)
                return GatewayConnection.EndpointSnapshot(
                    config: (url, nil, nil), routeAuthority: nil, revision: UInt64(url.port ?? 0))
            },
            currentEndpointRevision: { UInt64(source.value.port ?? 0) },
            sessionBox: WebSocketSessionBox(session: session))
    }

    func selectB() async throws {
        self.source.withValue { $0 = URL(string: "ws://127.0.0.1:49341/")! }
        _ = try await self.gateway.acquireServerLease()
    }

    func transition(_ transition: SkillsGatewayTransition) async throws {
        switch transition {
        case .unchanged:
            break
        case .replacement:
            try await self.selectB()
        case .reconnect:
            let source = try await self.gateway.acquireServerLease()
            self.session.latestTask()?.emitReceiveFailure()
            let deadline = ContinuousClock.now + .seconds(2)
            while self.gateway.serverLeaseMatchesCurrentState(source), ContinuousClock.now < deadline {
                try await Task.sleep(for: .milliseconds(5))
            }
            try #require(!self.gateway.serverLeaseMatchesCurrentState(source))
            let replacement = try await self.gateway.acquireServerLease()
            #expect(replacement != source)
        }
    }

    private static func report(gateway: String, installedReference: String?) throws -> SkillsStatusReport {
        let clawhub = try installedReference.map { reference in
            try JSONDecoder().decode(ClawHubInstalledSkillLink.self, from: JSONSerialization.data(withJSONObject: [
                "status": "installed",
                "valid": true,
                "slug": "fixture-skill",
                "ownerHandle": "fixture",
                "requestedReference": reference,
                "installedVersion": "1.0.0",
            ]))
        }
        return SkillsStatusReport(
            workspaceDir: "/tmp/skills-fixture/\(gateway)",
            managedSkillsDir: "/tmp/skills-fixture/\(gateway)/skills",
            skills: [SkillStatus(
                name: "Gateway \(gateway) skill",
                description: "Synthetic skill from Gateway \(gateway)",
                source: "openclaw-workspace",
                filePath: "/tmp/skills-fixture/\(gateway)/SKILL.md",
                baseDir: "/tmp/skills-fixture/\(gateway)",
                skillKey: "shared-skill",
                primaryEnv: "FIXTURE_SKILL_KEY",
                emoji: nil,
                homepage: nil,
                always: false,
                disabled: false,
                eligible: true,
                requirements: SkillRequirements(bins: [], env: [], config: []),
                missing: SkillMissing(bins: [], env: [], config: []),
                configChecks: [],
                install: [],
                clawhub: clawhub)])
    }

    @MainActor
    func withModel(_ body: @MainActor (SkillsSettingsModel) async throws -> Void) async throws {
        let model = SkillsSettingsModel(gateway: self.gateway)
        let observation = Task { await model.run() }
        do {
            try await body(model)
        } catch {
            observation.cancel()
            await observation.value
            await self.gateway.shutdown()
            throw error
        }
        observation.cancel()
        await observation.value
        await self.gateway.shutdown()
    }
}

private actor SkillsResponseGate {
    private var continuation: CheckedContinuation<Void, Never>?
    private var released = false

    func wait() async {
        if self.released { return }
        await withCheckedContinuation { self.continuation = $0 }
    }

    func release() {
        self.released = true
        self.continuation?.resume()
        self.continuation = nil
    }
}

@MainActor
struct SkillsGatewayOwnershipTests {
    @Test(arguments: SkillsFixtureMutation.allCases, SkillsGatewayTransition.allCases)
    private func `retained skill actions stay with their displayed gateway`(
        mutation: SkillsFixtureMutation,
        transition: SkillsGatewayTransition) async throws
    {
        let fixture = SkillsGatewayFixture()
        try await fixture.withModel { model in
            try #require(await self.waitUntil { model.skills.first?.name == "Gateway A skill" })
            let captured = try #require(model.skills.first)
            let source = try #require(model.catalog?.source)
            let replaceGateway = transition == .replacement
            try await fixture.transition(transition)

            switch mutation {
            case .apiKey:
                let error = await model.updateEnv(
                    skillKey: captured.skillKey,
                    envKey: "FIXTURE_SKILL_KEY",
                    value: "synthetic-value-from-a",
                    isPrimary: true,
                    source: source)
                #expect((error != nil) == replaceGateway)
            case .environment:
                let error = await model.updateEnv(
                    skillKey: captured.skillKey,
                    envKey: "FIXTURE_SKILL_ENV",
                    value: "synthetic-value-from-a",
                    isPrimary: false,
                    source: source)
                #expect((error != nil) == replaceGateway)
            case .enabled:
                await model.setEnabled(skillKey: captured.skillKey, enabled: false, source: source)
            }

            let writes = fixture.requests.value.filter { $0.method == "skills.update" }
            #expect(writes.count == (replaceGateway ? 0 : 1))
            #expect(writes.allSatisfy { $0.url.port == 49340 })
            if !replaceGateway {
                let write = try #require(writes.first)
                #expect(write.skillKey == "shared-skill")
                switch mutation {
                case .apiKey: #expect(write.apiKey == "synthetic-value-from-a")
                case .environment: #expect(write.environment == ["FIXTURE_SKILL_ENV": "synthetic-value-from-a"])
                case .enabled: #expect(write.enabled == false)
                }
            }
        }
    }

    @Test func `replacement hello refreshes the visible skill catalog`() async throws {
        let fixture = SkillsGatewayFixture()
        try await fixture.withModel { model in
            try #require(await self.waitUntil { model.skills.first?.name == "Gateway A skill" })
            try await fixture.selectB()
            try #require(await self.waitUntil { model.skills.first?.name == "Gateway B skill" })
        }
    }

    @Test(arguments: [false, true], SkillsGatewayTransition.allCases)
    private func `ClawHub search rows cannot install through a replacement gateway`(
        installOnly: Bool,
        transition: SkillsGatewayTransition) async throws
    {
        let fixture = SkillsGatewayFixture(installOnly: installOnly)
        let model = ClawHubSkillsBrowserModel(gateway: fixture.gateway)
        do {
            await model.search()
            let captured = try #require(model.results.first)
            let source = try #require(model.searchResults?.source)
            let replaceGateway = transition == .replacement
            try await fixture.transition(transition)

            var installed = await model.act(on: captured, source: source)
            if let sheet = model.sheet {
                installed = await model.install(sheet.review, source: sheet.source)
            }
            let writes = fixture.requests.value.filter { $0.method == "skills.install" }
            #expect(writes.count == (replaceGateway ? 0 : 1))
            #expect(writes.allSatisfy { $0.url.port == 49340 })
            if !replaceGateway {
                #expect(installed?.skills.first?.name == "Gateway A skill")
                #expect(writes.first?.reference == captured.reference)
            }
        } catch {
            await fixture.gateway.shutdown()
            throw error
        }
        await fixture.gateway.shutdown()
    }

    @Test(arguments: [SkillsGatewayTransition.reconnect, .replacement])
    private func `ClawHub review sheets retain only their configured gateway`(
        transition: SkillsGatewayTransition) async throws
    {
        let fixture = SkillsGatewayFixture()
        let model = ClawHubSkillsBrowserModel(gateway: fixture.gateway)
        let observation = Task { await model.run() }
        do {
            try #require(await self.waitUntil { model.results.count == 1 && !model.isSearching })
            let results = try #require(model.searchResults)
            let skill = try #require(results.skills.first)
            _ = await model.act(on: skill, source: results.source)
            let review = try #require(model.sheet)
            try await fixture.transition(transition)
            try #require(await self.waitUntil {
                model.searchResults?.source != nil && model.searchResults?.source != results.source
            })
            if transition == .replacement {
                #expect(model.sheet == nil)
            } else {
                #expect(model.sheet?.source == review.source)
            }
            let installed = await model.install(review.review, source: review.source)
            let installs = fixture.requests.value.filter { $0.method == "skills.install" }
            #expect(installed?.skills.first?.name == (transition == .replacement ? nil : "Gateway A skill"))
            #expect(installs.count == (transition == .replacement ? 0 : 1))
            #expect(installs.allSatisfy { $0.url.port == 49340 })
            if transition == .replacement {
                let currentResults = try #require(model.searchResults)
                let currentSkill = try #require(currentResults.skills.first)
                _ = await model.act(on: currentSkill, source: currentResults.source)
                let currentReview = try #require(model.sheet)
                #expect(currentReview.review.id == review.review.id)
                #expect(currentReview.source == currentResults.source)
                let currentInstall = await model.install(currentReview.review, source: currentReview.source)
                #expect(currentInstall?.skills.first?.name == "Gateway B skill")
                #expect(fixture.requests.value.filter { $0.method == "skills.install" }.map(\.url.port) == [49341])
            }
        } catch {
            observation.cancel()
            await observation.value
            await fixture.gateway.shutdown()
            throw error
        }
        observation.cancel()
        await observation.value
        await fixture.gateway.shutdown()
    }

    @Test(arguments: [false, true])
    func `selected gateway immediately hides retired skill data and errors`(failReads: Bool) async throws {
        let fixture = SkillsGatewayFixture(rejectedMethods: failReads ? ["skills.status", "skills.search"] : [])
        try await fixture.withModel { model in
            let browser = ClawHubSkillsBrowserModel(gateway: fixture.gateway)
            if failReads {
                try #require(await self.waitUntil { model.error != nil && !model.isLoading })
            } else {
                try #require(await self.waitUntil { model.skills.first?.name == "Gateway A skill" })
            }
            await browser.search()
            if failReads {
                #expect(browser.notices.first?.isError == true)
            } else {
                #expect(browser.results.count == 1)
            }
            // The selection producer advances before its asynchronous stream reaches these models.
            fixture.source.withValue { $0 = URL(string: "ws://127.0.0.1:49341/")! }
            #expect(model.skills.isEmpty)
            #expect(model.catalog == nil)
            #expect(model.error == nil)
            #expect(browser.results.isEmpty)
            #expect(browser.searchResults == nil)
            #expect(browser.notices.first == nil)
        }
    }

    @Test(arguments: SkillsGatewayTransition.allCases)
    private func `editor save retains its source through the followup refresh`(
        transition: SkillsGatewayTransition) async throws
    {
        let gate = SkillsResponseGate()
        let reads = LockIsolated(0)
        let fixture = SkillsGatewayFixture(beforeResponse: { request in
            if request.method == "skills.status", request.url.port == 49340 {
                let count = reads.withValue { value in
                    value += 1
                    return value
                }
                if count == 2 { await gate.wait() }
            }
        })
        try await fixture.withModel { model in
            try #require(await self.waitUntil { model.skills.first?.name == "Gateway A skill" })
            let catalog = try #require(model.catalog)
            let skill = try #require(catalog.skills.first)
            let save = Task {
                await model.updateEnv(
                    skillKey: skill.skillKey,
                    envKey: "FIXTURE_SKILL_KEY",
                    value: "synthetic-value-from-a",
                    isPrimary: true,
                    source: catalog.source)
            }
            do {
                // The save already succeeded on A; only its followup read is held.
                try #require(await self.waitUntil { reads.value == 2 })
                try await fixture.transition(transition)
                await gate.release()
                let error = await save.value
                #expect((error != nil) == (transition == .replacement))
                let writes = fixture.requests.value.filter { $0.method == "skills.update" }
                #expect(writes.count == 1)
                #expect(writes.first?.url.port == 49340)
                #expect(writes.first?.apiKey == "synthetic-value-from-a")
            } catch {
                await gate.release()
                _ = await save.value
                throw error
            }
        }
    }

    @Test func `held ClawHub install cannot block or overwrite a replacement gateway action`() async throws {
        let gate = SkillsResponseGate()
        let fixture = SkillsGatewayFixture(installOnly: true, beforeResponse: { request in
            if request.method == "skills.install", request.url.port == 49340 { await gate.wait() }
        })
        let model = ClawHubSkillsBrowserModel(gateway: fixture.gateway)
        let observation = Task { await model.run() }
        var firstInstall: Task<GatewaySkillCatalog?, Never>?
        do {
            try #require(await self.waitUntil { model.results.count == 1 && !model.isSearching })
            let first = try #require(model.searchResults)
            let skill = try #require(first.skills.first)
            firstInstall = Task { await model.act(on: skill, source: first.source) }
            try #require(await self.waitUntil {
                fixture.requests.value.contains { $0.method == "skills.install" && $0.url.port == 49340 }
            })
            try await fixture.selectB()
            try #require(await self.waitUntil { model.searchResults?.source.route.url.port == 49341 })
            let second = try #require(model.searchResults)
            let replacementSkill = try #require(second.skills.first)
            let installed = await model.act(on: replacementSkill, source: second.source)
            #expect(installed?.skills.first?.name == "Gateway B skill")
            #expect(fixture.requests.value.filter { $0.method == "skills.install" && $0.url.port == 49341 }.count == 1)
            await gate.release()
            _ = await firstInstall?.value
            #expect(model.notices.first?.title == "Installed")
            #expect(model.notices.first?.isError == false)
        } catch {
            await gate.release()
            _ = await firstInstall?.value
            observation.cancel()
            await observation.value
            await fixture.gateway.shutdown()
            throw error
        }
        observation.cancel()
        await observation.value
        await fixture.gateway.shutdown()
    }

    @Test(arguments: [false, true], SkillsGatewayTransition.allCases)
    private func `pending ClawHub actions keep busy state on their configured Gateway`(
        installOnly: Bool,
        transition: SkillsGatewayTransition) async throws
    {
        let firstGate = SkillsResponseGate()
        let secondGate = SkillsResponseGate()
        let holdFirst = LockIsolated(false)
        let holdSecond = LockIsolated(false)
        let firstEntered = LockIsolated(false)
        let secondEntered = LockIsolated(false)
        let fixture = SkillsGatewayFixture(installOnly: installOnly, beforeEndpointLookup: { url in
            if url.port == 49340, holdFirst.withValue({ let held = $0
                $0 = false
                return held })
            {
                firstEntered.setValue(true)
                await firstGate.wait()
            }
            if url.port == 49341, holdSecond.withValue({ let held = $0
                $0 = false
                return held })
            {
                secondEntered.setValue(true)
                await secondGate.wait()
            }
        })
        let model = ClawHubSkillsBrowserModel(gateway: fixture.gateway)
        let observation = Task { await model.run() }
        var firstAction: Task<GatewaySkillCatalog?, Never>?
        var secondAction: Task<GatewaySkillCatalog?, Never>?
        func busyReference() -> String? {
            installOnly ? model.installingSlug : model.reviewingSlug
        }
        func cleanup() async {
            await firstGate.release()
            await secondGate.release()
            _ = await firstAction?.value
            _ = await secondAction?.value
            observation.cancel()
            await observation.value
            await fixture.gateway.shutdown()
        }
        do {
            try #require(await self.waitUntil { model.results.count == 1 && !model.isSearching })
            let first = try #require(model.searchResults)
            let skill = try #require(first.skills.first)
            holdFirst.setValue(true)
            firstAction = Task { await model.act(on: skill, source: first.source) }
            // Endpoint preparation can outlive socket retirement; a held response cannot,
            // because the transport completes pending RPCs when that socket shuts down.
            try #require(await self.waitUntil { firstEntered.value })
            #expect(busyReference() == skill.reference)
            try await fixture.transition(transition)
            try #require(await self.waitUntil { model.searchResults != nil && !model.isSearching })
            let current = try #require(model.searchResults)
            let currentSkill = try #require(current.skills.first)
            if transition == .replacement {
                #expect(busyReference() == nil)
                holdSecond.setValue(true)
                secondAction = Task { await model.act(on: currentSkill, source: current.source) }
                try #require(await self.waitUntil { secondEntered.value })
                #expect(busyReference() == currentSkill.reference)
                await firstGate.release()
                _ = await firstAction?.value
                #expect(busyReference() == currentSkill.reference)
                await secondGate.release()
                let acceptedAction = try #require(secondAction)
                let installed = await acceptedAction.value
                if installOnly {
                    #expect(installed?.skills.first?.name == "Gateway B skill")
                } else {
                    #expect(model.sheet?.source == current.source)
                }
            } else {
                #expect(busyReference() == skill.reference)
                let requestCount = fixture.requests.value.count
                _ = await model.act(on: currentSkill, source: current.source)
                #expect(fixture.requests.value.count == requestCount)
                await firstGate.release()
                _ = await firstAction?.value
            }
            #expect(busyReference() == nil)
            let method = installOnly ? "skills.install" : "skills.detail"
            let actions = fixture.requests.value.filter { $0.method == method }
            #expect(actions.filter { $0.url.port == 49341 }.count == (transition == .replacement ? 1 : 0))
        } catch {
            await cleanup()
            throw error
        }
        await cleanup()
    }

    @Test(arguments: [
        "installed", "rejected", "confirmation-failed", "confirmation-disconnected", "confirmation-reconnected",
    ])
    func `ClawHub install acknowledgement survives a failed confirmation read`(outcome: String) async throws {
        let rejected: Set<String> = switch outcome {
        case "rejected": ["skills.install"]
        case "confirmation-failed": ["skills.status"]
        default: []
        }
        let disconnects = ["confirmation-disconnected", "confirmation-reconnected"].contains(outcome)
        let statusGate = SkillsResponseGate()
        let statusPending = LockIsolated(false)
        let offline = LockIsolated(false)
        let reconnectAttempted = LockIsolated(false)
        let fixture = SkillsGatewayFixture(
            installOnly: true,
            rejectedMethods: rejected,
            beforeConnect: {
                if offline.value {
                    reconnectAttempted.setValue(true)
                    throw URLError(.cannotConnectToHost)
                }
            },
            beforeResponse: { request in
                if disconnects, request.method == "skills.status" {
                    statusPending.setValue(true)
                    await statusGate.wait()
                }
            })
        let model = ClawHubSkillsBrowserModel(gateway: fixture.gateway)
        let observation = Task { await model.run() }
        var action: Task<GatewaySkillCatalog?, Never>?
        func cleanup() async {
            await statusGate.release()
            _ = await action?.value
            observation.cancel()
            await observation.value
            await fixture.gateway.shutdown()
        }
        do {
            try #require(await self.waitUntil { model.searchResults != nil && !model.isSearching })
            let results = try #require(model.searchResults)
            let skill = try #require(results.skills.first)
            let installation = Task { await model.act(on: skill, source: results.source) }
            action = installation
            if disconnects {
                try #require(await self.waitUntil { statusPending.value })
                offline.setValue(true)
                fixture.session.latestTask()?.emitReceiveFailure(URLError(.networkConnectionLost))
                try #require(await self.waitUntil { !fixture.gateway.serverLeaseMatchesCurrentState(results.source) })
            }
            let installed = await installation.value
            if disconnects {
                // Reconnect starts after the terminal callback; assert the retained
                // outcome after that lifecycle has progressed, not its transient value.
                try #require(await self.waitUntil { reconnectAttempted.value })
                if outcome == "confirmation-reconnected" {
                    await statusGate.release()
                    offline.setValue(false)
                    let reconnected = try await fixture.gateway.acquireServerLease()
                    try #require(await self.waitUntil {
                        model.searchResults?.source == reconnected && !model.isSearching
                    })
                }
            }
            try #require(await self.waitUntil { model.notices.first != nil })
            let notice = try #require(model.notices.first)
            switch outcome {
            case "rejected":
                #expect(installed == nil)
                #expect(notice.title == "Gateway blocked install")
                #expect(notice.isError)
                #expect(!fixture.requests.value.contains { $0.method == "skills.status" })
            case "confirmation-failed", "confirmation-disconnected", "confirmation-reconnected":
                #expect(installed == nil)
                #expect(notice.title == "Installed; refresh needed")
                #expect(notice.message.contains("Installed fixture skill"))
                if outcome == "confirmation-failed" {
                    #expect(notice.message.contains("Synthetic Gateway A read failure"))
                }
                #expect(notice.message.contains("Refresh Skills"))
                #expect(notice.warning == "Synthetic install audit warning")
                #expect(notice.isError)
            default:
                #expect(installed?.skills.first?.name == "Gateway A skill")
                #expect(notice.title == "Installed")
                #expect(notice.message == "Installed fixture skill")
                #expect(notice.warning == "Synthetic install audit warning")
                #expect(!notice.isError)
            }
            #expect(fixture.requests.value.filter { $0.method == "skills.install" }.count == 1)
            fixture.source.withValue { $0 = URL(string: "ws://127.0.0.1:49341/")! }
            #expect(model.notices.first == nil)
        } catch {
            await cleanup()
            throw error
        }
        await cleanup()
    }

    @Test(arguments: [false, true])
    func `socket failure remains visible until selected gateway reads recover`(replaceGateway: Bool) async throws {
        let offline = LockIsolated(false)
        let holdReads = LockIsolated(false)
        let statusGate = SkillsResponseGate()
        let searchGate = SkillsResponseGate()
        let reason = "Synthetic selected Gateway transport failure"
        let fixture = SkillsGatewayFixture(beforeConnect: {
            if offline.value { throw URLError(.cannotConnectToHost) }
        }, beforeResponse: { request in
            guard holdReads.value else { return }
            if request.method == "skills.status" { await statusGate.wait() }
            if request.method == "skills.search" { await searchGate.wait() }
        })
        try await fixture.withModel { model in
            let browser = ClawHubSkillsBrowserModel(gateway: fixture.gateway)
            let observation = Task { await browser.run() }
            var refresh: Task<Void, Never>?
            var search: Task<Void, Never>?
            do {
                try #require(await self.waitUntil {
                    model.catalog != nil && !model.isLoading && browser.searchResults != nil && !browser.isSearching
                })
                let source = try #require(model.catalog?.source)
                let statusReads = fixture.requests.value.count { $0.method == "skills.status" }
                let searches = fixture.requests.value.count { $0.method == "skills.search" }
                holdReads.withValue { $0 = true }
                refresh = Task { await model.refresh(force: true) }
                search = Task { await browser.search() }
                try #require(await self.waitUntil {
                    fixture.requests.value.count { $0.method == "skills.status" } > statusReads &&
                        fixture.requests.value.count { $0.method == "skills.search" } > searches
                })
                offline.withValue { $0 = true }
                fixture.session.latestTask()?.emitReceiveFailure(NSError(
                    domain: "SkillsTransportFixture", code: 1, userInfo: [NSLocalizedDescriptionKey: reason]))
                try #require(await self.waitUntil {
                    !fixture.gateway.serverLeaseMatchesCurrentState(source) && !model.isLoading && !browser.isSearching
                })
                #expect(await self.waitUntil {
                    model.error?.contains(reason) == true && browser.notices.first?.message.contains(reason) == true
                })
                #expect(model.catalog == nil)
                #expect(browser.searchResults == nil)
                #expect(model.error?.contains(reason) == true)
                #expect(browser.notices.first?.isError == true)
                #expect(browser.notices.first?.message.contains(reason) == true)
                await statusGate.release()
                await searchGate.release()
                await refresh?.value
                await search?.value
                holdReads.withValue { $0 = false }
                if replaceGateway {
                    fixture.source.withValue { $0 = URL(string: "ws://127.0.0.1:49341/")! }
                    #expect(model.error == nil)
                    #expect(browser.notices.first == nil)
                    let replacementRefresh = Task { await model.refresh(force: true) }
                    await browser.search()
                    await replacementRefresh.value
                    #expect(model.error != nil)
                    #expect(model.error?.contains(reason) == false)
                    #expect(browser.notices.first?.isError == true)
                    #expect(browser.notices.first?.message.contains(reason) == false)
                }
                offline.withValue { $0 = false }
                let replacement = try await fixture.gateway.acquireServerLease()
                #expect(replacement != source)
                try #require(await self.waitUntil {
                    model.skills.first?.name == (replaceGateway ? "Gateway B skill" : "Gateway A skill") &&
                        !model.isLoading && browser.searchResults?.source == replacement && !browser.isSearching
                })
                #expect(model.error == nil)
                #expect(browser.notices.first == nil)
            } catch {
                await statusGate.release()
                await searchGate.release()
                await refresh?.value
                await search?.value
                observation.cancel()
                await observation.value
                throw error
            }
            observation.cancel()
            await observation.value
        }
    }

    @Test func `a completed ClawHub install does not hide later catalog failures`() async throws {
        let offline = LockIsolated(false)
        let reconnectAttempted = LockIsolated(false)
        let fixture = SkillsGatewayFixture(installOnly: true, beforeConnect: {
            if offline.value {
                reconnectAttempted.setValue(true)
                throw URLError(.cannotConnectToHost)
            }
        })
        let model = ClawHubSkillsBrowserModel(gateway: fixture.gateway)
        let observation = Task { await model.run() }
        func visibleNotices() -> [ClawHubSkillsBrowserModel.Notice] {
            model.notices
        }
        func expectInstalledReceipt() {
            #expect(visibleNotices().contains {
                $0.title == "Installed" && $0.message == "Installed fixture skill" &&
                    $0.warning == "Synthetic install audit warning" && !$0.isError
            })
        }
        func cleanup() async {
            observation.cancel()
            await observation.value
            await fixture.gateway.shutdown()
        }
        do {
            try #require(await self.waitUntil { model.searchResults != nil && !model.isSearching })
            let results = try #require(model.searchResults)
            let skill = try #require(results.skills.first)
            let installed = await model.act(on: skill, source: results.source)
            try #require(installed?.skills.first?.name == "Gateway A skill")
            expectInstalledReceipt()

            let transportFailure = "Synthetic later catalog transport failure"
            offline.setValue(true)
            fixture.session.latestTask()?.emitReceiveFailure(NSError(
                domain: "SkillsTransportFixture",
                code: 2,
                userInfo: [NSLocalizedDescriptionKey: transportFailure]))
            try #require(await self.waitUntil { reconnectAttempted.value })
            #expect(model.searchResults == nil)
            expectInstalledReceipt()
            #expect(visibleNotices().contains { $0.isError && $0.message.contains(transportFailure) })

            fixture.rejectedMethods.setValue(["skills.search"])
            let searches = fixture.requests.value.count { $0.method == "skills.search" }
            offline.setValue(false)
            let reconnected = try await fixture.gateway.acquireServerLease()
            try #require(await self.waitUntil {
                fixture.requests.value.count { $0.method == "skills.search" } > searches && !model.isSearching
            })
            #expect(reconnected != results.source)
            #expect(model.searchResults == nil)
            expectInstalledReceipt()
            #expect(visibleNotices().contains {
                $0.isError && $0.message.contains("Synthetic Gateway A read failure")
            })

            fixture.rejectedMethods.setValue([])
            try await fixture.transition(.reconnect)
            try #require(await self.waitUntil { model.searchResults != nil && !model.isSearching })
            expectInstalledReceipt()
            #expect(!visibleNotices().contains { $0.isError })
            try fixture.source.setValue(#require(URL(string: "ws://127.0.0.1:49341/")))
            #expect(visibleNotices().isEmpty)
            _ = try await fixture.gateway.acquireServerLease()
            try #require(await self.waitUntil {
                model.searchResults?.source.route.url.port == 49341 && !model.isSearching
            })
            #expect(visibleNotices().isEmpty)
            model.query = "missing-skill"
            await model.search()
            let emptyResults = try #require(model.searchResults)
            #expect(emptyResults.skills.isEmpty)
            #expect(!model.isSearching)
            #expect(visibleNotices().isEmpty)
        } catch {
            await cleanup()
            throw error
        }
        await cleanup()
    }

    @Test func `unavailable replacement invalidates observed terminal errors and install receipts`() async throws {
        let offline = LockIsolated(false)
        let fixture = SkillsGatewayFixture(installOnly: true, beforeConnect: {
            if offline.value { throw URLError(.cannotConnectToHost) }
        })
        try await fixture.withModel { skills in
            let browser = ClawHubSkillsBrowserModel(gateway: fixture.gateway)
            let observation = Task { await browser.run() }
            do {
                try #require(await self.waitUntil {
                    skills.catalog != nil && !skills.isLoading && browser.searchResults != nil && !browser.isSearching
                })
                let results = try #require(browser.searchResults)
                let skill = try #require(results.skills.first)
                let installed = await browser.act(on: skill, source: results.source)
                try #require(installed != nil)
                offline.setValue(true)
                fixture.session.latestTask()?.emitReceiveFailure(URLError(.networkConnectionLost))
                try #require(await self.waitUntil {
                    skills.error != nil && !skills.isLoading && !browser.isSearching &&
                        browser.notices.contains { $0.isError }
                })
                #expect(browser.notices.contains { $0.title == "Installed" && !$0.isError })

                let skillsInvalidated = LockIsolated(false)
                let browserInvalidated = LockIsolated(false)
                withObservationTracking {
                    _ = skills.error
                    _ = skills.statusMessage
                    _ = skills.catalog
                    _ = skills.isLoading
                } onChange: {
                    skillsInvalidated.setValue(true)
                }
                withObservationTracking {
                    _ = browser.notices
                    _ = browser.searchResults
                    _ = browser.isSearching
                } onChange: {
                    browserInvalidated.setValue(true)
                }
                try fixture.source.setValue(#require(URL(string: "ws://127.0.0.1:49341/")))
                try await fixture.gateway.adoptSelectedEndpoint()
                #expect(await self.waitUntil { skillsInvalidated.value && browserInvalidated.value })
                #expect(skillsInvalidated.value)
                #expect(browserInvalidated.value)
                #expect(skills.error == nil)
                #expect(browser.notices.isEmpty)
                #expect(fixture.requests.value.allSatisfy { $0.url.port == 49340 })
            } catch {
                observation.cancel()
                await observation.value
                throw error
            }
            observation.cancel()
            await observation.value
        }
    }

    private func waitUntil(_ predicate: @MainActor () -> Bool) async -> Bool {
        let deadline = ContinuousClock.now + .seconds(2)
        while ContinuousClock.now < deadline {
            if predicate() { return true }
            try? await Task.sleep(for: .milliseconds(5))
        }
        return predicate()
    }
}
