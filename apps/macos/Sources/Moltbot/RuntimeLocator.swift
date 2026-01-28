import Foundation
import OSLog

enum RuntimeKind: String {
    case node
}

struct RuntimeVersion: Comparable, CustomStringConvertible {
    let major: Int
    let minor: Int
    let patch: Int

    var description: String { "\(self.major).\(self.minor).\(self.patch)" }

    static func < (lhs: RuntimeVersion, rhs: RuntimeVersion) -> Bool {
        if lhs.major != rhs.major { return lhs.major < rhs.major }
        if lhs.minor != rhs.minor { return lhs.minor < rhs.minor }
        return lhs.patch < rhs.patch
    }

    static func from(string: String) -> RuntimeVersion? {
        // Accept optional leading "v" and ignore trailing metadata.
        let pattern = #"(\d+)\.(\d+)\.(\d+)"#
        guard let match = string.range(of: pattern, options: .regularExpression) else { return nil }
        let versionString = String(string[match])
        let parts = versionString.split(separator: ".")
        guard parts.count == 3,
              let major = Int(parts[0]),
              let minor = Int(parts[1]),
              let patch = Int(parts[2])
        else { return nil }
        return RuntimeVersion(major: major, minor: minor, patch: patch)
    }
}

struct RuntimeResolution {
    let kind: RuntimeKind
    let path: String
    let version: RuntimeVersion
}

enum RuntimeResolutionError: Error {
    case notFound(searchPaths: [String])
    case unsupported(
        kind: RuntimeKind,
        found: RuntimeVersion,
        required: RuntimeVersion,
        path: String,
        searchPaths: [String])
    case versionParse(kind: RuntimeKind, raw: String, path: String, searchPaths: [String])
}

enum RuntimeLocator {
    private static let logger = Logger(subsystem: "bot.molt", category: "runtime")
    private static let minNode = RuntimeVersion(major: 22, minor: 0, patch: 0)

    static func resolve(
        searchPaths: [String] = CommandResolver.preferredPaths()) -> Result<RuntimeResolution, RuntimeResolutionError>
    {
        let pathEnv = searchPaths.joined(separator: ":")
        let runtime: RuntimeKind = .node

        guard let binary = findExecutable(named: runtime.binaryName, searchPaths: searchPaths) else {
            return .failure(.notFound(searchPaths: searchPaths))
        }
        guard let rawVersion = readVersion(of: binary, pathEnv: pathEnv) else {
            return .failure(.versionParse(
                kind: runtime,
                raw: "(unreadable)",
                path: binary,
                searchPaths: searchPaths))
        }
        guard let parsed = RuntimeVersion.from(string: rawVersion) else {
            return .failure(.versionParse(kind: runtime, raw: rawVersion, path: binary, searchPaths: searchPaths))
        }
        guard parsed >= self.minNode else {
            return .failure(.unsupported(
                kind: runtime,
                found: parsed,
                required: self.minNode,
                path: binary,
                searchPaths: searchPaths))
        }

        return .success(RuntimeResolution(kind: runtime, path: binary, version: parsed))
    }

    static func describeFailure(_ error: RuntimeResolutionError) -> String {
        switch error {
        case let .notFound(searchPaths):
            [
                "moltbot needs Node >=22.0.0 but found no runtime.",
                "PATH searched: \(searchPaths.joined(separator: ":"))",
                "Install Node: https://nodejs.org/en/download",
            ].joined(separator: "\n")
        case let .unsupported(kind, found, required, path, searchPaths):
            [
                "Found \(kind.rawValue) \(found) at \(path) but need >= \(required).",
                "PATH searched: \(searchPaths.joined(separator: ":"))",
                "Upgrade Node and rerun moltbot.",
            ].joined(separator: "\n")
        case let .versionParse(kind, raw, path, searchPaths):
            [
                "Could not parse \(kind.rawValue) version output \"\(raw)\" from \(path).",
                "PATH searched: \(searchPaths.joined(separator: ":"))",
                "Try reinstalling or pinning a supported version (Node >=22.0.0).",
            ].joined(separator: "\n")
        }
    }

    // MARK: - Internals

    private static func findExecutable(named name: String, searchPaths: [String]) -> String? {
        let fm = FileManager()
        for dir in searchPaths {
            let candidate = (dir as NSString).appendingPathComponent(name)
            if fm.isExecutableFile(atPath: candidate) {
                return candidate
            }
        }
        return nil
    }

    private static func readVersion(of binary: String, pathEnv: String) -> String? {
        let start = Date()
        let process = Process()
        process.executableURL = URL(fileURLWithPath: binary)
        process.arguments = ["--version"]
        process.environment = ["PATH": pathEnv]

        let pipe = Pipe()
        process.standardOutput = pipe
        process.standardError = pipe

        do {
            let data = try process.runAndReadToEnd(from: pipe)
            let elapsedMs = Int(Date().timeIntervalSince(start) * 1000)
            if elapsedMs > 500 {
                self.logger.warning(
                    """
                    runtime --version slow (\(elapsedMs, privacy: .public)ms) \
                    bin=\(binary, privacy: .public)
                    """)
            } else {
                self.logger.debug(
                    """
                    runtime --version ok (\(elapsedMs, privacy: .public)ms) \
                    bin=\(binary, privacy: .public)
                    """)
            }
            return String(data: data, encoding: .utf8)?.trimmingCharacters(in: .whitespacesAndNewlines)
        } catch {
            let elapsedMs = Int(Date().timeIntervalSince(start) * 1000)
            self.logger.error(
                """
                runtime --version failed (\(elapsedMs, privacy: .public)ms) \
                bin=\(binary, privacy: .public) \
                err=\(error.localizedDescription, privacy: .public)
                """)
            return nil
        }
    }
}

extension RuntimeKind {
    fileprivate var binaryName: String { "node" }
}
