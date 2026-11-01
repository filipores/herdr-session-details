import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { claudeSnapshot } from "../mods/session-details/integrations/claude.mjs";
import { applyRecord, readTranscript, codexSnapshot } from "../mods/session-details/integrations/codex.mjs";
import { ownsTerminal } from "../mods/session-details/integrations/terminal.mjs";
import { liveStatus, quotaStatus } from "../mods/session-details/status.js";

const now = Date.parse("2026-10-31T12:00:00Z");
async function directory(t) {
  const dir = await mkdtemp(join(tmpdir(), "session-details-test-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}
const records = provider => [
  { type: "session_meta", payload: { id: "session-a", model_provider: provider } },
  { type: "turn_context", payload: { model: "model-a", effort: "high" } },
  { type: "response_item", payload: { content: "PRIVATE_CONVERSATION" } },
  { type: "event_msg", timestamp: "2026-10-31T12:00:00Z", payload: { type: "token_count", info: {
    total_token_usage: { total_tokens: 900000 }, last_token_usage: { total_tokens: 40000 }, model_context_window: 200000,
  }, rate_limits: { primary: { used_percent: 70, window_minutes: 10080, resets_at: now / 1000 + 3600 },
    secondary: { used_percent: 20, window_minutes: 300, resets_at: now / 1000 + 600 } } } },
];
async function transcript(t, provider = "openai") {
  const dir = await directory(t);
  const path = join(dir, "rollout.jsonl");
  await writeFile(path, records(provider).map(record => JSON.stringify(record)).join("\n") + '\n{"partial":');
  return { dir, path };
}

test("Claude reports model, effort, context and both quotas without exporting unrelated fields", () => {
  const result = claudeSnapshot({ model: { id: "claude-sonnet", display_name: "Sonnet" }, effort: { level: "high" },
    workspace: { current_dir: "/project" }, context_window: { used_percentage: 23.5 },
    rate_limits: { seven_day: { used_percentage: 41.2, resets_at: now / 1000 + 3600 },
      five_hour: { used_percentage: 75, resets_at: "2026-10-31T13:00:00Z" } },
    prompt: "PRIVATE_CONVERSATION", session_id: "not-exported" }, now);
  assert.equal(result.model.name, "Sonnet");
  assert.equal(result.effort, "high");
  assert.equal(result.contextPercent, 23.5);
  assert.equal(result.quota.weeklyLeft, 58.8);
  assert.equal(result.quota.weeklyResetAt, now + 3600000);
  assert.equal(result.quota.sessionLeft, 25);
  assert.equal(result.quota.sessionResetAt, now + 3600000);
  assert.deepEqual(result.capabilities, { session: true, weekly: true, resetCredits: false });
  assert.ok(!JSON.stringify(result).includes("PRIVATE_CONVERSATION"));
  assert.ok(!JSON.stringify(result).includes("not-exported"));
});

test("Claude without reported limits does not pretend to have a subscription quota", () => {
  const claude = claudeSnapshot({ model: { id: "bedrock-model", display_name: "Bedrock" } });
  assert.equal(claude.model.name, "Bedrock");
  assert.equal(claude.contextPercent, null);
  assert.deepEqual(claude.capabilities, { session: false, weekly: false, resetCredits: false });
});

test("Claude distinguishes an unknown 5h allowance from an unsupported one", () => {
  const result = claudeSnapshot({ rate_limits: { five_hour: { used_percentage: "75", resets_at: "invalid" } } }, now);
  assert.deepEqual(result.capabilities, { session: true, weekly: false, resetCredits: false });
  assert.equal(result.quota.sessionLeft, null);
  assert.equal(result.quota.sessionResetAt, null);
  assert.equal(result.quota.weeklyLeft, null);
});

test("Codex uses last-turn context, not lifetime tokens, and verifies the transcript session", async t => {
  const { path } = await transcript(t);
  const result = await readTranscript(path, "session-a");
  assert.equal(result.model, "model-a");
  assert.equal(result.effort, "high");
  assert.equal(result.contextPercent, 20);
  assert.equal(result.quota.weeklyLeft, 30);
  assert.equal(result.quota.sessionLeft, 80);
  assert.equal(result.quota.sessionResetAt, now + 600000);
  assert.ok(!JSON.stringify(result).includes("PRIVATE_CONVERSATION"));
  await assert.rejects(readTranscript(path, "session-b"), /does not belong/);
  applyRecord(result, { type: "turn_context", payload: { model: "model-b" } });
  assert.equal(result.contextPercent, null);
  applyRecord(result, records("openai")[3]);
  applyRecord(result, { type: "compacted", payload: {} });
  assert.equal(result.contextPercent, null);
});

test("Codex transcript windows follow duration, including 5h-only and unknown reports", () => {
  for (const slot of ["primary", "secondary"]) {
    const state = {};
    const record = { type: "event_msg", timestamp: "2026-10-31T12:00:00Z", payload: { type: "token_count",
      rate_limits: { [slot]: { used_percent: 100, window_minutes: 300, resets_at: now / 1000 + 600 } } } };
    applyRecord(state, record);
    assert.deepEqual(state.capabilities, { session: true, weekly: false, resetCredits: false });
    assert.equal(state.quota.sessionLeft, 0);
    assert.equal(state.quota.weeklyLeft, null);
    record.payload.rate_limits[slot].used_percent = "unknown";
    applyRecord(state, record);
    assert.equal(state.quota.sessionLeft, null);
    record.payload.rate_limits[slot].window_minutes = 60;
    applyRecord(state, record);
    assert.equal(state.capabilities.session, false);
    assert.equal(state.quota, null);
  }
});

test("Codex local/API-key sessions do not fetch a ChatGPT subscription", async t => {
  let requests = 0;
  t.mock.method(globalThis, "fetch", () => { requests++; throw new Error("Unexpected network request"); });
  for (const provider of ["ollama", "openai"]) {
    const { dir, path } = await transcript(t, provider);
    await writeFile(join(dir, "auth.json"), JSON.stringify({ auth_mode: "apikey" }));
    const result = await codexSnapshot({ session_id: "session-a", transcript_path: path, model: "model-a" }, null, { codexHome: dir });
    assert.equal(result.contextPercent, 20);
    assert.deepEqual(result.capabilities, { session: true, weekly: true, resetCredits: false });
    assert.equal(result.quota.sessionLeft, 80);
  }
  assert.equal(requests, 0);
});

test("event-driven CLI metadata stays bound to its process; expired limits become unknown", () => {
  const value = { version: 2, client: "claude-code", pid: 123, updatedAt: now - 3600000,
    quota: { fetchedAt: now - 3600000, sessionLeft: 80, sessionResetAt: now - 1, weeklyLeft: 30, weeklyResetAt: now - 1, resetCount: 2, firstResetExpiresAt: now - 1 } };
  const terminal = { foreground: { pid: 123 }, labels: { "herdr.session-details": JSON.stringify(value) } };
  assert.equal(liveStatus(terminal, now)?.client, "claude-code");
  assert.equal(liveStatus({ ...terminal, foreground: { pid: 456 } }, now), null);
  assert.equal(liveStatus({ ...terminal, report: { app: "pi" } }, now), null);
  assert.equal(quotaStatus(value, now).sessionLeft, null);
  assert.equal(quotaStatus(value, now).weeklyLeft, null);
  assert.equal(quotaStatus(value, now).resetCount, null);
  assert.equal(liveStatus({ ...terminal, labels: { "herdr.session-details": JSON.stringify({ ...value, client: "pi" }) } }, now), null);
});

test("native hooks cannot publish into a parent's Pi terminal", () => {
  const terminal = { state: "live", foreground: { pid: 123, argv: ["node", "/pi/cli.js"] }, status: { app: "pi" } };
  assert.equal(ownsTerminal(terminal, "claude-code"), false);
  assert.equal(ownsTerminal(terminal, "codex"), false);
  for (const [client, alias] of [["claude-code", "claude"], ["codex", "codex"]]) {
    const foreground = { pid: 123, argv: ["node", "/pi/cli.js", "--model", alias] };
    assert.equal(ownsTerminal({ ...terminal, foreground }, client), false);
    assert.equal(ownsTerminal({ ...terminal, status: null, foreground }, client), false);
  }
  assert.equal(ownsTerminal({ ...terminal, status: null, foreground: { pid: 123, argv: ["/opt/bin/claude"] } }, "claude-code"), true);
  assert.equal(ownsTerminal({ ...terminal, status: null, foreground: { pid: 123, argv: ["node", "/node_modules/@openai/codex/bin/codex.js"] } }, "codex"), true);
});

test("Claude wrapper preserves existing status-line output and stdin", async t => {
  const dir = await directory(t);
  const script = join(dir, "previous.mjs");
  await writeFile(script, 'let s=""; for await(const c of process.stdin) s+=c; process.stdout.write(JSON.parse(s).model.display_name+" ORIGINAL\\n");');
  const previous = join(dir, "previous.json");
  await writeFile(previous, JSON.stringify({ command: `"${process.execPath}" "${script}"` }));
  const input = JSON.stringify({ model: { display_name: "Sonnet" } });
  const wrapper = new URL("../mods/session-details/integrations/claude.mjs", import.meta.url).pathname;
  const result = await new Promise((resolve, reject) => {
    const child = execFile(process.execPath, [wrapper, "--previous", previous], { env: { ...process.env, HC_TERMINAL_ID: "" } }, (error, stdout, stderr) => error ? reject(error) : resolve({ stdout, stderr }));
    child.stdin.end(input);
  });
  assert.equal(result.stdout, "Sonnet ORIGINAL\n");
  assert.equal(result.stderr, "");
});

async function hookHarness(t, app, switchedPid) {
  const dir = await directory(t);
  const state = join(dir, "terminal.json"), calls = join(dir, "calls");
  await writeFile(state, JSON.stringify({ address: "t1", state: "live", status: { app }, foreground: { pid: 123 }, labels: {} }));
  await writeFile(calls, "");
  await writeFile(join(dir, "hc"), `#!${process.execPath}
import { readFileSync, writeFileSync, appendFileSync } from "node:fs";
const args = process.argv.slice(2), path = process.env.HC_TEST_STATE;
const terminal = JSON.parse(readFileSync(path, "utf8"));
appendFileSync(process.env.HC_TEST_CALLS, args[0] + "\\n");
if (args[0] === "get") {
  if (terminal.read && process.env.HC_TEST_SWITCH_PID) terminal.foreground.pid = Number(process.env.HC_TEST_SWITCH_PID);
  terminal.read = true;
  process.stdout.write(JSON.stringify(terminal));
} else if (args[0] === "label") {
  terminal.labels["herdr.session-details"] = args[2].slice("herdr.session-details=".length);
} else process.exit(1);
writeFileSync(path, JSON.stringify(terminal));
`, { mode: 0o755 });
  const env = { ...process.env, PATH: `${dir}:${process.env.PATH}`, HC_TERMINAL_ID: "t1",
    HC_TEST_STATE: state, HC_TEST_CALLS: calls, HC_TEST_SWITCH_PID: switchedPid ? String(switchedPid) : "" };
  return { state, calls, async run(adapter, input) {
    const path = new URL(`../mods/session-details/integrations/${adapter}.mjs`, import.meta.url).pathname;
    await new Promise((resolve, reject) => {
      const child = execFile(process.execPath, [path], { env }, (error, stdout, stderr) => {
        if (error) return reject(error);
        try { assert.equal(stdout, ""); assert.equal(stderr, ""); resolve(); } catch (error) { reject(error); }
      });
      child.stdin.end(JSON.stringify(input));
    });
  } };
}

test("Claude reads once per tick and only labels changed snapshots, not timestamp changes", async t => {
  const hook = await hookHarness(t, "claude");
  const input = { model: { id: "sonnet" }, rate_limits: { five_hour: { used_percentage: 75 } } };
  await hook.run("claude", input);
  assert.equal(await readFile(hook.calls, "utf8"), "get\nlabel\n");
  const first = JSON.parse(await readFile(hook.state, "utf8")).labels["herdr.session-details"];
  await hook.run("claude", input);
  assert.equal(await readFile(hook.calls, "utf8"), "get\nlabel\nget\n");
  assert.equal(JSON.parse(await readFile(hook.state, "utf8")).labels["herdr.session-details"], first);
  input.rate_limits.five_hour.used_percentage = 80;
  await hook.run("claude", input);
  assert.equal(await readFile(hook.calls, "utf8"), "get\nlabel\nget\nget\nlabel\n");
  const terminal = JSON.parse(await readFile(hook.state, "utf8"));
  assert.equal(JSON.parse(terminal.labels["herdr.session-details"]).quota.sessionLeft, 20);
  terminal.foreground.pid = 456;
  await writeFile(hook.state, JSON.stringify(terminal));
  await hook.run("claude", input);
  assert.equal(JSON.parse(JSON.parse(await readFile(hook.state, "utf8")).labels["herdr.session-details"]).pid, 456);
});

test("Codex publishes only if the process still owns its session metadata", async t => {
  const { path } = await transcript(t, "ollama");
  for (const switchedPid of [undefined, 456]) {
    const hook = await hookHarness(t, "codex", switchedPid);
    await hook.run("codex", { session_id: "session-a", transcript_path: path, model: "model-a" });
    assert.equal(await readFile(hook.calls, "utf8"), switchedPid ? "get\nget\n" : "get\nget\nlabel\n");
    const labels = JSON.parse(await readFile(hook.state, "utf8")).labels;
    if (switchedPid) assert.deepEqual(labels, {});
    else assert.equal(JSON.parse(labels["herdr.session-details"]).pid, 123);
  }
});

test("Claude's final ownership read rejects an unrelated foreground client", async t => {
  const hook = await hookHarness(t, "pi");
  await hook.run("claude", { model: { id: "sonnet" } });
  assert.equal(await readFile(hook.calls, "utf8"), "get\n");
  assert.deepEqual(JSON.parse(await readFile(hook.state, "utf8")).labels, {});
});
