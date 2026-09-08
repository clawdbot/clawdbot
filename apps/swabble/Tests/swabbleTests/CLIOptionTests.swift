import Commander
import Foundation
import XCTest
@testable import SwabbleCLI

@available(macOS 26.0, *)
@MainActor
final class CLIOptionTests: XCTestCase {
    func testConfigOptionPreservesDefaultAndUsesLastExplicitPath() throws {
        let cases: [([String], String?)] = [
            ([], nil),
            (["--config", "/tmp/first-config.json"], "/tmp/first-config.json"),
            (["--config", "/tmp/first-config.json", "--config", "/tmp/last-config.json"], "/tmp/last-config.json"),
        ]
        for (options, expected) in cases {
            XCTAssertEqual(try DoctorCommand(parsed: self.parse(["doctor"] + options)).configPath, expected)
            XCTAssertEqual(try MicSet(parsed: self.parse(["mic", "set", "37"] + options)).configPath, expected)
            XCTAssertEqual(try ServeCommand(parsed: self.parse(["serve"] + options)).configPath, expected)
            XCTAssertEqual(try SetupCommand(parsed: self.parse(["setup"] + options)).configPath, expected)
            XCTAssertEqual(try StatusCommand(parsed: self.parse(["status"] + options)).configPath, expected)
            XCTAssertEqual(
                try TestHookCommand(parsed: self.parse(["test-hook", "synthetic"] + options)).configPath,
                expected)
        }
    }

    func testTranscribeDefaultsAndExplicitOptions() throws {
        let defaults = try TranscribeCommand(parsed: self.parse(["transcribe", "synthetic.wav"]))
        XCTAssertNil(defaults.outputFile)
        XCTAssertEqual(defaults.format, "txt")
        XCTAssertEqual(defaults.locale, Locale.current.identifier)
        XCTAssertEqual(defaults.maxLength, 40)
        XCTAssertFalse(defaults.censor)

        let command = try TranscribeCommand(parsed: self.parse([
            "transcribe", "synthetic.wav",
            "--output", "first.srt", "--output", "last.srt",
            "--format", "srt", "--locale", "de_DE", "--max-length", "71", "--censor",
        ]))
        XCTAssertEqual(command.inputFile, "synthetic.wav")
        XCTAssertEqual(command.outputFile, "last.srt")
        XCTAssertEqual(command.format, "srt")
        XCTAssertEqual(command.locale, "de_DE")
        XCTAssertEqual(command.maxLength, 71)
        XCTAssertTrue(command.censor)
    }

    private func parse(_ arguments: [String]) throws -> ParsedValues {
        try Program(descriptors: CLIRegistry.descriptors).resolve(argv: ["swabble"] + arguments).parsedValues
    }
}
