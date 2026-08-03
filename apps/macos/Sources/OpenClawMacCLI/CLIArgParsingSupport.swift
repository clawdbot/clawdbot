import Foundation

enum CLIArgParsingSupport {
    static func nextValue(_ args: [String], index: inout Int) -> String? {
        guard index + 1 < args.count else { return nil }
        index += 1
        return args[index].trimmingCharacters(in: .whitespacesAndNewlines)
    }
}
