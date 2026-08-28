import OpenClawKit
import Foundation
import Testing

@Suite struct ToolDisplayRegistryTests {
    @Test func resolvesKnownToolFromConfig() {
        let summary = ToolDisplayRegistry.resolve(name: "exec", args: nil)
        #expect(summary.emoji == "🛠️")
        #expect(summary.title == "Exec")
    }
}
