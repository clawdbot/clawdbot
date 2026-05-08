import Foundation
import Testing
@testable import OpenClaw

private struct SystemRunCommandContractFixture: Decodable {
    let cases: [SystemRunCommandContractCase]
}

private struct SystemRunCommandContractCase: Decodable {
    let name: String
    let command: [String]
    let rawCommand: String?
    let expected: SystemRunCommandContractExpected
}

private struct SystemRunCommandContractExpected: Decodable {
    let valid: Bool
    let displayCommand: String?
    let errorContains: String?
}

struct ExecSystemRunCommandValidatorTests {
    @Test func `matches shared system run command contract fixture`() throws {
        for entry in try Self.loadContractCases() {
            let result = ExecSystemRunCommandValidator.resolve(command: entry.command, rawCommand: entry.rawCommand)

            if !entry.expected.valid {
                switch result {
                case let .ok(resolved):
                    Issue
                        .record("\(entry.name): expected invalid result, got displayCommand=\(resolved.displayCommand)")
                case let .invalid(message):
                    if let expected = entry.expected.errorContains {
                        #expect(
                            message.contains(expected),
                            "\(entry.name): expected error containing \(expected), got \(message)")
                    }
                }
                continue
            }

            switch result {
            case let .ok(resolved):
                #expect(
                    resolved.displayCommand == entry.expected.displayCommand,
                    "\(entry.name): unexpected display command")
            case let .invalid(message):
                Issue.record("\(entry.name): unexpected invalid result: \(message)")
            }
        }
    }

    @Test func `validator keeps canonical wrapper text out of allowlist raw parsing`() {
        let command = ["/bin/sh", "-lc", "/usr/bin/printf ok"]
        let rawCommand = "/bin/sh -lc \"/usr/bin/printf ok\""
        let result = ExecSystemRunCommandValidator.resolve(command: command, rawCommand: rawCommand)

        switch result {
        case let .ok(resolved):
            #expect(resolved.displayCommand == rawCommand)
            #expect(resolved.evaluationRawCommand == nil)
        case let .invalid(message):
            Issue.record("unexpected invalid result: \(message)")
        }
    }

    @Test func `env dash shell wrapper requires canonical raw command binding`() {
        let command = ["/usr/bin/env", "-", "bash", "-lc", "echo hi"]

        let legacy = ExecSystemRunCommandValidator.resolve(command: command, rawCommand: "echo hi")
        switch legacy {
        case .ok:
            Issue.record("expected rawCommand mismatch for env dash prelude")
        case let .invalid(message):
            #expect(message.contains("rawCommand does not match command"))
        }

        let canonicalRaw = "/usr/bin/env - bash -lc \"echo hi\""
        let canonical = ExecSystemRunCommandValidator.resolve(command: command, rawCommand: canonicalRaw)
        switch canonical {
        case let .ok(resolved):
            #expect(resolved.displayCommand == canonicalRaw)
        case let .invalid(message):
            Issue.record("unexpected invalid result for canonical raw command: \(message)")
        }
    }

    @Test func `fish attached c command requires canonical raw command binding`() {
        let command = ["/usr/bin/fish", "-c/tmp/payload.fish", "/usr/bin/printf safe_marker"]
        let result = ExecSystemRunCommandValidator.resolve(
            command: command,
            rawCommand: "/usr/bin/printf safe_marker")

        switch result {
        case .ok:
            Issue.record("expected rawCommand mismatch for attached fish command payload")
        case let .invalid(message):
            #expect(message.contains("rawCommand does not match command"))
        }
    }

    @Test func `startup shell wrappers require canonical raw command binding`() {
        for command in [
            ["/bin/bash", "-lc", "/usr/bin/printf safe_marker"],
            ["/bin/bash", "--rcfile", "/tmp/payload.sh", "-i", "-c", "/usr/bin/printf safe_marker"],
            ["/bin/bash", "--login", "-c", "/usr/bin/printf safe_marker"],
            ["/usr/bin/fish", "--init-command=/tmp/payload.fish", "-c", "/usr/bin/printf safe_marker"],
        ] {
            let legacy = ExecSystemRunCommandValidator.resolve(
                command: command,
                rawCommand: "/usr/bin/printf safe_marker")
            switch legacy {
            case .ok:
                Issue.record("expected rawCommand mismatch for startup shell wrapper")
            case let .invalid(message):
                #expect(message.contains("rawCommand does not match command"))
            }

            let canonicalRaw = ExecCommandFormatter.displayString(for: command)
            let canonical = ExecSystemRunCommandValidator.resolve(command: command, rawCommand: canonicalRaw)
            switch canonical {
            case let .ok(resolved):
                #expect(resolved.displayCommand == canonicalRaw)
            case let .invalid(message):
                Issue.record("unexpected invalid result for canonical raw command: \(message)")
            }
        }
    }

    private static func loadContractCases() throws -> [SystemRunCommandContractCase] {
        let fixtureURL = try self.findContractFixtureURL()
        let data = try Data(contentsOf: fixtureURL)
        let decoded = try JSONDecoder().decode(SystemRunCommandContractFixture.self, from: data)
        return decoded.cases
    }

    private static func findContractFixtureURL() throws -> URL {
        var cursor = URL(fileURLWithPath: #filePath).deletingLastPathComponent()
        for _ in 0..<8 {
            let candidate = cursor
                .appendingPathComponent("test")
                .appendingPathComponent("fixtures")
                .appendingPathComponent("system-run-command-contract.json")
            if FileManager.default.fileExists(atPath: candidate.path) {
                return candidate
            }
            cursor.deleteLastPathComponent()
        }
        throw NSError(
            domain: "ExecSystemRunCommandValidatorTests",
            code: 1,
            userInfo: [NSLocalizedDescriptionKey: "missing shared system-run command contract fixture"])
    }
}
