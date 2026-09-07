import Foundation
import OSLog

enum RuntimeKind: String {
    case node
}

struct RuntimeVersion: Comparable, CustomStringConvertible {
    let major: Int
    let minor: Int
    let patch: Int

    var description: String {
        "\(self.major).\(self.minor).\(self.patch)"
    }

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
        path: String,
        searchPaths: [String])
    case versionParse(kind: RuntimeKind, raw: String, path: String, searchPaths: [String])
}

enum RuntimeLocator {
    private static let logger = Logger(subsystem: "ai.openclaw", category: "runtime")
    // Keep these floors aligned with package.json engines so the app never launches
    // the gateway on an unsupported odd release or an older even-major runtime.
    private static let minNode24 = RuntimeVersion(major: 24, minor: 16, patch: 0)
    private static let minNode26 = RuntimeVersion(major: 26, minor: 1, patch: 0)
    private static let supportedNodeRange = ">=24.16.0 <25, or >=26.1.0"

    static func isSupportedNodeVersion(_ version: RuntimeVersion) -> Bool {
        if version.major == self.minNode24.major {
            return version >= self.minNode24
        }
        if version.major == self.minNode26.major {
            return version >= self.minNode26
        }
        return version.major > self.minNode26.major
    }

    static func resolve(
        searchPaths: [String] = CommandResolver.preferredPaths()) async
        -> Result<RuntimeResolution, RuntimeResolutionError>
    {
        let pathEnv = searchPaths.joined(separator: ":")
        let runtime: RuntimeKind = .node

        guard let binary = findExecutable(named: runtime.binaryName, searchPaths: searchPaths) else {
            return .failure(.notFound(searchPaths: searchPaths))
        }
        guard let rawVersion = await readVersion(of: binary, pathEnv: pathEnv) else {
            return .failure(.versionParse(
                kind: runtime,
                raw: "(unreadable)",
                path: binary,
                searchPaths: searchPaths))
        }
        guard let parsed = RuntimeVersion.from(string: rawVersion) else {
            return .failure(.versionParse(kind: runtime, raw: rawVersion, path: binary, searchPaths: searchPaths))
        }
        guard self.isSupportedNodeVersion(parsed) else {
            return .failure(.unsupported(
                kind: runtime,
                found: parsed,
                path: binary,
                searchPaths: searchPaths))
        }

        return .success(RuntimeResolution(kind: runtime, path: binary, version: parsed))
    }

    static func describeFailure(_ error: RuntimeResolutionError) -> String {
        switch error {
        case let .notFound(searchPaths):
            [
                "openclaw needs Node \(self.supportedNodeRange) but found no runtime.",
                "PATH searched: \(searchPaths.joined(separator: ":"))",
                "Install Node: https://nodejs.org/en/download",
            ].joined(separator: "\n")
        case let .unsupported(kind, found, path, searchPaths):
            [
                "Found \(kind.rawValue) \(found) at \(path) but need \(self.supportedNodeRange).",
                "PATH searched: \(searchPaths.joined(separator: ":"))",
                "Upgrade Node and rerun openclaw.",
            ].joined(separator: "\n")
        case let .versionParse(kind, raw, path, searchPaths):
            [
                "Could not parse \(kind.rawValue) version output \"\(raw)\" from \(path).",
                "PATH searched: \(searchPaths.joined(separator: ":"))",
                "Try reinstalling or pinning a supported version (Node \(self.supportedNodeRange)).",
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

    private static func readVersion(of binary: String, pathEnv: String) async -> String? {
        let start = Date()
        do {
            let result = try await BoundedProcess.run(
                path: binary,
                arguments: ["--version"],
                environment: ["PATH": pathEnv],
                timeout: CommandResolver.versionProbeTimeout)
            guard result.terminationStatus == 0 else { return nil }
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
            return String(data: result.output, encoding: .utf8)?
                .trimmingCharacters(in: .whitespacesAndNewlines)
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
    fileprivate var binaryName: String {
        "node"
    }
}
