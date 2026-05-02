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

// ─── Middleware ───────────────────────────────────────────────────────────────
const allowedOrigins = (process.env.CLIENT_ORIGIN || "http://localhost:5173")
  .split(",").map(o => o.trim());

app.use(cors({
  origin: function(origin, callback) {
    // Allow requests with no origin (e.g. curl, Postman) or matched origins
    if (!origin || allowedOrigins.includes("*") || allowedOrigins.includes(origin)) {
      callback(null, true);
    } else {
      callback(new Error("Not allowed by CORS: " + origin));
    }
  },
  methods: ["GET", "POST", "OPTIONS"],
  allowedHeaders: ["Content-Type", "Authorization"],
  credentials: false,
}));

// Handle preflight requests
app.options("*", cors());
app.use(express.json({ limit: "10mb" }));

// In-memory storage for screenshots (max 8 MB per file)
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 8 * 1024 * 1024 },
  fileFilter: (_, file, cb) => {
    if (file.mimetype.startsWith("image/")) cb(null, true);
    else cb(new Error("Only image files are accepted"));
  },
});

// Rate limiting — 20 assessments per IP per 15 minutes
const limiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many requests — please try again in a few minutes." },
});
app.use("/api/", limiter);

// ─── Assessment log (in-memory; swap for a DB in production) ─────────────────
const assessmentLog = [];

// ─── Helpers ──────────────────────────────────────────────────────────────────
function buildSystemPrompt(weights) {
  const weightDesc = Object.entries(weights)
    .map(([k, v]) => `  - ${k}: weight ${v}`)
    .join("\n");

  return `You are a senior game UI/UX specialist with deep expertise in accessibility, HUD design, menu systems, and player experience across all platforms and genres. You assess game interfaces with the rigour of a professional studio audit.

The client has configured the following category weights (1 = standard, 2 = elevated importance, 3 = critical):
${weightDesc}

Apply these weights when forming your overall score — weighted categories should disproportionately influence the overall score and your verdict.

Return ONLY valid JSON. No markdown fences. No preamble. Schema:
{
  "overallScore": <number 0-10, one decimal, weight-adjusted>,
  "accessibilityScore": <number 0-10, one decimal>,
  "playabilityScore": <number 0-10, one decimal>,
  "verdict": "<2–3 sentence sharp professional verdict that reflects the weight priorities>",
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
    "readability": "<1–2 sentence specific observation>",
    "navigation": "<1–2 sentence specific observation>",
    "feedback": "<1–2 sentence specific observation>",
    "accessibility": "<1–2 sentence specific observation>",
    "consistency": "<1–2 sentence specific observation>",
    "cognitive": "<1–2 sentence specific observation>"
  },
  "priorityRecommendations": ["<rec 1>","<rec 2>","<rec 3>","<rec 4>"]
}`;
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

    // Parse weights (sent as JSON string from FormData)
    let weights = {
      readability: 1, navigation: 1, feedback: 1,
      accessibility: 1, consistency: 1, cognitive: 1,
    };
    if (rawWeights) {
      try { weights = { ...weights, ...JSON.parse(rawWeights) }; } catch (_) {}
    }

    // Build message content
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
        gameName ? `Game: ${gameName}` : "",
        `Platform: ${platform}`,
        `Genre: ${genre}`,
        projectType ? `Project type: ${projectType}` : "",
        `Description:\n${description}`,
        req.file
          ? "Use the provided screenshot as primary evidence. Be specific about what you observe visually."
          : "Base your assessment on the description. Flag any areas where a screenshot would sharpen the analysis.",
      ].filter(Boolean).join("\n"),
    });

    // Call Anthropic
    const message = await anthropic.messages.create({
      model: "claude-opus-4-5",
      max_tokens: 1500,
      system: buildSystemPrompt(weights),
      messages: [{ role: "user", content: userContent }],
    });

    const raw = message.content.find((b) => b.type === "text")?.text || "";
    const clean = raw.replace(/```json|```/g, "").trim();
    const result = JSON.parse(clean);

    // Log assessment (no personal data stored)
    assessmentLog.push({
      timestamp: new Date().toISOString(),
      platform,
      genre,
      projectType: projectType || null,
      overallScore: result.overallScore,
      hasScreenshot: !!req.file,
    });

    res.json({ success: true, result });
  } catch (err) {
    console.error("Assessment error:", err);
    if (err.message?.includes("parse")) {
      return res.status(502).json({ error: "Model returned an unexpected format. Please try again." });
    }
    res.status(500).json({ error: "Assessment failed. Please try again." });
  }
});

// ─── GET /api/stats (internal dashboard use) ─────────────────────────────────
app.get("/api/stats", (req, res) => {
  const total = assessmentLog.length;
  const avg = total
    ? (assessmentLog.reduce((s, a) => s + a.overallScore, 0) / total).toFixed(2)
    : null;
  res.json({ total, averageScore: avg, recent: assessmentLog.slice(-10).reverse() });
});

// ─── Health check ─────────────────────────────────────────────────────────────
app.get("/api/health", (_, res) => res.json({ status: "ok" }));

app.listen(PORT, () => {
  console.log(`Dead Nice Audit Server running on port ${PORT}`);
  if (!process.env.ANTHROPIC_API_KEY) {
    console.warn("⚠  ANTHROPIC_API_KEY not set — requests will fail");
  }
});
