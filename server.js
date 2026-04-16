// Coachly — AI Business Coach backend
// Express server with Supabase Auth + competitor scraping.
//
// Required env vars:
//   SUPABASE_URL=https://your-project.supabase.co
//   SUPABASE_ANON_KEY=eyJ...   (anon/public key)
//
// Run:
//   npm install
//   npm start
// Open http://localhost:3000

import dotenv from "dotenv";
dotenv.config({ override: true });
import express from "express";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createClient } from "@supabase/supabase-js";
import nodemailer from "nodemailer";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ---------- Supabase ----------
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY;
const supabase = SUPABASE_URL && SUPABASE_ANON_KEY
  ? createClient(SUPABASE_URL, SUPABASE_ANON_KEY)
  : null;

// ---------- Auth middleware ----------
async function requireAuth(req, res, next) {
  const authHeader = req.headers.authorization;
  if (!authHeader?.startsWith("Bearer ")) {
    return res.status(401).json({ error: "Not authenticated" });
  }
  const token = authHeader.slice(7);
  if (!supabase) return res.status(500).json({ error: "Supabase not configured" });

  const { data, error } = await supabase.auth.getUser(token);
  if (error || !data?.user) return res.status(401).json({ error: "Invalid token" });
  req.user = data.user;
  next();
}

// ---------- Scraping helpers ----------
function extractMeta(html, url) {
  const get = (re) => { const m = html.match(re); return m ? m[1].trim() : null; };
  const getAll = (re) => { const matches = []; let m; while ((m = re.exec(html)) !== null) matches.push(m[1].trim()); return matches; };

  // Basic meta
  const description = get(/<meta[^>]+name=["']description["'][^>]+content=["']([^"']+)/i)
    || get(/<meta[^>]+property=["']og:description["'][^>]+content=["']([^"']+)/i)
    || null;

  const title = get(/<meta[^>]+property=["']og:site_name["'][^>]+content=["']([^"']+)/i)
    || get(/<title[^>]*>([^<]+)/i)
    || null;

  // Social links
  const twitter = get(/href=["']https?:\/\/(?:www\.)?(?:twitter|x)\.com\/([^"'/]+)/i);
  const linkedin = get(/href=["']https?:\/\/(?:www\.)?linkedin\.com\/company\/([^"'/]+)/i);

  // Tech stack detection
  const techStack = [];
  const techPatterns = [
    [/react/i, 'React'], [/next\.js|nextjs|_next\//i, 'Next.js'], [/vue/i, 'Vue.js'],
    [/angular/i, 'Angular'], [/svelte/i, 'Svelte'], [/tailwind/i, 'Tailwind CSS'],
    [/bootstrap/i, 'Bootstrap'], [/stripe/i, 'Stripe'], [/intercom/i, 'Intercom'],
    [/segment\.com|analytics\.js/i, 'Segment'], [/google-analytics|gtag|GA4/i, 'Google Analytics'],
    [/hotjar/i, 'Hotjar'], [/hubspot/i, 'HubSpot'], [/cloudflare/i, 'Cloudflare'],
    [/vercel/i, 'Vercel'], [/netlify/i, 'Netlify'], [/wordpress/i, 'WordPress'],
    [/shopify/i, 'Shopify'], [/webflow/i, 'Webflow'], [/framer/i, 'Framer'],
    [/supabase/i, 'Supabase'], [/firebase/i, 'Firebase'], [/amplitude/i, 'Amplitude'],
    [/mixpanel/i, 'Mixpanel'], [/sentry/i, 'Sentry'], [/datadog/i, 'Datadog'],
    [/zendesk/i, 'Zendesk'], [/drift/i, 'Drift'], [/crisp/i, 'Crisp'],
  ];
  const seen = new Set();
  for (const [re, name] of techPatterns) {
    if (re.test(html) && !seen.has(name)) { techStack.push(name); seen.add(name); }
  }

  // Features from pricing/features sections
  const features = [];
  const featurePatterns = [
    /<li[^>]*>(?:<[^>]+>)*\s*([^<]{5,80})/gi,
  ];
  const featureSection = html.match(/(?:features|what you get|included|capabilities)[^]*?<\/(?:section|div|ul)>/i);
  if (featureSection) {
    const items = featureSection[0].matchAll(/<li[^>]*>(?:<[^>]+>)*\s*([A-Z][^<]{4,60})/gi);
    for (const m of items) { if (features.length < 8) features.push(m[1].replace(/<[^>]+>/g, '').trim()); }
  }

  // Pricing detection
  let pricing = null;
  const priceMatch = html.match(/\$(\d{1,4}(?:\.\d{2})?)\s*(?:\/\s*(?:mo|month|user|seat))/i);
  if (priceMatch) pricing = '$' + priceMatch[1] + '/mo';
  else {
    const freeMatch = html.match(/free\s+(?:plan|tier|forever)/i);
    if (freeMatch) pricing = 'Free tier available';
  }

  // Try to find structured data
  let structured = {};
  const jsonLdMatch = html.match(/<script[^>]+type=["']application\/ld\+json["'][^>]*>([^<]+)/i);
  if (jsonLdMatch) {
    try { structured = JSON.parse(jsonLdMatch[1]); } catch {}
  }

  return {
    description: description?.slice(0, 300),
    title,
    twitter: twitter ? '@' + twitter : null,
    linkedin: linkedin ? '/company/' + linkedin : null,
    tech_stack: techStack.slice(0, 15),
    features: features.slice(0, 8),
    pricing,
    founded: structured.foundingDate || null,
    employees: structured.numberOfEmployees?.value
      ? String(structured.numberOfEmployees.value) : null,
    headquarters: structured.address?.addressLocality || null,
    domain_authority: null,
    traffic: null,
    funding: null,
    strengths: [],
    weaknesses: [],
  };
}

// ---------- App ----------
const app = express();
app.use(express.json({ limit: "1mb" }));
app.use(express.static(__dirname));

// Scrape competitor URL and return metadata
app.get("/api/scrape", requireAuth, async (req, res) => {
  const { url } = req.query;
  if (!url) return res.status(400).json({ error: "url parameter required" });

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10000);

    const response = await fetch(url, {
      signal: controller.signal,
      headers: {
        "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
        "Accept": "text/html,application/xhtml+xml",
        "Accept-Language": "en-US,en;q=0.9",
      },
    });
    clearTimeout(timeout);

    if (!response.ok) {
      return res.json({ error: "Could not fetch URL", status: response.status });
    }

    const html = await response.text();
    const meta = extractMeta(html, url);

    // Also try to fetch /pricing page for better pricing data
    try {
      const pricingUrl = new URL("/pricing", url).href;
      const pRes = await fetch(pricingUrl, {
        signal: AbortSignal.timeout(5000),
        headers: {
          "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36",
          "Accept": "text/html",
        },
      });
      if (pRes.ok) {
        const pHtml = await pRes.text();
        // Try to extract pricing
        const priceMatch = pHtml.match(/\$(\d{1,4}(?:\.\d{2})?)\s*(?:\/\s*(?:mo|month|user|seat))/i);
        if (priceMatch && !meta.pricing) meta.pricing = '$' + priceMatch[1] + '/mo';
        // Try to extract more features
        const pFeatures = pHtml.matchAll(/<li[^>]*>(?:<[^>]+>)*\s*([A-Z][^<]{4,60})/gi);
        for (const m of pFeatures) {
          const f = m[1].replace(/<[^>]+>/g, '').trim();
          if (meta.features.length < 8 && !meta.features.includes(f)) meta.features.push(f);
        }
      }
    } catch {}

    // Generate basic strengths/weaknesses from what we found
    if (meta.tech_stack.length > 5) meta.strengths.push('Modern, diverse tech stack');
    if (meta.tech_stack.includes('Google Analytics') || meta.tech_stack.includes('Segment')) meta.strengths.push('Strong analytics infrastructure');
    if (meta.tech_stack.includes('Intercom') || meta.tech_stack.includes('Zendesk') || meta.tech_stack.includes('Crisp')) meta.strengths.push('Dedicated customer support tooling');
    if (meta.pricing?.includes('Free')) meta.strengths.push('Free tier lowers barrier to entry');
    if (meta.features.length > 4) meta.strengths.push('Feature-rich product offering');

    if (meta.tech_stack.length < 3) meta.weaknesses.push('Limited technology footprint detected');
    if (!meta.pricing) meta.weaknesses.push('Pricing not publicly visible');
    if (!meta.twitter && !meta.linkedin) meta.weaknesses.push('Limited social media presence');
    if (meta.features.length < 2) meta.weaknesses.push('Few public-facing features found');

    res.json(meta);
  } catch (err) {
    console.error("[scrape]", err.message);
    res.json({
      error: err.message,
      description: null,
      tech_stack: [],
      features: [],
      strengths: [],
      weaknesses: [],
    });
  }
});

// ---------- Mailer (Nodemailer + Gmail SMTP) ----------
const SMTP_USER = process.env.SMTP_USER;
const SMTP_PASS = process.env.SMTP_PASS;
const NOTIFY_EMAIL = process.env.NOTIFY_EMAIL || "saqlainmirza212@gmail.com";

const transporter = SMTP_USER && SMTP_PASS
  ? nodemailer.createTransport({
      service: "gmail",
      auth: { user: SMTP_USER, pass: SMTP_PASS },
    })
  : null;

function escapeHtmlStr(s){
  return String(s ?? "").replace(/[&<>"']/g, c => ({
    "&":"&amp;","<":"&lt;",">":"&gt;","\"":"&quot;","'":"&#39;"
  }[c]));
}

function buildBookingEmail(data) {
  const rows = [
    ["Name", data.name],
    ["Company", data.company],
    ["Work email", data.email],
    ["Team size", data.teamSize],
    ["Preferred time", data.preferredTime],
    ["Message", data.message],
    ["Submitted at", new Date().toISOString()],
    ["User-Agent", data.userAgent],
  ].filter(([, v]) => v);

  const textBody = rows.map(([k, v]) => `${k}: ${v}`).join("\n");
  const htmlRows = rows.map(([k, v]) => `
    <tr>
      <td style="padding:10px 14px;border-bottom:1px solid #eee;color:#666;font-size:12px;text-transform:uppercase;letter-spacing:.04em;width:160px;vertical-align:top">${escapeHtmlStr(k)}</td>
      <td style="padding:10px 14px;border-bottom:1px solid #eee;color:#111;font-size:14px">${escapeHtmlStr(v)}</td>
    </tr>`).join("");

  const html = `<!doctype html>
<html><body style="margin:0;padding:24px;background:#f6f6f7;font-family:-apple-system,BlinkMacSystemFont,Segoe UI,Roboto,sans-serif">
  <div style="max-width:600px;margin:0 auto;background:#fff;border-radius:12px;overflow:hidden;box-shadow:0 1px 3px rgba(0,0,0,.06)">
    <div style="padding:22px 24px;background:#0f0f12;color:#fff">
      <div style="font-size:11px;letter-spacing:.12em;text-transform:uppercase;color:#D97757">Coachly</div>
      <div style="font-size:20px;font-weight:600;margin-top:4px">New demo booking 🚀</div>
    </div>
    <table style="width:100%;border-collapse:collapse">${htmlRows}</table>
    <div style="padding:16px 24px;background:#fafafa;color:#888;font-size:12px;border-top:1px solid #eee">
      Reply directly to this email to contact ${escapeHtmlStr(data.name || "the lead")}.
    </div>
  </div>
</body></html>`;

  return { text: textBody, html };
}

// ---------- AI Chat ----------
// Accepts: { agent: {name, role, tone, skills[], instructions, description}, messages: [{role, content}] }
// Returns: { reply }
// Uses Anthropic API if ANTHROPIC_API_KEY is set; otherwise returns a persona-aware templated reply.
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const ANTHROPIC_MODEL = process.env.ANTHROPIC_MODEL || "claude-3-5-haiku-latest";

function buildSystemPrompt(agent) {
  const a = agent || {};
  const skills = Array.isArray(a.skills) && a.skills.length ? a.skills.join(", ") : "general business coaching";
  const tone = a.tone || "Direct";
  const parts = [
    `You are ${a.name || "an AI business coach"}, acting as a ${a.role || "Business Coach"}.`,
    a.description ? `About you: ${a.description}` : "",
    `Your specialties: ${skills}.`,
    `Tone: ${tone}. Keep replies concise, actionable, and specific. Use short paragraphs or tight bullet lists.`,
    a.instructions ? `Custom instructions from your operator:\n${a.instructions}` : "",
    `If the user asks something outside your expertise, briefly redirect back to your specialties.`,
  ];
  return parts.filter(Boolean).join("\n\n");
}

function fallbackReply(agent, userMsg) {
  const a = agent || {};
  const name = a.name || "Coach";
  const role = a.role || "Business Coach";
  const skills = (a.skills || []).slice(0, 3).join(", ") || "growth strategy";
  const msg = (userMsg || "").toLowerCase();

  if (!userMsg) return `Hi — I'm ${name}, your ${role}. What would you like to work on?`;
  if (/\b(hi|hello|hey|yo)\b/.test(msg)) {
    return `Hey! I'm ${name}. I focus on ${skills}. What's the one thing you want to move forward today?`;
  }
  if (/price|pricing|cost|charge/.test(msg)) {
    return `On pricing: anchor to value delivered, not cost-plus. Try:\n• Talk to 5 customers; ask what they'd pay if it vanished.\n• Test 3 tiers with one clear \"most popular\" anchor.\n• Raise prices 10–20% on new customers first, measure conversion.`;
  }
  if (/growth|scale|grow/.test(msg)) {
    return `Growth comes from one compounding loop, not ten tactics. Pick one:\n• Content → SEO → signup\n• Referral → invite → signup\n• Paid → landing → trial\nWhich channel has your best unit economics today?`;
  }
  if (/marketing|ads|campaign/.test(msg)) {
    return `Before spending: who is the single highest-intent buyer, and where do they already hang out? Start with one channel, one message, one offer. Measure CAC payback before scaling.`;
  }
  if (/hire|hiring|team/.test(msg)) {
    return `Hire against the bottleneck, not the org chart. What's the one task that, if off your plate, would unlock 10+ hours/week? Hire that role first.`;
  }
  return `As your ${role}, here's how I'd frame it:\n• Clarify the goal in one sentence.\n• Identify the single biggest constraint.\n• Pick the smallest experiment that tests a fix this week.\n\nTell me more about your situation and I'll get specific. (Tip: set ANTHROPIC_API_KEY on the server for full AI replies.)`;
}

app.post("/api/chat", requireAuth, async (req, res) => {
  const { agent, messages } = req.body || {};
  if (!Array.isArray(messages) || messages.length === 0) {
    return res.status(400).json({ error: "messages array required" });
  }
  const lastUser = [...messages].reverse().find(m => m.role === "user")?.content || "";

  // No API key → persona-aware fallback
  if (!ANTHROPIC_API_KEY) {
    return res.json({ reply: fallbackReply(agent, lastUser), mode: "fallback" });
  }

  try {
    const system = buildSystemPrompt(agent);
    const apiMessages = messages
      .filter(m => m && (m.role === "user" || m.role === "assistant") && typeof m.content === "string")
      .slice(-20)
      .map(m => ({ role: m.role, content: m.content }));

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 30000);

    const r = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      signal: controller.signal,
      headers: {
        "content-type": "application/json",
        "x-api-key": ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: ANTHROPIC_MODEL,
        max_tokens: 800,
        system,
        messages: apiMessages,
      }),
    });
    clearTimeout(timeout);

    if (!r.ok) {
      const errText = await r.text();
      console.error("[chat] Anthropic error:", r.status, errText.slice(0, 200));
      return res.json({ reply: fallbackReply(agent, lastUser), mode: "fallback" });
    }

    const data = await r.json();
    const reply = (data.content || []).map(p => p.text).filter(Boolean).join("\n").trim()
      || fallbackReply(agent, lastUser);
    res.json({ reply, mode: "live" });
  } catch (err) {
    console.error("[chat]", err.message);
    res.json({ reply: fallbackReply(agent, lastUser), mode: "fallback" });
  }
});

// ---------- Demo booking ----------
// Public endpoint — anyone filling the "Book a demo" form hits this.
// Rate-limited by a simple in-memory map (per IP, 5/min).
const bookingHits = new Map();
function rateLimit(ip, limit = 5, windowMs = 60_000) {
  const now = Date.now();
  const rec = bookingHits.get(ip) || { count: 0, reset: now + windowMs };
  if (now > rec.reset) { rec.count = 0; rec.reset = now + windowMs; }
  rec.count++;
  bookingHits.set(ip, rec);
  return rec.count <= limit;
}

app.post("/api/book-demo", async (req, res) => {
  const ip = req.ip || req.headers["x-forwarded-for"] || "unknown";
  if (!rateLimit(ip)) return res.status(429).json({ error: "Too many requests — try again in a minute." });

  const { name, company, email, teamSize, preferredTime, message } = req.body || {};
  const emailRe = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

  if (!name || String(name).trim().length < 2) return res.status(400).json({ error: "Please enter your name." });
  if (!email || !emailRe.test(String(email).trim())) return res.status(400).json({ error: "Please enter a valid email." });
  if (String(name).length > 120 || String(company || "").length > 120 || String(message || "").length > 2000) {
    return res.status(400).json({ error: "Field too long." });
  }

  const payload = {
    name: String(name).trim(),
    company: String(company || "").trim(),
    email: String(email).trim(),
    teamSize: String(teamSize || "").trim(),
    preferredTime: String(preferredTime || "").trim(),
    message: String(message || "").trim(),
    userAgent: req.headers["user-agent"] || "",
  };

  if (!transporter) {
    console.warn("[book-demo] No SMTP configured. Payload:", payload);
    return res.status(500).json({ error: "Email service not configured on server." });
  }

  try {
    const { text, html } = buildBookingEmail(payload);
    await transporter.sendMail({
      from: `"Coachly Bookings" <${SMTP_USER}>`,
      to: NOTIFY_EMAIL,
      replyTo: payload.email,
      subject: `New demo booking — ${payload.name}${payload.company ? ` (${payload.company})` : ""}`,
      text,
      html,
    });
    console.log(`[book-demo] Sent to ${NOTIFY_EMAIL} for ${payload.email}`);
    res.json({ ok: true });
  } catch (err) {
    console.error("[book-demo]", err.message);
    res.status(500).json({ error: "Failed to send booking. Please try again." });
  }
});

app.get("/api/health", (_req, res) => {
  res.json({
    ok: true,
    supabaseConfigured: !!supabase,
    anthropicConfigured: !!ANTHROPIC_API_KEY,
    mailerConfigured: !!transporter,
    notifyEmail: NOTIFY_EMAIL,
  });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  if (!supabase) console.warn("⚠️  SUPABASE_URL or SUPABASE_ANON_KEY not set — auth will fail.");
  console.log(`Coachly running → http://localhost:${PORT}`);
});
