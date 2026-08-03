import XCTest
@testable import OpenClawKit

final class TalkHistoryTimestampTests: XCTestCase {
    func testSecondsTimestampsAreAcceptedWithSmallTolerance() {
        XCTAssertTrue(TalkHistoryTimestamp.isAfter(999.6, sinceSeconds: 1000))
        XCTAssertFalse(TalkHistoryTimestamp.isAfter(999.4, sinceSeconds: 1000))
    }

    func testMillisecondsTimestampsAreAcceptedWithSmallTolerance() {
        let sinceSeconds = 1_700_000_000.0
        let sinceMs = sinceSeconds * 1000
        XCTAssertTrue(TalkHistoryTimestamp.isAfter(sinceMs - 500, sinceSeconds: sinceSeconds))
        XCTAssertFalse(TalkHistoryTimestamp.isAfter(sinceMs - 501, sinceSeconds: sinceSeconds))
    }
}
