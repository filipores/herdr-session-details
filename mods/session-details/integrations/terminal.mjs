import { execFile } from "node:child_process";
import { promisify } from "node:util";

const exec = promisify(execFile);
export const LABEL = "herdr.session-details";

export async function readInput() {
  let input = "";
  for await (const chunk of process.stdin) {
    input += chunk;
    if (Buffer.byteLength(input) > 2 * 1024 * 1024) throw new Error("Hook input too large");
  }
  return input;
}

export function ownsTerminal(terminal, client) {
  const apps = client === "claude-code" ? ["claude", "claude-code"] : ["codex"];
  const pattern = client === "claude-code"
    ? /(?:^|[/\\])claude(?:\.exe)?$|[/\\]@anthropic-ai[/\\]claude-code[/\\]/
    : /(?:^|[/\\])codex(?:\.exe|\.js)?$/;
  return terminal?.state === "live" && Number.isInteger(terminal.foreground?.pid)
    && (terminal.status?.app ? apps.includes(terminal.status.app)
      : terminal.foreground.argv?.slice(0, 2).some(arg => pattern.test(arg)));
}

export async function getTerminal(client) {
  const address = process.env.HC_TERMINAL_ID;
  if (!address) return null;
  const { stdout } = await exec("hc", ["get", address, "--json"], { timeout: 2000, maxBuffer: 256 * 1024 });
  const terminal = JSON.parse(stdout);
  return ownsTerminal(terminal, client) ? terminal : null;
}

export function previousStatus(terminal, client) {
  try {
    const value = JSON.parse(terminal.labels?.[LABEL]);
    return value?.version === 2 && value.client === client && value.pid === terminal.foreground.pid ? value : null;
  } catch { return null; }
}

export async function publish(terminal, client, snapshot) {
  const current = await getTerminal(client);
  if (!current || current.foreground.pid !== terminal.foreground.pid) return;
  const value = { ...snapshot, version: 2, client, pid: terminal.foreground.pid, updatedAt: Date.now() };
  await exec("hc", ["label", terminal.address, `${LABEL}=${JSON.stringify(value)}`], { timeout: 2000 });
}
