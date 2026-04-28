import Foundation

enum ModelCatalogLoader {
    static var defaultPath: String {
        self.resolveDefaultPath()
    }

    private static let maxCatalogBytes: UInt64 = 2 * 1024 * 1024
    private static let logger = Logger(subsystem: "ai.openclaw", category: "models")
    private nonisolated static let appSupportDir: URL = {
        let base = FileManager().urls(for: .applicationSupportDirectory, in: .userDomainMask).first!
        return base.appendingPathComponent("OpenClaw", isDirectory: true)
    }()

    private static var cachePath: URL {
        self.appSupportDir.appendingPathComponent("model-catalog/models.generated.js", isDirectory: false)
    }

    static func load(from path: String) async throws -> [ModelChoice] {
        let expanded = (path as NSString).expandingTildeInPath
        guard let resolved = self.resolvePath(preferred: expanded) else {
            self.logger.error("model catalog load failed: file not found")
            throw NSError(
                domain: "ModelCatalogLoader",
                code: 1,
                userInfo: [NSLocalizedDescriptionKey: "Model catalog file not found"])
        }
        self.logger.debug("model catalog load start file=\(URL(fileURLWithPath: resolved.path).lastPathComponent)")
        let source = try self.readCatalogSource(path: resolved.path)
        let rawModels = try self.parseModels(source: source)

        var choices: [ModelChoice] = []
        for (provider, value) in rawModels {
            guard let models = value as? [String: Any] else { continue }
            for (id, payload) in models {
                guard let dict = payload as? [String: Any] else { continue }
                let name = dict["name"] as? String ?? id
                let ctxWindow = dict["contextWindow"] as? Int
                choices.append(ModelChoice(id: id, name: name, provider: provider, contextWindow: ctxWindow))
            }
        }

        let sorted = choices.sorted { lhs, rhs in
            if lhs.provider == rhs.provider {
                return lhs.name.localizedCaseInsensitiveCompare(rhs.name) == .orderedAscending
            }
            return lhs.provider.localizedCaseInsensitiveCompare(rhs.provider) == .orderedAscending
        }
        self.logger.debug("model catalog loaded providers=\(rawModels.count) models=\(sorted.count)")
        if resolved.shouldCache {
            self.cacheCatalog(sourcePath: resolved.path)
        }
        return sorted
    }

    private static func resolveDefaultPath() -> String {
        let cache = self.cachePath.path
        if FileManager().isReadableFile(atPath: cache) { return cache }
        if let bundlePath = self.bundleCatalogPath() { return bundlePath }
        if let nodePath = self.nodeModulesCatalogPath() { return nodePath }
        return cache
    }

    private static func resolvePath(preferred: String) -> (path: String, shouldCache: Bool)? {
        if FileManager().isReadableFile(atPath: preferred) {
            return (preferred, preferred != self.cachePath.path)
        }

        if let bundlePath = self.bundleCatalogPath(), bundlePath != preferred {
            self.logger.warning("model catalog path missing; falling back to bundled catalog")
            return (bundlePath, true)
        }

        let cache = self.cachePath.path
        if cache != preferred, FileManager().isReadableFile(atPath: cache) {
            self.logger.warning("model catalog path missing; falling back to cached catalog")
            return (cache, false)
        }

        if let nodePath = self.nodeModulesCatalogPath(), nodePath != preferred {
            self.logger.warning("model catalog path missing; falling back to node_modules catalog")
            return (nodePath, true)
        }

        return nil
    }

    private static func bundleCatalogPath() -> String? {
        guard let url = Bundle.main.url(forResource: "models.generated", withExtension: "js") else {
            return nil
        }
        return url.path
    }

    private static func nodeModulesCatalogPath() -> String? {
        let roots = [
            URL(fileURLWithPath: CommandResolver.projectRootPath()),
            URL(fileURLWithPath: FileManager().currentDirectoryPath),
        ]
        for root in roots {
            let candidate = root
                .appendingPathComponent("node_modules/@mariozechner/pi-ai/dist/models.generated.js")
            if FileManager().isReadableFile(atPath: candidate.path) {
                return candidate.path
            }
        }
        return nil
    }

    private static func cacheCatalog(sourcePath: String) {
        let destination = self.cachePath
        do {
            try FileManager().createDirectory(
                at: destination.deletingLastPathComponent(),
                withIntermediateDirectories: true)
            if FileManager().fileExists(atPath: destination.path) {
                try FileManager().removeItem(at: destination)
            }
            try FileManager().copyItem(atPath: sourcePath, toPath: destination.path)
            self.logger.debug("model catalog cached file=\(destination.lastPathComponent)")
        } catch {
            self.logger.warning("model catalog cache failed: \(error.localizedDescription)")
        }
    }

    private static func readCatalogSource(path: String) throws -> String {
        let attrs = try FileManager().attributesOfItem(atPath: path)
        if let size = attrs[.size] as? NSNumber,
           size.uint64Value > self.maxCatalogBytes
        {
            throw NSError(
                domain: "ModelCatalogLoader",
                code: 2,
                userInfo: [NSLocalizedDescriptionKey: "Model catalog file is too large"])
        }
        return try String(contentsOfFile: path, encoding: .utf8)
    }

    private static func parseModels(source: String) throws -> [String: Any] {
        guard let assignmentEnd = self.findModelsAssignmentEnd(in: source) else {
            throw ModelCatalogParseError.missingModelsExport
        }
        var parser = ModelCatalogObjectParser(source: String(source[assignmentEnd...]))
        return try parser.parseObject()
    }

    private static func findModelsAssignmentEnd(in source: String) -> String.Index? {
        var index = source.startIndex
        while index < source.endIndex {
            if self.consumeIf("//", in: source, at: &index) {
                self.skipLineComment(in: source, from: &index)
                continue
            }
            if self.consumeIf("/*", in: source, at: &index) {
                self.skipBlockComment(in: source, from: &index)
                continue
            }
            if source[index] == "\"" || source[index] == "'" || source[index] == "`" {
                self.skipString(in: source, quote: source[index], from: &index)
                continue
            }

            var cursor = index
            if self.consumeKeyword("export", in: source, at: &cursor) {
                self.skipWhitespaceAndComments(in: source, from: &cursor)
                if self.consumeKeyword("const", in: source, at: &cursor) {
                    self.skipWhitespaceAndComments(in: source, from: &cursor)
                    if self.consumeKeyword("MODELS", in: source, at: &cursor) {
                        self.skipWhitespaceAndComments(in: source, from: &cursor)
                        if self.consumeIf("=", in: source, at: &cursor) {
                            return cursor
                        }
                    }
                }
            }

            index = source.index(after: index)
        }
        return nil
    }

    private static func skipWhitespaceAndComments(in source: String, from index: inout String.Index) {
        while index < source.endIndex {
            if source[index].isWhitespace {
                index = source.index(after: index)
                continue
            }
            if self.consumeIf("//", in: source, at: &index) {
                self.skipLineComment(in: source, from: &index)
                continue
            }
            if self.consumeIf("/*", in: source, at: &index) {
                self.skipBlockComment(in: source, from: &index)
                continue
            }
            return
        }
    }

    private static func skipLineComment(in source: String, from index: inout String.Index) {
        while index < source.endIndex, source[index] != "\n" {
            index = source.index(after: index)
        }
    }

    private static func skipBlockComment(in source: String, from index: inout String.Index) {
        while index < source.endIndex, !self.consumeIf("*/", in: source, at: &index) {
            index = source.index(after: index)
        }
    }

    private static func skipString(in source: String, quote: Character, from index: inout String.Index) {
        index = source.index(after: index)
        while index < source.endIndex {
            let char = source[index]
            index = source.index(after: index)
            if char == "\\" {
                if index < source.endIndex {
                    index = source.index(after: index)
                }
                continue
            }
            if char == quote {
                return
            }
        }
    }

    private static func consumeKeyword(_ keyword: String, in source: String, at index: inout String.Index) -> Bool {
        guard source[index...].hasPrefix(keyword) else {
            return false
        }
        let end = source.index(index, offsetBy: keyword.count)
        if index > source.startIndex {
            let previous = source[source.index(before: index)]
            if self.isIdentifierCharacter(previous) {
                return false
            }
        }
        if end < source.endIndex, self.isIdentifierCharacter(source[end]) {
            return false
        }
        index = end
        return true
    }

    private static func consumeIf(_ token: String, in source: String, at index: inout String.Index) -> Bool {
        guard source[index...].hasPrefix(token) else {
            return false
        }
        index = source.index(index, offsetBy: token.count)
        return true
    }

    private static func isIdentifierCharacter(_ char: Character) -> Bool {
        char.isLetter || char.isNumber || char == "_" || char == "$"
    }
}

private enum ModelCatalogParseError: Error {
    case expectedObject
    case expectedKey
    case expectedColon
    case expectedValue
    case maxDepthExceeded
    case missingModelsExport
    case unterminatedString
    case invalidNumber
    case unexpectedToken
}

private struct ModelCatalogObjectParser {
    private let maxDepth: Int
    private let source: String
    private var index: String.Index

    init(source: String, maxDepth: Int = 80) {
        self.maxDepth = maxDepth
        self.source = source
        self.index = source.startIndex
    }

    mutating func parseObject(depth: Int = 0) throws -> [String: Any] {
        guard depth <= self.maxDepth else {
            throw ModelCatalogParseError.maxDepthExceeded
        }
        try self.consume("{", or: .expectedObject)
        var result: [String: Any] = [:]

        while true {
            self.skipWhitespaceAndComments()
            if self.consumeIf("}") {
                return result
            }

            let key = try self.parseKey()
            self.skipWhitespaceAndComments()
            try self.consume(":", or: .expectedColon)
            let value = try self.parseValue(depth: depth)
            self.skipTypeAssertion()
            result[key] = value

            self.skipWhitespaceAndComments()
            if self.consumeIf(",") {
                continue
            }
            if self.consumeIf("}") {
                return result
            }
            throw ModelCatalogParseError.unexpectedToken
        }
    }

    private mutating func parseArray(depth: Int) throws -> [Any] {
        guard depth <= self.maxDepth else {
            throw ModelCatalogParseError.maxDepthExceeded
        }
        try self.consume("[", or: .expectedValue)
        var result: [Any] = []

        while true {
            self.skipWhitespaceAndComments()
            if self.consumeIf("]") {
                return result
            }

            try result.append(self.parseValue(depth: depth))
            self.skipTypeAssertion()
            self.skipWhitespaceAndComments()
            if self.consumeIf(",") {
                continue
            }
            if self.consumeIf("]") {
                return result
            }
            throw ModelCatalogParseError.unexpectedToken
        }
    }

    private mutating func parseValue(depth: Int) throws -> Any {
        self.skipWhitespaceAndComments()
        guard let char = self.current else {
            throw ModelCatalogParseError.expectedValue
        }

        switch char {
        case "{":
            return try self.parseObject(depth: depth + 1)
        case "[":
            return try self.parseArray(depth: depth + 1)
        case "\"", "'":
            return try self.parseString()
        case "-", "0"..."9":
            return try self.parseNumber()
        default:
            let identifier = try self.parseIdentifier()
            switch identifier {
            case "true":
                return true
            case "false":
                return false
            case "null", "undefined":
                return NSNull()
            default:
                throw ModelCatalogParseError.unexpectedToken
            }
        }
    }

    private mutating func parseKey() throws -> String {
        self.skipWhitespaceAndComments()
        guard let char = self.current else {
            throw ModelCatalogParseError.expectedKey
        }
        if char == "\"" || char == "'" {
            return try self.parseString()
        }
        return try self.parseIdentifier()
    }

    private mutating func parseIdentifier() throws -> String {
        self.skipWhitespaceAndComments()
        let start = self.index
        while let char = self.current, self.isIdentifierCharacter(char) {
            self.advance()
        }
        guard start != self.index else {
            throw ModelCatalogParseError.expectedKey
        }
        return String(self.source[start..<self.index])
    }

    private mutating func parseString() throws -> String {
        guard let quote = self.current, quote == "\"" || quote == "'" else {
            throw ModelCatalogParseError.expectedValue
        }
        self.advance()

        var result = ""
        while let char = self.current {
            self.advance()
            if char == quote {
                return result
            }
            if char == "\\" {
                try result.append(self.parseEscapedCharacter())
            } else {
                result.append(char)
            }
        }
        throw ModelCatalogParseError.unterminatedString
    }

    private mutating func parseEscapedCharacter() throws -> Character {
        guard let char = self.current else {
            throw ModelCatalogParseError.unterminatedString
        }
        self.advance()

        switch char {
        case "\"", "'", "\\", "/":
            return char
        case "b":
            return "\u{08}"
        case "f":
            return "\u{0c}"
        case "n":
            return "\n"
        case "r":
            return "\r"
        case "t":
            return "\t"
        case "u":
            return try self.parseUnicodeEscape()
        default:
            return char
        }
    }

    private mutating func parseUnicodeEscape() throws -> Character {
        var hex = ""
        for _ in 0..<4 {
            guard let char = self.current else {
                throw ModelCatalogParseError.unterminatedString
            }
            hex.append(char)
            self.advance()
        }
        guard let value = UInt32(hex, radix: 16),
              let scalar = UnicodeScalar(value)
        else {
            throw ModelCatalogParseError.unterminatedString
        }
        return Character(scalar)
    }

    private mutating func parseNumber() throws -> Any {
        let start = self.index
        if self.current == "-" {
            self.advance()
        }
        while let char = self.current, ("0"..."9").contains(char) {
            self.advance()
        }
        var isFloatingPoint = false
        if self.current == "." {
            isFloatingPoint = true
            self.advance()
            while let char = self.current, ("0"..."9").contains(char) {
                self.advance()
            }
        }
        if self.current == "e" || self.current == "E" {
            isFloatingPoint = true
            self.advance()
            if self.current == "-" || self.current == "+" {
                self.advance()
            }
            while let char = self.current, ("0"..."9").contains(char) {
                self.advance()
            }
        }

        let raw = String(self.source[start..<self.index])
        if !isFloatingPoint, let int = Int(raw) {
            return int
        }
        if let double = Double(raw) {
            return double
        }
        throw ModelCatalogParseError.invalidNumber
    }

    private mutating func skipTypeAssertion() {
        while true {
            self.skipWhitespaceAndComments()
            if self.consumeKeyword("satisfies") || self.consumeKeyword("as") {
                self.skipTypeExpression()
            } else {
                return
            }
        }
    }

    private mutating func skipTypeExpression() {
        var angleDepth = 0
        while let char = self.current {
            if char == "<" {
                angleDepth += 1
                self.advance()
                continue
            }
            if char == ">", angleDepth > 0 {
                angleDepth -= 1
                self.advance()
                continue
            }
            if angleDepth == 0, char == "," || char == "}" || char == "]" {
                return
            }
            self.advance()
        }
    }

    private mutating func skipWhitespaceAndComments() {
        while true {
            while let char = self.current, char.isWhitespace {
                self.advance()
            }
            if self.consumeIf("//") {
                while let char = self.current, char != "\n" {
                    self.advance()
                }
                continue
            }
            if self.consumeIf("/*") {
                while self.index < self.source.endIndex, !self.consumeIf("*/") {
                    self.advance()
                }
                continue
            }
            return
        }
    }

    private mutating func consume(_ token: String, or error: ModelCatalogParseError) throws {
        self.skipWhitespaceAndComments()
        guard self.consumeIf(token) else {
            throw error
        }
    }

    private mutating func consumeIf(_ token: String) -> Bool {
        guard self.source[self.index...].hasPrefix(token) else {
            return false
        }
        self.index = self.source.index(self.index, offsetBy: token.count)
        return true
    }

    private mutating func consumeKeyword(_ keyword: String) -> Bool {
        guard self.source[self.index...].hasPrefix(keyword) else {
            return false
        }
        let end = self.source.index(self.index, offsetBy: keyword.count)
        if end < self.source.endIndex, self.isIdentifierCharacter(self.source[end]) {
            return false
        }
        self.index = end
        return true
    }

    private var current: Character? {
        guard self.index < self.source.endIndex else {
            return nil
        }
        return self.source[self.index]
    }

    private mutating func advance() {
        self.index = self.source.index(after: self.index)
    }

    private func isIdentifierCharacter(_ char: Character) -> Bool {
        char.isLetter || char.isNumber || char == "_" || char == "$"
    }
}
