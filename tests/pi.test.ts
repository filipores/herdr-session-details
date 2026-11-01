import assert from "node:assert/strict";
import { test } from "node:test";
import extension from "../mods/session-details/integrations/pi/index.ts";
import { codexQuota, loadQuota } from "../mods/session-details/integrations/pi/usage.ts";

const now = Date.parse("2026-10-31T12:00:00Z");
const session = { used_percent: 20, limit_window_seconds: 18000, reset_at: now / 1000 + 600 };
const week = { used_percent: 69, limit_window_seconds: 604800, reset_at: now / 1000 + 86400 };

test("5h and weekly quotas follow window duration, not primary/secondary position", () => {
  for (const [first, second] of [[session, week], [week, session]]) {
    const result = codexQuota({ rate_limit: { primary_window: first, secondary_window: second } }, { credits: [] }, now);
    assert.equal(result.sessionLeft, 80);
    assert.equal(result.sessionResetAt, now + 600000);
    assert.equal(result.weeklyLeft, 31);
    assert.equal(result.weeklyResetAt, now + 86400000);
    assert.equal(result.resetCount, 0);
  }
  assert.equal(codexQuota({ rate_limit: { primary_window: { ...week, limit_window_seconds: 18000 } } }, null, now).weeklyLeft, null);
});

test("only available, unexpired resets count; first expiry is sorted, not array order", () => {
  const result = codexQuota({}, { credits: [
    { status: "available", expires_at: "2026-11-08T00:00:00Z" },
    { status: "redeemed", expires_at: "2026-11-01T00:00:00Z" },
    { status: "available", expires_at: "2026-11-06T23:18:20.460962Z" },
    { status: "available", expires_at: "2026-10-30T00:00:00Z" },
    { status: "redeeming", expires_at: null },
    { status: "available", expires_at: null },
  ] }, now);
  assert.equal(result.resetCount, 3);
  assert.equal(result.firstResetExpiresAt, Date.parse("2026-11-06T23:18:20.460Z"));
});

test("unknown quota and unavailable reset endpoint never become zero or 100%", () => {
  const result = codexQuota({ rate_limit: { primary_window: { ...week, used_percent: "69" } } }, null, now);
  assert.equal(result.weeklyLeft, null);
  assert.equal(result.sessionLeft, null);
  assert.equal(result.sessionResetAt, null);
  assert.equal(codexQuota({ rate_limit: { primary_window: { ...session, used_percent: "20" } } }, null, now).sessionLeft, null);
  assert.equal(result.resetCount, null);
  assert.ok(result.error);
  assert.equal(codexQuota({}, { credits: [] }, now).firstResetExpiresAt, null);
});

test("quota adapter performs read-only GETs and tolerates reset-only failure", async t => {
  const requests: string[] = [];
  const fakeToken = `test.${Buffer.from(JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "test-account" } })).toString("base64url")}.test`;
  t.mock.method(globalThis, "fetch", async (url: string, options: RequestInit) => {
    assert.equal(options.method ?? "GET", "GET");
    assert.equal(options.body, undefined);
    requests.push(url);
    return url.endsWith("/usage")
      ? new Response(JSON.stringify({ rate_limit: { primary_window: session, secondary_window: week } }))
      : new Response("", { status: 503 });
  });
  const ctx: any = { model: { provider: "openai-codex" }, modelRegistry: {
    isUsingOAuth: () => true, getApiKeyForProvider: async () => fakeToken,
  } };
  const result = await loadQuota(ctx, new AbortController().signal);
  assert.equal(result?.weeklyLeft, 31);
  assert.equal(result?.sessionLeft, 80);
  assert.equal(result?.sessionResetAt, now + 600000);
  assert.equal(result?.resetCount, null);
  assert.deepEqual(requests, ["https://chatgpt.com/backend-api/wham/usage", "https://chatgpt.com/backend-api/wham/rate-limit-reset-credits"]);
  assert.equal(await loadQuota({ ...ctx, model: { provider: "openai" } }, new AbortController().signal), null);
});

test("bridge publishes session facts, handles model change and clears on shutdown", async () => {
  const previous = process.env.HC_TERMINAL_ID;
  process.env.HC_TERMINAL_ID = "test-terminal";
  const handlers = new Map<string, Function>();
  const writes: string[][] = [];
  const pi: any = { on: (event: string, handler: Function) => handlers.set(event, handler),
    getThinkingLevel: () => "xhigh", exec: async (_command: string, args: string[]) => { writes.push(args); return { code: 0 }; } };
  const ctx: any = { mode: "tui", cwd: "/test/project", model: { id: "model-a", name: "Model A", provider: "local" },
    modelRegistry: { isUsingOAuth: () => false }, getContextUsage: () => ({ percent: 42.5 }) };
  try {
    extension(pi);
    handlers.get("session_start")!({}, ctx);
    await new Promise(resolve => setImmediate(resolve));
    const first = JSON.parse(writes[0][2].slice("herdr.session-details=".length));
    assert.equal(first.contextPercent, 42.5);
    assert.equal(first.effort, "xhigh");
    assert.equal(first.model.name, "Model A");
    assert.equal(first.pid, process.pid);
    assert.deepEqual(first.capabilities, { session: false, weekly: false, resetCredits: false });
    assert.deepEqual(Object.keys(first).sort(), ["capabilities", "client", "contextPercent", "cwd", "effort", "model", "pid", "quota", "updatedAt", "version"]);
    for (const provider of ["anthropic", "google", "openrouter", "ollama"]) {
      ctx.model = { ...ctx.model, provider, id: "model-b", name: "Model B" };
      handlers.get("model_select")!({}, ctx);
      await new Promise(resolve => setImmediate(resolve));
      const next = JSON.parse(writes.at(-1)![2].slice("herdr.session-details=".length));
      assert.equal(next.model.provider, provider);
      assert.equal(next.model.name, "Model B");
      assert.deepEqual(next.capabilities, { session: false, weekly: false, resetCredits: false });
    }
    await handlers.get("session_shutdown")!({});
    assert.deepEqual(writes.at(-1), ["label", "test-terminal", "herdr.session-details="]);
  } finally {
    await handlers.get("session_shutdown")?.({});
    if (previous === undefined) delete process.env.HC_TERMINAL_ID;
    else process.env.HC_TERMINAL_ID = previous;
  }
});

test("Anthropic OAuth reads 5h and weekly utilization without Codex reset credits", async t => {
  const requests: string[] = [];
  t.mock.method(globalThis, "fetch", async (url: string, options: RequestInit) => {
    requests.push(url);
    assert.equal(options.method ?? "GET", "GET");
    return new Response(JSON.stringify({ five_hour: { utilization: 95, resets_at: "2026-10-31T13:00:00Z" },
      seven_day: { utilization: 58, resets_at: "2026-11-07T00:00:00Z" } }));
  });
  const result = await loadQuota({ model: { provider: "anthropic" }, modelRegistry: {
    isUsingOAuth: () => true, getApiKeyForProvider: async () => Buffer.from("test-fixture").toString("base64"),
  } } as any, new AbortController().signal);
  assert.deepEqual(requests, ["https://api.anthropic.com/api/oauth/usage"]);
  assert.equal(result?.sessionLeft, 5);
  assert.equal(result?.sessionResetAt, now + 3600000);
  assert.equal(result?.weeklyLeft, 42);
  assert.equal(result?.weeklyResetAt, Date.parse("2026-11-07T00:00:00Z"));
  assert.equal(result?.resetCount, null);
});

test("non-interactive subagents never overwrite the parent terminal metadata", async () => {
  const previous = process.env.HC_TERMINAL_ID;
  process.env.HC_TERMINAL_ID = "parent-terminal";
  const handlers = new Map<string, Function>();
  let writes = 0;
  try {
    extension({ on: (event: string, handler: Function) => handlers.set(event, handler), exec: () => { writes++; } } as any);
    handlers.get("session_start")!({}, { mode: "json" });
    await handlers.get("session_shutdown")!({});
    assert.equal(writes, 0);
  } finally {
    if (previous === undefined) delete process.env.HC_TERMINAL_ID;
    else process.env.HC_TERMINAL_ID = previous;
  }
});
