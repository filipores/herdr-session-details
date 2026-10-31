import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, mkdir, writeFile, readFile, rm, access } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { exec } from "node:child_process";
import { install } from "../install.mjs";

async function setup(t) {
  const home = await mkdtemp(join(tmpdir(), "herdr install 'test-"));
  t.after(() => rm(home, { recursive: true, force: true }));
  const paths = { home, appHome: join(home, "app"), piDir: join(home, "pi"), claudeDir: join(home, "claude"), codexHome: join(home, "codex") };
  await mkdir(paths.claudeDir); await mkdir(paths.codexHome);
  return paths;
}
const load = path => readFile(path, "utf8").then(JSON.parse);

test("install preserves Claude HUD, unrelated settings and Codex hooks, and does not double-wrap", async t => {
  const paths = await setup(t);
  const statusLine = { type: "command", command: `"${process.execPath}" -e "process.stdout.write('ORIGINAL-HUD')"`, padding: 2 };
  const settings = { statusLine, permissions: { allow: ["Read"] }, hooks: { Stop: [{ hooks: [{ command: "existing-claude-hook" }] }] } };
  await writeFile(join(paths.claudeDir, "settings.json"), JSON.stringify(settings));
  const existing = { hooks: { SessionStart: [{ hooks: [{ type: "command", command: "existing-codex-hook" }] }] }, unrelated: true };
  await writeFile(join(paths.codexHome, "hooks.json"), JSON.stringify(existing));
  await install(["pi", "claude", "codex"], paths);
  const after = await load(join(paths.claudeDir, "settings.json"));
  assert.deepEqual(after.permissions, settings.permissions);
  assert.deepEqual(after.hooks, settings.hooks);
  assert.equal(after.statusLine.padding, 2);
  assert.deepEqual(await load(join(paths.claudeDir, "herdr-session-details-statusline.json")), statusLine);
  const hooks = await load(join(paths.codexHome, "hooks.json"));
  assert.deepEqual(hooks.hooks.SessionStart[0], existing.hooks.SessionStart[0]);
  assert.equal(hooks.hooks.SessionStart.length, 2);
  assert.equal(hooks.hooks.Stop.length, 1);
  assert.equal(hooks.hooks.PostCompact?.length, 1);
  assert.deepEqual(hooks.hooks.PostCompact[0].hooks, hooks.hooks.Stop[0].hooks);
  assert.equal(hooks.unrelated, true);
  await install(["pi", "claude", "codex"], paths);
  assert.deepEqual(await load(join(paths.claudeDir, "settings.json")), after);
  assert.deepEqual(await load(join(paths.codexHome, "hooks.json")), hooks);
  assert.deepEqual(await load(join(paths.claudeDir, "herdr-session-details-statusline.json")), statusLine);
  const output = await new Promise((resolve, reject) => {
    const child = exec(after.statusLine.command, { env: { ...process.env, HC_TERMINAL_ID: "" }, timeout: 5000 }, (error, stdout) => error ? reject(error) : resolve(stdout));
    child.stdin.end("{}");
  });
  assert.equal(output, "ORIGINAL-HUD");
  const entry = await readFile(join(paths.piDir, "extensions/herdr-live-status/index.ts"), "utf8");
  assert.match(entry, /integrations\/pi\/index\.ts/);
  assert.ok(entry.includes(JSON.stringify(join(paths.appHome, "mods/session-details/integrations/pi/index.ts").replaceAll("\\", "/"))));
});

test("invalid client configuration is rejected before installed files are replaced", async t => {
  const paths = await setup(t);
  await writeFile(join(paths.claudeDir, "settings.json"), '{"statusLine":{"type":"unknown"}}');
  await assert.rejects(install(["claude"], paths), /Unsupported Claude status line/);
  await assert.rejects(access(join(paths.appHome, "mods/session-details")));
  assert.equal(await readFile(join(paths.claudeDir, "settings.json"), "utf8"), '{"statusLine":{"type":"unknown"}}');
});

test("an unrelated mod is never overwritten without explicit replacement", async t => {
  const paths = await setup(t);
  const main = join(paths.appHome, "mods/session-details/main.js");
  await mkdir(join(paths.appHome, "mods/session-details"), { recursive: true });
  await writeFile(main, "original user mod");
  await assert.rejects(install([], paths), /already exists/);
  assert.equal(await readFile(main, "utf8"), "original user mod");
  await install([], { ...paths, replace: true });
  assert.notEqual(await readFile(main, "utf8"), "original user mod");
});

test("installed mod includes its license and links to docs without copying catalog assets", async t => {
  const paths = await setup(t);
  const target = await install([], paths);
  assert.match(await readFile(join(target, "README.md"), "utf8"), /https:\/\/github\.com\/filipores\/herdr-session-details#readme/);
  assert.equal(await readFile(join(target, "LICENSE"), "utf8"), await readFile(new URL("../LICENSE", import.meta.url), "utf8"));
  await assert.rejects(access(join(target, "RECIPE.md")));
  await assert.rejects(access(join(target, "preview.png")));
});

test("mod-only installation never changes agent configuration", async t => {
  const paths = await setup(t);
  const target = await install([], paths);
  await access(join(target, "main.js"));
  await assert.rejects(access(join(paths.claudeDir, "settings.json")));
  await assert.rejects(access(join(paths.codexHome, "hooks.json")));
  await assert.rejects(access(join(paths.piDir, "extensions")));
});
