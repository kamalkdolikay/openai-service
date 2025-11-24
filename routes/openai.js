import express from "express";
import OpenAI from "openai";
import { WebSocketServer } from "ws";
import dotenv from "dotenv";
import { XMLParser } from "fast-xml-parser";

dotenv.config();

const router = express.Router();
const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

const parser = new XMLParser();

// WebSocket setup
let wss = null;
if (!global.openaiWss) {
  global.openaiWss = new WebSocketServer({ port: 8080 });
  console.log("WebSocket server started → ws://localhost:8080");
}
wss = global.openaiWss;

wss.broadcast = (data) => {
  wss.clients.forEach((client) => {
    if (client.readyState === client.OPEN) {
      client.send(JSON.stringify(data));
    }
  });
};

// --- Fire-And-Forget (update db from go service) ---
function logActivity(userId, prompt, topic, lang, type) {
  if (!userId) return;

  fetch("https://go-auth-service-seven.vercel.app/api/events/activity-logged", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      user_id: userId,
      prompt: prompt?.slice(0, 1000) || "",
      topic_detected: topic || "unknown",
      target_language: lang || "en",
      request_type: type
    }),
    keepalive: true,
    timeout: 1500
  }).catch(() => {
    // Silent fail — never crash the user experience
  });
}

// --- Fetch google news ---
async function fetchGoogleNews(query, langCode, countryCode) {
  try {
    const lang = langCode || 'en';
    const country = countryCode || 'US';
    const ceid = `${country}:${lang}`;
    const url = `https://news.google.com/rss/search?q=${encodeURIComponent(query)}&hl=${lang}-${country}&gl=${country}&ceid=${ceid}`;

    const response = await fetch(url);
    const xmlText = await response.text();
    const jsonObj = parser.parse(xmlText);

    if (!jsonObj.rss?.channel?.item) return [];

    let items = jsonObj.rss.channel.item;
    if (!Array.isArray(items)) items = [items];

    return items.slice(0, 5).map(item => ({
      title: item.title,
      link: item.link,
      pubDate: item.pubDate,
      source: item.source ? (typeof item.source === 'object' ? item.source['#text'] : item.source) : "Google News"
    }));
  } catch (e) {
    console.error("RSS Fetch Error:", e);
    return [];
  }
}

// --- Process text and fetch news ---
async function processNewsRequest(textInput, detectedLang = 'en', res, userId = null) {
  let context = null;

  try {
    // 1. Analyze intent
    const analysis = await openai.chat.completions.create({
    model: "gpt-4o-mini",
    temperature: 0,
    response_format: { type: "json_object" },
    messages: [
      {
        role: "system",
        content: `You are a news topic detector. 
          The user wrote a query in a certain language and wants news about that topic.
          Detect:
          - The main topic (keep it in the ORIGINAL language unless the user explicitly asks for translation)
          - The ISO-2 language code of the ORIGINAL query (never guess a different language)
          - The most likely ISO-2 country the user is interested in (default to US if unclear)
          - A nice header title in the ORIGINAL language

          Return ONLY valid JSON with these exact keys:
          {
            "topic_translated": "the topic exactly as user wrote it, or minor cleanup",
            "language": "original query language (en, fr, es, de, etc.)",
            "country": "most relevant country (US default)",
            "headerTitle": "nice header in original language"
          }`
        },
        {
          role: "user",
          content: `Query: "${textInput}"`
        }
      ]
    });

    context = JSON.parse(analysis.choices[0].message.content);
    console.log("Context:", context);

    // 2. Fetch news
    const newsItems = await fetchGoogleNews(context.topic_translated, context.language, context.country);

    let news = [];
    if (newsItems.length === 0) {
      news = [{
        title: "No recent news found",
        summary: `No news for "${context.topic_translated}" in ${context.country} right now.`,
        source: "System",
        time: new Date().toISOString(),
        link: "#"
      }];
    } else {
      news = await Promise.all(newsItems.map(async (item) => {
        const summary = await openai.chat.completions.create({
          model: "gpt-4o-mini",
          messages: [
            { role: "system", content: `Summarize in 1 punchy sentence in ${context.language}.` },
            { role: "user", content: item.title }
          ],
          max_tokens: 60
        });
        return {
          title: item.title,
          summary: summary.choices[0].message.content,
          source: item.source,
          time: item.pubDate,
          link: item.link
        };
      }));
    }

    // 4. Send response (Removed header_image field)
    res.json({
      success: true,
      user_text: textInput,
      topic_data: context,
      news,
      header_image: "" // Empty string placeholder to prevent frontend error
    });

    // 5. Log After Response — never blocks user
    if (userId) {
      logActivity(userId, textInput, context.headerTitle, context.language, detectedLang === "auto" ? "text" : "voice");
    }

  } catch (error) {
    console.error("Processing Error:", error);
    // Only send error if headers not sent yet
    if (!res.headersSent) {
      res.status(500).json({ error: error.message });
    }
  }
}

// --- Audio request ---
router.post("/news-voice", async (req, res) => {
  try {
    const { audio: base64Audio } = req.body;
    if (!base64Audio) return res.status(400).json({ error: "Missing audio" });

    const audioBuffer = Buffer.from(base64Audio, "base64");
    const { toFile } = await import("openai");
    const audioFile = await toFile(audioBuffer, "recording.webm", { type: "audio/webm" });

    const transcription = await openai.audio.transcriptions.create({
      file: audioFile,
      model: "whisper-1",
      response_format: "verbose_json",
    });

    await processNewsRequest(
      transcription.text,
      transcription.language,
      res,
      req.user.id
    );

  } catch (error) {
    if (!res.headersSent) {
      res.status(500).json({ error: error.message });
    }
  }
});

// --- Text request ---
router.post("/news-text", async (req, res) => {
  try {
    const { text } = req.body;
    if (!text) return res.status(400).json({ error: "Missing text" });

    await processNewsRequest(text, "auto", res, req.user.id);

  } catch (error) {
    if (!res.headersSent) {
      res.status(500).json({ error: error.message });
    }
  }
});

export default router;