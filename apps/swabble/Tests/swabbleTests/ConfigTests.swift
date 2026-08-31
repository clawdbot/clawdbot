import Foundation
@testable import Swabble
import XCTest

final class ConfigTests: XCTestCase {
    func testConfigRoundTrip() throws {
        var cfg = SwabbleConfig()
        cfg.wake.word = "robot"
        let url = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString + ".json")
        defer { try? FileManager.default.removeItem(at: url) }

        try ConfigLoader.save(cfg, at: url)
        let loaded = try ConfigLoader.load(at: url)
        XCTAssertEqual(loaded.wake.word, "robot")
        XCTAssertTrue(loaded.hook.prefix.contains("Voice swabble"))
    }

    func testConfigMissingThrows() {
        XCTAssertThrowsError(
            try ConfigLoader.load(at: FileManager.default.temporaryDirectory.appendingPathComponent("nope.json")))
    }
}
