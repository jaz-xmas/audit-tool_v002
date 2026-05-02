require("dotenv").config();
const express = require("express");
const cors = require("cors");
const multer = require("multer");
const rateLimit = require("express-rate-limit");
const Anthropic = require("@anthropic-ai/sdk");

const app = express();
const PORT = process.env.PORT || 3001;

// ─── Anthropic client ────────────────────────────────────────────────────────
const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// ─── Trust proxy (required for Railway + rate limiting) ───────────────────────
app.set("trust proxy", 1);

// ─── CORS — allow null origin (Squarespace) and any configured origin ─────────
app.use((req, res, next) => {
  const allowedOrigins = (process.env.CLIENT_ORIGIN || "*")
    .split(",").map(o => o.trim());
  const origin = req.headers.origin;

  if (!origin || allowedOrigins.includes("*") || allowedOrigins.includes(origin)) {
    res.setHeader("Access-Control-Allow-Origin", origin || "*");
  }
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") {
    return res.sendStatus(204);
  }
  next();
});

app.use(express.json({ limit: "10mb" }));

// ─── File upload (screenshots, max 8 MB) ─────────────────────────────────────
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 8 * 1024 * 1024 },
  fileFilter: (_, file, cb) => {
    if (file.mimetype.startsWith("image/")) cb(null, true);
    else cb(new Error("Only image files are accepted"));
  },
});

// ─── Rate limiting ────────────────────────────────────────────────────────────
const limiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => req.headers["x-forwarded-for"]?.split(",")[0].trim() || req.ip,
  message: { error: "Too many requests — please try again in a few minutes." },
});
app.use("/api/", limiter);

// ─── Assessment log ───────────────────────────────────────────────────────────
const assessmentLog = [];

// ─── System prompt builder ────────────────────────────────────────────────────
function buildSystemPrompt(weights) {
  const weightDesc = Object.entries(weights)
    .map(([k, v]) => `  - ${k}: weight ${v}`)
    .join("\n");

  return `You are a senior game UI/UX specialist with deep expertise in accessibility, HUD design, menu systems, and player experience across all platforms and genres. You assess game interfaces with the rigour of a professional studio audit.

The client has configured the following category weights (1 = standard, 2 = elevated importance, 3 = critical):
${weightDesc}

Apply these weights when forming your overall score — weighted categories should disproportionately influence the overall score and your verdict.

Return ONLY a single valid JSON object. No markdown fences. No preamble. No text after the closing brace. Schema:
{
  "overallScore": <number 0-10, one decimal, weight-adjusted>,
  "accessibilityScore": <number 0-10, one decimal>,
  "playabilityScore": <number 0-10, one decimal>,
  "verdict": "<2-3 sentence sharp professional verdict>",
  "topStrengths": ["<strength 1>","<strength 2>","<strength 3>"],
  "criticalIssues": ["<issue 1>","<issue 2>","<issue 3>"],
  "scores": {
    "readability": <0-10>,
    "navigation": <0-10>,
    "feedback": <0-10>,
    "accessibility": <0-10>,
    "consistency": <0-10>,
    "cognitive": <0-10>
  },
  "notes": {
    "readability": "<1-2 sentence specific observation>",
    "navigation": "<1-2 sentence specific observation>",
    "feedback": "<1-2 sentence specific observation>",
    "accessibility": "<1-2 sentence specific observation>",
    "consistency": "<1-2 sentence specific observation>",
    "cognitive": "<1-2 sentence specific observation>"
  },
  "priorityRecommendations": ["<rec 1>","<rec 2>","<rec 3>","<rec 4>"]
}`;
}

// ─── Extract JSON robustly from model response ────────────────────────────────
function extractJSON(text) {
  let clean = text.replace(/```json\s*/gi, "").replace(/```\s*/g, "").trim();
  const start = clean.indexOf("{");
  const end   = clean.lastIndexOf("}");
  if (start === -1 || end === -1) throw new Error("No JSON object found in response");
  return JSON.parse(clean.slice(start, end + 1));
}

// ─── POST /api/assess ─────────────────────────────────────────────────────────
app.post("/api/assess", upload.single("screenshot"), async (req, res) => {
  try {
    const { platform, genre, description, weights: rawWeights, projectType, gameName } = req.body;

    if (!platform || !genre || !description) {
      return res.status(400).json({ error: "platform, genre, and description are required." });
    }
    if (description.trim().length < 20) {
      return res.status(400).json({ error: "Description must be at least 20 characters." });
    }

    let weights = {
      readability: 1, navigation: 1, feedback: 1,
      accessibility: 1, consistency: 1, cognitive: 1,
    };
    if (rawWeights) {
      try { weights = { ...weights, ...JSON.parse(rawWeights) }; } catch (_) {}
    }

    const userContent = [];

    if (req.file) {
      const base64 = req.file.buffer.toString("base64");
      userContent.push({
        type: "image",
        source: { type: "base64", media_type: req.file.mimetype, data: base64 },
      });
    }

    userContent.push({
      type: "text",
      text: [
        gameName    ? `Game: ${gameName}`            : "",
        `Platform: ${platform}`,
        `Genre: ${genre}`,
        projectType ? `Project type: ${projectType}` : "",
        `Description:\n${description}`,
        req.file
          ? "Use the provided screenshot as primary evidence. Be specific about what you observe visually."
          : "Base your assessment on the description. Flag any areas where a screenshot would sharpen the analysis.",
      ].filter(Boolean).join("\n"),
    });

    const message = await anthropic.messages.create({
      model: "claude-opus-4-5",
      max_tokens: 1500,
      system: buildSystemPrompt(weights),
      messages: [{ role: "user", content: userContent }],
    });

    const raw = message.content.find((b) => b.type === "text")?.text || "";
    const result = extractJSON(raw);

    assessmentLog.push({
      timestamp: new Date().toISOString(),
      platform, genre,
      projectType: projectType || null,
      overallScore: result.overallScore,
      hasScreenshot: !!req.file,
    });

    res.json({ success: true, result });
  } catch (err) {
    console.error("Assessment error:", err.message);
    res.status(500).json({ error: "Assessment failed. Please try again." });
  }
});

// ─── GET /api/stats ───────────────────────────────────────────────────────────
app.get("/api/stats", (req, res) => {
  const total = assessmentLog.length;
  const avg = total
    ? (assessmentLog.reduce((s, a) => s + a.overallScore, 0) / total).toFixed(2)
    : null;
  res.json({ total, averageScore: avg, recent: assessmentLog.slice(-10).reverse() });
});

// ─── Health check ─────────────────────────────────────────────────────────────
app.get("/api/health", (_, res) => res.json({ status: "ok" }));

app.listen(PORT, "0.0.0.0", () => {
  console.log(`Dead Nice Audit Server running on port ${PORT}`);
  if (!process.env.ANTHROPIC_API_KEY) {
    console.warn("WARNING: ANTHROPIC_API_KEY not set — requests will fail");
  }
});
