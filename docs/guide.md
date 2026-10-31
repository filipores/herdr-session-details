# Setup and troubleshooting

[Back to the README](../README.md)

## Clients

Pass only the clients you use to `node install.mjs`: `pi`, `claude`, `codex`, or a combination. No arguments installs only the panel.

- **Pi:** adds `extensions/herdr-live-status/index.ts` to your Pi agent directory. Run `/reload`. Don't also install the package as a Pi extension: that would load the adapter twice.
- **Claude Code:** wraps its status-line command, preserving stdin and output. The previous command is saved in `~/.claude/herdr-session-details-statusline.json`. Restart Claude.
- **Codex CLI:** merges `SessionStart`, `UserPromptSubmit`, `Stop` and `PostCompact` hooks. Restart Codex, enable hooks if your version requires it, and approve them through its normal trust flow. The installer doesn't change feature flags or bypass approval.

Reinstalling doesn't duplicate hooks. An unrelated mod named `session-details` is left alone; use `--replace` only after reviewing what will be backed up and replaced.

Custom directories are supported through `HERDR_APP_HOME`, `PI_CODING_AGENT_DIR`, `CLAUDE_CONFIG_DIR` and `CODEX_HOME`. For remote sessions, install the adapter on the machine running the client; credentials stay there.

## Sidebar

The installer doesn't rearrange your window. Clone your layout before editing it, then insert this block:

```json
{
  "id": "session-details",
  "type": "block",
  "content": { "mod": "session-details" },
  "size": { "px": 210 },
  "min": 160
}
```

Optional: use the same mod with `"props": {"footer": true}` for a machine/branch footer without an agent count. Existing `session-details` blocks keep working. The panel follows your terminal font and theme.

## Data and refresh

Adapters publish a `herdr.session-details` terminal label containing model, effort, directory, context percentage, client/process identity, optional session ID, quota values and timestamps. Legacy `pi.live-status` labels remain readable.

- **Pi:** model, effort and context changes publish on events without waiting for quota requests; a five-second poll covers other changes. Quotas refresh once a minute. Missing heartbeats expire after 75 seconds; stale quotas after two minutes.
- **Claude and Codex:** updates arrive through status-line callbacks or hooks. Codex may not run its first hooks until you send a prompt, including after resume. Its idle `/model` selection appears at the next turn hook; completed compaction refreshes immediately. Idle data stays valid only for the same process. Tooltips show when quotas were reported; elapsed reset dates don't imply a refill.
- **Codex context:** reads only the hook-provided transcript, verifies its session ID and discards conversation content. Usage is last-request tokens divided by the model window, not lifetime tokens. This can differ from Codex's baseline-adjusted percentage. Compaction clears it until a new report; large transcripts can exceed the three-second read deadline.

OAuth usage checks read OpenAI's `/backend-api/wham/usage` and `/rate-limit-reset-credits`, or Anthropic's `/api/oauth/usage`. These provider endpoints may change. Native Claude uses its supplied status-line JSON without reading credentials. Codex keychain-only credentials aren't read, so reset credits are unavailable in that setup.

## Missing values

- **No session details:** install the adapter on the client's machine, then reload/restart that client. It must run in a Herdr terminal with `HC_TERMINAL_ID`. In Codex, review the hooks through `/hooks`, then send a first prompt.
- **Context is `—`:** the client may not have reported usage yet, especially before its first response or after compaction.
- **No weekly allowance:** API-key and local-model sessions usually don't have a supported subscription limit. Claude shows one only when its callback supplies it.
- **Quota or credits become unavailable:** check the client's OAuth login and connectivity. Missing or expired data is never displayed as zero.

## Compatibility

Live checks on macOS used Herdr **0.1.10**, `hc` **0.1.15**, Pi **1.4.0**, Claude Code **2.1.316** and Codex CLI **0.166.0**. They cover Pi model/effort updates and both native clients' turns, model changes, compaction and resume. Claude's original status-line output remained intact. Automated tests target Node **22/24**.

API-key/local-model cases have fixture tests, not live end-to-end verification. Codex's transcript format is not a stable API; client updates may require adapter changes. Other platforms, remote setups, VoiceOver and light appearance still need QA. Gemini CLI and OpenCode adapters aren't included; their model providers can be used through Pi.

## Remove or roll back

1. Remove the panel block or return to your prior layout.
2. Restore backed-up client settings, or remove the adapter entries if there was no prior configuration. Remove the Pi `extensions/herdr-live-status/` shim if it was newly added.
3. Remove the installed `mods/session-details/` folder, or restore its previous version.
4. Reload Pi and restart affected clients.

Client JSON backups sit beside the originals as `.backup-*`; mod and Pi-extension backups live in their respective `backups/` directories. Restore Claude's original status line **before** deleting its saved configuration. Leave unrelated hooks intact.

## Development

From the source checkout:

```sh
npm test
herdr-app check "$PWD/mods/session-details"
```

The [recipe](../RECIPE.md) is the reconstruction brief required by Herdr's mod catalog. This repository is distributed through GitHub, not npm.
