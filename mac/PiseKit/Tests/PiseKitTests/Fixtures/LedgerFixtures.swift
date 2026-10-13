import Foundation
@testable import PiseKit

enum LedgerFixtures {
    static let now = date("2026-10-08T12:00:00Z")
    static var calendar: Calendar {
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = TimeZone(secondsFromGMT: 0)!
        return calendar
    }

    static func date(_ text: String) -> Date { try! Date.ISO8601FormatStyle().parse(text) }

    static func project(remote: String? = "github.com/example/project", root: String? = "/work/project",
                        common: String? = "/work/project/.git", branch: String? = "main") -> LedgerProject {
        LedgerProject(name: "project", gitRemote: remote, gitRoot: root, gitCommonDir: common, gitBranch: branch)
    }

    static func usage(id: String = "u1", timestamp: Date = now, cost: Double? = 1,
                      tokens: Double = 100, session: String? = "/sessions/one.jsonl",
                      project: LedgerProject = project(), cwd: String? = "/work/project",
                      model: String = "model", provider: String = "provider", tags: [String] = []) -> UsageRecord {
        UsageRecord(version: 1, id: id, source: "live", timestamp: timestamp, sessionFile: session,
                    sessionEntryId: id, cwd: cwd, project: project, tags: tags, provider: provider, model: model,
                    usage: .init(input: tokens / 2, output: tokens / 2, cacheRead: 0, cacheWrite: 0,
                                 totalTokens: tokens, totalCost: cost))
    }

    static func skill(id: String = "s1", timestamp: Date = now, name: String = "swiftui",
                      trigger: String = "read-tool", session: String? = "/sessions/one.jsonl",
                      sessionId: String? = "one", project: LedgerProject? = project(),
                      cwd: String? = "/work/project") -> SkillRecord {
        SkillRecord(version: 1, id: id, timestamp: timestamp, trigger: trigger, sessionFile: session,
                    sessionId: sessionId, cwd: cwd, project: project,
                    skill: .init(name: name, path: "/skills/\(name)/SKILL.md", scope: "user", source: "fixture"))
    }

    static func line<T: Encodable>(_ value: T) throws -> Data {
        let encoder = JSONEncoder()
        encoder.dateEncodingStrategy = .iso8601
        var data = try encoder.encode(value)
        data.append(0x0A)
        return data
    }

    static func snapshot(usage: [UsageRecord] = [], skills: [SkillRecord] = []) -> LedgerSnapshot {
        LedgerSnapshot(usage: LedgerResult(records: usage), skills: LedgerResult(records: skills), loadedAt: now)
    }

    static func temporaryDirectory() throws -> URL {
        let url = FileManager.default.temporaryDirectory.appending(path: "pise-tests-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: url, withIntermediateDirectories: true)
        return url
    }
}
