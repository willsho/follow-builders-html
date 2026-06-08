"use strict";

// ---------------------------------------------------------------------------
// Follow Builders Daily — "Broadsheet Dispatch" frontend.
// Loads latest.json + archive/index.json and renders a printed-gazette feed:
// dateline-style entries, hairline rules, edition ledger, back-issues rail.
// No API keys, no source re-fetching.
// ---------------------------------------------------------------------------

const FILTER_KEY = "fb.filter";
const LANG_KEY = "fb.lang";

// dateline tag per type — the "wire service" framing.
const TAG = { x: "Wire", podcast: "Airwave", blog: "Press" };

const state = {
  items: [], // items for the currently shown day
  filter: localStorage.getItem(FILTER_KEY) || "all",
  lang: localStorage.getItem(LANG_KEY) || "zh", // "zh" = translation, "en" = original
  date: null,
};

// ---------------------------------------------------------------------------
// small helpers
// ---------------------------------------------------------------------------

function el(tag, props = {}, children = []) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (v == null) continue;
    if (k === "class") node.className = v;
    else if (k === "text") node.textContent = v;
    else if (k === "style") node.style.cssText = v;
    else if (k.startsWith("on") && typeof v === "function") node.addEventListener(k.slice(2), v);
    else node.setAttribute(k, v);
  }
  for (const c of [].concat(children)) {
    if (c == null) continue;
    node.appendChild(typeof c === "string" ? document.createTextNode(c) : c);
  }
  return node;
}

function pad(n) {
  return String(n).padStart(2, "0");
}

function fmtDateTime(iso) {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function fmtNum(n) {
  if (n == null) return null;
  if (n >= 1000) return (n / 1000).toFixed(n >= 10000 ? 0 : 1).replace(/\.0$/, "") + "k";
  return String(n);
}

// Year → Roman numerals, for the masthead "volume" flourish.
function toRoman(num) {
  const map = [
    [1000, "M"], [900, "CM"], [500, "D"], [400, "CD"], [100, "C"],
    [90, "XC"], [50, "L"], [40, "XL"], [10, "X"], [9, "IX"],
    [5, "V"], [4, "IV"], [1, "I"],
  ];
  let out = "";
  for (const [v, sym] of map) while (num >= v) { out += sym; num -= v; }
  return out || "—";
}

// Issue number = ordinal day within the year (YYYY-MM-DD), e.g. No. 159.
function issueNo(dateStr) {
  if (!dateStr) return "—";
  const [y, m, d] = dateStr.split("-").map(Number);
  if (!y || !m || !d) return "—";
  const start = Date.UTC(y, 0, 0);
  const now = Date.UTC(y, m - 1, d);
  return String(Math.round((now - start) / 86400000));
}

async function getJson(url) {
  const res = await fetch(url, { cache: "no-cache" });
  if (!res.ok) throw new Error(`${url} -> ${res.status}`);
  return res.json();
}

// ---------------------------------------------------------------------------
// entry rendering
// ---------------------------------------------------------------------------

function renderEntry(item, idx, isLead) {
  const m = item.metadata || {};
  const zh = state.lang === "zh";
  const displayTitle = zh && item.titleZh ? item.titleZh : item.title;

  const entry = el("article", {
    class: "entry" + (isLead ? " entry--lead" : ""),
    "data-type": item.type,
    style: `--d:${Math.min(idx, 16) * 45}ms`,
  });

  // dateline: TAG · source · handle/author · time
  const dateline = el("div", { class: "dateline" }, [
    el("span", { class: "tag", text: TAG[item.type] || item.type }),
    el("span", { class: "source", text: item.sourceName || "" }),
    item.type === "x" && m.handle ? el("span", { class: "handle", text: `@${m.handle}` }) : null,
    item.type === "blog" && m.author ? el("span", { class: "handle", text: m.author }) : null,
    el("span", { class: "time", text: fmtDateTime(item.publishedAt || item.collectedAt) }),
  ]);
  entry.appendChild(dateline);

  // X bio
  if (item.type === "x" && m.bio) {
    entry.appendChild(el("p", { class: "bio", text: m.bio }));
  }

  // headline (blog/podcast) — X uses the tweet text as its body, no headline
  if (item.type !== "x") {
    entry.appendChild(
      el("h3", { class: "headline" }, [
        item.url ? el("a", { href: item.url, target: "_blank", rel: "noopener", text: displayTitle }) : displayTitle,
      ])
    );
  }

  // body — zh mode shows the translated summary (no full-text translation for
  // podcast/blog, so it isn't collapsible); otherwise show the original.
  let bodyText, clampable;
  if (item.type === "x") {
    bodyText = zh && item.summaryZh ? item.summaryZh : item.summaryText;
    clampable = false;
  } else if (zh && item.summaryZh) {
    bodyText = item.summaryZh;
    clampable = false;
  } else {
    bodyText = item.bodyText || item.summaryText;
    clampable = Boolean(item.bodyText); // podcast/blog collapse by default
  }

  let toggle = null;
  if (bodyText) {
    const body = el("div", { class: "body" + (clampable ? " is-clamped" : ""), text: bodyText });
    entry.appendChild(body);
    if (clampable) {
      toggle = el("button", {
        class: "toggle",
        text: "展开全文",
        onclick: () => {
          const open = body.classList.toggle("is-clamped");
          toggle.textContent = open ? "展开全文" : "收起全文";
        },
      });
    }
  }

  // X quote reference
  if (item.type === "x" && m.isQuote && m.quotedTweetId) {
    entry.appendChild(el("p", { class: "quote", text: `↪ 引用推文 ${m.quotedTweetId}` }));
  }

  // foot: metrics · toggle · read-original
  const foot = el("div", { class: "foot" });
  if (item.type === "x") {
    const metrics = el("div", { class: "metrics" });
    for (const [icon, val] of [["♥", m.likes], ["⇄", m.retweets], ["✦", m.replies]]) {
      const f = fmtNum(val);
      if (f != null) metrics.appendChild(el("span", {}, [`${icon} `, el("b", { text: f })]));
    }
    if (metrics.childNodes.length) foot.appendChild(metrics);
  }
  if (toggle) foot.appendChild(toggle);
  if (item.url) {
    foot.appendChild(el("a", { class: "read", href: item.url, target: "_blank", rel: "noopener", text: "原文" }));
  }
  if (foot.childNodes.length) entry.appendChild(foot);

  return entry;
}

// ---------------------------------------------------------------------------
// views
// ---------------------------------------------------------------------------

function renderFeed() {
  const feed = document.getElementById("feed");
  feed.replaceChildren();
  const items =
    state.filter === "all" ? state.items : state.items.filter((i) => i.type === state.filter);
  if (!items.length) {
    feed.appendChild(el("p", { class: "empty", text: "本期此版块暂无电讯。" }));
    return;
  }
  // the top entry of the page is the "lead" — bigger type (and, for articles,
  // a drop cap). Wire briefs that lead just read a little larger.
  const frag = document.createDocumentFragment();
  items.forEach((item, i) => frag.appendChild(renderEntry(item, i, i === 0)));
  feed.appendChild(frag);
}

function renderFilterCounts() {
  const counts = { all: state.items.length, x: 0, podcast: 0, blog: 0 };
  for (const it of state.items) if (counts[it.type] != null) counts[it.type]++;
  document.querySelectorAll(".section__count").forEach((node) => {
    node.textContent = counts[node.dataset.count] ?? 0;
  });
}

function syncFilterButtons() {
  document.querySelectorAll(".section").forEach((btn) => {
    btn.setAttribute("aria-pressed", String(btn.dataset.type === state.filter));
  });
}

function setDay(payload, date) {
  state.items = (payload.items || []).slice();
  state.date = date;

  const year = date ? Number(date.split("-")[0]) : new Date().getFullYear();
  document.getElementById("ed-vol").textContent = toRoman(year);
  document.getElementById("ed-no").textContent = "No. " + issueNo(date);
  document.getElementById("ed-date").textContent = date || "—";
  document.getElementById("ed-count").textContent = state.items.length + " 条";
  document.getElementById("ed-generated").textContent = fmtDateTime(payload.generatedAt);

  renderFilterCounts();
  renderFeed();
  document.querySelectorAll(".issue").forEach((b) => {
    b.setAttribute("aria-current", String(b.dataset.date === date));
  });
}

function renderHistory(index) {
  const list = document.getElementById("history");
  list.replaceChildren();
  for (const day of index.days || []) {
    const total = (day.counts?.x || 0) + (day.counts?.podcast || 0) + (day.counts?.blog || 0);
    const btn = el("button", { class: "issue", "data-date": day.date }, [
      el("span", { class: "issue__date", text: day.date }),
      el("span", { class: "issue__count", text: `${total} 条` }),
    ]);
    btn.addEventListener("click", () => loadDay(day));
    list.appendChild(el("li", {}, btn));
  }
}

async function loadDay(day) {
  const feed = document.getElementById("feed");
  feed.replaceChildren(el("p", { class: "empty", text: "正在付印…" }));
  try {
    const payload = await getJson(`./${day.path}`);
    setDay(payload, day.date);
  } catch (err) {
    feed.replaceChildren(el("p", { class: "empty", text: `调取失败：${err.message}` }));
  }
}

// ---------------------------------------------------------------------------
// wiring + init
// ---------------------------------------------------------------------------

function wireFilters() {
  document.querySelectorAll(".section").forEach((btn) => {
    btn.addEventListener("click", () => {
      state.filter = btn.dataset.type;
      localStorage.setItem(FILTER_KEY, state.filter);
      syncFilterButtons();
      renderFeed();
    });
  });
  syncFilterButtons();
}

function syncLangButtons() {
  document.querySelectorAll(".lang__btn").forEach((btn) => {
    btn.setAttribute("aria-pressed", String(btn.dataset.lang === state.lang));
  });
}

function wireLang() {
  document.querySelectorAll(".lang__btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      state.lang = btn.dataset.lang;
      localStorage.setItem(LANG_KEY, state.lang);
      syncLangButtons();
      renderFeed();
    });
  });
  syncLangButtons();
}

async function init() {
  wireFilters();
  wireLang();
  try {
    const [latest, index] = await Promise.all([
      getJson("./latest.json"),
      getJson("./archive/index.json").catch(() => ({ days: [] })),
    ]);
    renderHistory(index);
    setDay(latest, latest.date);
  } catch (err) {
    document.getElementById("feed").replaceChildren(
      el("p", { class: "empty", text: `无法调取本期电讯：${err.message}` })
    );
  }
}

document.addEventListener("DOMContentLoaded", init);
