import CoreFoundation
import Darwin
import Foundation

enum MacNodeCodexThreadCatalogContract {
    static let pluginId = "codex-supervisor"
    static let capability = "codex-app-server-threads"
    static let listCommand = "codex.appServer.threads.list.v1"
}

enum MacNodeCodexThreadCatalog {
    struct ResolvedInvocation: Equatable {
        var executable: String
        var arguments: [String]
        var cwd: URL?
    }

    enum CatalogError: LocalizedError, Equatable {
        case invalidParams(String)
        case codexUnavailable
        case appServerUnavailable
        case responseTooLarge
        case timedOut

        var errorDescription: String? {
            switch self {
            case let .invalidParams(message):
                "INVALID_REQUEST: \(message)"
            case .codexUnavailable:
                "UNAVAILABLE: Codex CLI not found"
            case .appServerUnavailable:
                "UNAVAILABLE: Codex app-server thread list failed"
            case .responseTooLarge:
                "UNAVAILABLE: Codex app-server thread metadata exceeded the size limit"
            case .timedOut:
                "UNAVAILABLE: Codex app-server thread list timed out"
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
        var archived = false
        var searchTerm: String?
        var cwd: String?
    }

    private struct ConfiguredStdioEndpoint {
        var command: String?
        var args: [String]?
        var cwd: String?
    }

    private enum StringOverflow {
        case omit
        case truncate
    }

    private static let defaultArguments = ["app-server", "--listen", "stdio://"]
    static let defaultMacOSAppExecutable = "/Applications/Codex.app/Contents/Resources/codex"
    private static let maxSessionIdLength = 256
    private static let maxSessionNameLength = 500
    private static let maxCwdLength = 4096
    private static let maxStatusLength = 64
    private static let maxMetadataLength = 500
    private static let maxActiveFlags = 16
    private static let maxActiveFlagLength = 128
    private static let maxCursorLength = 4096

    private struct WireResponse: Encodable {
        var sessions: [WireSession]
        var nextCursor: String?
        var backwardsCursor: String?
    }

    private struct WireSession: Encodable {
        var threadId: String
        var sessionId: String?
        var name: String?
        var cwd: String?
        var status: String
        var activeFlags: [String]?
        var createdAt: Int64?
        var updatedAt: Int64?
        var recencyAt: Int64?
        var source: String?
        var modelProvider: String?
        var cliVersion: String?
        var gitBranch: String?
        var archived: Bool
    }

    static func list(paramsJSON: String?) async throws -> String {
        let params = try self.decodeParams(paramsJSON)
        let invocation = try self.resolveInvocation()
        return try await self.list(params: params, invocation: invocation)
    }

    static func list(
        paramsJSON: String?,
        executable: String,
        arguments: [String]? = nil,
        cwd: URL? = nil,
        timeoutSeconds: Double = 12,
        maxLineBytes: Int = 5 * 1024 * 1024) async throws -> String
    {
        let params = try self.decodeParams(paramsJSON)
        return try await self.list(
            params: params,
            invocation: ResolvedInvocation(
                executable: executable,
                arguments: arguments ?? self.defaultArguments,
                cwd: cwd),
            timeoutSeconds: timeoutSeconds,
            maxLineBytes: maxLineBytes)
    }

    private static func list(
        params: ListParams,
        invocation: ResolvedInvocation,
        timeoutSeconds: Double = 12,
        maxLineBytes: Int = 5 * 1024 * 1024) async throws -> String
    {
        let session = try CodexAppServerThreadListSession(
            invocation: invocation,
            listParams: self.appServerParams(params),
            timeoutSeconds: timeoutSeconds,
            maxLineBytes: maxLineBytes)
        let output = try await session.run()
        return try self.normalize(
            listResultData: output.listResultData,
            archived: params.archived,
            searchTerm: params.searchTerm)
    }

    static func resolveInvocation(
        root: [String: Any]? = nil,
        searchPaths: [String]? = nil,
        currentDirectoryURL: URL = URL(
            fileURLWithPath: FileManager.default.currentDirectoryPath,
            isDirectory: true),
        defaultMacOSAppExecutable: String = MacNodeCodexThreadCatalog.defaultMacOSAppExecutable) throws
        -> ResolvedInvocation
    {
        let root = root ?? OpenClawConfigFile.loadDict()
        let endpoint = self.configuredStdioEndpoint(root: root)
        let cwd = endpoint?.cwd.map {
            self.resolvePath($0, relativeTo: currentDirectoryURL, isDirectory: true)
        }
        let configuredCommand = endpoint?.command
        let rawCommand = configuredCommand ?? "codex"
        let command = rawCommand.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !command.isEmpty else { throw CatalogError.codexUnavailable }

        let executable: String?
        if configuredCommand == nil,
           FileManager.default.isExecutableFile(atPath: defaultMacOSAppExecutable)
        {
            executable = defaultMacOSAppExecutable
        } else if command.contains("/") || command.hasPrefix("~") {
            let url = self.resolvePath(command, relativeTo: cwd ?? currentDirectoryURL)
            executable = FileManager.default.isExecutableFile(atPath: url.path) ? url.path : nil
        } else {
            executable = CommandResolver.findExecutable(named: command, searchPaths: searchPaths)
        }
        guard let executable else { throw CatalogError.codexUnavailable }
        return ResolvedInvocation(
            executable: executable,
            arguments: endpoint?.args ?? self.defaultArguments,
            cwd: cwd)
    }

    private static func configuredStdioEndpoint(root: [String: Any]) -> ConfiguredStdioEndpoint? {
        guard let entry = OpenClawConfigFile.pluginEntry(
            MacNodeCodexThreadCatalogContract.pluginId,
            root: root),
            let config = entry["config"] as? [String: Any],
            let endpoints = config["endpoints"] as? [Any]
        else { return nil }

        for value in endpoints {
            guard let endpoint = value as? [String: Any] else { continue }
            let transport = endpoint["transport"] as? String
            guard transport == nil || transport == "stdio-proxy" else { continue }
            let args = (endpoint["args"] as? [Any])?.compactMap { $0 as? String }
            return ConfiguredStdioEndpoint(
                command: endpoint["command"] as? String,
                args: args?.isEmpty == false ? args : nil,
                cwd: endpoint["cwd"] as? String)
        }
        return nil
    }

    private static func resolvePath(
        _ path: String,
        relativeTo base: URL,
        isDirectory: Bool = false) -> URL
    {
        let expanded = (path as NSString).expandingTildeInPath
        if expanded.hasPrefix("/") {
            return URL(fileURLWithPath: expanded, isDirectory: isDirectory).standardizedFileURL
        }
        return URL(fileURLWithPath: expanded, isDirectory: isDirectory, relativeTo: base)
            .standardizedFileURL
    }

    private static func decodeParams(_ paramsJSON: String?) throws -> ListParams {
        guard let paramsJSON, !paramsJSON.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else {
            return ListParams()
        }
        guard let data = paramsJSON.data(using: .utf8) else {
            throw CatalogError.invalidParams("parameters must be valid JSON")
        }
        let raw: Any
        do {
            raw = try JSONSerialization.jsonObject(with: data)
        } catch {
            throw CatalogError.invalidParams("parameters must be valid JSON")
        }
        guard let raw = raw as? [String: Any] else {
            throw CatalogError.invalidParams("parameters must be an object")
        }
        let allowed = Set(["cursor", "limit", "archived", "searchTerm", "cwd"])
        if let unknown = raw.keys.first(where: { !allowed.contains($0) }) {
            throw CatalogError.invalidParams("unknown Codex session catalog parameter: \(unknown)")
        }

        var params = ListParams()
        params.cursor = try self.optionalString(raw, key: "cursor", maxLength: self.maxCursorLength)
        params.searchTerm = try self.optionalString(
            raw,
            key: "searchTerm",
            maxLength: self.maxSessionNameLength)
        params.cwd = try self.optionalString(raw, key: "cwd", maxLength: self.maxCwdLength)
        if let value = raw["limit"] {
            guard let number = value as? NSNumber,
                  CFGetTypeID(number) != CFBooleanGetTypeID(),
                  number.doubleValue.rounded() == number.doubleValue,
                  (1...100).contains(number.intValue)
            else {
                throw CatalogError.invalidParams("limit must be an integer from 1 to 100")
            }
            params.limit = number.intValue
        }
        if let value = raw["archived"] {
            guard CFGetTypeID(value as CFTypeRef) == CFBooleanGetTypeID(),
                  let archived = value as? Bool
            else {
                throw CatalogError.invalidParams("archived must be a boolean")
            }
            params.archived = archived
        }
        return params
    }

    private static func optionalString(
        _ params: [String: Any],
        key: String,
        maxLength: Int) throws -> String?
    {
        guard let value = params[key] else { return nil }
        guard let value = value as? String else {
            throw CatalogError.invalidParams("\(key) must be a string")
        }
        let trimmed = value.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return nil }
        guard trimmed.utf16.count <= maxLength else {
            throw CatalogError.invalidParams("\(key) must be at most \(maxLength) characters")
        }
        return trimmed
    }

    private static func appServerParams(_ params: ListParams) -> [String: Any] {
        var result: [String: Any] = [
            "limit": params.limit,
            "sortKey": "recency_at",
            "sortDirection": "desc",
            // An empty provider list means all providers. Omitting sourceKinds keeps
            // Codex's stable interactive-session default.
            "modelProviders": [String](),
            "archived": params.archived,
            "useStateDbOnly": false,
        ]
        if let cursor = params.cursor {
            result["cursor"] = cursor
        }
        // Search only the normalized names below. App Server title search can
        // match transcript-derived previews that the node boundary withholds.
        if let cwd = params.cwd {
            result["cwd"] = cwd
        }
        return result
    }

    static func normalize(
        listResultData: Data,
        archived: Bool,
        searchTerm: String? = nil) throws -> String
    {
        guard let result = try JSONSerialization.jsonObject(with: listResultData) as? [String: Any],
              let rawThreads = result["data"] as? [Any]
        else {
            throw CatalogError.appServerUnavailable
        }

        let sessions = rawThreads.compactMap { value -> WireSession? in
            guard let thread = value as? [String: Any],
                  let threadId = self.boundedString(
                      thread["id"],
                      maxLength: self.maxSessionIdLength)
            else { return nil }
            let statusRecord = thread["status"] as? [String: Any]
            let status = self.boundedString(
                statusRecord?["type"],
                maxLength: self.maxStatusLength) ?? "notLoaded"
            let decodedActiveFlags = (statusRecord?["activeFlags"] as? [Any])?
                .compactMap {
                    self.boundedString($0, maxLength: self.maxActiveFlagLength)
                }
                .prefix(self.maxActiveFlags)
            let activeFlags = decodedActiveFlags?.isEmpty == false ? decodedActiveFlags : nil
            let gitInfo = thread["gitInfo"] as? [String: Any]
            let name = self.boundedString(
                thread["name"],
                maxLength: self.maxSessionNameLength,
                overflow: .truncate)
            if let searchTerm,
               name?.range(of: searchTerm, options: [.literal]) == nil
            {
                return nil
            }
            return WireSession(
                threadId: threadId,
                sessionId: self.boundedString(
                    thread["sessionId"],
                    maxLength: self.maxSessionIdLength),
                name: name,
                cwd: self.boundedString(thread["cwd"], maxLength: self.maxCwdLength),
                status: status,
                activeFlags: activeFlags.map(Array.init),
                createdAt: self.integer(thread["createdAt"]),
                updatedAt: self.integer(thread["updatedAt"]),
                recencyAt: self.integer(thread["recencyAt"]),
                source: self.sourceName(thread["source"]),
                modelProvider: self.boundedString(
                    thread["modelProvider"],
                    maxLength: self.maxMetadataLength,
                    overflow: .truncate),
                cliVersion: self.boundedString(
                    thread["cliVersion"],
                    maxLength: self.maxMetadataLength,
                    overflow: .truncate),
                gitBranch: self.boundedString(
                    gitInfo?["branch"],
                    maxLength: self.maxMetadataLength,
                    overflow: .truncate),
                archived: archived)
        }

        let response = WireResponse(
            sessions: sessions,
            nextCursor: self.boundedCursor(result["nextCursor"]),
            backwardsCursor: self.boundedCursor(result["backwardsCursor"]))
        let data = try JSONEncoder().encode(response)
        guard let json = String(data: data, encoding: .utf8) else {
            throw CatalogError.appServerUnavailable
        }
        return json
    }

    fileprivate static func nonEmptyString(_ value: Any?) -> String? {
        guard let value = value as? String else { return nil }
        let trimmed = value.trimmingCharacters(in: .whitespacesAndNewlines)
        return trimmed.isEmpty ? nil : trimmed
    }

    private static func boundedString(
        _ value: Any?,
        maxLength: Int,
        overflow: StringOverflow = .omit) -> String?
    {
        guard let value = self.nonEmptyString(value) else { return nil }
        guard value.utf16.count > maxLength else { return value }
        guard case .truncate = overflow else { return nil }
        return self.truncateUTF16(value, maxLength: maxLength)
    }

    private static func boundedCursor(_ value: Any?) -> String? {
        guard let value = value as? String,
              self.nonEmptyString(value) != nil,
              value.utf16.count <= self.maxCursorLength
        else { return nil }
        // App Server cursors are opaque; do not trim or regenerate them after
        // locally filtering a page by its normalized session names.
        return value
    }

    private static func truncateUTF16(_ value: String, maxLength: Int) -> String {
        var result = ""
        var length = 0
        for scalar in value.unicodeScalars {
            let scalarLength = scalar.value > 0xFFFF ? 2 : 1
            guard length + scalarLength <= maxLength else { break }
            result.unicodeScalars.append(scalar)
            length += scalarLength
        }
        return result
    }

    private static func integer(_ value: Any?) -> Int64? {
        guard let number = value as? NSNumber,
              CFGetTypeID(number) != CFBooleanGetTypeID()
        else { return nil }
        return number.int64Value
    }

    private static func sourceName(_ value: Any?) -> String? {
        let raw: String? = if let source = self.nonEmptyString(value) {
            source
        } else if let source = value as? [String: Any],
                  let custom = self.nonEmptyString(source["custom"])
        {
            "custom:\(custom)"
        } else if let source = value as? [String: Any] {
            source.keys.min()
        } else {
            nil
        }
        return self.boundedString(
            raw,
            maxLength: self.maxMetadataLength,
            overflow: .truncate)
    }
}

private final class CodexAppServerThreadListSession: @unchecked Sendable {
    struct Output {
        var listResultData: Data
    }

    private enum Phase {
        case initialize
        case list
    }

    private let process = Process()
    private let stdinPipe = Pipe()
    private let stdoutPipe = Pipe()
    private let stderrPipe = Pipe()
    private let queue = DispatchQueue(label: "ai.openclaw.codex-thread-catalog")
    private let listRequestData: Data
    private let timeoutSeconds: Double
    private let maxLineBytes: Int
    private var continuation: CheckedContinuation<Output, Error>?
    private var timer: DispatchSourceTimer?
    private var stdoutBuffer = Data()
    private var phase = Phase.initialize
    private var finished = false
    private var launched = false

    private struct ReadChunk {
        var data: Data
        var reachedEOF: Bool
    }

    init(
        invocation: MacNodeCodexThreadCatalog.ResolvedInvocation,
        listParams: [String: Any],
        timeoutSeconds: Double,
        maxLineBytes: Int) throws
    {
        self.process.executableURL = URL(fileURLWithPath: invocation.executable)
        self.process.arguments = invocation.arguments
        self.process.currentDirectoryURL = invocation.cwd
        var environment = ProcessInfo.processInfo.environment
        environment["PATH"] = CommandResolver.preferredPaths().joined(separator: ":")
        self.process.environment = environment
        self.process.standardInput = self.stdinPipe
        self.process.standardOutput = self.stdoutPipe
        self.process.standardError = self.stderrPipe
        self.timeoutSeconds = max(0.01, timeoutSeconds)
        self.maxLineBytes = max(1, maxLineBytes)
        self.listRequestData = try Self.jsonData([
            "id": 2,
            "method": "thread/list",
            "params": listParams,
        ])
    }

    func run() async throws -> Output {
        try await withTaskCancellationHandler {
            try await withCheckedThrowingContinuation { continuation in
                self.queue.async {
                    self.start(continuation)
                }
            }
        } onCancel: {
            self.queue.async {
                self.finish(.failure(CancellationError()))
            }
        }
    }

    private func start(_ continuation: CheckedContinuation<Output, Error>) {
        guard !self.finished else {
            continuation.resume(throwing: CancellationError())
            return
        }
        self.continuation = continuation
        // DispatchSource readability callbacks may be followed by future drain
        // loops. Keep both pipes non-blocking so an open App Server cannot stall
        // the catalog handshake after emitting one JSON-RPC frame.
        Self.setNonBlocking(self.stdoutPipe.fileHandleForReading)
        Self.setNonBlocking(self.stderrPipe.fileHandleForReading)
        self.stdoutPipe.fileHandleForReading.readabilityHandler = { [weak self] handle in
            guard let session = self else { return }
            let chunk = Self.readAvailable(from: handle, maxBytes: session.maxLineBytes)
            if chunk.reachedEOF {
                handle.readabilityHandler = nil
            }
            guard !chunk.data.isEmpty else { return }
            session.queue.async { [session] in
                session.consumeStdout(chunk.data)
            }
        }
        // Drain stderr so the child cannot block. App Server stderr is deliberately
        // not forwarded over the Gateway because it may contain local paths.
        self.stderrPipe.fileHandleForReading.readabilityHandler = { handle in
            if Self.drainAvailable(from: handle) {
                handle.readabilityHandler = nil
            }
        }
        self.process.terminationHandler = { [weak self] _ in
            guard let session = self else { return }
            session.queue.async { [session] in
                guard !session.finished else { return }
                session.finish(.failure(MacNodeCodexThreadCatalog.CatalogError.appServerUnavailable))
            }
        }

        let timer = DispatchSource.makeTimerSource(queue: self.queue)
        timer.schedule(deadline: .now() + self.timeoutSeconds)
        timer.setEventHandler { [weak self] in
            self?.finish(.failure(MacNodeCodexThreadCatalog.CatalogError.timedOut))
        }
        self.timer = timer
        timer.resume()

        do {
            try self.process.run()
            self.launched = true
            try self.write(Self.initializeRequestData())
        } catch {
            self.finish(.failure(MacNodeCodexThreadCatalog.CatalogError.appServerUnavailable))
        }
    }

    private func consumeStdout(_ data: Data) {
        guard !self.finished else { return }
        self.stdoutBuffer.append(data)
        guard self.stdoutBuffer.count <= self.maxLineBytes else {
            self.finish(.failure(MacNodeCodexThreadCatalog.CatalogError.responseTooLarge))
            return
        }

        while let newline = self.stdoutBuffer.firstIndex(of: 0x0A) {
            let line = self.stdoutBuffer.prefix(upTo: newline)
            self.stdoutBuffer.removeSubrange(...newline)
            guard !line.isEmpty else { continue }
            self.handleLine(Data(line))
            if self.finished {
                return
            }
        }
    }

    private func handleLine(_ data: Data) {
        guard let message = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let id = (message["id"] as? NSNumber)?.intValue
        else { return }

        if message["error"] is [String: Any] {
            self.finish(.failure(MacNodeCodexThreadCatalog.CatalogError.appServerUnavailable))
            return
        }

        switch (self.phase, id) {
        case (.initialize, 1):
            guard message["result"] is [String: Any] else {
                self.finish(.failure(MacNodeCodexThreadCatalog.CatalogError.appServerUnavailable))
                return
            }
            self.phase = .list
            do {
                try self.write(Self.initializedNotificationData())
                try self.write(self.listRequestData)
            } catch {
                self.finish(.failure(MacNodeCodexThreadCatalog.CatalogError.appServerUnavailable))
            }
        case (.list, 2):
            guard let result = message["result"] as? [String: Any],
                  let resultData = try? Self.jsonData(result)
            else {
                self.finish(.failure(MacNodeCodexThreadCatalog.CatalogError.appServerUnavailable))
                return
            }
            self.finish(.success(Output(listResultData: resultData)))
        default:
            break
        }
    }

    private func write(_ data: Data) throws {
        var frame = data
        frame.append(0x0A)
        try self.stdinPipe.fileHandleForWriting.write(contentsOf: frame)
    }

    private func finish(_ result: Result<Output, Error>) {
        guard !self.finished else { return }
        self.finished = true
        self.timer?.cancel()
        self.timer = nil
        self.stdoutPipe.fileHandleForReading.readabilityHandler = nil
        self.stderrPipe.fileHandleForReading.readabilityHandler = nil
        try? self.stdinPipe.fileHandleForWriting.close()
        if self.launched, self.process.isRunning {
            self.process.terminate()
        }
        guard let continuation = self.continuation else { return }
        self.continuation = nil
        continuation.resume(with: result)
    }

    private static func initializeRequestData() throws -> Data {
        try self.jsonData([
            "id": 1,
            "method": "initialize",
            "params": [
                "clientInfo": [
                    "name": "openclaw_macos",
                    "title": "OpenClaw macOS Node",
                    "version": GatewayEnvironment.expectedGatewayVersionString() ?? "unknown",
                ],
            ],
        ])
    }

    private static func initializedNotificationData() throws -> Data {
        try self.jsonData(["method": "initialized"])
    }

    private static func jsonData(_ object: Any) throws -> Data {
        try JSONSerialization.data(withJSONObject: object)
    }

    private static func readAvailable(from handle: FileHandle, maxBytes: Int) -> ReadChunk {
        // FileHandle.read(upToCount:) can wait for EOF despite a readability callback.
        // The descriptor is non-blocking, so drain one complete JSONL frame (or
        // the response cap plus one byte) without waiting for the App Server to exit.
        var data = Data()
        let captureLimit = maxBytes == Int.max ? Int.max : maxBytes + 1
        var buffer = [UInt8](repeating: 0, count: 64 * 1024)
        while true {
            let count = buffer.withUnsafeMutableBytes { bytes in
                Darwin.read(handle.fileDescriptor, bytes.baseAddress, bytes.count)
            }
            if count > 0 {
                let remaining = max(0, captureLimit - data.count)
                data.append(contentsOf: buffer.prefix(min(count, remaining)))
                if data.count > maxBytes {
                    return ReadChunk(data: data, reachedEOF: false)
                }
                continue
            }
            if count == 0 {
                return ReadChunk(data: data, reachedEOF: true)
            }
            if errno == EINTR { continue }
            if errno == EAGAIN || errno == EWOULDBLOCK {
                return ReadChunk(data: data, reachedEOF: false)
            }
            return ReadChunk(data: data, reachedEOF: true)
        }
    }

    private static func drainAvailable(from handle: FileHandle) -> Bool {
        var buffer = [UInt8](repeating: 0, count: 64 * 1024)
        while true {
            let count = buffer.withUnsafeMutableBytes { bytes in
                Darwin.read(handle.fileDescriptor, bytes.baseAddress, bytes.count)
            }
            if count > 0 {
                continue
            }
            if count == 0 {
                return true
            }
            if errno == EINTR { continue }
            if errno == EAGAIN || errno == EWOULDBLOCK {
                return false
            }
            return true
        }
    }

    private static func setNonBlocking(_ handle: FileHandle) {
        let descriptor = handle.fileDescriptor
        let flags = Darwin.fcntl(descriptor, F_GETFL)
        if flags >= 0 {
            _ = Darwin.fcntl(descriptor, F_SETFL, flags | O_NONBLOCK)
        }
    }
}
