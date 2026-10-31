import assert from "node:assert/strict";
import { test } from "node:test";
import extension from "../mods/session-details/integrations/pi/index.ts";

const flush = () => new Promise<void>(resolve => setImmediate(resolve));

for (const blocked of ["nothing", "quota lookup", "previous label write"]) {
  test(`effort changes reach Herdr without polling, with ${blocked} pending`, async () => {
    const previous = process.env.HC_TERMINAL_ID;
    process.env.HC_TERMINAL_ID = "effort-test";
    const handlers = new Map<string, Function>();
    const writes: string[][] = [];
    let effort = "low";
    let firstWrite = true;
    let release!: () => void;
    const pending = new Promise<void>(resolve => { release = resolve; });
    const pi: any = {
      on: (event: string, handler: Function) => handlers.set(event, handler),
      getThinkingLevel: () => effort,
      exec: async (_command: string, args: string[]) => {
        if (firstWrite) {
          firstWrite = false;
          if (blocked === "previous label write") await pending;
        }
        writes.push(args);
        return { code: 0 };
      },
    };
    const ctx: any = {
      mode: "tui", cwd: "/test/project", model: { provider: "openai-codex", id: "model", name: "Model" },
      modelRegistry: { isUsingOAuth: () => blocked === "quota lookup", getApiKeyForProvider: () => pending },
      getContextUsage: () => ({ percent: 10 }),
    };
    try {
      extension(pi);
      handlers.get("session_start")!({}, ctx);
      await flush();
      effort = "medium";
      handlers.get("thinking_level_select")?.({ type: "thinking_level_select", level: effort, previousLevel: "low" }, ctx);
      await flush();
      if (blocked === "previous label write") { release(); await flush(); }
      const published = writes.map(args => JSON.parse(args[2].slice("herdr.session-details=".length)).effort);
      assert.equal(published.at(-1), "medium");
      assert.ok(!published.slice(published.indexOf("medium") + 1).includes("low"), "an old write must not restore the old effort");
    } finally {
      release();
      await handlers.get("session_shutdown")?.({});
      if (previous === undefined) delete process.env.HC_TERMINAL_ID;
      else process.env.HC_TERMINAL_ID = previous;
    }
  });
}
