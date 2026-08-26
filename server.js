const express = require("express");
const fs = require("fs");
const path = require("path");
const Anthropic = require("@anthropic-ai/sdk");

const app = express();
app.use(express.json({ limit: "1mb" }));
app.use(express.static(path.join(__dirname, "public")));

const PORT = process.env.PORT || 3000;

// ---- Load the dataset summary once at startup ----
const DATA_PATH = path.join(__dirname, "data", "data_summary.json");
let dataSummaryText = null;
try {
  const raw = fs.readFileSync(DATA_PATH, "utf-8");
  JSON.parse(raw); // validate it's well-formed before trusting it
  dataSummaryText = raw;
  console.log(`Loaded data summary (${(raw.length / 1024).toFixed(1)} KB) from ${DATA_PATH}`);
} catch (err) {
  console.error(`Could not load ${DATA_PATH}:`, err.message);
}

const SYSTEM_PROMPT = `You are a marketing analyst embedded in the Comfort Colors Creative Board, a dashboard of Meta Ads (Facebook & Instagram) creative performance data.

Answer questions about this dataset precisely and concisely, in plain language a marketer would use — not a data engineer. Always ground answers in the numbers below; never invent figures. If a question can't be answered from this data (e.g. asks about a platform, date range, or dimension not included), say so plainly instead of guessing.

Formatting: use short paragraphs or a tight bullet list. Lead with the answer, then the supporting number(s). Cite spend in $ and rates as %. When comparing creatives, name them by their actual title/name, not their ID, unless the name is missing.

Dataset (JSON):
${dataSummaryText || "{}"}`;

// ---- Chat endpoint (streams plain text chunks) ----
app.post("/api/chat", async (req, res) => {
  const { messages } = req.body || {};

  if (!Array.isArray(messages) || messages.length === 0) {
    res.status(400).json({ error: "Request body must include a non-empty `messages` array." });
    return;
  }
  if (!dataSummaryText) {
    res.status(500).json({ error: "Server has no data loaded (data/data_summary.json missing or invalid)." });
    return;
  }
  if (!process.env.ANTHROPIC_API_KEY) {
    res.status(500).json({
      error: "ANTHROPIC_API_KEY is not set on the server. Add it as an environment variable in Railway, then redeploy.",
    });
    return;
  }

  // Keep only role/content, and cap history length defensively.
  const cleanMessages = messages
    .filter((m) => m && (m.role === "user" || m.role === "assistant") && typeof m.content === "string")
    .slice(-40)
    .map((m) => ({ role: m.role, content: m.content }));

  if (cleanMessages.length === 0 || cleanMessages[0].role !== "user") {
    res.status(400).json({ error: "Message history must start with a `user` message." });
    return;
  }

  res.setHeader("Content-Type", "text/plain; charset=utf-8");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("X-Accel-Buffering", "no"); // avoid proxy buffering the stream

  const client = new Anthropic();

  try {
    const stream = client.messages.stream({
      model: "claude-opus-5",
      max_tokens: 4096,
      system: [
        { type: "text", text: SYSTEM_PROMPT, cache_control: { type: "ephemeral" } },
      ],
      messages: cleanMessages,
    });

    stream.on("text", (delta) => {
      res.write(delta);
    });

    stream.on("error", (err) => {
      console.error("Anthropic stream error:", err);
      // Best-effort: surface something to the client even mid-stream.
      try {
        res.write(`\n\n[error: ${err.message || "the model call failed"}]`);
        res.end();
      } catch (_) {}
    });

    await stream.finalMessage();
    res.end();
  } catch (err) {
    console.error("Chat request failed:", err);
    if (!res.headersSent) {
      const status = err && err.status ? err.status : 500;
      res.status(status).json({ error: err.message || "Chat request failed." });
    } else {
      try {
        res.write(`\n\n[error: ${err.message || "the model call failed"}]`);
        res.end();
      } catch (_) {}
    }
  }
});

app.get("/api/health", (req, res) => {
  res.json({
    ok: true,
    dataLoaded: !!dataSummaryText,
    apiKeyConfigured: !!process.env.ANTHROPIC_API_KEY,
  });
});

app.listen(PORT, () => {
  console.log(`Marketing insights app listening on port ${PORT}`);
});
