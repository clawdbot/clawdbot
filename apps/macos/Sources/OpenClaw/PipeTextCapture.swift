import Foundation

final class PipeTextCapture: @unchecked Sendable {
    enum Retention {
        case head, tail
    }

    private let characterLimit: Int
    private let retention: Retention
    private let lock = NSLock()
    private var text = ""
    private var pending = Data()

    init(characterLimit: Int, retention: Retention) {
        self.characterLimit = characterLimit
        self.retention = retention
    }

    func append(_ chunk: Data, atEOF: Bool = false) -> String {
        self.lock.withLock {
            self.pending.append(chunk)
            var end = self.pending.endIndex
            // UTF-8's 2–4-byte leaders can leave at most three bytes unfinished.
            // Keep only that suffix; the standard decoder repairs malformed text.
            if !atEOF,
               let start = self.pending.indices.suffix(4).last(where: { !UTF8.isContinuation(self.pending[$0]) }),
               (0xC2...0xF4).contains(self.pending[start]),
               end - start < (~self.pending[start]).leadingZeroBitCount
            {
                end = start
            }
            // swiftlint:disable:next optional_data_string_conversion
            let message = String(decoding: self.pending[..<end], as: UTF8.self)
                .trimmingCharacters(in: .whitespacesAndNewlines)
            self.pending.removeSubrange(..<end)
            self.text = self.retaining(message)
            return message
        }
    }

    func snapshot() -> String {
        self.lock.withLock { self.text.trimmingCharacters(in: .whitespacesAndNewlines) }
    }

    private func retaining(_ addition: String) -> String {
        // Head retention is final once full. Separate records so later combining
        // marks cannot extend a retained Character across read callbacks.
        guard !addition.isEmpty,
              self.retention != .head || self.text.count < self.characterLimit else { return self.text }
        let text = self.text.isEmpty ? addition : self.text + "\n" + addition
        return String(self.retention == .head ? text.prefix(self.characterLimit) : text.suffix(self.characterLimit))
    }
}
