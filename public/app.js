"use strict";

// ---------------------------------------------------------------------------
// Follow Builders Daily — static frontend.
// Loads latest.json + archive/index.json, renders a filterable, dense feed,
// and lets you jump to any archived day. No API keys, no source re-fetching.
// ---------------------------------------------------------------------------

const FILTER_KEY = "fb.filter";
const LANG_KEY = "fb.lang";
const TYPE_LABELS = { x: "X", podcast: "PODCAST", blog: "BLOG" };

const state = {
  items: [], // items for the currently shown day
  filter: localStorage.getItem(FILTER_KEY) || "all",
  lang: localStorage.getItem(LANG_KEY) || "zh", // "zh" shows translation, "en" original
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

async function getJson(url) {
  const res = await fetch(url, { cache: "no-cache" });
  if (!res.ok) throw new Error(`${url} -> ${res.status}`);
  return res.json();
}

// ---------------------------------------------------------------------------
// card rendering
// ---------------------------------------------------------------------------

function renderCard(item) {
  const m = item.metadata || {};
  const zh = state.lang === "zh";
  const displayTitle = zh && item.titleZh ? item.titleZh : item.title;
  const card = el("article", { class: "card", "data-type": item.type });

  // head: badge · source · handle · time
  const head = el("div", { class: "card__head" }, [
    el("span", { class: "badge", text: TYPE_LABELS[item.type] || item.type }),
    el("span", { class: "card__source", text: item.sourceName || "" }),
    item.type === "x" && m.handle ? el("span", { class: "card__handle", text: `@${m.handle}` }) : null,
    item.type === "blog" && m.author ? el("span", { class: "card__handle", text: m.author }) : null,
    el("span", { class: "card__time", text: fmtDateTime(item.publishedAt || item.collectedAt) }),
  ]);
  card.appendChild(head);

  // X: bio line
  if (item.type === "x" && m.bio) {
    card.appendChild(el("p", { class: "bio", text: m.bio }));
  }

  // title (link to original) — skip for X where the tweet text is the body
  if (item.type !== "x") {
    card.appendChild(
      el("h3", { class: "card__title" }, [
        item.url ? el("a", { href: item.url, target: "_blank", rel: "noopener", text: displayTitle }) : displayTitle,
      ])
    );
  }

  // body — in zh mode show the translated summary (no full-text translation for
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
  if (bodyText) {
    const body = el("div", { class: "card__body" + (clampable ? " is-clamped" : ""), text: bodyText });
    card.appendChild(body);
    if (clampable) {
      const toggle = el("button", {
        class: "toggle",
        text: "展开全文",
        onclick: () => {
          const open = body.classList.toggle("is-clamped");
          toggle.textContent = open ? "展开全文" : "收起";
        },
      });
      card._toggle = toggle; // attached to foot below
    }
  }

  // X quote reference
  if (item.type === "x" && m.isQuote && m.quotedTweetId) {
    card.appendChild(el("p", { class: "quote", text: `↪ 引用推文 ${m.quotedTweetId}` }));
  }

  // foot: metrics / expand / link
  const foot = el("div", { class: "card__foot" });
  if (item.type === "x") {
    const metrics = el("div", { class: "metrics" });
    const parts = [
      ["♥", m.likes],
      ["⟲", m.retweets],
      ["💬", m.replies],
    ];
    for (const [icon, val] of parts) {
      const f = fmtNum(val);
      if (f != null) metrics.appendChild(el("span", {}, [`${icon} `, el("b", { text: f })]));
    }
    if (metrics.childNodes.length) foot.appendChild(metrics);
  }
  if (card._toggle) foot.appendChild(card._toggle);
  if (item.url) {
    foot.appendChild(el("a", { class: "link-out", href: item.url, target: "_blank", rel: "noopener", text: "原文 ↗" }));
  }
  if (foot.childNodes.length) card.appendChild(foot);

  return card;
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
    feed.appendChild(el("p", { class: "empty", text: "这一天没有该类型的内容。" }));
    return;
  }
  const frag = document.createDocumentFragment();
  for (const item of items) frag.appendChild(renderCard(item));
  feed.appendChild(frag);
}

function renderFilterCounts() {
  const counts = { all: state.items.length, x: 0, podcast: 0, blog: 0 };
  for (const it of state.items) if (counts[it.type] != null) counts[it.type]++;
  document.querySelectorAll(".filter__count").forEach((node) => {
    node.textContent = counts[node.dataset.count] ?? 0;
  });
}

function syncFilterButtons() {
  document.querySelectorAll(".filter").forEach((btn) => {
    btn.setAttribute("aria-pressed", String(btn.dataset.type === state.filter));
  });
}

function setDay(payload, date) {
  state.items = (payload.items || []).slice();
  state.date = date;
  document.getElementById("stat-date").textContent = date || "—";
  document.getElementById("stat-count").textContent = state.items.length;
  document.getElementById("stat-generated").textContent = fmtDateTime(payload.generatedAt);
  renderFilterCounts();
  renderFeed();
  document.querySelectorAll(".history__item").forEach((b) => {
    b.setAttribute("aria-current", String(b.dataset.date === date));
  });
}

function renderHistory(index) {
  const list = document.getElementById("history");
  list.replaceChildren();
  for (const day of index.days || []) {
    const total = (day.counts?.x || 0) + (day.counts?.podcast || 0) + (day.counts?.blog || 0);
    const btn = el("button", { class: "history__item", "data-date": day.date }, [
      el("span", { class: "history__date", text: day.date }),
      el("span", { class: "history__count", text: `${total}` }),
    ]);
    btn.addEventListener("click", () => loadDay(day));
    list.appendChild(el("li", {}, btn));
  }
}

async function loadDay(day) {
  const feed = document.getElementById("feed");
  feed.replaceChildren(el("p", { class: "empty", text: "加载中…" }));
  try {
    const payload = await getJson(`./${day.path}`);
    setDay(payload, day.date);
  } catch (err) {
    feed.replaceChildren(el("p", { class: "empty", text: `加载失败：${err.message}` }));
  }
}

// ---------------------------------------------------------------------------
// init
// ---------------------------------------------------------------------------

function wireFilters() {
  document.querySelectorAll(".filter").forEach((btn) => {
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
      el("p", { class: "empty", text: `无法加载数据：${err.message}` })
    );
  }
}

document.addEventListener("DOMContentLoaded", init);
