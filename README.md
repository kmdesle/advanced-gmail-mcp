# Gmail MCP Server

![Advanced Gmail MCP](social-preview.png)

A Gmail [MCP server](https://modelcontextprotocol.io) for [Claude Code](https://docs.anthropic.com/en/docs/claude-code) that provides full email management across multiple Gmail accounts.

## Features

- **Gmail and Google Calendar** on one server and one token store per Google account
- **Multi-account** support with simple aliases
- **OAuth2** authentication with interactive CLI flow
- **Token auto-refresh** — re-authenticates transparently
- **Rate limit retry** with exponential backoff
- **Claude Code commands** included (`/email` and `/checkemail`) for structured inbox triage

## Quick Start

### 1. Clone & Install

```bash
git clone https://github.com/coreyepstein/advanced-gmail-mcp.git
cd advanced-gmail-mcp
npm install
```

### 2. Google Cloud Setup

1. Go to [Google Cloud Console](https://console.cloud.google.com/)
2. Create a new project (or select an existing one)
3. Enable the **Gmail API** and the **Google Calendar API**:
   - APIs & Services → Enable APIs → search "Gmail API" → Enable
   - Search "Google Calendar API" → Enable
4. Configure the **OAuth consent screen**:
   - APIs & Services → OAuth consent screen
   - User type: External (or Internal if using Google Workspace)
   - Add your email address(es) as test users
   - Add scopes: `gmail.readonly`, `gmail.modify`, `gmail.send`, `gmail.compose`, `gmail.settings.basic`, and `https://www.googleapis.com/auth/calendar.events` (`calendar.events` — read and create/update events; this server does not request a delete scope)
5. Create **OAuth credentials**:
   - APIs & Services → Credentials → Create Credentials → OAuth client ID
   - Application type: **Desktop app**
   - Download the JSON file
6. Save the downloaded file as `credentials.json` in the project root

### 3. Configure Accounts

```bash
cp accounts.example.json accounts.json
```

Edit `accounts.json` with your Gmail accounts:

```json
{
  "accounts": [
    { "email": "you@gmail.com", "alias": "personal" },
    { "email": "you@company.com", "alias": "work" }
  ],
  "default": "personal"
}
```

You can add as many accounts as you want. Each needs a unique `alias`.

### 4. Authenticate

```bash
# Authenticate all accounts (opens browser for each)
npm run auth

# Or authenticate a single account
npm run auth -- work

# Check auth status
npm run auth:check
```

The auth flow opens a browser window for each account. Tokens are saved to `./tokens/`.

#### Calendar scope (one-time re-consent per account)

`calendar.events` was added after the original Gmail scopes. Tokens saved before that do not include it. Gmail tools keep working for those accounts. Calendar tools do not: they return an error that names the account and tells you to re-run auth. They do not crash the server.

```bash
npm run auth -- work
npm run auth:check
```

`npm run auth:check` prints `[calendar: granted]` or `[calendar: not granted]` on each account line. Re-run `npm run auth` (or `npm run auth -- <alias>`) once per account that should use Calendar. The Cloud project must already have the Calendar API enabled and `calendar.events` on the OAuth consent screen, or consent cannot grant the scope.

### 5. Add to Claude Code

Add to your MCP config (project `.mcp.json` or `~/.claude.json`):

```json
{
  "mcpServers": {
    "gmail": {
      "type": "stdio",
      "command": "npx",
      "args": ["tsx", "/absolute/path/to/gmail-mcp/src/server.ts"]
    }
  }
}
```

> **Important:** Use the absolute path to `src/server.ts`.

### 6. (Optional) Add Commands

Copy the included Claude Code commands for structured email workflows:

```bash
# From your project root (where .claude/ lives)
mkdir -p .claude/commands
cp /path/to/gmail-mcp/.claude/commands/email.md .claude/commands/
cp /path/to/gmail-mcp/.claude/commands/checkemail.md .claude/commands/
```

Then use `/email` or `/checkemail` in Claude Code.

## Tools

| Tool | Description |
|------|-------------|
| `list_emails` | List inbox or label emails |
| `search_emails` | Search with Gmail query syntax |
| `read_email` | Read full email by ID; optional `headers` selects raw headers (including repeats), and `auth_summary: true` parses SPF/DKIM/DMARC and unsubscribe headers |
| `download_attachment` | Save an attachment by ID or exact filename to an existing directory |
| `get_thread` | Get full thread with all messages |
| `get_labels` | List all labels |
| `list_send_as` | List verified send-as aliases (wraps users.settings.sendAs.list) |
| `send_email` | Send a new email |
| `draft_email` | Create a draft |
| `reply_email` | Reply with proper threading |
| `archive_email` | Archive (remove INBOX label) |
| `label_email` | Add/remove labels |
| `trash_email` | Move to trash |
| `batch_modify` | Batch archive/trash/label |
| `calendar_list_calendars` | List calendars on the account |
| `calendar_list_events` | List events (`calendar_id` default `primary`, `time_min`, `time_max`, `max_results`, `query`) |
| `calendar_get_event` | Get one event by id |
| `calendar_freebusy` | Free/busy for a time range across a list of calendars |
| `calendar_create_event` | Create an event (`summary`, `start`, `end`, optional `timezone`, `description`, `location`, `attendees`) |
| `calendar_update_event` | Patch an event (only fields you pass) |

There is no calendar delete tool. Access is read plus create/update.

`calendar_create_event` and `calendar_update_event` send `send_updates: "none"` unless you pass `send_updates` (`none`, `all`, or `externalOnly`). If `attendees` is set, you must pass `send_updates` yourself — the tool will not assume `"none"` and will not email guests without an explicit value.

All tools accept an optional `account` parameter (alias or email). Defaults to the account set in `accounts.json`. Calendar uses the same OAuth client and token file as Gmail for that account.

## Commands

### `/email [action] [account]`

Full email management command with actions:
- **triage** — Summarize inbox, batch archive/trash
- **cleanup** — 4-phase daily email workflow
- **search {query}** — Cross-account search
- **send / draft / reply** — Compose with confirmation

### `/checkemail [account]`

Quick 3-phase inbox sweep:
1. Fetch & classify all inbox emails (auto-archive junk)
2. Batch archive on approval
3. Walk through remaining emails one at a time

## Troubleshooting

| Error | Fix |
|-------|-----|
| `accounts.json not found` | Copy `accounts.example.json` to `accounts.json` |
| `credentials.json not found` | Download OAuth credentials from GCP Console |
| `No token for...` | Run `npm run auth -- <alias>` |
| `Token refresh failed` | Re-authenticate: `npm run auth -- <alias>` |
| `403 Forbidden` | Add your email as test user in GCP OAuth consent screen |
| `403 insufficient scopes` | Re-authenticate to get updated scopes: `npm run auth -- <alias>` |
| Calendar tool: scope is not granted | Enable the Calendar API, add `calendar.events` on the OAuth consent screen, then `npm run auth -- <alias>`. Gmail tools still work before that re-consent. |

## License

MIT

## Read-only sender alerts ($0)

`npm run alerts` runs a separate watcher; the MCP server entry point and tools
are unchanged. It uses the existing account aliases and token-loading client.
Only accounts listed in rules are watched. Each account polls immediately and
then every 60 seconds, without overlapping its own requests. A slow poll delays
that account's next poll. The watcher only calls `users.history.list`
(`messageAdded`, `INBOX`), `users.messages.get` (`format=metadata`, headers
`From`, `Subject`, `Date`), and `users.getProfile`. It never reads or stores bodies,
snippets, or attachment information. Existing tokens may have broader scopes;
these operations only require `gmail.readonly`. Token refresh follows the
existing client behavior. No new dependencies, paid services, AI, Pub/Sub, or
cloud resources are used. On an ERROR alert (five failed polls or
`invalid_grant`), the watcher posts one 🔴 message per failure streak using
`SLACK_ALERTS_ACTION_WEBHOOK_URL` from `~/.config/desler/alerts.env`. When the
streak recovers, it posts one 🟢 message if
`SLACK_ALERTS_OK_WEBHOOK_URL` is configured. The file accepts `KEY='value'`
and `KEY="value"` lines. Missing action configuration and failed posts are
logged without exposing URLs or stopping the poll loop. Sender matches do not
post to Slack.

Create `~/.config/gmail-alerts/rules.json` as a JSON array, for example:

```json
[
  { "account": "tractic", "from": ["alfred.gpt@ktagroupinc.com"], "tag": "ALFRED" },
  { "account": "tractic", "from": ["greg.namrow@tractic.io"], "tag": "GREG" }
]
```

`account` must be an exact alias in the existing `accounts.json`. `from` is a
nonempty list of exact mailbox addresses, matched case-insensitively after
extracting the address from a display-name header. Optional `subject_contains`
is a nonempty array of literal, case-insensitive substrings; any one must match.
Each matching rule emits an alert. Restart the watcher after changing rules.
It does not create or edit rules, accounts, credentials, or authentication setup.

State is saved atomically in `~/.local/state/gmail-alerts/<account>.json`.
First startup seeds the current profile history ID; it does not scan old mail.
An expired history ID (404) logs a JSON `gap` event to stdout/journald and reseeds
from the profile. Mail in that gap cannot be recovered by this watcher.
History is paginated and message IDs are deduplicated within each poll. Cursors
advance only after processing all pages and messages. Delivery is at least once:
a crash or partial failure after appending alerts but before saving the cursor
can repeat alerts. Consumers can deduplicate by account, tag, and message ID.
Messages deleted before their metadata fetch (404) are skipped.

Matches append to `~/.local/state/gmail-alerts/alerts.jsonl` with exactly:

```json
{"ts":"2026-10-30T00:00:00.000Z","account":"tractic","tag":"ALFRED","from":"Alfred <alfred.gpt@ktagroupinc.com>","subject":"Status update","message_id":"example-message","thread_id":"example-thread"}
```

`ts` is observation time in UTC. After five consecutive failed polls, or
immediately on `invalid_grant`, the watcher appends an alert with tag `ERROR`,
a diagnostic subject, and empty sender/message/thread fields. It emits one
ERROR per failure streak and resets on success. Polling continues for recovery.
A daily per-account JSON `heartbeat` event and sanitized failure counts go to
stdout/journald. If state storage itself fails, an alert cannot be persisted;
the service exits and systemd retries. Alert files contain sender/subject data;
new directories/files are private. Use only one watcher process per state directory.

### Install the user service (manual)

Use a permanent checkout with its existing dependencies and authenticated tokens.
Copy the supplied unit, then edit its `WorkingDirectory` and `ExecStart` paths
for that checkout and the absolute Node executable (`command -v node`):

```bash
mkdir -p ~/.config/systemd/user
cp systemd/gmail-alerts.service ~/.config/systemd/user/
# Edit ~/.config/systemd/user/gmail-alerts.service paths before starting it.
systemctl --user daemon-reload
systemctl --user enable --now gmail-alerts.service
journalctl --user -u gmail-alerts.service -f
```

The repository ships the unit only; it does not install or enable it. User
services require an active user manager (lingering is an administrator choice).
Stop with `systemctl --user disable --now gmail-alerts.service`. Preserve the
state directory to resume at its cursor; removing state deliberately resets the
baseline and skips intervening mail. Alert rotation/retention is operator managed.

### Coordinator Monitor

Run this long-lived command through the coordinator's **Monitor** tool to receive
new JSON alerts as live events (create the file first if no match has arrived):

```bash
mkdir -p ~/.local/state/gmail-alerts
# Keep the directory private, including when creating it manually.
chmod 700 ~/.local/state/gmail-alerts
touch ~/.local/state/gmail-alerts/alerts.jsonl
chmod 600 ~/.local/state/gmail-alerts/alerts.jsonl
tail -n 0 -F ~/.local/state/gmail-alerts/alerts.jsonl | jq --unbuffered -c .
```

Inspect `ERROR` alerts for authentication failures and the service journal for
gaps or missing heartbeats. `jq` is only a convenience for the Monitor command;
the watcher does not require it.

## Slack alerts watcher

`npm run slack-alerts` runs a separate, read-only watcher (same pattern as the
Gmail alerts watcher; the MCP server is unchanged). It watches **every channel
the bot is a member of**, public and private. Channels are discovered with
`users.conversations` at startup and every 15 minutes, so channels the app is
added to later are picked up without a restart. It polls `conversations.history`
every 60 seconds using plain `fetch` against `https://slack.com/api`, with no new
dependencies. It never calls a Slack write method.

**Setup.** Create a Slack app with a bot token (`xoxb-...`) and exactly these
scopes: `channels:history`, `channels:read`, `groups:history`, `groups:read`.
Invite the bot to each channel to watch. Put the token in an env file that only
you can read (the token is never logged):

```bash
mkdir -p ~/.config/slack-alerts
printf 'SLACK_ALERTS_BOT_TOKEN=xoxb-...\n' > ~/.config/slack-alerts/env
chmod 600 ~/.config/slack-alerts/env
```

**Optional overrides**: `~/.config/slack-alerts/channels.json`. Without it every
member channel is watched and its tag is the channel name.

```json
{ "exclude": ["random"], "tags": { "fleet-red-action": "RED", "fleet-amber-watch": "AMBER", "fleet-green-ok": "GREEN" } }
```

**Files**

| File | Purpose |
|------|---------|
| `~/.local/state/slack-alerts/alerts.jsonl` | One line per new message |
| `~/.local/state/slack-alerts/state.json` | Last seen `ts` per channel ID |
| `~/.local/state/slack-alerts/backfill-<date>.jsonl` | Output of `--backfill` |

A message line is `{"ts_iso","channel","tag","color","ts","text","bot_name"|"user","thread_ts"?}`.
`text` is the first 500 characters. `color` is `red`, `amber` or `green` when the
text starts with 🔴, 🟡 or 🟢, otherwise `null`. A channel seen for the first
time (first run, or newly joined) starts at "now", so old history is not flooded
into the feed. Thread replies are not fetched. Permalinks are not included.

On an API error the watcher appends `{"ERROR":"<code>","channel","ts_iso"}`, at
most once per distinct error and channel per hour. A 429 pauses all polling for
the `Retry-After` time. A failure to write state exits the process so systemd
restarts it.

**Backfill** (one-shot, separate from the loop; does not touch `state.json`):

```bash
npm run slack-alerts -- --backfill 7
```

writes the last 7 days from all member channels to
`~/.local/state/slack-alerts/backfill-<date>.jsonl` and exits.

**Service.** `deploy/slack-alerts.service` is a user unit that reads the token
from `EnvironmentFile=%h/.config/slack-alerts/env`. It is committed but not
installed. Edit its paths, then copy it to `~/.config/systemd/user/` and run
`systemctl --user enable --now slack-alerts.service`. Use one watcher per state
directory. Follow the feed with the same Monitor `tail -F ... | jq` command as
above, pointed at the Slack `alerts.jsonl`.
