import Foundation

struct LaunchAgentPlistSnapshot: Equatable {
    let programArguments: [String]
    let environment: [String: String]
    let stdoutPath: String?
    let stderrPath: String?

    let port: Int?
    let bind: String?
    let token: String?
    let password: String?
}

enum LaunchAgentPlist {
    static func snapshot(
        url: URL,
        generatedEnvironmentFileURL: URL? = nil,
        generatedEnvironmentWrapperURL: URL? = nil) -> LaunchAgentPlistSnapshot?
    {
        guard let data = try? Data(contentsOf: url) else { return nil }
        let rootAny: Any
        do {
            rootAny = try PropertyListSerialization.propertyList(
                from: data,
                options: [],
                format: nil)
        } catch {
            return nil
        }
        guard let root = rootAny as? [String: Any] else { return nil }
        let programArguments = root["ProgramArguments"] as? [String] ?? []
        let inlineEnvironment = root["EnvironmentVariables"] as? [String: String] ?? [:]
        let generatedEnvironment = self.readGeneratedEnvironment(
            programArguments: programArguments,
            fileURL: generatedEnvironmentFileURL,
            wrapperURL: generatedEnvironmentWrapperURL)
        let env = inlineEnvironment.merging(generatedEnvironment) { _, generated in generated }
        let stdoutPath = (root["StandardOutPath"] as? String)?
            .trimmingCharacters(in: .whitespacesAndNewlines).nonEmpty
        let stderrPath = (root["StandardErrorPath"] as? String)?
            .trimmingCharacters(in: .whitespacesAndNewlines).nonEmpty
        let port = Self.extractFlagInt(programArguments, flag: "--port")
        let bind = Self.extractFlagString(programArguments, flag: "--bind")?.lowercased()
        let token = env["OPENCLAW_GATEWAY_TOKEN"]?.trimmingCharacters(in: .whitespacesAndNewlines).nonEmpty
        let password = env["OPENCLAW_GATEWAY_PASSWORD"]?.trimmingCharacters(in: .whitespacesAndNewlines).nonEmpty
        return LaunchAgentPlistSnapshot(
            programArguments: programArguments,
            environment: env,
            stdoutPath: stdoutPath,
            stderrPath: stderrPath,
            port: port,
            bind: bind,
            token: token,
            password: password)
    }

    private static func readGeneratedEnvironment(
        programArguments: [String],
        fileURL: URL?,
        wrapperURL: URL?) -> [String: String]
    {
        guard let fileURL, let wrapperURL else { return [:] }
        let filePath = fileURL.standardizedFileURL.path
        let wrapperPath = wrapperURL.standardizedFileURL.path
        let usesShellWrapper = programArguments.count >= 3 &&
            programArguments[0] == "/bin/sh" &&
            programArguments[1] == wrapperPath &&
            programArguments[2] == filePath
        let usesDirectWrapper = programArguments.count >= 2 &&
            programArguments[0] == wrapperPath &&
            programArguments[1] == filePath
        // Read only the canonical file when the LaunchAgent uses OpenClaw's generated wrapper.
        // This keeps arbitrary ProgramArguments paths from becoming app-readable secret sources.
        guard usesShellWrapper || usesDirectWrapper,
              FileManager.default.fileExists(atPath: wrapperPath),
              let content = try? String(contentsOf: fileURL, encoding: .utf8)
        else { return [:] }

        var environment: [String: String] = [:]
        for rawLine in content.components(separatedBy: .newlines) {
            let line = rawLine.trimmingCharacters(in: .whitespacesAndNewlines)
            guard line.hasPrefix("export ") else { continue }
            let assignment = line.dropFirst("export ".count)
            guard let separator = assignment.firstIndex(of: "=") else { continue }
            let key = String(assignment[..<separator])
            guard key.range(of: #"^[A-Za-z_][A-Za-z0-9_]*$"#, options: .regularExpression) != nil else {
                continue
            }
            let rawValue = String(assignment[assignment.index(after: separator)...])
            guard rawValue.hasPrefix("'"), rawValue.hasSuffix("'") else { continue }
            environment[key] = String(rawValue.dropFirst().dropLast())
                .replacingOccurrences(of: #"'\''"#, with: "'")
        }
        return environment
    }

    private static func extractFlagInt(_ args: [String], flag: String) -> Int? {
        guard let raw = self.extractFlagString(args, flag: flag) else { return nil }
        return Int(raw)
    }

    private static func extractFlagString(_ args: [String], flag: String) -> String? {
        guard let idx = args.firstIndex(of: flag) else { return nil }
        let valueIdx = args.index(after: idx)
        guard valueIdx < args.endIndex else { return nil }
        let token = args[valueIdx].trimmingCharacters(in: .whitespacesAndNewlines)
        return token.isEmpty ? nil : token
    }
}
