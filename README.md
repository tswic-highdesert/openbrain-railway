# Firmament Open Brain

A shared "context brain" for the Firmament team, inspired by [OB1](https://github.com/NateBJones-Projects/OB1) but rebuilt lean for Railway. It's an MCP (Model Context Protocol) server backed by Postgres: each person gets a private memory store that follows them across AI tools (Claude Desktop, Claude Code, claude.ai, Cursor, etc.). Memories are isolated per user — your token only ever sees your own memories.

## How it works

- One Railway service (this Node app) + one Railway Postgres.
- Each user gets a personal token. Their MCP URL is `https://<host>/mcp/<token>`.
- All memory reads/writes are scoped to the user that token resolves to. Tokens are stored hashed (SHA-256).
- Search is Postgres full-text search with a substring fallback — no embedding API keys needed.

## MCP tools exposed

| Tool | What it does |
|---|---|
| `remember` | Store a memory (content + optional tags) |
| `recall` | Search your memories by topic/keywords |
| `recent_memories` | List newest memories |
| `forget` | Delete a memory by id |

## Connecting a client

**Claude Code:**
```bash
claude mcp add --transport http openbrain https://<host>/mcp/<your-token>
```

**Claude Desktop / claude.ai:** Settings → Connectors → Add custom connector → paste `https://<host>/mcp/<your-token>`.

**Cursor:** Settings → MCP → Add server, type `http`, same URL.

Then just talk: "remember that ..." / "what do you know about ...". A good habit is to start sessions with "check my open brain for context on <topic>".

## Admin (minting users)

Requires the `ADMIN_TOKEN` env var; pass it as a Bearer token.

```bash
# create a user (returns their token + MCP URL — shown only once)
curl -X POST https://<host>/admin/users \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"name": "Jack Wright"}'

# list users
curl https://<host>/admin/users -H "Authorization: Bearer $ADMIN_TOKEN"

# delete a user (and all their memories)
curl -X DELETE https://<host>/admin/users/<id> -H "Authorization: Bearer $ADMIN_TOKEN"
```

## Deploy (Railway)

Env vars on the app service:

- `DATABASE_URL` — reference the Railway Postgres
- `ADMIN_TOKEN` — long random string (admin API auth)
- `DATABASE_SSL` — set to `false` if connecting over Railway private networking

Deploy with `railway up` from this directory. Schema auto-creates on boot.

## Security notes

- The token lives in the URL. That's what makes hookup one-paste-easy, and it's acceptable for a small trusted team, but treat the URL like a password: don't share it, don't paste it in group chats.
- Lost token → delete the user, mint a new one (memories are keyed to the user row, so deleting the user deletes their memories — export first if needed).
