// Coachly — AI Business Coach backend
// Express server with Supabase Auth + streaming Claude chat endpoint.
//
// Required env vars:
//   ANTHROPIC_API_KEY=sk-ant-...
//   SUPABASE_URL=https://your-project.supabase.co
//   SUPABASE_SERVICE_KEY=eyJ...   (service_role key — server only, never expose to client)
//
// Run:
//   npm install
//   npm start
// Open http://localhost:3000

import express from "express";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createClient } from "@supabase/supabase-js";
import Anthropic from "@anthropic-ai/sdk";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ---------- Supabase ----------
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;
const supabase = SUPABASE_URL && SUPABASE_SERVICE_KEY
  ? createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY)
  : null;

// ---------- Anthropic ----------
const client = new Anthropic();
const MODEL = "claude-opus-4-6";

const SYSTEM_PROMPT = `You are Coachly, a sharp, practical AI Business Coach for early-stage founders and small business owners.

Your job:
- Help the user grow their business, get unstuck, and make better decisions.
- Cover: positioning, pricing, marketing, sales, retention, hiring, fundraising, ops, and founder mindset.
- Be direct and confident — never wishy-washy. If you disagree with the user, say so plainly and explain why.
- Default to concrete next actions: specific numbers, scripts, step-by-step playbooks, and 7/14/30-day plans.
- Ask 1 clarifying question only when it would meaningfully change your answer; otherwise just answer.

Style:
- Tight, conversational, no corporate filler.
- Short paragraphs, use bullets when listing 3+ items.
- Prefer examples, frameworks, and templates over abstract advice.
- Markdown is fine. Never start with "As an AI" or apologize.

If the user shares numbers (revenue, churn, CAC, conversion), reference them in your reasoning.`;

// ---------- Auth middleware ----------
async function requireAuth(req, res, next) {
  const authHeader = req.headers.authorization;
  if (!authHeader?.startsWith("Bearer ")) {
    return res.status(401).json({ error: "Not authenticated" });
  }
  const token = authHeader.slice(7);

  if (!supabase) {
    return res.status(500).json({ error: "Supabase not configured on server" });
  }

  const { data, error } = await supabase.auth.getUser(token);
  if (error || !data?.user) {
    return res.status(401).json({ error: "Invalid or expired token" });
  }

  req.user = data.user;
  next();
}

// ---------- App ----------
const app = express();
app.use(express.json({ limit: "1mb" }));
app.use(express.static(__dirname));

// ===== CHAT: streaming (auth required) =====
app.post("/api/chat", requireAuth, async (req, res) => {
  const { messages } = req.body || {};
  if (!Array.isArray(messages) || messages.length === 0) {
    return res.status(400).json({ error: "messages array required" });
  }

  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache, no-transform");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Accel-Buffering", "no");
  res.flushHeaders?.();

  const send = (event, data) => {
    res.write(`event: ${event}\n`);
    res.write(`data: ${JSON.stringify(data)}\n\n`);
  };

  try {
    const stream = client.messages.stream({
      model: MODEL,
      max_tokens: 4096,
      thinking: { type: "adaptive" },
      system: SYSTEM_PROMPT,
      messages: messages.map((m) => ({
        role: m.role === "assistant" ? "assistant" : "user",
        content: String(m.content ?? ""),
      })),
    });

    stream.on("text", (delta) => send("delta", { text: delta }));
    stream.on("error", (err) => {
      console.error("[stream error]", err);
      send("error", { message: err?.message || "stream error" });
      res.end();
    });

    const finalMsg = await stream.finalMessage();
    send("done", { stop_reason: finalMsg.stop_reason, usage: finalMsg.usage });
    res.end();
  } catch (err) {
    console.error("[chat error]", err);
    if (!res.headersSent) {
      res.status(500).json({ error: err?.message || "server error" });
    } else {
      send("error", { message: err?.message || "server error" });
      res.end();
    }
  }
});

app.get("/api/health", (_req, res) => {
  res.json({
    ok: true,
    model: MODEL,
    hasKey: !!process.env.ANTHROPIC_API_KEY,
    supabaseConfigured: !!supabase,
  });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  if (!process.env.ANTHROPIC_API_KEY) console.warn("⚠️  ANTHROPIC_API_KEY is not set — /api/chat will fail.");
  if (!supabase) console.warn("⚠️  SUPABASE_URL or SUPABASE_SERVICE_KEY not set — auth will fail.");
  console.log(`Coachly running → http://localhost:${PORT}`);
});
