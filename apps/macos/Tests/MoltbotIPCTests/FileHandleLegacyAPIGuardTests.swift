import Foundation
import Testing

@Suite struct FileHandleLegacyAPIGuardTests {
    @Test func sourcesAvoidLegacyNonThrowingFileHandleReadAPIs() throws {
        let testFile = URL(fileURLWithPath: #filePath)
        let packageRoot = testFile
            .deletingLastPathComponent() // MoltbotIPCTests
            .deletingLastPathComponent() // Tests
            .deletingLastPathComponent() // apps/macos

        let sourcesRoot = packageRoot.appendingPathComponent("Sources")
        let swiftFiles = try Self.swiftFiles(under: sourcesRoot)

        var offenders: [String] = []
        for file in swiftFiles {
            let raw = try String(contentsOf: file, encoding: .utf8)
            let stripped = Self.stripCommentsAndStrings(from: raw)

            if stripped.contains("readDataToEndOfFile(") || stripped.contains(".availableData") {
                offenders.append(file.path)
            }
        }

        if !offenders.isEmpty {
            let message = "Found legacy FileHandle reads in:\n" + offenders.joined(separator: "\n")
            throw NSError(
                domain: "FileHandleLegacyAPIGuardTests",
                code: 1,
                userInfo: [NSLocalizedDescriptionKey: message])
        }
    }

    private static func swiftFiles(under root: URL) throws -> [URL] {
        let fm = FileManager()
        guard let enumerator = fm.enumerator(at: root, includingPropertiesForKeys: [.isRegularFileKey]) else {
            return []
        }

        var files: [URL] = []
        for case let url as URL in enumerator {
            guard url.pathExtension == "swift" else { continue }
            files.append(url)
        }
        return files
    }

    private static func stripCommentsAndStrings(from source: String) -> String {
        enum Mode {
            case code
            case lineComment
            case blockComment(depth: Int)
            case string(quoteCount: Int) // 1 = ", 3 = """
        }

        var mode: Mode = .code
        var out = ""
        out.reserveCapacity(source.count)

        var index = source.startIndex
        func peek(_ offset: Int) -> Character? {
            guard
                let i = source.index(index, offsetBy: offset, limitedBy: source.endIndex),
                i < source.endIndex
            else { return nil }
            return source[i]
        }

        while index < source.endIndex {
            let ch = source[index]

            switch mode {
            case .code:
                if ch == "/", peek(1) == "/" {
                    out.append("  ")
                    index = source.index(index, offsetBy: 2)
                    mode = .lineComment
                    continue
                }
                if ch == "/", peek(1) == "*" {
                    out.append("  ")
                    index = source.index(index, offsetBy: 2)
                    mode = .blockComment(depth: 1)
                    continue
                }
                if ch == "\"" {
                    let triple = (peek(1) == "\"") && (peek(2) == "\"")
                    out.append(triple ? "   " : " ")
                    index = source.index(index, offsetBy: triple ? 3 : 1)
                    mode = .string(quoteCount: triple ? 3 : 1)
                    continue
                }
                out.append(ch)
                index = source.index(after: index)

            case .lineComment:
                if ch == "\n" {
                    out.append(ch)
                    index = source.index(after: index)
                    mode = .code
                } else {
                    out.append(" ")
                    index = source.index(after: index)
                }

            case let .blockComment(depth):
                if ch == "/", peek(1) == "*" {
                    out.append("  ")
                    index = source.index(index, offsetBy: 2)
                    mode = .blockComment(depth: depth + 1)
                    continue
                }
                if ch == "*", peek(1) == "/" {
                    out.append("  ")
                    index = source.index(index, offsetBy: 2)
                    let newDepth = depth - 1
                    mode = newDepth > 0 ? .blockComment(depth: newDepth) : .code
                    continue
                }
                out.append(ch == "\n" ? "\n" : " ")
                index = source.index(after: index)

            case let .string(quoteCount):
                if ch == "\\", quoteCount == 1 {
                    // Skip escaped character in normal strings.
                    out.append(" ")
                    index = source.index(after: index)
                    if index < source.endIndex {
                        out.append(" ")
                        index = source.index(after: index)
                    }
                    continue
                }
                if ch == "\"" {
                    if quoteCount == 3, peek(1) == "\"", peek(2) == "\"" {
                        out.append("   ")
                        index = source.index(index, offsetBy: 3)
                        mode = .code
                        continue
                    }
                    if quoteCount == 1 {
                        out.append(" ")
                        index = source.index(after: index)
                        mode = .code
                        continue
                    }
                }
                out.append(ch == "\n" ? "\n" : " ")
                index = source.index(after: index)
            }
        }

        return out
    }
}
