import Foundation
import Testing
@testable import OpenClawKit

struct SkillManagementTests {
    @Test func `missing requirements preserve alternatives and platforms`() throws {
        let data = Data(#"{"bins":[],"anyBins":["rg","grep"],"env":[],"config":[],"os":["darwin"]}"#.utf8)
        let missing = try JSONDecoder().decode(SkillMissing.self, from: data)

        #expect(missing.anyBins == ["rg", "grep"])
        #expect(missing.os == ["darwin"])
    }

    @Test func `legacy requirements default new fields to empty`() throws {
        let data = Data(#"{"bins":["rg"],"env":[],"config":[]}"#.utf8)
        let requirements = try JSONDecoder().decode(SkillRequirements.self, from: data)
        let missing = try JSONDecoder().decode(SkillMissing.self, from: data)

        #expect(requirements.anyBins.isEmpty)
        #expect(requirements.os.isEmpty)
        #expect(missing.anyBins.isEmpty)
        #expect(missing.os.isEmpty)
    }
}
