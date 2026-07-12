import Foundation
import OpenClawIPC
import OpenClawKit

enum MacNodeFileSystemCommands {
    private struct ListDirectoryParams: Decodable {
        var path: String?
    }

    private struct DirectoryEntry: Encodable {
        var name: String
        var path: String
        var hidden: Bool?
    }

    private struct ListDirectoryPayload: Encodable {
        var path: String
        var parent: String?
        var home: String
        var entries: [DirectoryEntry]
    }

    static func listDirectory(_ request: BridgeInvokeRequest) throws -> BridgeInvokeResponse {
        let params: ListDirectoryParams = if let paramsJSON = request.paramsJSON {
            try self.decodeParams(paramsJSON)
        } else {
            ListDirectoryParams(path: nil)
        }
        let home = FileManager.default.homeDirectoryForCurrentUser.path
        let requested = params.path?.trimmingCharacters(in: .whitespacesAndNewlines)
        let rawPath = requested.flatMap { $0.isEmpty ? nil : $0 } ?? home
        guard NSString(string: rawPath).isAbsolutePath else {
            return self.errorResponse(
                request,
                code: .invalidRequest,
                message: "INVALID_REQUEST: fs.listDir path must be absolute")
        }

        let directory = URL(fileURLWithPath: rawPath, isDirectory: true).standardizedFileURL
        let children = try FileManager.default.contentsOfDirectory(
            at: directory,
            includingPropertiesForKeys: [.isDirectoryKey],
            options: [])
        var entries: [DirectoryEntry] = []
        for child in children {
            var isDirectory: ObjCBool = false
            guard FileManager.default.fileExists(atPath: child.path, isDirectory: &isDirectory),
                  isDirectory.boolValue
            else { continue }
            let name = child.lastPathComponent
            entries.append(DirectoryEntry(
                name: name,
                path: directory.appendingPathComponent(name, isDirectory: true).path,
                hidden: name.hasPrefix(".") ? true : nil))
        }
        entries.sort { lhs, rhs in
            if (lhs.hidden != nil) != (rhs.hidden != nil) {
                return lhs.hidden == nil
            }
            return lhs.name.utf8.lexicographicallyPrecedes(rhs.name.utf8)
        }

        let parentPath = directory.deletingLastPathComponent().path
        let payload = ListDirectoryPayload(
            path: directory.path,
            parent: parentPath == directory.path ? nil : parentPath,
            home: home,
            entries: entries)
        return try BridgeInvokeResponse(
            id: request.id,
            ok: true,
            payloadJSON: self.encodePayload(payload))
    }

    private static func decodeParams(_ paramsJSON: String) throws -> ListDirectoryParams {
        guard let data = paramsJSON.data(using: .utf8) else {
            throw NSError(domain: "Gateway", code: 20, userInfo: [
                NSLocalizedDescriptionKey: "INVALID_REQUEST: paramsJSON required",
            ])
        }
        return try JSONDecoder().decode(ListDirectoryParams.self, from: data)
    }

    private static func encodePayload(_ payload: ListDirectoryPayload) throws -> String {
        let data = try JSONEncoder().encode(payload)
        guard let json = String(bytes: data, encoding: .utf8) else {
            throw NSError(domain: "Node", code: 21, userInfo: [
                NSLocalizedDescriptionKey: "Failed to encode payload as UTF-8",
            ])
        }
        return json
    }

    private static func errorResponse(
        _ request: BridgeInvokeRequest,
        code: OpenClawNodeErrorCode,
        message: String) -> BridgeInvokeResponse
    {
        BridgeInvokeResponse(
            id: request.id,
            ok: false,
            error: OpenClawNodeError(code: code, message: message))
    }
}
