// Coachly — AI Business Coach backend
// Express server with auth (signup / signin / forgot / me / signout)
// and a streaming Claude chat endpoint protected by session cookies.
//
// Run:
//   export ANTHROPIC_API_KEY=sk-ant-...
//   export JWT_SECRET=any-long-random-string   (optional, dev fallback provided)
//   npm install
//   npm start
// Open http://localhost:3000

import express from "express";
import path from "node:path";
import fs from "node:fs/promises";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import cookieParser from "cookie-parser";
import Anthropic from "@anthropic-ai/sdk";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(__dirname, "data");
const USERS_FILE = path.join(DATA_DIR, "users.json");
const RESET_FILE = path.join(DATA_DIR, "resets.json");

const JWT_SECRET = process.env.JWT_SECRET || "dev-only-secret-change-in-prod";
const COOKIE_NAME = "coachly_session";
const SESSION_TTL = "7d";

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

// ---------- tiny JSON store ----------
async function ensureStore() {
  await fs.mkdir(DATA_DIR, { recursive: true });
  for (const f of [USERS_FILE, RESET_FILE]) {
    try { await fs.access(f); }
    catch { await fs.writeFile(f, "[]", "utf8"); }
  }
}
async function readJson(file) {
  const raw = await fs.readFile(file, "utf8");
  try { return JSON.parse(raw); } catch { return []; }
}
async function writeJson(file, data) {
  await fs.writeFile(file, JSON.stringify(data, null, 2), "utf8");
}

// ---------- validation ----------
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
function validateEmail(email) {
  if (typeof email !== "string") return "Email is required";
  const e = email.trim().toLowerCase();
  if (!e) return "Email is required";
  if (e.length > 254) return "Email is too long";
  if (!EMAIL_RE.test(e)) return "Enter a valid email address";
  return null;
}
function validatePassword(pw) {
  if (typeof pw !== "string" || pw.length === 0) return "Password is required";
  return null;
}
function normalizeEmail(email) { return String(email || "").trim().toLowerCase(); }

// ---------- session helpers ----------
function issueSession(res, user) {
  const token = jwt.sign({ sub: user.id, email: user.email }, JWT_SECRET, { expiresIn: SESSION_TTL });
  res.cookie(COOKIE_NAME, token, {
    httpOnly: true,
    sameSite: "lax",
    secure: false, // set true behind HTTPS in prod
    maxAge: 7 * 24 * 60 * 60 * 1000,
    path: "/",
  });
}
function clearSession(res) {
  res.clearCookie(COOKIE_NAME, { path: "/" });
}
function readSession(req) {
  const token = req.cookies?.[COOKIE_NAME];
  if (!token) return null;
  try { return jwt.verify(token, JWT_SECRET); }
  catch { return null; }
}
function requireAuth(req, res, next) {
  const session = readSession(req);
  if (!session) return res.status(401).json({ error: "Not authenticated" });
  req.session = session;
  next();
}

function publicUser(u) {
  return { id: u.id, email: u.email, name: u.name || null, createdAt: u.createdAt };
}

// ---------- app ----------
const app = express();
app.use(express.json({ limit: "1mb" }));
app.use(cookieParser());
app.use(express.static(__dirname));

// ===== AUTH: signup =====
app.post("/api/auth/signup", async (req, res) => {
  try {
    const { email, password, name } = req.body || {};
    const errors = {};
    const ee = validateEmail(email); if (ee) errors.email = ee;
    const pe = validatePassword(password); if (pe) errors.password = pe;
    if (Object.keys(errors).length) return res.status(400).json({ error: "Invalid input", errors });

    const users = await readJson(USERS_FILE);
    const norm = normalizeEmail(email);
    if (users.find(u => u.email === norm)) {
      return res.status(409).json({ error: "An account with that email already exists", errors: { email: "Email already in use" } });
    }
    const passwordHash = await bcrypt.hash(password, 10);
    const user = {
      id: crypto.randomUUID(),
      email: norm,
      name: name ? String(name).slice(0, 80) : null,
      passwordHash,
      createdAt: new Date().toISOString(),
    };
    users.push(user);
    await writeJson(USERS_FILE, users);
    issueSession(res, user);
    res.json({ user: publicUser(user) });
  } catch (err) {
    console.error("[signup]", err);
    res.status(500).json({ error: "Server error" });
  }
});

// ===== AUTH: signin =====
app.post("/api/auth/signin", async (req, res) => {
  try {
    const { email, password } = req.body || {};
    const errors = {};
    const ee = validateEmail(email); if (ee) errors.email = ee;
    if (!password) errors.password = "Password is required";
    if (Object.keys(errors).length) return res.status(400).json({ error: "Invalid input", errors });

    const users = await readJson(USERS_FILE);
    const norm = normalizeEmail(email);
    const user = users.find(u => u.email === norm);
    // constant-ish time: always run a hash compare
    const ok = user ? await bcrypt.compare(password, user.passwordHash) : await bcrypt.compare(password, "$2a$10$CwTycUXWue0Thq9StjUM0uJ8U6cT3uX4y3aHb3oW8WXk1y9o9kQ8m");
    if (!user || !ok) {
      return res.status(401).json({ error: "Invalid email or password" });
    }
    issueSession(res, user);
    res.json({ user: publicUser(user) });
  } catch (err) {
    console.error("[signin]", err);
    res.status(500).json({ error: "Server error" });
  }
});

// ===== AUTH: forgot password (issues a token; logs it to console for dev) =====
app.post("/api/auth/forgot", async (req, res) => {
  try {
    const { email } = req.body || {};
    const ee = validateEmail(email);
    if (ee) return res.status(400).json({ error: "Invalid input", errors: { email: ee } });

    const users = await readJson(USERS_FILE);
    const norm = normalizeEmail(email);
    const user = users.find(u => u.email === norm);

    // Always respond OK (don't leak which emails exist)
    if (user) {
      const resets = await readJson(RESET_FILE);
      const token = crypto.randomBytes(24).toString("hex");
      resets.push({
        token,
        userId: user.id,
        createdAt: Date.now(),
        expiresAt: Date.now() + 30 * 60 * 1000, // 30 min
      });
      await writeJson(RESET_FILE, resets);
      console.log(`[forgot] Reset link for ${user.email}: http://localhost:${PORT}/?reset=${token}`);
    }
    res.json({ ok: true });
  } catch (err) {
    console.error("[forgot]", err);
    res.status(500).json({ error: "Server error" });
  }
});

// ===== AUTH: me =====
app.get("/api/auth/me", async (req, res) => {
  const session = readSession(req);
  if (!session) return res.json({ user: null });
  const users = await readJson(USERS_FILE);
  const user = users.find(u => u.id === session.sub);
  if (!user) { clearSession(res); return res.json({ user: null }); }
  res.json({ user: publicUser(user) });
});

// ===== AUTH: signout =====
app.post("/api/auth/signout", (req, res) => {
  clearSession(res);
  res.json({ ok: true });
});

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
  res.json({ ok: true, model: MODEL, hasKey: !!process.env.ANTHROPIC_API_KEY });
});

const PORT = process.env.PORT || 3000;
await ensureStore();
app.listen(PORT, () => {
  if (!process.env.ANTHROPIC_API_KEY) console.warn("⚠️  ANTHROPIC_API_KEY is not set — /api/chat will fail.");
  if (JWT_SECRET === "dev-only-secret-change-in-prod") console.warn("⚠️  Using dev JWT_SECRET. Set JWT_SECRET in production.");
  console.log(`Coachly running → http://localhost:${PORT}`);
});
