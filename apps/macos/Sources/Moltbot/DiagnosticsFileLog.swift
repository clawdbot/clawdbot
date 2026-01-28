import Foundation

actor DiagnosticsFileLog {
    static let shared = DiagnosticsFileLog()

    private let fileName = "diagnostics.jsonl"
    private let maxBytes: Int64 = 5 * 1024 * 1024
    private let maxBackups = 5

    struct Record: Codable, Sendable {
        let ts: String
        let pid: Int32
        let category: String
        let event: String
        let fields: [String: String]?
    }

    nonisolated static func isEnabled() -> Bool {
        UserDefaults.standard.bool(forKey: debugFileLogEnabledKey)
    }

    nonisolated static func logDirectoryURL() -> URL {
        let library = FileManager().urls(for: .libraryDirectory, in: .userDomainMask).first
            ?? FileManager().homeDirectoryForCurrentUser.appendingPathComponent("Library", isDirectory: true)
        return library
            .appendingPathComponent("Logs", isDirectory: true)
            .appendingPathComponent("Moltbot", isDirectory: true)
    }

    nonisolated static func logFileURL() -> URL {
        self.logDirectoryURL().appendingPathComponent("diagnostics.jsonl", isDirectory: false)
    }

    nonisolated func log(category: String, event: String, fields: [String: String]? = nil) {
        guard Self.isEnabled() else { return }
        let record = Record(
            ts: ISO8601DateFormatter().string(from: Date()),
            pid: ProcessInfo.processInfo.processIdentifier,
            category: category,
            event: event,
            fields: fields)
        Task { await self.write(record: record) }
    }

    func clear() throws {
        let fm = FileManager()
        let base = Self.logFileURL()
        if fm.fileExists(atPath: base.path) {
            try fm.removeItem(at: base)
        }
        for idx in 1...self.maxBackups {
            let url = self.rotatedURL(index: idx)
            if fm.fileExists(atPath: url.path) {
                try fm.removeItem(at: url)
            }
        }
    }

    private func write(record: Record) {
        do {
            try self.ensureDirectory()
            try self.rotateIfNeeded()
            try self.append(record: record)
        } catch {
            // Best-effort only: never crash or block the app on logging.
        }
    }

    private func ensureDirectory() throws {
        try FileManager().createDirectory(
            at: Self.logDirectoryURL(),
            withIntermediateDirectories: true)
    }

    private func append(record: Record) throws {
        let url = Self.logFileURL()
        let data = try JSONEncoder().encode(record)
        var line = Data()
        line.append(data)
        line.append(0x0A) // newline

        let fm = FileManager()
        if !fm.fileExists(atPath: url.path) {
            fm.createFile(atPath: url.path, contents: nil)
        }

        let handle = try FileHandle(forWritingTo: url)
        defer { try? handle.close() }
        try handle.seekToEnd()
        try handle.write(contentsOf: line)
    }

    private func rotateIfNeeded() throws {
        let url = Self.logFileURL()
        guard let attrs = try? FileManager().attributesOfItem(atPath: url.path),
              let size = attrs[.size] as? NSNumber
        else { return }

        if size.int64Value < self.maxBytes { return }

        let fm = FileManager()

        let oldest = self.rotatedURL(index: self.maxBackups)
        if fm.fileExists(atPath: oldest.path) {
            try fm.removeItem(at: oldest)
        }

        if self.maxBackups > 1 {
            for idx in stride(from: self.maxBackups - 1, through: 1, by: -1) {
                let src = self.rotatedURL(index: idx)
                let dst = self.rotatedURL(index: idx + 1)
                if fm.fileExists(atPath: src.path) {
                    if fm.fileExists(atPath: dst.path) {
                        try fm.removeItem(at: dst)
                    }
                    try fm.moveItem(at: src, to: dst)
                }
            }
        }

        let first = self.rotatedURL(index: 1)
        if fm.fileExists(atPath: first.path) {
            try fm.removeItem(at: first)
        }
        if fm.fileExists(atPath: url.path) {
            try fm.moveItem(at: url, to: first)
        }
    }

    private func rotatedURL(index: Int) -> URL {
        Self.logDirectoryURL().appendingPathComponent("\(self.fileName).\(index)", isDirectory: false)
    }
}
