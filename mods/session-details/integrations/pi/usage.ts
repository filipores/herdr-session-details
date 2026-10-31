import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { fetchAnthropicQuota, fetchCodexQuota } from "../usage.mjs";

export { codexQuota } from "../usage.mjs";
export type Quota = {
  weeklyLeft: number | null;
  weeklyResetAt: number | null;
  resetCount: number | null;
  firstResetExpiresAt: number | null;
  fetchedAt: number;
  error?: string;
};

export function subscriptionProvider(ctx: ExtensionContext): string | null {
  const model = ctx.model;
  return model && ["openai-codex", "anthropic"].includes(model.provider)
    && ctx.modelRegistry.isUsingOAuth(model) ? model.provider : null;
}

export async function loadQuota(ctx: ExtensionContext, signal: AbortSignal): Promise<Quota | null> {
  const provider = subscriptionProvider(ctx);
  if (!provider) return null;
  const key = await ctx.modelRegistry.getApiKeyForProvider(provider);
  if (!key) throw new Error("Subscription authentication unavailable");
  return provider === "openai-codex" ? fetchCodexQuota(key, undefined, signal) : fetchAnthropicQuota(key, signal);
}
