export const emptyQuota = (now = Date.now()) => ({
  sessionLeft: null, sessionResetAt: null,
  weeklyLeft: null, weeklyResetAt: null, resetCount: null,
  firstResetExpiresAt: null, fetchedAt: now,
});

export function timestamp(value) {
  if (typeof value === "number" && Number.isFinite(value)) return value * 1000;
  if (typeof value !== "string") return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

export function remaining(value) {
  return typeof value === "number" && Number.isFinite(value)
    ? Math.max(0, Math.min(100, 100 - value)) : null;
}

export function codexQuota(usage, resets, now = Date.now()) {
  const windows = [usage?.rate_limit?.primary_window, usage?.rate_limit?.secondary_window];
  const session = windows.find(window => window?.limit_window_seconds === 18000);
  const weekly = windows.find(window => window?.limit_window_seconds === 604800);
  const credits = Array.isArray(resets?.credits) ? resets.credits : null;
  const available = credits?.filter(credit => credit?.status === "available"
    && (credit.expires_at == null || (timestamp(credit.expires_at) ?? 0) > now));
  const expiries = available?.map(credit => timestamp(credit.expires_at)).filter(time => time !== null) ?? [];
  return {
    ...emptyQuota(now), sessionLeft: remaining(session?.used_percent), sessionResetAt: timestamp(session?.reset_at),
    weeklyLeft: remaining(weekly?.used_percent), weeklyResetAt: timestamp(weekly?.reset_at),
    resetCount: available?.length ?? null,
    firstResetExpiresAt: expiries.length ? Math.min(...expiries) : null,
    ...(credits === null ? { error: "Reset credits unavailable" } : {}),
  };
}

async function get(url, headers, signal) {
  const response = await fetch(url, { headers, signal: AbortSignal.any([signal, AbortSignal.timeout(5000)]) });
  if (!response.ok) throw new Error(`Usage unavailable (HTTP ${response.status})`);
  return response.json();
}

export async function fetchCodexQuota(token, account, signal) {
  if (!account) {
    const claims = JSON.parse(Buffer.from(token.split(".")[1], "base64url").toString());
    account = claims["https://api.openai.com/auth"]?.chatgpt_account_id;
  }
  if (typeof account !== "string") throw new Error("Codex account unavailable");
  const headers = { authorization: `Bearer ${token}`, "chatgpt-account-id": account, accept: "application/json" };
  const base = "https://chatgpt.com/backend-api/wham/";
  const [usage, resets] = await Promise.all([
    get(`${base}usage`, headers, signal), get(`${base}rate-limit-reset-credits`, headers, signal).catch(() => null),
  ]);
  return codexQuota(usage, resets);
}

export async function fetchAnthropicQuota(token, signal) {
  const usage = await get("https://api.anthropic.com/api/oauth/usage", {
    authorization: `Bearer ${token}`, accept: "application/json", "anthropic-beta": "oauth-2025-04-20",
  }, signal);
  return {
    ...emptyQuota(), sessionLeft: remaining(usage?.five_hour?.utilization), sessionResetAt: timestamp(usage?.five_hour?.resets_at),
    weeklyLeft: remaining(usage?.seven_day?.utilization), weeklyResetAt: timestamp(usage?.seven_day?.resets_at),
  };
}
