export const skillBlockingSessionChangedEvent = "pise-en-place:skill-blocking-session-changed";

export type SkillBlockingSessionChanged = {
	sessionManager: object;
	disabled: boolean;
};

export function isSkillBlockingSessionChanged(value: unknown): value is SkillBlockingSessionChanged {
	if (!value || typeof value !== "object") return false;
	const change = value as Partial<SkillBlockingSessionChanged>;
	return !!change.sessionManager && typeof change.sessionManager === "object" && typeof change.disabled === "boolean";
}

const sessionsWithSkillBlockingDisabled = new WeakSet<object>();

/** Returns whether disabled-skill enforcement is bypassed for this live session. */
export function isSkillBlockingDisabled(session: object): boolean {
	return sessionsWithSkillBlockingDisabled.has(session);
}

/** Enables or disables the in-memory bypass for one live session. */
export function setSkillBlockingDisabled(session: object, disabled: boolean): void {
	if (disabled) sessionsWithSkillBlockingDisabled.add(session);
	else sessionsWithSkillBlockingDisabled.delete(session);
}

/** Clears the in-memory bypass when a session starts or reloads. */
export function resetSkillBlockingSession(session: object): void {
	sessionsWithSkillBlockingDisabled.delete(session);
}
