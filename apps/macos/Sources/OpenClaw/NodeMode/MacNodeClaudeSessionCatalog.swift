import CoreFoundation
import Foundation

enum MacNodeClaudeSessionCatalogContract {
    static let pluginId = "anthropic"
    static let capability = "claude-sessions"
    static let listCommand = "anthropic.claude.sessions.list.v1"
    static let readCommand = "anthropic.claude.sessions.read.v1"
    static let commands = [listCommand, readCommand]
}

enum MacNodeClaudeSessionCatalog {
    enum CatalogError: LocalizedError, Equatable {
        case invalidParams(String)
        case unavailable
        case responseTooLarge

        var errorDescription: String? {
            switch self {
            case let .invalidParams(message):
                "INVALID_REQUEST: \(message)"
            case .unavailable:
                "UNAVAILABLE: Claude session catalog is unavailable"
            case .responseTooLarge:
                "UNAVAILABLE: Claude session item exceeded the size limit"
            }
        }

        var isInvalidRequest: Bool {
            if case .invalidParams = self {
                return true
            }
            return false
        }
    }

    private struct ListParams {
        var cursor: String?
        var limit = 50
        var searchTerm: String?
    }

    private struct ReadParams {
        var threadId: String
        var cursor: String?
        var limit = 20
    }

    private struct SessionRecord {
        var threadId: String
        var name: String?
        var cwd: String?
        var createdAt: Int64?
        var updatedAt: Int64?
        var source: String
        var gitBranch: String?
        var fileURL: URL

        var wire: [String: Any] {
            var value: [String: Any] = [
                "threadId": threadId,
                "status": "stored",
                "source": source,
                "modelProvider": "anthropic",
                "archived": false,
            ]
            value["name"] = self.name ?? NSNull()
            if let cwd {
                value["cwd"] = cwd
            }
            if let createdAt {
                value["createdAt"] = createdAt
            }
            if let updatedAt {
                value["updatedAt"] = updatedAt
                value["recencyAt"] = updatedAt
            }
            if let gitBranch {
                value["gitBranch"] = gitBranch
            }
            return value
        }
    }

    private static let defaultPageLimit = 50
    private static let maxPageLimit = 100
    private static let defaultReadLimit = 20
    private static let maxReadLimit = 50
    private static let maxCursorLength = 256
    private static let maxSessionIdLength = 256
    private static let maxSearchLength = 500
    private static let maxCatalogDiscoveryFiles = 10000
    private static let metadataPrefixBytes = 1024 * 1024
    private static let metadataReadChunkBytes = 16 * 1024
    private static let maxCatalogMetadataScanBytes = 64 * 1024 * 1024
    private static let readChunkBytes = 128 * 1024
    private static let maxTranscriptScanBytes = 64 * 1024 * 1024
    private static let maxTranscriptItemBytes = 4 * 1024 * 1024
    private static let maxTranscriptPageBytes = 20 * 1024 * 1024
    private static let maxTruncatedTranscriptTextBytes = 512 * 1024
    private static let iso8601FractionalStyle = Date.ISO8601FormatStyle(includingFractionalSeconds: true)
    private static let iso8601Style = Date.ISO8601FormatStyle()

    static func shouldAdvertise(
        root: [String: Any]? = nil,
        homeURL: URL = FileManager.default.homeDirectoryForCurrentUser) -> Bool
    {
        let root = root ?? OpenClawConfigFile.loadDict()
        guard OpenClawConfigFile.defaultEnabledBundledPluginAllowed(
            MacNodeClaudeSessionCatalogContract.pluginId,
            root: root)
        else { return false }
        var isDirectory: ObjCBool = false
        return FileManager.default.fileExists(
            atPath: projectsURL(homeURL: homeURL).path,
            isDirectory: &isDirectory) && isDirectory.boolValue
    }

    static func list(paramsJSON: String?) throws -> String {
        try self.list(
            paramsJSON: paramsJSON,
            homeURL: FileManager.default.homeDirectoryForCurrentUser)
    }

    static func read(paramsJSON: String?) throws -> String {
        try self.read(
            paramsJSON: paramsJSON,
            homeURL: FileManager.default.homeDirectoryForCurrentUser)
    }

    static func list(paramsJSON: String?, homeURL: URL) throws -> String {
        let params = try decodeListParams(paramsJSON)
        let offset = try decodeCursor(params.cursor, label: "catalog")
        let search = params.searchTerm?.lowercased()
        let records = try sessions(homeURL: homeURL).filter { record in
            guard let search else { return true }
            return [record.name, record.cwd, record.gitBranch, record.threadId]
                .compactMap { $0?.lowercased() }
                .contains { $0.contains(search) }
        }
        guard offset <= records.count else {
            throw CatalogError.invalidParams("catalog cursor is invalid")
        }
        let end = min(records.count, offset + params.limit)
        let page = records[offset..<end].map(\.wire)
        var response: [String: Any] = ["sessions": page]
        if end < records.count {
            response["nextCursor"] = try encodeCursor(end)
        }
        return try encode(response, maxBytes: self.maxTranscriptPageBytes)
    }

    static func read(paramsJSON: String?, homeURL: URL) throws -> String {
        let params = try decodeReadParams(paramsJSON)
        guard let fileURL = try sessions(homeURL: homeURL)
            .first(where: { $0.threadId == params.threadId })?.fileURL
        else { throw CatalogError.invalidParams("Claude session is unavailable") }

        let handle = try FileHandle(forReadingFrom: fileURL)
        defer { try? handle.close() }
        let fileSize = try handle.seekToEnd()
        let requestedEnd = try params.cursor.map { try self.decodeCursor($0, label: "transcript") }
        let end = UInt64(requestedEnd ?? Int(fileSize))
        guard end <= fileSize else {
            throw CatalogError.invalidParams("transcript cursor is invalid")
        }

        var position = end
        var scanned = 0
        var fragments: [Data] = []
        var found: [(item: [String: Any], start: UInt64)] = []
        func appendLine(prefix: Data, start: UInt64) {
            var line = Data(capacity: prefix.count + fragments.reduce(0) { $0 + $1.count })
            line.append(prefix)
            for fragment in fragments.reversed() {
                line.append(fragment)
            }
            fragments.removeAll(keepingCapacity: true)
            if let item = parseTranscriptLine(line) {
                found.append((item, start))
            }
        }
        while position > 0,
              scanned < self.maxTranscriptScanBytes,
              found.count <= params.limit
        {
            let size = min(
                readChunkBytes,
                Int(position),
                maxTranscriptScanBytes - scanned)
            position -= UInt64(size)
            try handle.seek(toOffset: position)
            guard let chunk = try handle.read(upToCount: size), chunk.count == size else {
                throw CatalogError.unavailable
            }
            scanned += chunk.count
            let bytes = [UInt8](chunk)
            var right = bytes.count
            if !bytes.isEmpty {
                for index in stride(from: bytes.count - 1, through: 0, by: -1) where bytes[index] == 0x0A {
                    let segment = chunk.subdata(in: (index + 1)..<right)
                    if !segment.isEmpty || !fragments.isEmpty {
                        appendLine(prefix: segment, start: position + UInt64(index + 1))
                        if found.count > params.limit {
                            break
                        }
                    }
                    right = index
                }
            }
            if found.count > params.limit {
                break
            }
            let prefix = chunk.subdata(in: 0..<right)
            if position == 0 {
                if !prefix.isEmpty || !fragments.isEmpty {
                    appendLine(prefix: prefix, start: 0)
                }
            } else if !prefix.isEmpty {
                fragments.append(prefix)
            }
        }
        if position > 0, found.count < params.limit {
            throw CatalogError.responseTooLarge
        }
        let requested = Array(found.prefix(params.limit))
        var selected: [(item: [String: Any], start: UInt64)] = []
        var selectedBytes = 0
        for entry in requested {
            guard let data = try? JSONSerialization.data(withJSONObject: entry.item) else { continue }
            if !selected.isEmpty,
               selectedBytes + data.count > self.maxTranscriptPageBytes - 64 * 1024
            {
                break
            }
            selected.append(entry)
            selectedBytes += data.count
        }
        let hasEarlierItems = selected.count < found.count || position > 0
        var response: [String: Any] = [
            "threadId": params.threadId,
            // Shared UI expects newest-first pages and restores chronological order.
            "items": selected.map(\.item),
        ]
        if hasEarlierItems, let earliest = selected.last?.start, earliest > 0 {
            response["nextCursor"] = try encodeCursor(Int(earliest))
        }
        return try encode(response)
    }
}

extension MacNodeClaudeSessionCatalog {
    private static func projectsURL(homeURL: URL) -> URL {
        homeURL.appending(path: ".claude/projects", directoryHint: .isDirectory)
    }

    private static func desktopSessionsURL(homeURL: URL) -> URL {
        homeURL.appending(
            path: "Library/Application Support/Claude/claude-code-sessions",
            directoryHint: .isDirectory)
    }

    private static func childDirectories(_ root: URL) -> [URL] {
        let keys: [URLResourceKey] = [.isDirectoryKey]
        return ((try? FileManager.default.contentsOfDirectory(
            at: root,
            includingPropertiesForKeys: keys,
            options: [.skipsHiddenFiles])) ?? []).filter { url in
            (try? url.resourceValues(forKeys: Set(keys)).isDirectory) == true
        }
    }

    private static func readJSON(_ url: URL) -> Any? {
        guard let data = try? Data(contentsOf: url) else { return nil }
        return try? JSONSerialization.jsonObject(with: data)
    }

    private static func string(_ value: Any?, maxLength: Int = 4096) -> String? {
        guard let raw = value as? String else { return nil }
        let value = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        return value.isEmpty || value.utf8.count > maxLength ? nil : value
    }

    private static func timestampMs(_ value: Any?) -> Int64? {
        if let value = value as? NSNumber {
            return value.int64Value
        }
        guard let value = value as? String else { return nil }
        guard let date = (try? iso8601FractionalStyle.parse(value)) ?? (try? iso8601Style.parse(value))
        else { return nil }
        return Int64(date.timeIntervalSince1970 * 1000)
    }

    private static func isWithin(_ root: URL, candidate: URL) -> Bool {
        let rootPath = root.standardizedFileURL.path
        let candidatePath = candidate.standardizedFileURL.path
        return candidatePath == rootPath || candidatePath.hasPrefix(rootPath + "/")
    }

    private static func safeSessionFile(
        root: URL,
        resolvedRoot: URL,
        candidate: URL,
        sessionId: String) -> URL?
    {
        guard self.isWithin(root, candidate: candidate),
              candidate.lastPathComponent == "\(sessionId).jsonl"
        else { return nil }
        let resolvedCandidate = candidate.resolvingSymlinksInPath()
        var isDirectory: ObjCBool = false
        guard self.isWithin(resolvedRoot, candidate: resolvedCandidate),
              FileManager.default.fileExists(
                  atPath: resolvedCandidate.path,
                  isDirectory: &isDirectory),
              !isDirectory.boolValue
        else { return nil }
        return resolvedCandidate
    }

    private static func desktopMetadata(homeURL: URL) -> (
        active: [String: [String: Any]],
        archived: Set<String>)
    {
        var active: [String: [String: Any]] = [:]
        var archived = Set<String>()
        for accountURL in self.childDirectories(self.desktopSessionsURL(homeURL: homeURL)) {
            for workspaceURL in self.childDirectories(accountURL) {
                let files = (try? FileManager.default.contentsOfDirectory(
                    at: workspaceURL,
                    includingPropertiesForKeys: nil,
                    options: [.skipsHiddenFiles])) ?? []
                for fileURL in files
                    where fileURL.lastPathComponent.hasPrefix("local_") &&
                    fileURL.pathExtension == "json"
                {
                    guard let metadata = self.readJSON(fileURL) as? [String: Any],
                          let sessionId = self.string(metadata["cliSessionId"], maxLength: 256)
                    else { continue }
                    if (metadata["isArchived"] as? Bool) == true {
                        archived.insert(sessionId)
                        active.removeValue(forKey: sessionId)
                    } else if !archived.contains(sessionId) {
                        active[sessionId] = metadata
                    }
                }
            }
        }
        return (active, archived)
    }

    private static func discoverCLIRecords(
        projectsURL: URL,
        resolvedProjectsURL: URL,
        records: inout [String: SessionRecord],
        sidechainIds: inout Set<String>)
    {
        var discoveredFiles = 0
        var scannedBytes = 0
        for projectURL in self.childDirectories(projectsURL) {
            let files = (try? FileManager.default.contentsOfDirectory(
                at: projectURL,
                includingPropertiesForKeys: [.contentModificationDateKey],
                options: [.skipsHiddenFiles])) ?? []
            for candidate in files where candidate.pathExtension == "jsonl" {
                guard discoveredFiles < self.maxCatalogDiscoveryFiles else { return }
                discoveredFiles += 1
                let sessionId = candidate.deletingPathExtension().lastPathComponent
                guard !sessionId.isEmpty,
                      records[sessionId] == nil,
                      !sidechainIds.contains(sessionId),
                      let fileURL = self.safeSessionFile(
                          root: projectsURL,
                          resolvedRoot: resolvedProjectsURL,
                          candidate: candidate,
                          sessionId: sessionId),
                      let handle = try? FileHandle(forReadingFrom: fileURL)
                else { continue }
                var aiTitle: String?
                let updatedAt = (try? fileURL.resourceValues(
                    forKeys: [.contentModificationDateKey]).contentModificationDate)
                    .map { Int64($0.timeIntervalSince1970 * 1000) }
                var stopFile = false
                func inspectLine(_ line: Data) {
                    guard let row = try? JSONSerialization.jsonObject(with: line) as? [String: Any],
                          self.string(row["sessionId"], maxLength: self.maxSessionIdLength) == sessionId
                    else { return }
                    if row["type"] as? String == "ai-title" {
                        aiTitle = self.string(row["aiTitle"], maxLength: 500) ?? aiTitle
                        return
                    }
                    if let entrypoint = row["entrypoint"] as? String, entrypoint != "sdk-cli" {
                        stopFile = true
                        return
                    }
                    if row["entrypoint"] as? String == "sdk-cli",
                       (row["isSidechain"] as? Bool) == true
                    {
                        sidechainIds.insert(sessionId)
                        stopFile = true
                        return
                    }
                    guard row["entrypoint"] as? String == "sdk-cli",
                          row["type"] as? String == "user",
                          let message = row["message"] as? [String: Any],
                          message["role"] as? String == "user",
                          let content = message["content"]
                    else { return }
                    var fragments: [String] = []
                    self.collectText(content, into: &fragments)
                    records[sessionId] = SessionRecord(
                        threadId: sessionId,
                        name: aiTitle ?? fragments.first.flatMap { self.string($0, maxLength: 500) },
                        cwd: self.string(row["cwd"]),
                        createdAt: self.timestampMs(row["timestamp"]),
                        updatedAt: updatedAt,
                        source: "claude-cli",
                        gitBranch: self.string(row["gitBranch"], maxLength: 500),
                        fileURL: fileURL)
                    stopFile = true
                }
                var pending = Data()
                var fileBytes = 0
                var reachedEnd = false
                while !stopFile,
                      fileBytes < self.metadataPrefixBytes,
                      scannedBytes < self.maxCatalogMetadataScanBytes
                {
                    let size = min(
                        self.metadataReadChunkBytes,
                        self.metadataPrefixBytes - fileBytes,
                        self.maxCatalogMetadataScanBytes - scannedBytes)
                    guard size > 0 else { break }
                    guard let chunk = try? handle.read(upToCount: size) else {
                        pending.removeAll()
                        break
                    }
                    if chunk.isEmpty {
                        reachedEnd = true
                        break
                    }
                    fileBytes += chunk.count
                    scannedBytes += chunk.count
                    pending.append(chunk)
                    while !stopFile, let newline = pending.firstIndex(of: 0x0A) {
                        inspectLine(Data(pending[..<newline]))
                        pending.removeSubrange(...newline)
                    }
                }
                if !stopFile, reachedEnd, !pending.isEmpty {
                    inspectLine(pending)
                }
                try? handle.close()
                if scannedBytes >= self.maxCatalogMetadataScanBytes {
                    return
                }
            }
        }
    }

    private static func sessions(homeURL: URL) throws -> [SessionRecord] {
        let projectsURL = self.projectsURL(homeURL: homeURL)
        let resolvedProjectsURL = projectsURL.resolvingSymlinksInPath()
        var records: [String: SessionRecord] = [:]
        var sidechainIds = Set<String>()
        for projectURL in self.childDirectories(projectsURL) {
            guard let index = readJSON(projectURL.appending(path: "sessions-index.json")) as? [String: Any],
                  let entries = index["entries"] as? [[String: Any]]
            else { continue }
            for entry in entries {
                guard let sessionId = string(entry["sessionId"], maxLength: 256) else { continue }
                if (entry["isSidechain"] as? Bool) == true {
                    sidechainIds.insert(sessionId)
                    records.removeValue(forKey: sessionId)
                    continue
                }
                let indexedPath = self.string(entry["fullPath"])
                let candidate = indexedPath.map { URL(filePath: $0) } ??
                    projectURL.appending(path: "\(sessionId).jsonl")
                guard let fileURL = safeSessionFile(
                    root: projectsURL,
                    resolvedRoot: resolvedProjectsURL,
                    candidate: candidate,
                    sessionId: sessionId)
                else { continue }
                records[sessionId] = SessionRecord(
                    threadId: sessionId,
                    name: self.string(entry["summary"], maxLength: 500) ??
                        self.string(entry["firstPrompt"], maxLength: 500),
                    cwd: self.string(entry["projectPath"]),
                    createdAt: self.timestampMs(entry["created"]),
                    updatedAt: self.timestampMs(entry["modified"]) ?? self.timestampMs(entry["fileMtime"]),
                    source: "claude-cli",
                    gitBranch: self.string(entry["gitBranch"], maxLength: 500),
                    fileURL: fileURL)
            }
        }

        self.discoverCLIRecords(
            projectsURL: projectsURL,
            resolvedProjectsURL: resolvedProjectsURL,
            records: &records,
            sidechainIds: &sidechainIds)

        let desktop = self.desktopMetadata(homeURL: homeURL)
        for sessionId in desktop.archived {
            records.removeValue(forKey: sessionId)
        }
        for (sessionId, metadata) in desktop.active {
            if sidechainIds.contains(sessionId) {
                continue
            }
            var record = records[sessionId]
            if record == nil,
               let fileURL = try locateSessionFile(homeURL: homeURL, sessionId: sessionId)
            {
                record = SessionRecord(
                    threadId: sessionId,
                    name: nil,
                    cwd: nil,
                    createdAt: nil,
                    updatedAt: nil,
                    source: "claude-desktop",
                    gitBranch: nil,
                    fileURL: fileURL)
            }
            guard var record else { continue }
            record.name = self.string(metadata["title"], maxLength: 500) ?? record.name
            record.cwd = self.string(metadata["cwd"]) ?? self.string(metadata["originCwd"]) ?? record.cwd
            record.createdAt = self.timestampMs(metadata["createdAt"]) ?? record.createdAt
            record.updatedAt = self.timestampMs(metadata["lastActivityAt"]) ?? record.updatedAt
            record.source = "claude-desktop"
            records[sessionId] = record
        }
        return records.values.sorted { left, right in
            let leftTime = left.updatedAt ?? 0
            let rightTime = right.updatedAt ?? 0
            return leftTime == rightTime ? left.threadId < right.threadId : leftTime > rightTime
        }
    }

    private static func locateSessionFile(homeURL: URL, sessionId: String) throws -> URL? {
        let root = self.projectsURL(homeURL: homeURL)
        let resolvedRoot = root.resolvingSymlinksInPath()
        for projectURL in self.childDirectories(root) {
            let candidate = projectURL.appending(path: "\(sessionId).jsonl")
            if let fileURL = safeSessionFile(
                root: root,
                resolvedRoot: resolvedRoot,
                candidate: candidate,
                sessionId: sessionId)
            {
                return fileURL
            }
        }
        return nil
    }
}

extension MacNodeClaudeSessionCatalog {
    private static func decodeObject(_ paramsJSON: String?) throws -> [String: Any] {
        guard let paramsJSON, !paramsJSON.isEmpty else { return [:] }
        guard let data = paramsJSON.data(using: .utf8),
              let value = try? JSONSerialization.jsonObject(with: data) as? [String: Any]
        else { throw CatalogError.invalidParams("parameters must be valid JSON objects") }
        return value
    }

    private static func requireOnlyKeys(_ value: [String: Any], allowed: Set<String>) throws {
        if let unknown = value.keys.first(where: { !allowed.contains($0) }) {
            throw CatalogError.invalidParams("unknown Claude session parameter: \(unknown)")
        }
    }

    private static func boundedLimit(_ value: Any?, fallback: Int, max: Int) throws -> Int {
        guard let value else { return fallback }
        guard let number = value as? NSNumber,
              CFGetTypeID(number) != CFBooleanGetTypeID(),
              number.doubleValue.rounded() == number.doubleValue,
              number.intValue >= 1,
              number.intValue <= max
        else { throw CatalogError.invalidParams("limit must be an integer from 1 to \(max)") }
        return number.intValue
    }

    private static func decodeListParams(_ paramsJSON: String?) throws -> ListParams {
        let value = try decodeObject(paramsJSON)
        try requireOnlyKeys(value, allowed: ["cursor", "limit", "searchTerm"])
        let cursor = self.string(value["cursor"], maxLength: self.maxCursorLength)
        let search = self.string(value["searchTerm"], maxLength: self.maxSearchLength)
        return try ListParams(
            cursor: cursor,
            limit: self.boundedLimit(value["limit"], fallback: self.defaultPageLimit, max: self.maxPageLimit),
            searchTerm: search)
    }

    private static func decodeReadParams(_ paramsJSON: String?) throws -> ReadParams {
        let value = try decodeObject(paramsJSON)
        try requireOnlyKeys(value, allowed: ["threadId", "cursor", "limit"])
        guard let threadId = string(value["threadId"], maxLength: maxSessionIdLength),
              threadId.range(of: "^[A-Za-z0-9._:-]+$", options: .regularExpression) != nil
        else { throw CatalogError.invalidParams("threadId is invalid") }
        return try ReadParams(
            threadId: threadId,
            cursor: self.string(value["cursor"], maxLength: self.maxCursorLength),
            limit: self.boundedLimit(value["limit"], fallback: self.defaultReadLimit, max: self.maxReadLimit))
    }

    private static func encodeCursor(_ offset: Int) throws -> String {
        let data = try JSONSerialization.data(withJSONObject: ["offset": offset], options: [.sortedKeys])
        return data.base64EncodedString()
            .replacingOccurrences(of: "+", with: "-")
            .replacingOccurrences(of: "/", with: "_")
            .replacingOccurrences(of: "=", with: "")
    }

    private static func decodeCursor(_ cursor: String?, label: String) throws -> Int {
        guard let cursor else { return 0 }
        guard cursor.count <= self.maxCursorLength else {
            throw CatalogError.invalidParams("\(label) cursor is invalid")
        }
        var base64 = cursor.replacingOccurrences(of: "-", with: "+")
            .replacingOccurrences(of: "_", with: "/")
        base64 += String(repeating: "=", count: (4 - base64.count % 4) % 4)
        guard let data = Data(base64Encoded: base64),
              let value = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let offset = value["offset"] as? NSNumber,
              offset.intValue >= 0
        else { throw CatalogError.invalidParams("\(label) cursor is invalid") }
        return offset.intValue
    }

    private static func encode(_ value: [String: Any], maxBytes: Int? = nil) throws -> String {
        guard JSONSerialization.isValidJSONObject(value) else { throw CatalogError.unavailable }
        let data = try JSONSerialization.data(withJSONObject: value, options: [.sortedKeys])
        if let maxBytes, data.count > maxBytes {
            throw CatalogError.responseTooLarge
        }
        guard let result = String(data: data, encoding: .utf8)
        else { throw CatalogError.unavailable }
        return result
    }

    private static func truncateUTF8(_ value: String, maxBytes: Int) -> String {
        guard value.utf8.count > maxBytes else { return value }
        var data = Data(value.utf8.prefix(maxBytes))
        while !data.isEmpty {
            if let result = String(data: data, encoding: .utf8) {
                return result
            }
            data.removeLast()
        }
        return ""
    }
}

extension MacNodeClaudeSessionCatalog {
    private static func collectText(_ value: Any, into fragments: inout [String]) {
        if let value = value as? String {
            if !value.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
                fragments.append(value)
            }
            return
        }
        if let values = value as? [Any] {
            for value in values {
                self.collectText(value, into: &fragments)
            }
            return
        }
        guard let value = value as? [String: Any] else { return }
        for key in ["text", "thinking", "content", "input"] {
            if let child = value[key] {
                self.collectText(child, into: &fragments)
            }
        }
    }

    private static func itemType(role: String, content: Any) -> String {
        guard let blocks = content as? [[String: Any]] else {
            return role == "user" ? "userMessage" : "agentMessage"
        }
        let types = blocks.compactMap { $0["type"] as? String }
        if !types.isEmpty, types.allSatisfy({ $0 == "tool_result" }) {
            return "toolResult"
        }
        if !types.isEmpty, types.allSatisfy({ $0 == "tool_use" }) {
            return "toolCall"
        }
        if !types.isEmpty, types.allSatisfy({ $0 == "thinking" }) {
            return "reasoning"
        }
        return role == "user" ? "userMessage" : "agentMessage"
    }

    private static func parseTranscriptLine(_ data: Data) -> [String: Any]? {
        guard let row = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              (row["isSidechain"] as? Bool) != true,
              let type = row["type"] as? String,
              type == "user" || type == "assistant",
              let message = row["message"] as? [String: Any],
              let role = message["role"] as? String,
              role == type,
              let content = message["content"],
              content is String || content is [Any]
        else { return nil }
        var fragments: [String] = []
        self.collectText(content, into: &fragments)
        let text = Array(NSOrderedSet(array: fragments)) as? [String] ?? fragments
        var item: [String: Any] = [
            "type": itemType(role: role, content: content),
            "content": content,
        ]
        if !text.isEmpty {
            item["text"] = text.joined(separator: "\n\n")
        }
        if let timestamp = string(row["timestamp"], maxLength: 128) {
            item["timestamp"] = timestamp
        }
        if let model = string(message["model"], maxLength: 256) {
            item["model"] = model
        }
        if let uuid = string(row["uuid"], maxLength: 256) {
            item["uuid"] = uuid
        }
        if let encoded = try? JSONSerialization.data(withJSONObject: item),
           encoded.count <= self.maxTranscriptItemBytes
        {
            return item
        }
        let fullText = (item["text"] as? String) ?? ""
        let truncated = self.truncateUTF8(fullText, maxBytes: self.maxTruncatedTranscriptTextBytes) +
            "\n\n[oversized Claude item truncated]"
        let fallback: [String: Any] = [
            "type": item["type"] ?? "item",
            "text": truncated,
            "truncated": true,
        ]
        guard let encoded = try? JSONSerialization.data(withJSONObject: fallback),
              encoded.count <= maxTranscriptItemBytes
        else {
            return ["type": item["type"] ?? "item", "truncated": true]
        }
        return fallback
    }
}
