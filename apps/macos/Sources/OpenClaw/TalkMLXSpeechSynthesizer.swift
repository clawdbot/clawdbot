import Foundation
import OSLog

// swiftformat:disable wrap wrapMultilineStatementBraces trailingCommas redundantSelf extensionAccessControl
/// Runtime access stays serialized through `TalkModeRuntime` actor helper methods.
final class TalkMLXSpeechSynthesizer {
    enum SynthesizeError: Error {
        case canceled
        case modelLoadFailed(String)
        case audioGenerationFailed
        case audioPlaybackFailed
        case timedOut
    }

    static let shared = TalkMLXSpeechSynthesizer()
    static let defaultModelRepo = "mlx-community/Soprano-80M-bf16"

    private let logger = Logger(subsystem: "ai.openclaw", category: "talk.mlx")
    private var currentToken = UUID()
    private var currentProcess: Process?

    private init() {}

    func stop() {
        self.currentToken = UUID()
        self.currentProcess?.terminate()
        self.currentProcess = nil
    }

    func synthesize(
        text: String,
        modelRepo: String?,
        language: String?,
        voicePreset: String?) async throws -> Data {
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return Data() }

        self.stop()
        let token = UUID()
        self.currentToken = token

        let tempDir = FileManager.default.temporaryDirectory
            .appendingPathComponent("openclaw-mlx-tts-\(token.uuidString)", isDirectory: true)
        try FileManager.default.createDirectory(at: tempDir, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: tempDir) }

        let outputURL = tempDir.appendingPathComponent("speech.wav")
        let invocation = Self.helperInvocation()
        let resolvedRepo = Self.resolvedModelRepo(modelRepo)
        var arguments = invocation.argumentPrefix
        arguments += [
            "--text", trimmed,
            "--model", resolvedRepo,
            "--output", outputURL.path,
        ]
        if let language = language?.trimmingCharacters(in: .whitespacesAndNewlines), !language.isEmpty {
            arguments += ["--language", language]
        }
        if let voicePreset = voicePreset?.trimmingCharacters(in: .whitespacesAndNewlines), !voicePreset.isEmpty {
            arguments += ["--voice", voicePreset]
        }

        self.logger.info("talk mlx helper start modelRepo=\(resolvedRepo, privacy: .public)")
        let process = Process()
        process.executableURL = invocation.executableURL
        process.arguments = arguments
        let stderr = Pipe()
        process.standardError = stderr
        process.standardOutput = Pipe()
        self.currentProcess = process

        let status: Int32
        do {
            status = try await Self.run(process)
        } catch {
            self.currentProcess = nil
            self.logger.error("talk mlx helper launch failed: \(error.localizedDescription, privacy: .public)")
            throw SynthesizeError.modelLoadFailed(invocation.displayName)
        }
        self.currentProcess = nil

        guard self.currentToken == token else {
            throw SynthesizeError.canceled
        }
        guard status == 0 else {
            let errorText = Self.readPipe(stderr)
            self.logger.error(
                "talk mlx helper failed status=\(status, privacy: .public): \(errorText, privacy: .public)")
            throw SynthesizeError.audioGenerationFailed
        }

        do {
            return try Data(contentsOf: outputURL)
        } catch {
            self.logger.error("talk mlx helper output missing: \(error.localizedDescription, privacy: .public)")
            throw SynthesizeError.audioGenerationFailed
        }
    }

    private struct HelperInvocation {
        let executableURL: URL
        let argumentPrefix: [String]
        let displayName: String
    }

    private static func helperInvocation() -> HelperInvocation {
        let fileManager = FileManager.default
        if let override = ProcessInfo.processInfo.environment["OPENCLAW_MLX_TTS_BIN"], !override.isEmpty {
            return HelperInvocation(
                executableURL: URL(fileURLWithPath: override),
                argumentPrefix: [],
                displayName: override)
        }

        if let executableDir = Bundle.main.executableURL?.deletingLastPathComponent() {
            let bundled = executableDir.appendingPathComponent("openclaw-mlx-tts")
            if fileManager.isExecutableFile(atPath: bundled.path) {
                return HelperInvocation(
                    executableURL: bundled,
                    argumentPrefix: [],
                    displayName: bundled.path)
            }
        }

        return HelperInvocation(
            executableURL: URL(fileURLWithPath: "/usr/bin/env"),
            argumentPrefix: ["openclaw-mlx-tts"],
            displayName: "openclaw-mlx-tts")
    }

    private static func resolvedModelRepo(_ modelRepo: String?) -> String {
        let trimmed = modelRepo?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        return trimmed.isEmpty ? Self.defaultModelRepo : trimmed
    }

    private static func run(_ process: Process) async throws -> Int32 {
        try await withCheckedThrowingContinuation { continuation in
            process.terminationHandler = { process in
                continuation.resume(returning: process.terminationStatus)
            }
            do {
                try process.run()
            } catch {
                continuation.resume(throwing: error)
            }
        }
    }

    private static func readPipe(_ pipe: Pipe) -> String {
        let data = (try? pipe.fileHandleForReading.readToEnd()) ?? Data()
        let text = String(data: data, encoding: .utf8) ?? ""
        return text.trimmingCharacters(in: .whitespacesAndNewlines)
    }
}

extension TalkMLXSpeechSynthesizer: @unchecked Sendable {}

// swiftformat:enable wrap wrapMultilineStatementBraces trailingCommas redundantSelf extensionAccessControl
