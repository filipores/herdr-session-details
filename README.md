# Session Details

Model, effort and context for your focused [Herdr](https://herdr.dev) terminal, with subscription usage where supported.

<img src="preview.png" width="480" alt="A Pi session showing its model, reasoning effort, folder, branch, context usage, weekly allowance and reset credits in Session Details.">

## Get started

Requires **Node.js 22.19+**, Herdr and `hc` on your PATH.

```sh
git clone https://github.com/filipores/herdr-session-details.git
cd herdr-session-details
node install.mjs pi
herdr-app do mod.open --name session-details
```

Use `claude` or `codex` instead of `pi`, or combine them. Run `/reload` in Pi; restart Claude Code or Codex after installing. Approve Codex's new hooks if prompted.

The installer backs up changed files and preserves Claude's existing status line. To keep the panel beside your terminal, follow the [sidebar setup](docs/guide.md#sidebar).

## Supported clients

| Client | What it reports |
| --- | --- |
| **Pi** | Model, effort and context for any provider. Weekly usage for Codex and Anthropic OAuth subscriptions. |
| **Claude Code** | Model, effort, context and weekly usage supplied by its status line. |
| **Codex CLI · experimental** | Session-hook metadata, plus ChatGPT subscription usage with file-backed OAuth credentials. |

Reset credits are Codex-only. Unsupported limits stay hidden; unavailable values show `—`, not zero.

## Privacy and limits

Adapters publish status metadata to the panel, never chat text or credentials. Subscription checks use read-only provider APIs; credits are never purchased or redeemed.

Tested on macOS. **Codex CLI has not been live-tested.** See [compatibility notes](docs/guide.md#compatibility) before relying on an unverified client or platform.

[Setup & troubleshooting](docs/guide.md) · [Rebuild recipe](RECIPE.md) · [Report an issue](https://github.com/filipores/herdr-session-details/issues)
