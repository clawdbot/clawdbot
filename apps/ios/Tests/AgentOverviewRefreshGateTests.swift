import Foundation
import Testing
@testable import OpenClaw

struct AgentOverviewRefreshGateTests {
    @Test func `legacy skill missing requirements default new fields`() throws {
        let report = try JSONDecoder().decode(
            SkillStatusReportLite.self,
            from: Data(#"{"skills":[{"name":"Legacy","missing":{"bins":[],"env":[],"config":[]}}]}"#.utf8))
        let skill = try #require(report.skills.first)

        #expect(skill.missing?.anyBins == [])
        #expect(skill.missing?.os == [])
        #expect(!skill.hasMissingRequirements)
    }

    @Test func `any binary requirements participate in skill setup state`() throws {
        let report = try JSONDecoder().decode(
            SkillStatusReportLite.self,
            from: Data(
                #"{"skills":[{"name":"Search","missing":{"bins":[],"anyBins":["rg","grep"],"env":[],"config":[],"os":[]}}]}"#
                    .utf8))
        let skill = try #require(report.skills.first)

        #expect(skill.hasMissingRequirements)
        #expect(skill.missingSummary == "rg, grep")
        #expect(skill.missingBins == ["rg", "grep"])
    }

    @Test func `new overview refresh invalidates an older result`() {
        var gate = AgentOverviewRefreshGate()

        let first = gate.begin()
        let second = gate.begin()

        #expect(!gate.isCurrent(first))
        #expect(gate.isCurrent(second))
    }

    @Test func `current overview refresh remains accepted until superseded`() {
        var gate = AgentOverviewRefreshGate()
        let generation = gate.begin()

        #expect(gate.isCurrent(generation))
    }

    @Test func `automatic refresh coalesces before invalidating current work`() throws {
        let source = try String(contentsOf: Self.gatewayDataSourceURL(), encoding: .utf8)
        let method = try #require(source.range(of: "func refreshOverview(force: Bool) async"))
        let tail = source[method.lowerBound...]
        let coalescingGuard = try #require(tail.range(of: "if self.overviewLoading, !force"))
        let generation = try #require(tail.range(of: "let generation = self.overviewRefreshGate.begin()"))

        #expect(coalescingGuard.lowerBound < generation.lowerBound)
    }

    private static func gatewayDataSourceURL() -> URL {
        URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent()
            .deletingLastPathComponent()
            .appendingPathComponent("Sources/Design/AgentProTab+GatewayData.swift")
    }
}
