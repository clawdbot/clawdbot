import Foundation
import OpenClawChatUI
import Testing
@testable import OpenClaw

struct CommandSessionGroupingTests {
    @Test func `groups pinned categories and ungrouped in display order`() {
        let sections = CommandSessionGrouping.sections(from: [
            self.entry("ungrouped", activity: 2),
            self.entry("beta", category: "Beta", activity: 3),
            self.entry("alpha-old", category: "Alpha", activity: 1),
            self.entry("pinned", category: "Beta", pinned: true, activity: 4),
            self.entry("alpha-new", category: "Alpha", activity: 5),
        ])

        #expect(sections.map(\.id) == [
            .pinned,
            .category("Alpha"),
            .category("Beta"),
            .ungrouped,
        ])
        #expect(sections[0].entries.map(\.key) == ["pinned"])
        #expect(sections[1].entries.map(\.key) == ["alpha-new", "alpha-old"])
        #expect(sections[3].showsHeader)
    }

    @Test func `known groups render empty sections in alphabetical merge`() {
        let sections = CommandSessionGrouping.sections(
            from: [
                self.entry("beta", category: "Beta", activity: 2),
                self.entry("plain", activity: 1),
            ],
            knownGroups: ["Zulu", "Alpha"])

        #expect(sections.map(\.id) == [
            .category("Alpha"),
            .category("Beta"),
            .category("Zulu"),
            .ungrouped,
        ])
        #expect(sections[0].entries.isEmpty)
        #expect(sections[1].entries.map(\.key) == ["beta"])
        #expect(sections[2].entries.isEmpty)
        #expect(sections[3].showsHeader)
    }

    @Test func `known groups ignore blanks and duplicates`() {
        let sections = CommandSessionGrouping.sections(
            from: [self.entry("beta", category: "Beta", activity: 1)],
            knownGroups: ["  ", "Beta", "Beta", "Alpha"])

        #expect(sections.map(\.id) == [.category("Alpha"), .category("Beta")])

        let categories = CommandSessionGrouping.categories(
            from: [self.entry("beta", category: "Beta", activity: 1)],
            knownGroups: ["", "Beta", "Alpha", "Alpha"])
        #expect(categories == ["Alpha", "Beta"])
    }

    @Test func `group members merge active and archived lists deduped by key`() {
        let members = CommandSessionGrouping.members(
            of: "Ops",
            in: [
                [
                    self.entry("a", category: "Ops", activity: 1),
                    self.entry("other", category: "Dev", activity: 2),
                ],
                [
                    self.entry("a", category: "Ops", activity: 1),
                    self.entry("b", category: " Ops ", activity: 3),
                    self.entry("plain", activity: 4),
                ],
            ])

        #expect(members.map(\.key) == ["a", "b"])
        #expect(CommandSessionGrouping.members(of: "  ", in: [[self.entry("a", activity: 1)]]).isEmpty)
    }

    @Test func `hides ungrouped header without category sections`() {
        let sections = CommandSessionGrouping.sections(from: [self.entry("plain", activity: 1)])

        #expect(sections.count == 1)
        #expect(sections[0].id == .ungrouped)
        #expect(!sections[0].showsHeader)
    }

    @Test func `preview puts pinned sessions before recent activity`() {
        let entries = CommandSessionGrouping.previewOrder([
            self.entry("recent", activity: 20),
            self.entry("pinned-old", pinned: true, activity: 1),
            self.entry("older", activity: 10),
        ])

        #expect(entries.map(\.key) == ["pinned-old", "recent", "older"])
    }

    @Test func `preview selection keeps the open chat visible past the cap`() {
        let entries = [
            self.entry("a", activity: 40),
            self.entry("b", activity: 30),
            self.entry("c", activity: 20),
            self.entry("current", activity: 10),
        ]

        let selection = CommandSessionGrouping.previewSelection(entries, currentKey: "current")
        #expect(selection.map(\.key) == ["current", "a", "b"])

        // Natural order wins when the current session already fits the cap.
        let natural = CommandSessionGrouping.previewSelection(entries, currentKey: "a")
        #expect(natural.map(\.key) == ["a", "b", "c"])

        // Unknown or empty keys fall back to the plain capped ordering.
        let fallback = CommandSessionGrouping.previewSelection(entries, currentKey: "")
        #expect(fallback.map(\.key) == ["a", "b", "c"])
    }

    private func entry(
        _ key: String,
        category: String? = nil,
        pinned: Bool = false,
        activity: Double) -> OpenClawChatSessionEntry
    {
        OpenClawChatSessionEntry(
            key: key,
            kind: nil,
            displayName: nil,
            surface: nil,
            subject: nil,
            room: nil,
            space: nil,
            updatedAt: nil,
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
            category: category,
            pinned: pinned,
            lastActivityAt: activity)
    }
}

struct SessionGroupStoreTests {
    @Test func `normalizes trims dedupes and drops blanks`() {
        #expect(SessionGroupStore.normalized([" Ops ", "Ops", "", "  ", "Dev"]) == ["Ops", "Dev"])
    }

    @Test func `renaming replaces a stored name in place`() {
        #expect(SessionGroupStore.renaming(["Dev", "Ops"], from: "Dev", to: "Core") == ["Core", "Ops"])
        // Renaming onto an existing name collapses the duplicate.
        #expect(SessionGroupStore.renaming(["Dev", "Ops"], from: "Dev", to: "Ops") == ["Ops"])
    }

    @Test func `renaming a live-only group appends the new name`() {
        #expect(SessionGroupStore.renaming(["Ops"], from: "Dev", to: "Core") == ["Ops", "Core"])
    }

    @Test func `removing and adding keep the list unique`() {
        #expect(SessionGroupStore.removing(["Dev", "Ops"], "Dev") == ["Ops"])
        #expect(SessionGroupStore.adding(["Ops"], "Ops") == ["Ops"])
        #expect(SessionGroupStore.adding(["Ops"], " Dev ") == ["Ops", "Dev"])
    }

    @Test func `load and save round-trip through user defaults`() {
        withUserDefaults([SessionGroupStore.defaultsKey: nil]) {
            #expect(SessionGroupStore.load() == [])
            SessionGroupStore.save([" Dev ", "Dev", "Ops"])
            #expect(SessionGroupStore.load() == ["Dev", "Ops"])
            SessionGroupStore.remember("Core")
            #expect(SessionGroupStore.load() == ["Dev", "Ops", "Core"])
        }
    }
}
