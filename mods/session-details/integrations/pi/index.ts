import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { loadQuota, subscriptionProvider, type Quota } from "./usage.ts";

const LABEL = "herdr.session-details";

export default function (pi: ExtensionAPI) {
  const terminal = process.env.HC_TERMINAL_ID;
  if (!terminal) return;
  let ctx: ExtensionContext;
  let active = false;
  let timer: ReturnType<typeof setInterval> | undefined;
  let task: Promise<void> | undefined;
  let publishing = Promise.resolve();
  let controller = new AbortController();
  let quota: Quota | null = null;
  let quotaModel = "";
  let nextQuotaAt = 0;
  let lastValue = "";
  let publishedAt = 0;

  const modelKey = () => `${ctx.model?.provider}/${ctx.model?.id}`;
  const publish = () => (publishing = publishing.then(async () => {
    if (!active) return;
    const model = ctx.model;
    const provider = subscriptionProvider(ctx);
    const snapshot = {
      version: 2, client: "pi", pid: process.pid, cwd: ctx.cwd,
      capabilities: { weekly: provider !== null, resetCredits: provider === "openai-codex" },
      model: model ? { id: model.id, name: model.name, provider: model.provider } : null,
      effort: pi.getThinkingLevel(), contextPercent: ctx.getContextUsage()?.percent ?? null,
      quota: quotaModel === modelKey() ? quota : null,
    };
    const value = JSON.stringify(snapshot);
    if (value === lastValue && Date.now() - publishedAt < 30_000) return;
    const updatedAt = Date.now();
    const payload = JSON.stringify({ ...snapshot, updatedAt });
    const result = await pi.exec("hc", ["label", terminal, `${LABEL}=${payload}`], { timeout: 2000 });
    if (result.code === 0) { lastValue = value; publishedAt = updatedAt; }
  }).catch(() => {
    // Herdr may be restarting; retry without interrupting Pi.
  }));

  const refresh = () => {
    if (!active || task) return;
    task = (async () => {
      const key = modelKey();
      if (quotaModel !== key) { quota = null; nextQuotaAt = 0; quotaModel = key; }
      await publish();
      if (!active || modelKey() !== key || Date.now() < nextQuotaAt) return;
      nextQuotaAt = Date.now() + 60_000;
      let next: Quota | null;
      try { next = await loadQuota(ctx, controller.signal); }
      catch {
        next = { weeklyLeft: null, weeklyResetAt: null, resetCount: null,
          firstResetExpiresAt: null, fetchedAt: Date.now(), error: "Usage unavailable" };
      }
      if (!active || modelKey() !== key) return;
      quota = next;
      await publish();
    })().catch(() => {}).finally(() => { task = undefined; });
  };

  pi.on("session_start", (_event, context) => {
    if (context.mode !== "tui") return;
    ctx = context;
    active = true;
    controller = new AbortController();
    refresh();
    timer = setInterval(refresh, 5000);
    timer.unref();
  });
  const update = (_event: unknown, context: ExtensionContext) => { ctx = context; refresh(); };
  pi.on("model_select", update);
  pi.on("thinking_level_select", (_event, context) => {
    ctx = context;
    void publish();
  });
  pi.on("turn_end", update);
  pi.on("session_compact", update);
  pi.on("session_shutdown", async () => {
    if (!active) return;
    active = false;
    clearInterval(timer);
    controller.abort();
    await task;
    await publishing;
    await pi.exec("hc", ["label", terminal, `${LABEL}=`], { timeout: 2000 }).catch(() => undefined);
  });
}
