export const MEMBERSHIP_ENTRY_TYPE = "team-binding-v1";
export const INSPECT_ENTRY_TYPE = "team-inspect-v1";
export const WIDGET_ID = "team-room-v1";

export const TEAM_HELP = `Team coordination · automatic communication
/team join <room> --name <name> --role <role> [--rejoin]
/team leave                 Leave this room; keep history
/team status                Roster, presence, requests, blockers
/team inbox [cursor] [--history]  Active inbox (or all history)
/team thread <id> [cursor]  Paginated thread summaries
/team read <message>        Inspect full message without agent delivery
/team deliver <message>     Record in agent context at idle; no model run
/team reconcile <message>   Check this session's persisted delivery evidence
/team retry <message>       Deliberate retry of uncertain recording
/team review <message>      Wait, human answer, cancel, or redirect
/team resolve <thread>      Explicitly close a discussion
/team pause [local|room]    Persist pause (default local)
/team resume [local|room]   Resume eligible automatic delivery
/team help

One room per Pi session in this pilot; multiple isolated rooms can run concurrently.
Joining starts/reuses the broker automatically; it exits after 60s with no connections.
Automatic idle-boundary wakeups: questions, decision requests, requested replies, actionable handoffs.
Limits: no thread cap; 100 activations/room/rolling hour. Abort pauses local automation.
No moderator or approved-decision tooling.`;
