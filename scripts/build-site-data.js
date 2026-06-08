#!/usr/bin/env node
/*
 * build-site-data.js
 *
 * Reads the three upstream Follow Builders feeds (feed-x / feed-podcasts /
 * feed-blogs), normalizes them into a single FeedItem[] model, and writes the
 * static data the web page consumes:
 *
 *   public/latest.json                 -> newest day, ready for the homepage
 *   public/archive/YYYY-MM-DD.json     -> everything collected on that day
 *   public/archive/index.json          -> list of archived days + per-type counts
 *
 * The script never touches the upstream repo and never needs any API key: it
 * only consumes the public feed snapshots.
 *
 * Config (all optional, via env):
 *   UPSTREAM_BASE  base URL for the raw feeds
 *                  (default: https://raw.githubusercontent.com/zarazhangrui/follow-builders/main)
 *   FEED_DIR       read feed-*.json from this local dir instead of fetching
 *   PUBLIC_DIR     output dir (default: public)
 *   SITE_DATE      force the archive date as YYYY-MM-DD (default: today, UTC)
 *   SUMMARY_LEN    summaryText length in chars (default: 280)
 */

const fs = require("fs");
const path = require("path");

const UPSTREAM_BASE =
  process.env.UPSTREAM_BASE ||
  "https://raw.githubusercontent.com/zarazhangrui/follow-builders/main";
const FEED_DIR = process.env.FEED_DIR || "";
const PUBLIC_DIR = path.resolve(process.env.PUBLIC_DIR || "public");
const ARCHIVE_DIR = path.join(PUBLIC_DIR, "archive");
const SUMMARY_LEN = Number(process.env.SUMMARY_LEN || 280);

const FEEDS = ["feed-x", "feed-podcasts", "feed-blogs"];

// build-time EN -> ZH translation (title + summary only). Keys never reach the
// frontend; if no key is configured, translation is skipped and the frontend
// falls back to the original text.
const TRANSLATE_MOCK = process.env.TRANSLATE_MOCK === "1";
const DEEPSEEK_API_KEY = process.env.DEEPSEEK_API_KEY || "";
const DEEPSEEK_BASE = process.env.DEEPSEEK_BASE || "https://api.deepseek.com";
const DEEPSEEK_MODEL = process.env.DEEPSEEK_MODEL || "deepseek-v4-flash";
const TRANSLATE_ENABLED =
  process.env.TRANSLATE !== "0" && (TRANSLATE_MOCK || Boolean(DEEPSEEK_API_KEY));
const TRANSLATE_BATCH = Number(process.env.TRANSLATE_BATCH || 20);

// --------------------------------------------------------------------------
// helpers
// --------------------------------------------------------------------------

async function loadFeed(name) {
  if (FEED_DIR) {
    const file = path.join(path.resolve(FEED_DIR), `${name}.json`);
    if (!fs.existsSync(file)) {
      console.warn(`[warn] local feed missing: ${file}`);
      return null;
    }
    return JSON.parse(fs.readFileSync(file, "utf8"));
  }
  const url = `${UPSTREAM_BASE}/${name}.json`;
  const res = await fetch(url);
  if (!res.ok) {
    console.warn(`[warn] failed to fetch ${url}: ${res.status}`);
    return null;
  }
  return res.json();
}

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return fallback;
  }
}

function writeJson(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(data, null, 2) + "\n");
}

// Decode the handful of HTML entities the blog extractor leaves behind, so the
// frontend can render the text safely with textContent.
function decodeEntities(str) {
  if (!str) return "";
  return str
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(parseInt(d, 10)))
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&nbsp;/g, " ");
}

function clamp(text, len) {
  const t = (text || "").trim();
  if (t.length <= len) return t;
  return t.slice(0, len).trimEnd() + "…";
}

// Blog publishedAt arrives as a free-form date string (e.g. "May 06, 2026").
// Normalize to ISO when we can, otherwise keep null.
function toIso(value) {
  if (!value) return null;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

function sortKey(item) {
  return item.publishedAt || item.collectedAt || "";
}

// --------------------------------------------------------------------------
// translation (build-time, EN -> ZH)
// --------------------------------------------------------------------------

const TRANSLATE_SYSTEM =
  "You are a professional English-to-Chinese translator. " +
  "Translate every string in the input JSON array into natural Simplified Chinese. " +
  "Keep @handles, URLs, hashtags, inline code, product/person names and emoji unchanged. " +
  "Do not add explanations, quotes or numbering. " +
  'Return ONLY a JSON object {"t": [...]} whose array has exactly the same length and order as the input array.';

async function translateBatch(texts) {
  if (TRANSLATE_MOCK) return texts.map((t) => "〔译〕" + t);
  const res = await fetch(`${DEEPSEEK_BASE}/chat/completions`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${DEEPSEEK_API_KEY}`,
    },
    body: JSON.stringify({
      model: DEEPSEEK_MODEL,
      temperature: 0,
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content: TRANSLATE_SYSTEM },
        { role: "user", content: JSON.stringify(texts) },
      ],
    }),
  });
  if (!res.ok) throw new Error(`deepseek ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const data = await res.json();
  const content = data.choices?.[0]?.message?.content || "{}";
  const parsed = JSON.parse(content);
  const out = Array.isArray(parsed) ? parsed : parsed.t || parsed.translations;
  if (!Array.isArray(out) || out.length !== texts.length) {
    throw new Error(`unexpected shape: got ${out && out.length} for ${texts.length}`);
  }
  return out;
}

// Fill titleZh / summaryZh on items missing them. title is only translated for
// non-X items (X cards show the full tweet body, not a separate title). Items
// that already carry a translation (from a previous run's archive) are skipped,
// so each item is translated at most once.
async function translateItems(items) {
  const tasks = [];
  for (const it of items) {
    if (it.type !== "x" && it.title && it.titleZh == null) {
      tasks.push({ it, out: "titleZh", text: it.title });
    }
    if (it.summaryText && it.summaryZh == null) {
      tasks.push({ it, out: "summaryZh", text: it.summaryText });
    }
  }
  if (!tasks.length) {
    console.log("[translate] nothing new to translate");
    return;
  }
  console.log(`[translate] translating ${tasks.length} strings (batch ${TRANSLATE_BATCH})…`);
  let done = 0;
  for (let i = 0; i < tasks.length; i += TRANSLATE_BATCH) {
    const batch = tasks.slice(i, i + TRANSLATE_BATCH);
    try {
      const zh = await translateBatch(batch.map((t) => t.text));
      batch.forEach((t, j) => {
        if (zh[j]) t.it[t.out] = zh[j];
      });
      done += batch.length;
    } catch (err) {
      console.warn(`[translate] batch ${i / TRANSLATE_BATCH} failed, keeping original: ${err.message}`);
    }
  }
  console.log(`[translate] filled ${done}/${tasks.length} strings`);
}

// --------------------------------------------------------------------------
// normalization -> FeedItem[]
// --------------------------------------------------------------------------

function normalizeX(feed) {
  if (!feed || !Array.isArray(feed.x)) return [];
  const collectedAt = feed.generatedAt || new Date().toISOString();
  const items = [];
  for (const author of feed.x) {
    const sourceName = author.name || (author.handle ? `@${author.handle}` : "X");
    for (const tweet of author.tweets || []) {
      if (!tweet.id) continue;
      const text = (tweet.text || "").trim();
      items.push({
        id: `x:${tweet.id}`,
        type: "x",
        sourceName,
        title: clamp(text, 80),
        url: tweet.url || (author.handle ? `https://x.com/${author.handle}/status/${tweet.id}` : ""),
        publishedAt: toIso(tweet.createdAt),
        collectedAt,
        summaryText: text,
        metadata: {
          handle: author.handle || "",
          bio: author.bio || "",
          likes: tweet.likes ?? null,
          retweets: tweet.retweets ?? null,
          replies: tweet.replies ?? null,
          isQuote: Boolean(tweet.isQuote),
          quotedTweetId: tweet.quotedTweetId || null,
        },
      });
    }
  }
  return items;
}

function normalizePodcasts(feed) {
  if (!feed || !Array.isArray(feed.podcasts)) return [];
  const collectedAt = feed.generatedAt || new Date().toISOString();
  return feed.podcasts
    .filter((p) => p.guid)
    .map((p) => {
      const transcript = (p.transcript || "").trim();
      return {
        id: `podcast:${p.guid}`,
        type: "podcast",
        sourceName: p.name || "Podcast",
        title: p.title || "(untitled episode)",
        url: p.url || "",
        publishedAt: toIso(p.publishedAt),
        collectedAt,
        summaryText: clamp(transcript, SUMMARY_LEN),
        bodyText: transcript || undefined,
        metadata: { guid: p.guid },
      };
    });
}

function normalizeBlogs(feed) {
  if (!feed || !Array.isArray(feed.blogs)) return [];
  const collectedAt = feed.generatedAt || new Date().toISOString();
  return feed.blogs
    .filter((b) => b.url)
    .map((b) => {
      const content = decodeEntities(b.content || "");
      const description = decodeEntities(b.description || "");
      return {
        id: `blog:${b.url}`,
        type: "blog",
        sourceName: b.name || "Blog",
        title: b.title || "(untitled post)",
        url: b.url,
        publishedAt: toIso(b.publishedAt),
        collectedAt,
        summaryText: clamp(description || content, SUMMARY_LEN),
        bodyText: content || undefined,
        metadata: { author: decodeEntities(b.author || "") },
      };
    });
}

// --------------------------------------------------------------------------
// main
// --------------------------------------------------------------------------

async function main() {
  const now = new Date();
  const generatedAt = now.toISOString();
  const date = process.env.SITE_DATE || generatedAt.slice(0, 10);

  console.log(`[build] source: ${FEED_DIR ? `local:${FEED_DIR}` : UPSTREAM_BASE}`);
  console.log(`[build] date: ${date}`);

  const [xFeed, podFeed, blogFeed] = await Promise.all(FEEDS.map(loadFeed));

  const incoming = [
    ...normalizeX(xFeed),
    ...normalizePodcasts(podFeed),
    ...normalizeBlogs(blogFeed),
  ];
  console.log(
    `[build] normalized ${incoming.length} items ` +
      `(x=${incoming.filter((i) => i.type === "x").length}, ` +
      `podcast=${incoming.filter((i) => i.type === "podcast").length}, ` +
      `blog=${incoming.filter((i) => i.type === "blog").length})`
  );

  // merge with today's existing archive, deduped by stable id (existing wins).
  const dayFile = path.join(ARCHIVE_DIR, `${date}.json`);
  const existing = readJson(dayFile, { items: [] });
  const byId = new Map();
  for (const it of existing.items || []) byId.set(it.id, it);
  let added = 0;
  for (const it of incoming) {
    if (!byId.has(it.id)) {
      byId.set(it.id, it);
      added++;
    }
  }
  const items = [...byId.values()].sort((a, b) =>
    sortKey(b).localeCompare(sortKey(a))
  );
  console.log(`[build] day total ${items.length} items (+${added} new)`);

  if (TRANSLATE_ENABLED) {
    await translateItems(items);
  } else {
    console.log("[translate] skipped (no DEEPSEEK_API_KEY; set TRANSLATE_MOCK=1 to dry-run)");
  }

  const counts = { x: 0, podcast: 0, blog: 0 };
  for (const it of items) if (counts[it.type] != null) counts[it.type]++;

  // 1) day archive
  writeJson(dayFile, { date, generatedAt, items });

  // 2) latest.json -> newest day (the one we just built)
  writeJson(path.join(PUBLIC_DIR, "latest.json"), { generatedAt, date, items });

  // 3) archive/index.json
  const indexFile = path.join(ARCHIVE_DIR, "index.json");
  const index = readJson(indexFile, { days: [] });
  const days = (index.days || []).filter((d) => d.date !== date);
  days.push({ date, path: `archive/${date}.json`, counts });
  days.sort((a, b) => b.date.localeCompare(a.date));
  writeJson(indexFile, { updatedAt: generatedAt, days });

  console.log(`[build] wrote ${path.relative(process.cwd(), dayFile)}`);
  console.log(`[build] wrote ${path.relative(process.cwd(), path.join(PUBLIC_DIR, "latest.json"))}`);
  console.log(`[build] wrote ${path.relative(process.cwd(), indexFile)} (${days.length} days)`);
}

main().catch((err) => {
  console.error("[build] failed:", err);
  process.exit(1);
});
