import Foundation

public actor TranscriptsStore {
    public static let shared = TranscriptsStore()

    private var entries: [String] = []
    private let limit = 100
    private let fileURL: URL

    public init() {
        let dir = FileManager.default.homeDirectoryForCurrentUser
            .appendingPathComponent("Library/Application Support/swabble", isDirectory: true)
        try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        self.fileURL = dir.appendingPathComponent("transcripts.log")
        if let data = try? Data(contentsOf: fileURL),
           let text = String(data: data, encoding: .utf8)
        {
            self.entries = text.split(separator: "\n").map(String.init).suffix(self.limit)
        }
    }

    public func append(text: String) {
        self.entries.append(text)
        if self.entries.count > self.limit {
            self.entries.removeFirst(self.entries.count - self.limit)
        }
        let body = self.entries.joined(separator: "\n")
        try? body.write(to: self.fileURL, atomically: false, encoding: .utf8)
    }

    public func latest() -> [String] {
        self.entries
    }
}
