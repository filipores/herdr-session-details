import { access, cp, mkdir, readFile, rename, writeFile, chmod } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(fileURLToPath(import.meta.url));
const exists = path => access(path).then(() => true, () => false);
const quote = value => process.platform === "win32" ? `"${value.replaceAll('"', '\\"')}"` : `'${value.replaceAll("'", "'\\''")}'`;
const command = (...args) => args.map(quote).join(" ");

async function jsonFile(path) {
  if (!await exists(path)) return {};
  const value = JSON.parse(await readFile(path, "utf8"));
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`Expected a JSON object: ${path}`);
  return value;
}

async function save(path, value, stamp) {
  await mkdir(dirname(path), { recursive: true });
  if (await exists(path)) {
    const backup = `${path}.backup-${stamp}`;
    await cp(path, backup, { errorOnExist: true, force: false });
    await chmod(backup, 0o600);
  }
  const temp = `${path}.tmp-${stamp}`;
  await writeFile(temp, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600, flag: "wx" });
  await rename(temp, path);
}

export function codexHooks(config, adapterPath, adapterCommand) {
  const result = structuredClone(config);
  result.hooks ??= {};
  if (typeof result.hooks !== "object" || Array.isArray(result.hooks)) throw new Error("Invalid Codex hooks configuration");
  for (const event of ["SessionStart", "UserPromptSubmit", "Stop"]) {
    const groups = result.hooks[event] ??= [];
    if (!Array.isArray(groups) || groups.some(group => !Array.isArray(group?.hooks))) throw new Error(`Invalid ${event} hooks`);
    const installed = groups.flatMap(group => group.hooks).find(hook => hook.command?.includes(quote(adapterPath)));
    if (installed) installed.command = adapterCommand;
    else groups.push({ hooks: [{ type: "command", command: adapterCommand, timeout: 10 }] });
  }
  return result;
}

export async function install(clients, paths = {}) {
  if (clients.some(client => !["pi", "claude", "codex"].includes(client))) throw new Error("Usage: node install.mjs [pi] [claude] [codex]");
  const home = paths.home ?? homedir();
  const appHome = paths.appHome ?? process.env.HERDR_APP_HOME ?? join(home, ".config/herdr-app");
  const piDir = paths.piDir ?? process.env.PI_CODING_AGENT_DIR ?? join(home, ".pi/agent");
  const claudeDir = paths.claudeDir ?? process.env.CLAUDE_CONFIG_DIR ?? join(home, ".claude");
  const codexHome = paths.codexHome ?? process.env.CODEX_HOME ?? join(home, ".codex");
  const target = join(appHome, "mods/session-details");
  const stamp = `${Date.now()}-${process.pid}`;
  const writes = [];
  if (await exists(target) && !await exists(join(target, ".session-details-installed")) && !paths.replace) {
    throw new Error("A mod already exists at session-details. Review it, then use --replace to back it up and replace it.");
  }

  // Validate existing configuration before touching installed code.
  if (clients.includes("claude")) {
    const path = join(claudeDir, "settings.json");
    const settings = await jsonFile(path);
    const adapter = join(target, "integrations/claude.mjs");
    const previousPath = join(claudeDir, "herdr-session-details-statusline.json");
    const current = settings.statusLine;
    if (current && (current.type !== "command" || typeof current.command !== "string")) throw new Error("Unsupported Claude status line; left unchanged");
    if (current?.command.includes(quote(adapter))) {
      if (!await exists(previousPath)) throw new Error("Original Claude status line backup is missing; left unchanged");
    } else writes.push([previousPath, current ?? {}]);
    const next = { ...settings, statusLine: { ...current, type: "command", command: command(process.execPath, adapter, "--previous", previousPath) } };
    if (JSON.stringify(settings) !== JSON.stringify(next)) writes.push([path, next]);
  }
  if (clients.includes("codex")) {
    const path = join(codexHome, "hooks.json");
    const settings = await jsonFile(path);
    const adapter = join(target, "integrations/codex.mjs");
    const next = codexHooks(settings, adapter, command(process.execPath, adapter));
    if (JSON.stringify(settings) !== JSON.stringify(next)) writes.push([path, next]);
  }

  const staged = join(appHome, `.session-details-stage-${stamp}`);
  await mkdir(join(appHome, "mods"), { recursive: true });
  await cp(join(root, "mods/session-details"), staged, { recursive: true });
  await cp(join(root, "README.md"), join(staged, "README.md"));
  await writeFile(join(staged, ".session-details-installed"), "1\n");
  if (await exists(target)) {
    await mkdir(join(appHome, "backups"), { recursive: true });
    await rename(target, join(appHome, "backups", `session-details-${stamp}`));
  }
  await rename(staged, target);

  if (clients.includes("pi")) {
    const extension = join(piDir, "extensions/herdr-live-status");
    if (await exists(extension)) {
      await mkdir(join(piDir, "backups"), { recursive: true });
      await rename(extension, join(piDir, "backups", `herdr-live-status-${stamp}`));
    }
    await mkdir(extension, { recursive: true });
    const source = join(target, "integrations/pi/index.ts").replaceAll("\\", "/");
    await writeFile(join(extension, "index.ts"), `export { default } from ${JSON.stringify(source)};\n`);
  }
  for (const [path, value] of writes) await save(path, value, stamp);
  return target;
}

if (import.meta.main) {
  try {
    const args = process.argv.slice(2);
    const target = await install(args.filter(arg => arg !== "--replace"), { replace: args.includes("--replace") });
    console.log(`Installed: ${target}\nExisting files backed up. Reload Pi; restart Claude/Codex. Approve Codex hooks if prompted.`);
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
