import crypto from "node:crypto";
import express from "express";
import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { pool, initSchema } from "./db.js";

const PORT = process.env.PORT || 3000;
const ADMIN_TOKEN = process.env.ADMIN_TOKEN;

const sha256 = (s) => crypto.createHash("sha256").update(s).digest("hex");

async function userForToken(token) {
  if (!token) return null;
  const { rows } = await pool.query("SELECT id, name FROM users WHERE token_hash = $1", [
    sha256(token),
  ]);
  return rows[0] || null;
}

function formatMemory(row) {
  const tags = row.tags?.length ? ` [${row.tags.join(", ")}]` : "";
  const date = new Date(row.created_at).toISOString().slice(0, 10);
  return `#${row.id} (${date})${tags}: ${row.content}`;
}

// ---------- MCP server (one instance per request, scoped to a user) ----------

function buildMcpServer(user) {
  const server = new McpServer({
    name: "firmament-openbrain",
    version: "1.0.0",
  });

  server.registerTool(
    "remember",
    {
      title: "Remember",
      description:
        "Store a memory in your Open Brain. Use this to save durable facts, preferences, decisions, project context, or anything worth recalling later. Write memories as self-contained statements.",
      inputSchema: {
        content: z.string().min(1).describe("The memory to store, as a self-contained statement"),
        tags: z
          .array(z.string())
          .optional()
          .describe("Optional short tags for grouping, e.g. ['deal-flow', 'preferences']"),
      },
    },
    async ({ content, tags }) => {
      const { rows } = await pool.query(
        "INSERT INTO memories (user_id, content, tags) VALUES ($1, $2, $3) RETURNING id",
        [user.id, content, tags || []]
      );
      return {
        content: [{ type: "text", text: `Saved memory #${rows[0].id}.` }],
      };
    }
  );

  server.registerTool(
    "recall",
    {
      title: "Recall",
      description:
        "Search your Open Brain memories by topic or keywords. Returns the most relevant memories. Use this at the start of a task to pull in relevant context.",
      inputSchema: {
        query: z.string().min(1).describe("What to search for, in plain words"),
        limit: z.number().int().min(1).max(50).optional().describe("Max results (default 8)"),
      },
    },
    async ({ query, limit }) => {
      const n = Math.min(limit || 8, 50);
      let { rows } = await pool.query(
        `SELECT id, content, tags, created_at
           FROM memories
          WHERE user_id = $1 AND tsv @@ websearch_to_tsquery('english', $2)
          ORDER BY ts_rank(tsv, websearch_to_tsquery('english', $2)) DESC, created_at DESC
          LIMIT $3`,
        [user.id, query, n]
      );
      if (rows.length === 0) {
        // Fallback: loose substring match on any word in the query
        const words = query.split(/\s+/).filter((w) => w.length > 2);
        if (words.length) {
          const res = await pool.query(
            `SELECT id, content, tags, created_at
               FROM memories
              WHERE user_id = $1 AND content ILIKE ANY($2)
              ORDER BY created_at DESC
              LIMIT $3`,
            [user.id, words.map((w) => `%${w}%`), n]
          );
          rows = res.rows;
        }
      }
      const text = rows.length
        ? `Found ${rows.length} memories:\n\n${rows.map(formatMemory).join("\n")}`
        : "No matching memories found.";
      return { content: [{ type: "text", text }] };
    }
  );

  server.registerTool(
    "recent_memories",
    {
      title: "Recent memories",
      description: "List your most recently stored memories, newest first.",
      inputSchema: {
        limit: z.number().int().min(1).max(100).optional().describe("Max results (default 20)"),
      },
    },
    async ({ limit }) => {
      const { rows } = await pool.query(
        `SELECT id, content, tags, created_at
           FROM memories WHERE user_id = $1
          ORDER BY created_at DESC LIMIT $2`,
        [user.id, Math.min(limit || 20, 100)]
      );
      const text = rows.length
        ? `Your ${rows.length} most recent memories:\n\n${rows.map(formatMemory).join("\n")}`
        : "No memories stored yet. Use the remember tool to save your first one.";
      return { content: [{ type: "text", text }] };
    }
  );

  server.registerTool(
    "forget",
    {
      title: "Forget",
      description:
        "Permanently delete one of your memories by its id (shown as #id in recall/recent results).",
      inputSchema: {
        memory_id: z.number().int().describe("The id of the memory to delete"),
      },
    },
    async ({ memory_id }) => {
      const { rowCount } = await pool.query(
        "DELETE FROM memories WHERE id = $1 AND user_id = $2",
        [memory_id, user.id]
      );
      return {
        content: [
          {
            type: "text",
            text: rowCount ? `Deleted memory #${memory_id}.` : `No memory #${memory_id} found.`,
          },
        ],
      };
    }
  );

  return server;
}

// ---------- HTTP layer ----------

const app = express();
app.set("trust proxy", true);
app.use(express.json({ limit: "2mb" }));

app.get("/", (_req, res) => {
  res.type("text/plain").send(
    "Firmament Open Brain — MCP memory server.\n" +
      "Connect your AI client to: /mcp/<your-token>\n" +
      "Ask Tal for a token."
  );
});

app.get("/healthz", async (_req, res) => {
  try {
    await pool.query("SELECT 1");
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// MCP endpoint — stateless streamable HTTP, token in the URL path
app.post("/mcp/:token", async (req, res) => {
  try {
    const user = await userForToken(req.params.token);
    if (!user) {
      return res.status(401).json({
        jsonrpc: "2.0",
        error: { code: -32001, message: "Invalid or unknown token" },
        id: null,
      });
    }
    const server = buildMcpServer(user);
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    res.on("close", () => {
      transport.close();
      server.close();
    });
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  } catch (e) {
    console.error("MCP error:", e);
    if (!res.headersSent) {
      res.status(500).json({
        jsonrpc: "2.0",
        error: { code: -32603, message: "Internal server error" },
        id: null,
      });
    }
  }
});

// Stateless mode: no session resumption / termination
app.get("/mcp/:token", (_req, res) => res.status(405).set("Allow", "POST").send());
app.delete("/mcp/:token", (_req, res) => res.status(405).set("Allow", "POST").send());

// ---------- Admin API (Bearer ADMIN_TOKEN) ----------

function requireAdmin(req, res, next) {
  const auth = req.headers.authorization || "";
  if (!ADMIN_TOKEN || auth !== `Bearer ${ADMIN_TOKEN}`) {
    return res.status(401).json({ error: "unauthorized" });
  }
  next();
}

app.post("/admin/users", requireAdmin, async (req, res) => {
  const name = (req.body?.name || "").trim();
  if (!name) return res.status(400).json({ error: "name is required" });
  const token = crypto.randomBytes(24).toString("hex");
  const { rows } = await pool.query(
    "INSERT INTO users (name, token_hash) VALUES ($1, $2) RETURNING id, name, created_at",
    [name, sha256(token)]
  );
  res.json({
    ...rows[0],
    token,
    mcp_url: `${req.protocol}://${req.get("host")}/mcp/${token}`,
    note: "Save this token now — it is not stored in plaintext and cannot be shown again.",
  });
});

app.get("/admin/users", requireAdmin, async (_req, res) => {
  const { rows } = await pool.query(
    `SELECT u.id, u.name, u.created_at, COUNT(m.id)::int AS memory_count
       FROM users u LEFT JOIN memories m ON m.user_id = u.id
      GROUP BY u.id ORDER BY u.id`
  );
  res.json(rows);
});

app.delete("/admin/users/:id", requireAdmin, async (req, res) => {
  const { rowCount } = await pool.query("DELETE FROM users WHERE id = $1", [req.params.id]);
  res.json({ deleted: rowCount === 1 });
});

// ---------- Boot ----------

await initSchema();
app.listen(PORT, () => console.log(`Firmament Open Brain listening on :${PORT}`));
