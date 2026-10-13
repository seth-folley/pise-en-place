import Foundation

struct LedgerProject: Codable, Sendable {
    var name: String?
    var gitRemote: String?
    var gitRoot: String?
    var gitCommonDir: String?
    var gitBranch: String?

    func key(cwd: String?) -> String {
        gitRemote ?? gitCommonDir ?? gitRoot ?? cwd ?? "unknown"
    }

    func label(cwd: String?) -> String {
        let key = key(cwd: cwd)
        return key == "unknown" ? "Unknown project" : (key as NSString).lastPathComponent
    }
}

protocol LedgerEntry: Decodable, Sendable {
    var isValid: Bool { get }
}

struct UsageRecord: Codable, LedgerEntry {
    struct Usage: Codable, Sendable {
        var input: Double
        var output: Double
        var cacheRead: Double
        var cacheWrite: Double
        var totalTokens: Double
        var totalCost: Double?
    }

    var version: Int
    var id: String
    var source: String
    var timestamp: Date
    var sessionFile: String?
    var sessionEntryId: String?
    var cwd: String?
    var project: LedgerProject
    var tags: [String]?
    var provider: String?
    var model: String?
    var usage: Usage

    var isValid: Bool {
        version == 1 && source == "live" && !id.isEmpty
            && [usage.input, usage.output, usage.cacheRead, usage.cacheWrite, usage.totalTokens]
                .allSatisfy { $0.isFinite && $0 >= 0 }
            && (usage.totalCost.map { $0.isFinite && $0 >= 0 } ?? true)
    }

    var projectKey: String { project.key(cwd: cwd) }
    var modelKey: String {
        if let provider, let model { return "\(provider)/\(model)" }
        return model ?? provider ?? "unknown"
    }
    var branch: String {
        guard let branch = project.gitBranch, !branch.isEmpty else { return "untracked" }
        return branch
    }
}

struct SkillRecord: Codable, LedgerEntry {
    struct Skill: Codable, Sendable {
        var name: String
        var path: String?
        var scope: String?
        var source: String?
    }

    var version: Int
    var id: String
    var timestamp: Date
    var trigger: String
    var sessionFile: String?
    var sessionId: String?
    var cwd: String?
    var project: LedgerProject?
    var skill: Skill
    var toolCallId: String?

    var isValid: Bool {
        version == 1 && !id.isEmpty && !skill.name.isEmpty
            && ["skill-command", "read-tool"].contains(trigger)
    }
    var projectKey: String { project?.key(cwd: cwd) ?? cwd ?? "unknown" }
    var projectLabel: String {
        project?.label(cwd: cwd) ?? (cwd.map { ($0 as NSString).lastPathComponent } ?? "Unknown project")
    }
    var sessionKey: String? {
        if let sessionFile, !sessionFile.isEmpty { return "file:\(sessionFile)" }
        if let sessionId, !sessionId.isEmpty { return "id:\(sessionId)" }
        return nil
    }
}

struct LedgerStatus: Equatable, Sendable {
    var missing = false
    var error: String?
    var malformed = 0
    var unsupported = 0
    var pendingTail = false

    var available: Bool { !missing && error == nil }
    var notices: [String] {
        var result: [String] = []
        if missing { result.append("No ledger yet. Enable tracking in Pi to record activity.") }
        if let error { result.append("Could not read ledger: \(error)") }
        if malformed > 0 { result.append("Skipped \(malformed) malformed record(s).") }
        if unsupported > 0 { result.append("Skipped \(unsupported) record(s) with unsupported schema versions.") }
        if pendingTail { result.append("Waiting for an unfinished final line.") }
        return result
    }
}

struct LedgerResult<Record: LedgerEntry>: Sendable {
    var records: [Record] = []
    var status = LedgerStatus()
}

struct LedgerSnapshot: Sendable {
    var usage = LedgerResult<UsageRecord>()
    var skills = LedgerResult<SkillRecord>()
    var loadedAt: Date?
}

struct LedgerPaths: Sendable {
    var usage: URL
    var skills: URL

    static var live: LedgerPaths {
        let agent = FileManager.default.homeDirectoryForCurrentUser.appending(path: ".pi/agent")
        return LedgerPaths(usage: agent.appending(path: "usage/ledger.jsonl"),
                           skills: agent.appending(path: "skill-reads/ledger.jsonl"))
    }
}
