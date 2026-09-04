import Foundation
import OpenClawKit
import Testing
@testable import OpenClaw

private func report(eligible: Bool) -> SkillsStatusReport {
    SkillsStatusReport(workspaceDir: "/tmp/workspace", managedSkillsDir: "/tmp/skills", skills: [
        SkillStatus(
            name: "Paprika",
            description: "Synthetic node eligibility",
            source: "openclaw-workspace",
            filePath: "/tmp/skills/paprika/SKILL.md",
            baseDir: "/tmp/skills/paprika",
            skillKey: "paprika",
            primaryEnv: nil,
            emoji: nil,
            homepage: nil,
            always: false,
            disabled: false,
            eligible: eligible,
            requirements: SkillRequirements(bins: ["paprika"], env: [], config: []),
            missing: SkillMissing(bins: eligible ? [] : ["paprika"], env: [], config: []),
            configChecks: [],
            install: []),
    ])
}

private final class SkillsStatusFixture: Sendable {
    let gateway: GatewayConnection
    let session: GatewayTestWebSocketSession

    init(load: @escaping @MainActor @Sendable () async throws -> SkillsStatusReport) {
        let session = GatewayTestWebSocketSession(taskFactory: {
            GatewayTestWebSocketTask(sendHook: { socket, message, sendIndex in
                guard sendIndex > 0 else { return }
                let data: Data = switch message {
                case let .data(data): data
                case let .string(text): Data(text.utf8)
                @unknown default: throw URLError(.cannotParseResponse)
                }
                let frame = try #require(JSONSerialization.jsonObject(with: data) as? [String: Any])
                let id = try #require(frame["id"] as? String)
                guard frame["method"] as? String == "skills.status" else {
                    socket.emitReceiveSuccess(.data(GatewayWebSocketTestSupport.okResponseData(id: id)))
                    return
                }
                do {
                    let data = try await JSONEncoder().encode(load())
                    let payload = try #require(String(data: data, encoding: .utf8))
                    socket.emitReceiveSuccess(.data(Data(
                        #"{"type":"res","id":"\#(id)","ok":true,"payload":\#(payload)}"#.utf8)))
                } catch {
                    socket.emitReceiveSuccess(.data(Data("""
                    {"type":"res","id":"\(id)","ok":false,
                    "error":{"code":"UNAVAILABLE","message":"Synthetic status failure"}}
                    """.utf8)))
                }
            })
        })
        self.session = session
        self.gateway = GatewayConnection(
            configProvider: { (URL(string: "ws://127.0.0.1:49342")!, nil, nil) },
            sessionBox: WebSocketSessionBox(session: session))
    }

    @MainActor
    func invalidate(sequenceGap: Bool = false) async throws {
        guard let socket = self.session.latestTask() else { return }
        if sequenceGap {
            let pushes = await self.gateway.subscribe()
            var firstReceived = false
            let observation = Task {
                for await delivery in pushes {
                    guard let push = delivery.push else { continue }
                    if case let .event(event) = push, event.event == "tick", event.seq == 1 {
                        firstReceived = true
                    }
                }
            }
            // The callback mock launches independent Tasks; establish wire order before creating the gap.
            socket.emitReceiveSuccess(.data(Data(#"{"type":"event","event":"tick","seq":1}"#.utf8)))
            do {
                let deadline = ContinuousClock.now + .seconds(2)
                while !firstReceived, ContinuousClock.now < deadline {
                    try await Task.sleep(for: .milliseconds(5))
                }
                try #require(firstReceived)
            } catch {
                observation.cancel()
                await observation.value
                throw error
            }
            observation.cancel()
            await observation.value
            socket.emitReceiveSuccess(.data(Data(#"{"type":"event","event":"tick","seq":3}"#.utf8)))
        } else {
            socket.emitReceiveSuccess(.data(Data(#"{"type":"event","event":"skills.changed"}"#.utf8)))
        }
    }

    @MainActor
    func withModel(_ body: (SkillsSettingsModel) async throws -> Void) async throws {
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

@MainActor
struct SkillsSettingsSmokeTests {
    @Test func `alternative binaries and OS blockers remain visible requirements`() {
        let alternatives = SkillMissing(bins: [], anyBins: ["rg", "grep"], env: [], config: [])
        let platforms = SkillMissing(bins: [], env: [], config: [], os: ["linux"])
        #expect(!SkillRequirementPresentation.requirementsMet(alternatives))
        #expect(SkillRequirementPresentation.shouldShowSummary(alternatives, showMissingBins: false))
        #expect(SkillRequirementPresentation.installOptions(missing: alternatives, options: [
            SkillInstallOption(id: "brew", kind: "brew", label: "brew install ripgrep", bins: ["rg"]),
        ]).map(\.id) == ["brew"])
        #expect(!SkillRequirementPresentation.requirementsMet(platforms))
        #expect(SkillRequirementPresentation.shouldShowSummary(platforms, showMissingBins: false))
    }

    @Test(arguments: [false, true])
    func `gateway invalidations refresh loaded skill eligibility`(sequenceGap: Bool) async throws {
        var loads = 0
        let fixture = SkillsStatusFixture {
            loads += 1
            return report(eligible: loads > 1)
        }
        try await fixture.withModel { model in
            try #require(await self.waitUntil { model.skills.first?.eligible == false && !model.isLoading })
            #expect(loads == 1)
            try await fixture.invalidate(sequenceGap: sequenceGap)
            try #require(await self.waitUntil { model.skills.first?.eligible == true && !model.isLoading })
            #expect(loads == 2)
            #expect(model.skills.first?.missing.bins == [])
        }
    }

    @Test func `gateway invalidation retries a failed initial status read`() async throws {
        var loads = 0
        let fixture = SkillsStatusFixture {
            loads += 1
            if loads == 1 { throw URLError(.cannotLoadFromNetwork) }
            return report(eligible: true)
        }
        try await fixture.withModel { model in
            try #require(await self.waitUntil { model.error != nil && !model.isLoading })
            try await fixture.invalidate()
            try #require(await self.waitUntil { model.skills.first?.eligible == true && !model.isLoading })
            #expect(loads == 2)
            #expect(model.error == nil)
        }
    }

    @Test(arguments: [false, true])
    func `invalidation during a status read drains to fresh eligibility`(firstReadFails: Bool) async throws {
        var loads = 0
        var release: CheckedContinuation<Void, Never>?
        let fixture = SkillsStatusFixture {
            loads += 1
            if loads == 1 {
                await withCheckedContinuation { release = $0 }
                if firstReadFails { throw URLError(.cannotLoadFromNetwork) }
                return report(eligible: false)
            }
            return report(eligible: true)
        }
        try await fixture.withModel { model in
            defer { release?.resume()
                release = nil
            }
            try #require(await self.waitUntil { release != nil })
            try await fixture.invalidate()
            release?.resume()
            release = nil
            try #require(await self.waitUntil { model.skills.first?.eligible == true && !model.isLoading })
            #expect(loads == 2)
            #expect(model.error == nil)
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
