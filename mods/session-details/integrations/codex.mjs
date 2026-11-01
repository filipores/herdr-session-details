import { createReadStream } from "node:fs";
import { readFile } from "node:fs/promises";
import { createInterface } from "node:readline";
import { homedir } from "node:os";
import { join } from "node:path";
import { emptyQuota, fetchCodexQuota, remaining, timestamp } from "./usage.mjs";
import { readInput, getTerminal, previousStatus, publish } from "./terminal.mjs";

export function applyRecord(state, record) {
  const data = record.payload;
  if (!data) return;
  if (record.type === "session_meta") {
    state.sessionId = data.id;
    state.provider = typeof data.model_provider === "string" ? data.model_provider : null;
  } else if (record.type === "turn_context") {
    if (state.model !== data.model) state.contextPercent = null;
    state.model = data.model;
    state.effort = typeof data.effort === "string" ? data.effort : null;
  } else if (record.type === "compacted") {
    state.contextPercent = null;
  } else if (record.type === "event_msg" && data.type === "token_count") {
    const total = data.info?.last_token_usage?.total_tokens;
    const size = data.info?.model_context_window;
    if (typeof total === "number" && Number.isFinite(total) && total >= 0 && typeof size === "number" && Number.isFinite(size) && size > 0) {
      state.contextPercent = Math.max(0, Math.min(100, total / size * 100));
    }
    if (data.rate_limits) {
      const windows = [data.rate_limits.primary, data.rate_limits.secondary];
      const session = windows.find(window => window?.window_minutes === 300);
      const weekly = windows.find(window => window?.window_minutes === 10080);
      state.capabilities = { session: session != null, weekly: weekly != null, resetCredits: false };
      state.quota = session || weekly ? {
        ...emptyQuota(timestamp(record.timestamp) ?? 0), sessionLeft: remaining(session?.used_percent), sessionResetAt: timestamp(session?.resets_at),
        weeklyLeft: remaining(weekly?.used_percent), weeklyResetAt: timestamp(weekly?.resets_at),
      } : null;
    }
  }
}

export async function readTranscript(path, sessionId) {
  const state = { sessionId: null, provider: null, model: null, effort: null, contextPercent: null, quota: null };
  const stream = createReadStream(path, { encoding: "utf8", signal: AbortSignal.timeout(3000) });
  const lines = createInterface({ input: stream, crlfDelay: Infinity });
  try {
    // shortcut: replay this session's metadata; add a byte-offset cache if large rollouts exceed the read deadline.
    for await (const line of lines) {
      let record;
      try { record = JSON.parse(line); } catch { continue; }
      applyRecord(state, record);
    }
  } finally { lines.close(); stream.destroy(); }
  if (!sessionId || state.sessionId !== sessionId) throw new Error("Transcript does not belong to this session");
  return state;
}

export async function codexSnapshot(data, previous, options = {}) {
  const state = data.transcript_path
    ? await readTranscript(data.transcript_path, data.session_id).catch(() => null) : null;
  const model = typeof data.model === "string" ? data.model : state?.model;
  const snapshot = {
    sessionId: data.session_id, cwd: data.cwd ?? null,
    model: model ? { id: model, name: model, provider: state?.provider ?? null } : null,
    effort: state?.model === model ? state.effort : null,
    contextPercent: state?.model === model ? state.contextPercent : null,
    capabilities: state?.capabilities ?? { session: false, weekly: false, resetCredits: false }, quota: state?.quota ?? null,
  };
  // Never attach a ChatGPT allowance to an API-key or local-model session.
  if (state?.provider !== "openai") return snapshot;
  const authPath = join(options.codexHome ?? process.env.CODEX_HOME ?? join(homedir(), ".codex"), "auth.json");
  const auth = await readFile(authPath, "utf8").then(JSON.parse).catch(() => null);
  const token = auth?.tokens?.access_token;
  if (!token || (auth.auth_mode && auth.auth_mode !== "chatgpt")) return snapshot;
  snapshot.capabilities = { session: true, weekly: true, resetCredits: true };
  if (previous?.sessionId === data.session_id && previous.model?.provider === "openai"
    && previous.capabilities?.resetCredits && Date.now() - previous.quota?.fetchedAt < 60000) {
    snapshot.quota = previous.quota;
  } else {
    snapshot.quota = await fetchCodexQuota(token, auth.tokens.account_id, AbortSignal.timeout(5500))
      .catch(() => ({ ...emptyQuota(), ...state?.quota, error: "Usage unavailable" }));
  }
  return snapshot;
}

async function main() {
  const data = JSON.parse(await readInput());
  const terminal = await getTerminal("codex");
  if (!terminal) return;
  const snapshot = await codexSnapshot(data, previousStatus(terminal, "codex"));
  await publish("codex", snapshot, terminal.foreground.pid);
}

if (import.meta.main) {
  await main().catch(() => {}); // A display-only hook must not block, print conversation data or request another turn.
}
