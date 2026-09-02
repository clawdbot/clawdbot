import Foundation
import Testing
@testable import OpenClaw

struct PipeTextCaptureTests {
    @Test(arguments: [false, true])
    func `split UTF8 retains the final SSH diagnostic`(endsWithNewline: Bool) {
        let capture = PipeTextCapture(characterLimit: 4096, retention: .tail)
        let diagnostic = "Permission denied (publickey)."
        let output = Data((String(repeating: "x", count: 65535) + "é\n" + diagnostic +
                (endsWithNewline ? "\n" : "")).utf8)

        let firstChunk = capture.append(Data(output.prefix(65536)))
        #expect(firstChunk == String(repeating: "x", count: 65535))
        let completeLines = capture.append(Data(output.dropFirst(65536)))
        let finalLine = capture.append(Data(), atEOF: true)

        let loggedLines = [completeLines, finalLine].filter { !$0.isEmpty }.joined(separator: "\n")
        #expect(loggedLines.contains("é\n" + diagnostic))
        #expect(capture.snapshot().hasSuffix("é\n" + diagnostic))
        #expect(!capture.snapshot().contains("�"))
        #expect(capture.snapshot().count <= 4096)
        #expect(capture.append(Data(), atEOF: true).isEmpty)
    }

    @Test func `live diagnostic chunks retain a bounded tail without repeating at EOF`() {
        let capture = PipeTextCapture(characterLimit: 4096, retention: .tail)
        let tail = String(repeating: "é", count: 4090) + "failure"
        #expect(capture.append(Data("earlier line\n".utf8)) == "earlier line")
        let padding = String(repeating: "x", count: 64 * 1024)
        for _ in 0..<4 {
            #expect(capture.append(Data(padding.utf8)) == padding)
        }
        #expect(capture.append(Data(tail.utf8)) == tail)

        #expect(capture.snapshot() == String(tail.suffix(4096)))
        #expect(capture.append(Data(), atEOF: true).isEmpty)
        #expect(capture.snapshot() == String(tail.suffix(4096)))
    }

    @Test func `worker retains the first 700 normalized characters across split UTF8 and long output`() {
        let capture = PipeTextCapture(characterLimit: 700, retention: .head)
        let head = "refused:\n" + String(repeating: "é", count: 691)
        let output = Data((head + String(repeating: "x", count: 64 * 1024)).utf8)
        #expect(capture.append(Data(output.prefix(10))) == "refused:")
        #expect(capture.append(Data(output.dropFirst(10))).hasPrefix("é"))
        #expect(capture.snapshot() == head)
        #expect(capture.append(Data(repeating: 0x78, count: 64 * 1024)).count == 64 * 1024)
        #expect(capture.snapshot() == head)
        #expect(capture.append(Data("\nlast error\n".utf8)).hasSuffix("last error"))
        #expect(capture.snapshot() == head)
    }

    @Test func `completed worker head cannot grow through later combining marks`() {
        let capture = PipeTextCapture(characterLimit: 700, retention: .head)
        let head = String(repeating: "x", count: 700)
        _ = capture.append(Data((head + "\n").utf8))
        for _ in 0..<256 {
            #expect(capture.append(Data("\u{0301}\n".utf8)) == "\u{0301}")
        }
        #expect(capture.snapshot() == head)
        #expect(capture.snapshot().utf8.count == head.utf8.count)
    }

    @Test(arguments: [false, true], [false, true])
    func `whitespace cannot displace a diagnostic`(retainHead: Bool, separateChunks: Bool) {
        let limit = retainHead ? 700 : 4096
        let capture = PipeTextCapture(characterLimit: limit, retention: retainHead ? .head : .tail)
        let diagnostic = "Permission denied (publickey)."
        let padding = String(repeating: " \n", count: limit)
        let records = retainHead ? [padding, diagnostic] : [diagnostic + "\n", padding]
        for chunk in separateChunks ? records : [records.joined()] {
            _ = capture.append(Data(chunk.utf8))
        }
        #expect(capture.snapshot() == diagnostic)
        _ = capture.append(Data(), atEOF: true)
        #expect(capture.snapshot() == diagnostic)
    }

    @Test(arguments: [false, true])
    func `diagnostic snapshots trim the retained boundary`(retainHead: Bool) {
        let limit = retainHead ? 700 : 4096
        let capture = PipeTextCapture(characterLimit: limit, retention: retainHead ? .head : .tail)
        let diagnostic = String(repeating: "x", count: limit - 1)
        let output = retainHead ? diagnostic + "\nnext\n" : "earlier\n" + diagnostic + "\n"
        _ = capture.append(Data(output.utf8))
        #expect(capture.snapshot() == diagnostic)
    }

    @Test(arguments: [false, true], [" ", "\u{2003}"])
    func `unterminated padding cannot evict diagnostics`(retainHead: Bool, whitespace: String) {
        let capture = PipeTextCapture(characterLimit: retainHead ? 700 : 4096, retention: retainHead ? .head : .tail)
        let diagnostic = "Permission denied (publickey)."
        let padding = String(repeating: whitespace, count: 64 * 1024)
        let output = Data((retainHead ? padding + diagnostic : diagnostic + padding).utf8)
        for offset in stride(from: 0, to: output.count, by: 65536) {
            _ = capture.append(output.subdata(in: offset..<min(offset + 65536, output.count)))
        }
        #expect(capture.snapshot() == diagnostic)
        _ = capture.append(Data("next diagnostic".utf8))
        #expect(capture.snapshot() == diagnostic + "\nnext diagnostic")
        _ = capture.append(Data(), atEOF: true)
        #expect(capture.snapshot() == diagnostic + "\nnext diagnostic")
    }

    @Test(arguments: ["é", "€", "💡"])
    func `split scalars emit as soon as their bytes are complete`(scalar: String) {
        let bytes = Data(scalar.utf8)
        for split in 1..<bytes.count {
            let capture = PipeTextCapture(characterLimit: 4096, retention: .tail)
            #expect(capture.append(Data(bytes.prefix(split))).isEmpty)
            #expect(capture.snapshot().isEmpty)
            #expect(capture.append(Data(bytes.dropFirst(split))) == scalar)
            #expect(capture.snapshot() == scalar)
            #expect(capture.append(Data(), atEOF: true).isEmpty)
        }
    }

    @Test(arguments: ["é", "€", "💡"])
    func `incomplete scalars flush once at EOF`(scalar: String) {
        let bytes = Data(scalar.utf8)
        for split in 1..<bytes.count {
            let capture = PipeTextCapture(characterLimit: 4096, retention: .tail)
            let prefix = Data(bytes.prefix(split))
            #expect(capture.append(prefix).isEmpty)
            let finalText = String(decoding: prefix, as: UTF8.self)
            #expect(capture.append(Data(), atEOF: true) == finalText)
            #expect(capture.snapshot() == finalText)
            #expect(capture.append(Data(), atEOF: true).isEmpty)
        }
    }

    @Test(arguments: [Data([0x80]), Data([0xC0, 0xAF]), Data([0xED, 0xA0, 0x80]), Data([0xFF, 0x61])])
    func `malformed complete bytes use the standard replacement behavior`(bytes: Data) {
        let capture = PipeTextCapture(characterLimit: 4096, retention: .tail)
        let expected = String(decoding: bytes, as: UTF8.self)
        #expect(capture.append(bytes) == expected)
        #expect(capture.snapshot() == expected)
        #expect(capture.append(Data(), atEOF: true).isEmpty)
    }
}
