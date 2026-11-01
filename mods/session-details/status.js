export function liveStatus(terminal, now = Date.now()) {
  try {
    const value = JSON.parse(terminal?.labels?.["herdr.session-details"] ?? terminal?.labels?.["pi.live-status"] ?? "null");
    const client = value?.version === 1 ? "pi" : value?.client;
    if (![1, 2].includes(value?.version) || !["pi", "claude-code", "codex"].includes(client)
      || !Number.isInteger(value.pid) || !Number.isFinite(value.updatedAt)
      || (client === "pi" && now - value.updatedAt > 75000) || value.updatedAt > now + 30000
      || terminal?.foreground?.pid !== value.pid || terminal?.state === "finished") return null;
    const app = terminal?.report?.app ?? terminal?.status?.app;
    if (app && ![client, client === "claude-code" ? "claude" : client].includes(app)) return null;
    return value;
  } catch { return null; }
}

export function percent(value) {
  return typeof value === "number" && Number.isFinite(value)
    ? Math.max(0, Math.min(100, value)) : null;
}

const months = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];

export function shortDate(time, now = Date.now()) {
  if (!Number.isFinite(time)) return "—";
  const date = new Date(time);
  const year = date.getFullYear() === new Date(now).getFullYear() ? "" : `, ${date.getFullYear()}`;
  return `${months[date.getMonth()]} ${date.getDate()}${year}`;
}

export function dateTime(time) {
  if (!Number.isFinite(time)) return "—";
  const date = new Date(time);
  const pad = n => String(n).padStart(2, "0");
  return `${months[date.getMonth()]} ${date.getDate()}, ${date.getFullYear()} at ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

export function resetSummary(quota, now = Date.now()) {
  const count = quota?.resetCount;
  if (!Number.isInteger(count) || count < 0) return { label: "resets unavailable", expiry: "", detail: "reset credits are unavailable" };
  const label = `${count} reset${count === 1 ? "" : "s"} available`;
  const expires = count > 0 && Number.isFinite(quota.firstResetExpiresAt);
  return {
    label,
    expiry: expires ? `expires ${shortDate(quota.firstResetExpiresAt, now)}` : count > 0 ? "no expiry" : "",
    detail: expires ? `first reset expires ${dateTime(quota.firstResetExpiresAt)} (local time)` : label,
  };
}

export function capabilities(status) {
  if (status?.version === 2) return status.capabilities ?? {};
  return {
    weekly: ["openai-codex", "anthropic"].includes(status?.model?.provider),
    resetCredits: status?.model?.provider === "openai-codex",
  };
}

export function quotaStatus(status, now = Date.now()) {
  const quota = status?.quota;
  const eventDriven = status?.version === 2 && ["claude-code", "codex"].includes(status.client);
  if (!quota || !Number.isFinite(quota.fetchedAt) || quota.fetchedAt > now + 30000
    || (!eventDriven && now - quota.fetchedAt >= 120000)) return null;
  return {
    ...quota,
    sessionLeft: quota.sessionResetAt != null && quota.sessionResetAt <= now ? null : quota.sessionLeft,
    weeklyLeft: quota.weeklyResetAt != null && quota.weeklyResetAt <= now ? null : quota.weeklyLeft,
    resetCount: quota.firstResetExpiresAt != null && quota.firstResetExpiresAt <= now ? null : quota.resetCount,
  };
}
