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
| `read_email` | Read full email by ID |
| `get_thread` | Get full thread with all messages |
| `get_labels` | List all labels |
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
