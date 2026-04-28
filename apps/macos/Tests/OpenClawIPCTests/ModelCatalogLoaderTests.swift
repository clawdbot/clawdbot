import Foundation
import Testing
@testable import OpenClaw

struct ModelCatalogLoaderTests {
    @Test
    func `load parses models from type script and sorts`() async throws {
        let src = """
        export const MODELS = {
          openai: {
            "gpt-4o-mini": { name: "GPT-4o mini", contextWindow: 128000 } satisfies any,
            "gpt-4o": { name: "GPT-4o", contextWindow: 128000 } as any,
            "gpt-3.5": { contextWindow: 16000 },
          },
          anthropic: {
            "claude-3": { name: "Claude 3", contextWindow: 200000 },
          },
        };
        """

        let tmp = FileManager().temporaryDirectory
            .appendingPathComponent("models-\(UUID().uuidString).ts")
        defer { try? FileManager().removeItem(at: tmp) }
        try src.write(to: tmp, atomically: true, encoding: .utf8)

        let choices = try await ModelCatalogLoader.load(from: tmp.path)
        #expect(choices.count == 4)
        #expect(choices.first?.provider == "anthropic")
        #expect(choices.first?.id == "claude-3")

        let ids = Set(choices.map(\.id))
        #expect(ids == Set(["claude-3", "gpt-4o", "gpt-4o-mini", "gpt-3.5"]))

        let openai = choices.filter { $0.provider == "openai" }
        let openaiNames = openai.map(\.name)
        #expect(openaiNames == openaiNames.sorted { a, b in
            a.localizedCaseInsensitiveCompare(b) == .orderedAscending
        })
    }

    @Test
    func `load with no export rejects catalog`() async throws {
        let src = "const NOPE = 1;"
        let tmp = FileManager().temporaryDirectory
            .appendingPathComponent("models-\(UUID().uuidString).ts")
        defer { try? FileManager().removeItem(at: tmp) }
        try src.write(to: tmp, atomically: true, encoding: .utf8)

        do {
            _ = try await ModelCatalogLoader.load(from: tmp.path)
            Issue.record("expected missing MODELS export rejection")
        } catch {
            #expect(String(describing: error).isEmpty == false)
        }
    }

    @Test
    func `load ignores fake exports in comments and strings`() async throws {
        let src = #"""
        // export const MODELS = { bad: { "bad": { name: "Bad", contextWindow: 1 } } };
        const text = "export const MODELS = { alsoBad: {} }";
        export const MODELS = {
          openai: {
            "gpt-4o": { name: "GPT-4o", contextWindow: 128000 } satisfies ModelConfig<string, number>,
          },
        };
        """#

        let tmp = FileManager().temporaryDirectory
            .appendingPathComponent("models-\(UUID().uuidString).ts")
        defer { try? FileManager().removeItem(at: tmp) }
        try src.write(to: tmp, atomically: true, encoding: .utf8)

        let choices = try await ModelCatalogLoader.load(from: tmp.path)
        #expect(choices.count == 1)
        #expect(choices.first?.id == "gpt-4o")
        #expect(choices.first?.provider == "openai")
    }

    @Test
    func `load rejects executable catalog expressions`() async throws {
        let src = """
        export const MODELS = {
          openai: {
            "gpt-4o": { name: (() => { throw new Error("nope") })(), contextWindow: 128000 },
          },
        };
        """

        let tmp = FileManager().temporaryDirectory
            .appendingPathComponent("models-\(UUID().uuidString).ts")
        defer { try? FileManager().removeItem(at: tmp) }
        try src.write(to: tmp, atomically: true, encoding: .utf8)

        do {
            _ = try await ModelCatalogLoader.load(from: tmp.path)
            Issue.record("expected executable catalog expression rejection")
        } catch {
            #expect(String(describing: error).isEmpty == false)
        }
    }
}
