import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { emptyQuota, remaining, timestamp } from "./usage.mjs";
import { readInput, getTerminal, publish } from "./terminal.mjs";

export function claudeSnapshot(data, now = Date.now()) {
  const weekly = data.rate_limits?.seven_day;
  const context = data.context_window?.used_percentage;
  return {
    cwd: data.workspace?.current_dir ?? data.cwd ?? null,
    model: data.model?.id ? { id: data.model.id, name: data.model.display_name || data.model.id, provider: null } : null,
    effort: typeof data.effort?.level === "string" ? data.effort.level : null,
    contextPercent: typeof context === "number" && Number.isFinite(context) ? Math.max(0, Math.min(100, context)) : null,
    capabilities: { weekly: weekly != null, resetCredits: false },
    quota: weekly ? { ...emptyQuota(now), weeklyLeft: remaining(weekly.used_percentage), weeklyResetAt: timestamp(weekly.resets_at) } : null,
  };
}

async function update(input) {
  const terminal = await getTerminal("claude-code");
  if (terminal) await publish(terminal, "claude-code", claudeSnapshot(JSON.parse(input)));
}

export async function forwardStatusline(command, input) {
  if (!command) return 0;
  return new Promise(resolve => {
    const child = spawn(command, { shell: true, stdio: ["pipe", "inherit", "inherit"] });
    child.stdin.on("error", () => {});
    child.on("error", () => resolve(1));
    child.on("exit", code => resolve(code ?? 1));
    child.stdin.end(input);
  });
}

if (import.meta.main) {
  const input = await readInput().catch(() => "");
  const previous = process.argv[2] === "--previous"
    ? await readFile(process.argv[3], "utf8").then(JSON.parse) : null;
  const command = previous?.command;
  const [code] = await Promise.all([
    forwardStatusline(command, input),
    update(input).catch(() => {}), // Optional metadata must never break the existing status line.
  ]);
  process.exitCode = code;
}
