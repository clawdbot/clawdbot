import Foundation
import Testing
@testable import OpenClawKit

struct HealthCommandsTests {
    @Test func `health summary periods use the node command wire values`() throws {
        #expect(OpenClawHealthCommand.summary.rawValue == "health.summary")
        #expect(OpenClawHealthSummaryPeriod.allCases.map(\.rawValue) == ["today"])

        let params = OpenClawHealthSummaryParams(period: .today)
        let data = try JSONEncoder().encode(params)
        #expect(String(decoding: data, as: UTF8.self) == #"{"period":"today"}"#)
    }
}
