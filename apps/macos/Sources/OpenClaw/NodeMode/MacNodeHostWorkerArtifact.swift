import CryptoKit
import Foundation
import Security

enum MacNodeHostWorkerArtifact {
    private struct Manifest: Decodable {
        let schemaVersion: Int
        let kind: String
        let sourceCommit: String
        let sha256: String
    }

    enum ArtifactError: LocalizedError {
        case invalid(String)

        var errorDescription: String? {
            switch self {
            case let .invalid(message): message
            }
        }
    }

    static func validateSignedBundle(at bundleURL: URL) -> Bool {
        var code: SecStaticCode?
        guard SecStaticCodeCreateWithPath(bundleURL as CFURL, SecCSFlags(), &code) == errSecSuccess,
              let code
        else { return false }
        return SecStaticCodeCheckValidity(
            code,
            SecCSFlags(rawValue: kSecCSCheckAllArchitectures | kSecCSCheckNestedCode),
            nil) == errSecSuccess
    }

    static func resolve(
        resourceRoot: URL,
        expectedSourceCommit: String,
        fileManager: FileManager = .default) throws -> URL
    {
        guard expectedSourceCommit.range(of: "^[0-9a-f]{40}$", options: .regularExpression) != nil else {
            throw ArtifactError.invalid("elevation app has no exact OpenClaw source identity")
        }
        let root = resourceRoot.appendingPathComponent("OpenClawNodeHostWorker", isDirectory: true)
        let manifestURL = root.appendingPathComponent("manifest.json")
        let workerURL = root.appendingPathComponent("node-host-worker.mjs")
        let expectedNames = Set([manifestURL.lastPathComponent, workerURL.lastPathComponent])
        let names = try Set(fileManager.contentsOfDirectory(atPath: root.path))
        guard names == expectedNames else {
            throw ArtifactError.invalid("elevation node-host worker contains unexpected entries")
        }
        for url in [root, manifestURL, workerURL] {
            let values = try url.resourceValues(forKeys: [.isDirectoryKey, .isRegularFileKey, .isSymbolicLinkKey])
            guard values.isSymbolicLink != true else {
                throw ArtifactError.invalid("elevation node-host worker must not contain symbolic links")
            }
            if url == root {
                guard values.isDirectory == true else {
                    throw ArtifactError.invalid("elevation node-host worker root is not a directory")
                }
            } else if values.isRegularFile != true {
                throw ArtifactError.invalid("elevation node-host worker resource is not a regular file")
            }
        }

        let manifestData = try Data(contentsOf: manifestURL, options: [.mappedIfSafe])
        guard let raw = try JSONSerialization.jsonObject(with: manifestData) as? [String: Any],
              Set(raw.keys) == Set(["schemaVersion", "kind", "sourceCommit", "sha256"])
        else {
            throw ArtifactError.invalid("elevation node-host worker manifest has an invalid shape")
        }
        let manifest = try JSONDecoder().decode(Manifest.self, from: manifestData)
        guard manifest.schemaVersion == 1,
              manifest.kind == "openclaw-macos-node-host-worker",
              manifest.sourceCommit == expectedSourceCommit,
              manifest.sha256.range(of: "^[0-9a-f]{64}$", options: .regularExpression) != nil
        else {
            throw ArtifactError.invalid("elevation node-host worker manifest does not match this app")
        }
        guard try self.sha256(of: workerURL) == manifest.sha256 else {
            throw ArtifactError.invalid("elevation node-host worker digest does not match its signed manifest")
        }
        return workerURL
    }

    private static func sha256(of url: URL) throws -> String {
        let handle = try FileHandle(forReadingFrom: url)
        defer { try? handle.close() }
        var hasher = SHA256()
        while let data = try handle.read(upToCount: 1024 * 1024), !data.isEmpty {
            hasher.update(data: data)
        }
        return hasher.finalize().map { String(format: "%02x", $0) }.joined()
    }
}
