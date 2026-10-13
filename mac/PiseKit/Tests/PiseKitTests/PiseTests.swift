import Foundation
import Testing
@testable import PiseKit

struct LedgerReaderTests {
    @Test func decodesBothLedgerSchemasAndFractionalTimestamps() throws {
        var line = String(decoding: try LedgerFixtures.line(LedgerFixtures.usage()), as: UTF8.self)
        line = line.replacingOccurrences(of: "2026-10-08T12:00:00Z", with: "2026-10-08T12:00:00.123Z")
        let usage: LedgerResult<UsageRecord> = try LedgerReader.parse(Data(line.utf8))
        let skills: LedgerResult<SkillRecord> = try LedgerReader.parse(LedgerFixtures.line(LedgerFixtures.skill()))
        #expect(usage.records.count == 1)
        #expect(skills.records.count == 1)
        #expect(usage.records[0].timestamp.timeIntervalSince(LedgerFixtures.now) > 0.12)
        #expect(skills.records[0].skill.name == "swiftui")
    }

    @Test func isolatesBadLinesAndUnknownVersions() throws {
        var data = try LedgerFixtures.line(LedgerFixtures.usage())
        data.append(Data("not json\n{\"version\":99}\n\n{\"version\":1}\n".utf8))
        data.append(contentsOf: [0xFF, 0x0A])
        let result: LedgerResult<UsageRecord> = try LedgerReader.parse(data)
        #expect(result.records.count == 1)
        #expect(result.status.malformed == 3)
        #expect(result.status.unsupported == 1)
    }

    @Test func defersTailAndAcceptsItOnceCommitted() throws {
        let complete = try LedgerFixtures.line(LedgerFixtures.usage())
        let partial: LedgerResult<UsageRecord> = try LedgerReader.parse(Data(complete.dropLast()))
        #expect(partial.records.isEmpty)
        #expect(partial.status.pendingTail)
        #expect(partial.status.malformed == 0)
        let committed: LedgerResult<UsageRecord> = try LedgerReader.parse(complete)
        #expect(committed.records.count == 1)
        #expect(!committed.status.pendingTail)
    }

    @Test func acceptsLegacyOptionalFieldsAndUnknownAdditions() throws {
        let line = #"{"version":1,"id":"legacy","timestamp":"2026-10-08T12:00:00Z","trigger":"read-tool","cwd":"/legacy","skill":{"name":"old-skill"},"futureField":true}"# + "\n"
        let result: LedgerResult<SkillRecord> = try LedgerReader.parse(Data(line.utf8))
        #expect(result.records.count == 1)
        #expect(result.records[0].projectKey == "/legacy")
        #expect(result.records[0].sessionKey == nil)
    }

    @Test func rejectsInvalidTimestampAndNegativeUsage() throws {
        var data = try LedgerFixtures.line(LedgerFixtures.usage(tokens: -1))
        let badDate = String(decoding: try LedgerFixtures.line(LedgerFixtures.usage()), as: UTF8.self)
            .replacingOccurrences(of: "2026-10-08T12:00:00Z", with: "bad-date")
        data.append(Data(badDate.utf8))
        let result: LedgerResult<UsageRecord> = try LedgerReader.parse(data)
        #expect(result.records.isEmpty)
        #expect(result.status.malformed == 2)
    }

    @Test func duplicateRowsRemainConsistentWithPiReports() throws {
        let line = try LedgerFixtures.line(LedgerFixtures.usage())
        let result: LedgerResult<UsageRecord> = try LedgerReader.parse(line + line)
        #expect(result.records.count == 2)
    }

    @Test func fullReloadHandlesAppendTruncationDeletionAndReplacement() async throws {
        let directory = try LedgerFixtures.temporaryDirectory()
        defer { try? FileManager.default.removeItem(at: directory) }
        let paths = LedgerPaths(usage: directory.appending(path: "usage.jsonl"), skills: directory.appending(path: "skills.jsonl"))
        let reader = LedgerReader(paths: paths)
        let missing = try await reader.load()
        #expect(missing.usage.status.missing)
        #expect(missing.skills.status.missing)
        let first = try LedgerFixtures.line(LedgerFixtures.usage())
        try first.write(to: paths.usage)
        let one = try await reader.load()
        #expect(one.usage.records.count == 1)
        #expect(one.skills.status.missing)
        let handle = try FileHandle(forWritingTo: paths.usage)
        try handle.seekToEnd()
        try handle.write(contentsOf: Data(first.prefix(20)))
        let partial = try await reader.load()
        #expect(partial.usage.records.count == 1)
        #expect(partial.usage.status.pendingTail)
        try handle.write(contentsOf: Data(first.dropFirst(20)))
        try handle.close()
        let appended = try await reader.load()
        #expect(appended.usage.records.count == 2)
        try Data().write(to: paths.usage)
        let truncated = try await reader.load()
        #expect(truncated.usage.records.isEmpty)
        #expect(truncated.usage.status.available)
        try FileManager.default.removeItem(at: paths.usage)
        let removed = try await reader.load()
        #expect(removed.usage.status.missing)
        try first.write(to: paths.usage, options: .atomic)
        let replaced = try await reader.load()
        #expect(replaced.usage.records.count == 1)
    }

    @Test func readFailureIsNotReportedAsEmptyOrMissing() throws {
        let directory = try LedgerFixtures.temporaryDirectory()
        defer { try? FileManager.default.removeItem(at: directory) }
        let result: LedgerResult<UsageRecord> = try LedgerReader.read(directory)
        #expect(result.status.error != nil)
        #expect(!result.status.missing)
        #expect(!result.status.available)
    }

    @Test func permissionFailureHasIndependentLedgerStatus() async throws {
        let directory = try LedgerFixtures.temporaryDirectory()
        let path = directory.appending(path: "usage.jsonl")
        defer {
            try? FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: path.path)
            try? FileManager.default.removeItem(at: directory)
        }
        try LedgerFixtures.line(LedgerFixtures.usage()).write(to: path)
        try FileManager.default.setAttributes([.posixPermissions: 0], ofItemAtPath: path.path)
        let skills = directory.appending(path: "skills.jsonl")
        try LedgerFixtures.line(LedgerFixtures.skill()).write(to: skills)
        let snapshot = try await LedgerReader(paths: LedgerPaths(usage: path, skills: skills)).load()
        #expect(snapshot.usage.status.error != nil)
        #expect(!snapshot.usage.status.missing)
        #expect(snapshot.skills.records.count == 1)
        #expect(snapshot.skills.status.available)
    }

    @Test func reportsCanRefilterWithoutReadingAgain() async throws {
        let directory = try LedgerFixtures.temporaryDirectory()
        defer { try? FileManager.default.removeItem(at: directory) }
        let path = directory.appending(path: "usage.jsonl")
        try LedgerFixtures.line(LedgerFixtures.usage(timestamp: Date())).write(to: path)
        let reader = LedgerReader(paths: LedgerPaths(usage: path, skills: directory.appending(path: "skills.jsonl")))
        let first = try await reader.report(query: ReportQuery(), reload: true)
        #expect(first.totals.calls == 1)
        try FileManager.default.removeItem(at: path)
        var query = ReportQuery()
        query.metric = .tokens
        let cached = try await reader.report(query: query, reload: false)
        #expect(cached.totals.calls == 1)
        let refreshed = try await reader.report(query: query, reload: true)
        #expect(refreshed.usageStatus.missing)
        #expect(refreshed.totals.calls == 0)
    }
}

struct ReportTests {
    private func report(_ usage: [UsageRecord], skills: [SkillRecord] = [], query: ReportQuery = ReportQuery()) throws -> DashboardReport {
        try Reports.build(LedgerFixtures.snapshot(usage: usage, skills: skills), query: query,
                          now: LedgerFixtures.now, calendar: LedgerFixtures.calendar)
    }

    @Test func costCoverageTokensAndSessionIdentity() throws {
        let result = try report([
            LedgerFixtures.usage(cost: 2, tags: ["review", "implementation"]),
            LedgerFixtures.usage(id: "u2", cost: nil, tags: ["review", "review"]),
            LedgerFixtures.usage(id: "u3", cost: 0, session: nil)
        ])
        #expect(result.totals.calls == 3)
        #expect(result.totals.tokens == 300)
        #expect(result.totals.cost == 2)
        #expect(result.totals.costedCalls == 2)
        #expect(UsageMetric.cost.formatted(result.totals).hasSuffix("*"))
        #expect(UsageMetric.cost.accessibleValue(result.totals).contains("partial"))
        #expect(result.days[0].totals.costedCalls == 2)
        #expect(UsageMetric.cost.formatted(result.projects[0].totals).hasSuffix("*"))
        #expect(result.totals.sessions == 1)
        #expect(result.totals.unidentifiedCalls == 1)
        #expect(result.tags.first(where: { $0.id == "review" })?.totals.calls == 2)
        #expect(result.tags.reduce(0) { $0 + $1.totals.calls } == 3)
        let unknown = try report([LedgerFixtures.usage(cost: nil)])
        #expect(unknown.totals.estimatedCost == nil)
        let zero = try report([LedgerFixtures.usage(cost: 0)])
        #expect(zero.totals.estimatedCost == 0)
        #expect(!UsageMetric.cost.formatted(zero.totals).hasSuffix("*"))
        #expect(UsageMetric.cost.formatted(unknown.totals) == "—")
    }

    @Test func projectsMergeWorktreesButNotSameNamedRepositories() throws {
        let other = LedgerFixtures.project(remote: "github.com/other/project", root: "/other")
        let worktree = LedgerFixtures.project(root: "/worktree", common: "/work/project/.git")
        let result = try report([LedgerFixtures.usage(), LedgerFixtures.usage(project: worktree), LedgerFixtures.usage(project: other)])
        #expect(result.projects.count == 2)
        #expect(result.projects.first?.totals.calls == 2)
        #expect(Set(result.projectOptions.map(\.label)).count == 2)
    }

    @Test func projectIdentityFallbacksAndProviderQualifiedModels() throws {
        let common = LedgerFixtures.project(remote: nil, root: "/root", common: "/common")
        #expect(common.key(cwd: "/cwd") == "/common")
        #expect(LedgerFixtures.project(remote: nil, root: "/root", common: nil).key(cwd: "/cwd") == "/root")
        #expect(LedgerFixtures.project(remote: nil, root: nil, common: nil).key(cwd: "/cwd") == "/cwd")
        #expect(LedgerFixtures.project(remote: nil, root: nil, common: nil).key(cwd: nil) == "unknown")
        let result = try report([LedgerFixtures.usage(provider: "a"), LedgerFixtures.usage(provider: "b")])
        #expect(result.models.map(\.id) == ["a/model", "b/model"])
    }

    @Test func weekStartsMondayAndExcludesFutureRecords() throws {
        var query = ReportQuery()
        query.range = .week
        let result = try report([
            LedgerFixtures.usage(timestamp: LedgerFixtures.date("2026-10-04T23:59:59Z")),
            LedgerFixtures.usage(timestamp: LedgerFixtures.date("2026-10-05T00:00:00Z")),
            LedgerFixtures.usage(timestamp: LedgerFixtures.now),
            LedgerFixtures.usage(timestamp: LedgerFixtures.date("2026-10-08T12:00:01Z"))
        ], query: query)
        #expect(result.totals.calls == 2)
        #expect(result.days.count == 4)
        #expect(result.days[0].id == LedgerFixtures.date("2026-10-05T00:00:00Z"))
        #expect(result.days[1].totals.calls == 0)
    }

    @Test func monthAndTodayBoundariesAreInclusive() throws {
        let records = [LedgerFixtures.usage(timestamp: LedgerFixtures.date("2026-09-30T23:59:59Z")),
                       LedgerFixtures.usage(timestamp: LedgerFixtures.date("2026-10-01T00:00:00Z")),
                       LedgerFixtures.usage(timestamp: LedgerFixtures.date("2026-10-08T00:00:00Z"))]
        var query = ReportQuery()
        query.range = .month
        #expect(try report(records, query: query).totals.calls == 2)
        #expect(try report(records).totals.calls == 1)
    }

    @Test func dailyBucketsRespectLocalTimezoneAndDST() throws {
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = TimeZone(identifier: "America/Los_Angeles")!
        let now = LedgerFixtures.date("2026-03-09T12:00:00Z")
        var query = ReportQuery()
        query.range = .month
        let records = [LedgerFixtures.usage(timestamp: LedgerFixtures.date("2026-03-08T09:30:00Z")),
                       LedgerFixtures.usage(timestamp: LedgerFixtures.date("2026-03-08T10:30:00Z"))]
        let result = try Reports.build(LedgerFixtures.snapshot(usage: records), query: query, now: now, calendar: calendar)
        #expect(result.days.count == 9)
        #expect(result.days[7].totals.calls == 2)
        #expect(result.days[8].id.timeIntervalSince(result.days[7].id) == 23 * 3600)
        #expect(UsageRange.today.start(now: now, calendar: calendar) == LedgerFixtures.date("2026-03-09T07:00:00Z"))
    }

    @Test func usageFiltersDoNotLeakIntoSkills() throws {
        var query = ReportQuery()
        query.project = "github.com/example/project"
        query.model = "provider/model"
        query.branch = "main"
        query.tag = "review"
        let result = try report([LedgerFixtures.usage(tags: ["review"]), LedgerFixtures.usage(model: "other")],
                                skills: [LedgerFixtures.skill(), LedgerFixtures.skill(id: "s2", trigger: "skill-command")], query: query)
        #expect(result.totals.calls == 1)
        #expect(result.skillTotals.events == 2)
        #expect(result.skillTotals.sessions == 1)
        #expect(result.skillTotals.commands == 1)
        #expect(result.skillTotals.reads == 1)
        #expect(result.skills[0].totals.events == 2)
        #expect(result.branches[0].id == "main")
    }

    @Test func legacySkillsAndSessionFallbacks() throws {
        let skill = LedgerFixtures.skill(session: nil, sessionId: "fallback", project: nil, cwd: "/legacy")
        let unidentified = LedgerFixtures.skill(id: "s2", session: nil, sessionId: nil, project: nil, cwd: nil)
        let result = try report([], skills: [skill, unidentified])
        #expect(result.skillTotals.sessions == 1)
        #expect(result.skillTotals.unidentifiedEvents == 1)
        #expect(result.projectOptions.map(\.id).contains("/legacy"))
        #expect(result.projectOptions.map(\.id).contains("unknown"))
        #expect(result.skillProjects.count == 2)
    }

    @Test func rankingChangesWithMetricAndUnknownBranchIsUntracked() throws {
        let result = try report([LedgerFixtures.usage(cost: 10, tokens: 1, model: "costly"),
                                LedgerFixtures.usage(cost: nil, tokens: 1000, project: LedgerFixtures.project(branch: nil), model: "token-heavy")])
        #expect(result.models.first?.id == "provider/costly")
        var query = ReportQuery()
        query.metric = .tokens
        query.project = "github.com/example/project"
        let tokens = try report([LedgerFixtures.usage(cost: 10, tokens: 1, model: "costly"),
                                 LedgerFixtures.usage(cost: nil, tokens: 1000, project: LedgerFixtures.project(branch: nil), model: "token-heavy")], query: query)
        #expect(tokens.models.first?.id == "provider/token-heavy")
        #expect(tokens.branches.contains(where: { $0.id == "untracked" }))
    }

    @Test func largeSyntheticLedgerMaintainsAccurateTotals() throws {
        let rows = (0..<100_000).map { LedgerFixtures.usage(id: "u\($0)", cost: 0.01, tokens: 10) }
        let result = try report(rows)
        #expect(result.totals.calls == 100_000)
        #expect(result.totals.tokens == 1_000_000)
        #expect(abs(result.totals.cost - 1000) < 0.00001)
        #expect(result.projects.count == 1)
    }
}
