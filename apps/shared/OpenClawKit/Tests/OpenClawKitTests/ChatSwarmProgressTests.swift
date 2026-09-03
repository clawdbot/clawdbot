import Foundation
import Testing
@testable import OpenClawChatUI

struct ChatSwarmProgressTests {
    @Test func `session rows decode Swarm identity and activity fields`() throws {
        let data = Data("""
        {
          "key": "agent:main:subagent:worker",
          "parentSessionKey": "agent:main:main",
          "spawnedBy": "agent:main:main",
          "subagentRunState": "active",
          "swarmGroupId": "swarm:agent:main:main:run-1",
          "swarmPhase": "Research",
          "swarmPhaseRank": 2,
          "swarmLog": "Reading sources"
        }
        """.utf8)
        let row = try JSONDecoder().decode(OpenClawChatSessionEntry.self, from: data)
        #expect(row.swarmGroupId == "swarm:agent:main:main:run-1")
        #expect(row.parentSessionKey == "agent:main:main")
        #expect(row.subagentRunState == "active")
        #expect(row.swarmPhase == "Research")
        #expect(row.swarmPhaseRank == 2)
        #expect(row.swarmLog == "Reading sources")
    }

    @Test func `activity notes decorate children in observation order`() {
        let groupID = "swarm:agent:main:parent:turn-1"
        var activity = OpenClawChatSwarmActivityState()

        let observedPhase = activity.observe(OpenClawChatSessionsChangedEvent(
            sessionKey: "agent:main:parent",
            reason: "swarm-note",
            swarmGroupId: groupID,
            kind: "phase",
            text: "Research"))
        let observedChild = activity.observe(OpenClawChatSessionsChangedEvent(
            sessionKey: "agent:main:child",
            reason: "create",
            swarmGroupId: groupID))
        let observedLog = activity.observe(OpenClawChatSessionsChangedEvent(
            sessionKey: "agent:main:parent",
            reason: "swarm-note",
            swarmGroupId: groupID,
            kind: "log",
            text: "Comparing sources"))
        #expect(observedPhase)
        #expect(observedChild)
        #expect(observedLog)

        let decorated = activity.decorate([self.session(
            key: "agent:main:child",
            status: "running",
            groupID: groupID)])
        #expect(decorated.single?.swarmPhase == "Research")
        #expect(decorated.single?.swarmPhaseRank == 0)
        #expect(decorated.single?.swarmLog == "Comparing sources")
    }

    @Test func `projection renders active group states and hides terminal groups`() {
        let activeGroup = "swarm:agent:main:parent:active"
        let finishedGroup = "swarm:agent:main:parent:finished"
        let sessions = [
            session(key: "queued", status: "queued", groupID: activeGroup, hasActiveRun: true),
            session(key: "running", status: "running", groupID: activeGroup),
            session(key: "done", status: "done", groupID: activeGroup),
            session(key: "failed", status: "timeout", groupID: activeGroup),
            session(key: "finished", status: "done", groupID: finishedGroup),
        ]

        let groups = buildOpenClawChatSwarmGroups(sessions: sessions) { $0 == "agent:main:parent" }
        #expect(groups.count == 1)
        #expect(groups.single?.id == activeGroup)
        #expect(groups.single?.running == 1)
        #expect(groups.single?.done == 1)
        #expect(groups.single?.failed == 1)
        #expect(groups.single?.phases.single?.dots.map(\.status) == [.queued, .running, .done, .failed])
    }

    @Test func `child pager repeats from zero when rows move across offsets`() async throws {
        let groupID = "swarm:agent:main:parent:paged"
        let pages = [
            [
                session(key: "zero", status: "running", groupID: groupID),
                session(key: "one", status: "running", groupID: groupID),
            ],
            [
                session(key: "one", status: "running", groupID: groupID),
                session(key: "two", status: "running", groupID: groupID),
            ],
            [
                session(key: "zero", status: "running", groupID: groupID),
                session(key: "one", status: "done", groupID: groupID),
            ],
            [
                session(key: "three", status: "running", groupID: groupID),
                session(key: "two", status: "running", groupID: groupID),
            ],
        ]
        var call = 0
        let rows = try await OpenClawChatChildSessionPager.collect { offset in
            let page = pages[call]
            call += 1
            return OpenClawChatSessionsListResponse(
                ts: 1,
                path: nil,
                count: page.count,
                totalCount: 4,
                offset: offset,
                nextOffset: offset == 0 ? 2 : nil,
                hasMore: offset == 0,
                defaults: nil,
                sessions: page)
        }

        #expect(Set(rows.map(\.key)) == ["zero", "one", "two", "three"])
        #expect(rows.first { $0.key == "one" }?.status == "done")
        #expect(call == 4)
    }

    @Test func `child pager bounds advancing malformed pagination`() async throws {
        var call = 0
        let rows = try await OpenClawChatChildSessionPager.collect { offset in
            call += 1
            return OpenClawChatSessionsListResponse(
                ts: 1,
                path: nil,
                count: 1,
                totalCount: .max,
                offset: offset,
                nextOffset: offset + 1,
                hasMore: true,
                defaults: nil,
                sessions: [self.session(
                    key: "child",
                    status: "running",
                    groupID: "swarm:agent:main:parent:paged")])
        }

        #expect(rows.map(\.key) == ["child"])
        #expect(call == 100)
    }

    @Test func `metadata capability defaults missing Swarm support to disabled`() throws {
        let capabilities = try JSONDecoder().decode(
            OpenClawChatMetadataCapabilities.self,
            from: Data("{}".utf8))
        #expect(!capabilities.swarmEnabled)

        #expect(throws: DecodingError.self) {
            _ = try JSONDecoder().decode(
                OpenClawChatMetadataCapabilities.self,
                from: Data(#"{"swarmEnabled":"yes"}"#.utf8))
        }
    }

    @Test func `Swarm events ignore other parents`() {
        let current = "agent:main:parent"
        let ownChild = OpenClawChatSessionsChangedEvent(
            sessionKey: "agent:main:child",
            parentSessionKey: current,
            reason: "create",
            swarmGroupId: "custom-group")
        let otherPhase = OpenClawChatSessionsChangedEvent(
            sessionKey: "agent:main:other",
            reason: "swarm-note",
            swarmGroupId: "swarm:agent:main:other:turn",
            kind: "phase",
            text: "Research")

        #expect(SelfContainedSwarmHelpers.eventBelongsToParent(ownChild) { $0 == current })
        #expect(!SelfContainedSwarmHelpers.eventBelongsToParent(otherPhase) { $0 == current })
    }

    @Test func `projection uses derived title before the raw session key`() {
        let groupID = "swarm:agent:main:parent:labels"
        var row = self.session(key: "agent:main:child", status: "running", groupID: groupID)
        row.displayName = nil
        row.derivedTitle = "Research worker"

        let group = buildOpenClawChatSwarmGroups(sessions: [row]) { $0 == "agent:main:parent" }.single
        #expect(group?.phases.single?.dots.single?.label == "Research worker")
    }

    @Test func `projection caps historical dots while retaining active workers`() {
        let groupID = "swarm:agent:main:parent:large"
        let completed = (0..<300).map { index in
            self.session(key: "done-\(index)", status: "done", groupID: groupID)
        }
        let running = self.session(key: "running", status: "running", groupID: groupID)

        let group = buildOpenClawChatSwarmGroups(
            sessions: completed + [running],
            matchesParent: { $0 == "agent:main:parent" }).single
        #expect(group?.phases.single?.dots.count == 256)
        #expect(group?.phases.single?.dots.contains { $0.status == .running } == true)
        #expect(group?.phases.single?.hidden == 45)
    }

    private func session(
        key: String,
        status: String?,
        groupID: String,
        subagentRunState: String? = nil,
        hasActiveRun: Bool? = nil) -> OpenClawChatSessionEntry
    {
        OpenClawChatSessionEntry(
            key: key,
            kind: "direct",
            displayName: key,
            surface: nil,
            subject: nil,
            room: nil,
            space: nil,
            updatedAt: 1,
            sessionId: nil,
            systemSent: nil,
            abortedLastRun: nil,
            thinkingLevel: nil,
            verboseLevel: nil,
            inputTokens: nil,
            outputTokens: nil,
            totalTokens: nil,
            modelProvider: nil,
            model: nil,
            contextTokens: nil,
            parentSessionKey: "agent:main:parent",
            status: status,
            hasActiveRun: hasActiveRun,
            subagentRunState: subagentRunState,
            swarmGroupId: groupID)
    }
}

extension Array {
    fileprivate var single: Element? {
        count == 1 ? self[0] : nil
    }
}
