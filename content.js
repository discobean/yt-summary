// YT Hover Summary — Copyright (C) 2026 discobean (github.com/discobean)
// Licensed under the GNU AGPL v3.0 or later; see the LICENSE file.
//
// Content script.
// Runs on youtube.com: injects the hover badge on thumbnails, fetches the
// transcript (same-origin, so the user's YouTube cookies apply), and renders
// the result card. The Anthropic API call lives in background.js so the API
// key never enters the page context.

const BADGE_CLASS = "yts-badge";
const CARD_ID = "yts-card";
// ~40k tokens; caps cost on multi-hour videos.
const TRANSCRIPT_CHAR_LIMIT = 150000;

// Hosts that get a badge: classic thumbnails (<ytd-thumbnail>), the newer
// lockup markup (<yt-thumbnail-view-model>), and YouTube's inline hover
// preview overlay — the preview covers the thumbnail once playback starts,
// so it needs its own badge or ours vanishes mid-hover.
const HOST_SELECTOR =
  "ytd-thumbnail, yt-thumbnail-view-model, ytd-video-preview, #video-preview";

// The preview overlay can't always tell us which video it's showing (its
// media link's href is often empty), so remember the last video id resolved
// from a hovered tile — the preview always belongs to that tile.
let lastHoveredVideoId = null;

document.addEventListener("mouseover", (e) => {
  const host = e.target.closest?.(HOST_SELECTOR);
  if (!host) return;
  const id = findVideoId(host);
  if (id) lastHoveredVideoId = id;
  ensureBadge(host);
});

// Badges are injected proactively — not just on hover — so they're visible
// at rest. The throttled sweep covers YouTube's constant DOM churn: initial
// load, infinite-scroll additions, and the hover preview (which mounts under
// a stationary cursor, firing no mouse events at all).
let sweepQueued = false;
new MutationObserver(() => {
  if (sweepQueued) return;
  sweepQueued = true;
  setTimeout(() => {
    sweepQueued = false;
    sweepBadges();
  }, 250);
}).observe(document.documentElement, { childList: true, subtree: true });
sweepBadges();

function sweepBadges() {
  const preview = document.querySelector("ytd-video-preview, #video-preview");
  if (preview) ensureBadge(preview);
  for (const thumb of document.querySelectorAll("ytd-thumbnail, yt-thumbnail-view-model")) {
    ensureBadge(thumb);
  }
}

function ensureBadge(host) {
  const previewWrap = host.closest("#video-preview");
  // In the preview, both the wrapper and its media link report zero-height
  // boxes (measured live) — #media-container is the element whose box
  // actually matches the video.
  const attach = previewWrap
    ? previewWrap.querySelector("#media-container")
    : host;
  if (!attach || attach.querySelector(`:scope > .${BADGE_CLASS}`)) return;
  // Tiles must resolve a video id up front; the preview often can't (empty
  // media-link href), so its badge resolves the id at click time instead.
  if (!previewWrap && !findVideoId(host)) return;

  const badge = document.createElement("button");
  badge.className = BADGE_CLASS;
  badge.textContent = "✨";
  badge.title = "Answer the question this video teases";
  badge.addEventListener("click", (ev) => {
    ev.preventDefault(); // don't navigate to the video
    ev.stopPropagation(); // don't trigger YouTube's SPA router
    const videoId =
      findVideoId(host) || (previewWrap ? lastHoveredVideoId : null);
    if (videoId) summarize(videoId, badge);
  });
  badge.addEventListener("mousedown", (ev) => ev.stopPropagation());
  attach.appendChild(badge);
}

function findVideoId(host) {
  // Ad tiles carry video ids too, but summarizing ads is noise — skip them.
  if (host.closest("ytd-ad-slot-renderer, ytd-in-feed-ad-layout-renderer")) return null;
  const anchor =
    host.closest('a[href*="watch?v="]') ||
    host.querySelector('a[href*="watch?v="]');
  if (anchor) return new URL(anchor.href, location.origin).searchParams.get("v");
  // Newer lockup markup (search results) has no watch link on the tile —
  // the video id rides on a content-id-<id> wrapper class instead.
  const tagged =
    host.closest('[class*="content-id-"]') ||
    host.querySelector('[class*="content-id-"]');
  const cls = tagged && [...tagged.classList].find((c) => c.startsWith("content-id-"));
  const id = cls && cls.slice("content-id-".length);
  return id && /^[\w-]{11}$/.test(id) ? id : null;
}

async function summarize(videoId, badge) {
  const card = showCard(cardAnchorRect(badge));
  setCard(card, { state: "loading", text: "Fetching video info…" });
  try {
    const meta = await fetchOembed(videoId);
    setCard(card, { state: "loading", title: meta.title, text: "Fetching transcript…" });
    const { transcript, description } = await fetchTranscript(videoId);
    setCard(card, { state: "loading", title: meta.title, text: "Asking the model…" });

    const res = await chrome.runtime.sendMessage({
      type: "summarize",
      videoId,
      title: meta.title,
      author: meta.author_name,
      thumbnailUrl: await bestThumbnailUrl(videoId),
      transcript,
      description,
      language: navigator.language || "en",
    });

    if (!res) throw new Error("No response from the background worker.");
    if (!res.ok) {
      if (res.error === "no-key") {
        setCard(card, {
          state: "error",
          title: meta.title,
          text: "No API key configured yet.",
          showOptionsLink: true,
        });
        return;
      }
      throw new Error(res.error);
    }
    // Once the result is back, show the title in the user's language too.
    setCard(card, { state: "done", title: res.titleTranslated || meta.title, result: res });
  } catch (err) {
    const msg = err?.message || String(err);
    setCard(card, {
      state: "error",
      // Thrown by the orphaned content script after the extension is
      // reloaded/updated while this tab stayed open.
      text: /Extension context invalidated/i.test(msg)
        ? "The extension was updated — refresh this YouTube tab and try again."
        : msg,
    });
  }
}

// --- YouTube data ---------------------------------------------------------

// Prefer the full-res thumbnail (1280x720) so the model can read the overlay
// text — that text is the primary signal. maxresdefault doesn't exist for
// every video, so probe it and fall back to hqdefault (480x360).
function bestThumbnailUrl(videoId) {
  return new Promise((resolve) => {
    const maxres = `https://i.ytimg.com/vi/${videoId}/maxresdefault.jpg`;
    const fallback = `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`;
    const img = new Image();
    // Guard naturalWidth: some videos serve a tiny placeholder instead of 404.
    img.onload = () => resolve(img.naturalWidth > 320 ? maxres : fallback);
    img.onerror = () => resolve(fallback);
    img.src = maxres;
  });
}

// oEmbed gives us a reliable title + channel name without scraping the DOM,
// which YouTube reshuffles regularly.
async function fetchOembed(videoId) {
  const url =
    "https://www.youtube.com/oembed?format=json&url=" +
    encodeURIComponent(`https://www.youtube.com/watch?v=${videoId}`);
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Could not fetch video info (HTTP ${res.status}).`);
  return res.json();
}

// There is no official public transcript API. Primary route: ask the
// InnerTube player endpoint as the Android client — its caption URLs are
// served without the proof-of-origin token that now blocks the web ones.
// Fallback: the caption URL embedded in the watch page HTML.
async function fetchTranscript(videoId) {
  let result = await transcriptFromAndroidPlayer(videoId);
  if (!result.text) {
    const fallback = await transcriptFromWatchPage(videoId);
    result = {
      text: fallback.text,
      description: fallback.description || result.description,
    };
  }
  if (!result.text) {
    throw new Error(
      "Couldn't get a transcript for this video (it has no captions, or YouTube blocked the caption download)."
    );
  }
  return {
    transcript:
      result.text.length > TRANSCRIPT_CHAR_LIMIT
        ? result.text.slice(0, TRANSCRIPT_CHAR_LIMIT)
        : result.text,
    // Sponsorship disclosures ("X sent me this…") usually sit at the top of
    // the description, so the start of it is enough.
    description: (result.description || "").slice(0, 1500),
  };
}

// Route 1: InnerTube player, posing as the Android app.
async function transcriptFromAndroidPlayer(videoId) {
  const empty = { text: "", description: "" };
  const res = await fetch("https://www.youtube.com/youtubei/v1/player", {
    method: "POST",
    credentials: "omit", // anonymous, like the app; also avoids tying the call to the user's account
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      videoId,
      context: {
        client: {
          clientName: "ANDROID",
          // Hardcoded app version — bump if YouTube ever retires it and this
          // route starts returning errors or no captions.
          clientVersion: "20.10.38",
          androidSdkVersion: 30,
          hl: "en",
        },
      },
    }),
  });
  if (!res.ok) return empty;
  const data = await res.json().catch(() => null);
  const description = data?.videoDetails?.shortDescription || "";
  if (data?.playabilityStatus?.status && data.playabilityStatus.status !== "OK")
    return { text: "", description };
  const tracks = data?.captions?.playerCaptionsTracklistRenderer?.captionTracks;
  if (!tracks?.length) return { text: "", description };
  return { text: await fetchTrackJson3(pickTrack(tracks)), description };
}

// Route 2 (fallback): caption track list from the watch page HTML. YouTube
// increasingly gates these URLs (HTTP 200 with an empty body), so this only
// matters if the Android route stops working.
async function transcriptFromWatchPage(videoId) {
  const empty = { text: "", description: "" };
  const res = await fetch(`https://www.youtube.com/watch?v=${videoId}`, {
    credentials: "same-origin",
  });
  if (!res.ok) return empty;
  const html = await res.text();
  const player = extractJsonAfter(html, "ytInitialPlayerResponse = ");
  const description = player?.videoDetails?.shortDescription || "";
  const tracks = player?.captions?.playerCaptionsTracklistRenderer?.captionTracks;
  if (!tracks?.length) return { text: "", description };
  return { text: await fetchTrackJson3(pickTrack(tracks)), description };
}

// Fetches a caption track as json3 and flattens it to plain text. Returns ""
// on any failure — including the gated empty-200 response — so callers can
// fall through to the next route.
async function fetchTrackJson3(track) {
  const url = new URL(track.baseUrl, "https://www.youtube.com");
  url.searchParams.set("fmt", "json3");
  const res = await fetch(url, { credentials: "omit" });
  if (!res.ok) return "";
  const raw = await res.text();
  if (!raw) return "";
  let data;
  try {
    data = JSON.parse(raw);
  } catch {
    return "";
  }
  return (data.events || [])
    .flatMap((ev) => ev.segs || [])
    .map((seg) => seg.utf8)
    .join("")
    .replace(/\s+/g, " ")
    .trim();
}

// Prefer human-made captions over auto-generated (asr), English over other
// languages, but take whatever exists.
function pickTrack(tracks) {
  const manual = tracks.filter((t) => t.kind !== "asr");
  const english = (list) => list.find((t) => t.languageCode?.startsWith("en"));
  return english(manual) || manual[0] || english(tracks) || tracks[0];
}

// Parses the JSON object literal that follows `marker` in the page source.
// Brace-counting is required because the object contains braces inside strings.
function extractJsonAfter(html, marker) {
  const at = html.indexOf(marker);
  if (at === -1) return null;
  const start = html.indexOf("{", at);
  if (start === -1) return null;

  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < html.length; i++) {
    const ch = html[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inString = false;
    } else if (ch === '"') {
      inString = true;
    } else if (ch === "{") {
      depth++;
    } else if (ch === "}") {
      depth--;
      if (depth === 0) {
        try {
          return JSON.parse(html.slice(start, i + 1));
        } catch {
          return null;
        }
      }
    }
  }
  return null;
}

// --- Result card ----------------------------------------------------------

// The card docks under the video, at the video's width. Candidate anchors in
// priority order: the open preview's media link, the preview host, the video
// tile, the bare thumbnail. Boxes are measured and collapsed/hidden ones
// skipped — several YouTube containers report degenerate rects because their
// contents are positioned out of flow.
function cardAnchorRect(badge) {
  // Card docks under whatever the badge belongs to: the preview's media box
  // when the badge lives in the preview, the video tile otherwise.
  const previewWrap = badge.closest("#video-preview");
  const candidates = previewWrap
    ? [
        previewWrap.querySelector("#media-container"),
        previewWrap.querySelector("ytd-video-preview"),
      ]
    : [
        badge.closest(
          "ytd-rich-item-renderer, ytd-video-renderer, ytd-compact-video-renderer, ytd-grid-video-renderer, yt-lockup-view-model"
        ),
        badge.closest("ytd-thumbnail, yt-thumbnail-view-model"),
      ];
  for (const el of candidates) {
    if (!el) continue;
    const r = el.getBoundingClientRect();
    if (r.width >= 120 && r.height >= 60) return r;
  }
  return badge.getBoundingClientRect();
}

function showCard(rect) {
  document.getElementById(CARD_ID)?.remove();
  const card = document.createElement("div");
  card.id = CARD_ID;
  // Absolute document coordinates so the card scrolls with the page.
  card.style.left = `${rect.left + window.scrollX}px`;
  card.style.top = `${rect.bottom + window.scrollY + 8}px`;
  card.style.width = `${rect.width}px`;
  document.body.appendChild(card);
  return card;
}

function setCard(card, { state, title, text, result, showOptionsLink }) {
  card.textContent = "";

  const header = document.createElement("div");
  header.className = "yts-card-header";
  const heading = document.createElement("span");
  heading.className = "yts-card-title";
  heading.textContent = title || "Summary";
  heading.title = title || "";
  header.append(heading);
  // Paid/gifted/loaner disclosure tag sits next to the close button so it's
  // impossible to miss.
  if (state === "done" && result?.disclosure) {
    header.append(buildDisclosureTag(result.disclosure));
  }
  const close = document.createElement("button");
  close.className = "yts-card-close";
  close.textContent = "✕";
  close.addEventListener("click", () => card.remove());
  header.append(close);

  const body = document.createElement("div");
  body.className = `yts-card-body yts-${state}`;
  // Only this element scrolls — the header, tab bar, and usage footer stay put.
  const scroll = document.createElement("div");
  scroll.className = "yts-card-scroll";
  if (state === "loading") {
    const spinner = document.createElement("span");
    spinner.className = "yts-spinner";
    scroll.append(spinner, document.createTextNode(` ${text}`));
    body.append(scroll);
  } else if (state === "done") {
    // Summary panel: the question the thumbnail/title poses (when there is
    // one), the very short answer, detail lines, follow-up chips.
    const summary = document.createElement("div");
    if (result.question) {
      const q = document.createElement("p");
      q.className = "yts-question";
      q.textContent = result.question;
      summary.append(q);
    }
    const lead = document.createElement("p");
    lead.className = "yts-answer";
    lead.textContent = result.answer;
    summary.append(lead);
    for (const line of result.details || []) {
      const p = document.createElement("p");
      p.textContent = line;
      summary.append(p);
    }
    if (result.followups?.length) {
      summary.append(buildFollowups(result.followups));
    }

    // Extra tabs by video type: Review for versus/ranking videos,
    // Ingredients + Steps for recipes (mutually exclusive with Review).
    const tabPanels = [["Summary", summary]];
    const review = result.comparison
      ? buildComparison(result.comparison)
      : result.ranking
        ? buildRanking(result.ranking)
        : null;
    if (review) tabPanels.push(["Review", review]);
    if (result.recipe) {
      tabPanels.push(["Ingredients", buildIngredients(result.recipe)]);
      tabPanels.push(["Steps", buildSteps(result.recipe)]);
    }
    if (tabPanels.length > 1) {
      const panels = tabPanels.map(([, p]) => p);
      body.append(buildTabs(tabPanels.map(([l]) => l), panels));
      scroll.append(...panels);
    } else {
      scroll.append(summary);
    }
    body.append(scroll);
    if (result.usage) {
      body.append(buildUsageLine(result.usage, result.cached));
    }
  } else {
    const p = document.createElement("p");
    p.textContent = text;
    scroll.append(p);
    body.append(scroll);
  }
  card.append(header, body);

  if (showOptionsLink) {
    const link = document.createElement("button");
    link.className = "yts-options-link";
    link.textContent = "Open settings to add your API key";
    link.addEventListener("click", () =>
      chrome.runtime.sendMessage({ type: "open-options" })
    );
    card.append(link);
  }
}

// Follow-up question chips: clicking one reveals its (pre-fetched) answer in
// a panel below; clicking the active chip again collapses it.
function buildFollowups(followups) {
  const wrap = document.createElement("div");
  const chips = document.createElement("div");
  chips.className = "yts-followups";
  const answerBox = document.createElement("div");
  answerBox.className = "yts-followup-answer";
  answerBox.hidden = true;

  for (const fu of followups) {
    const chip = document.createElement("button");
    chip.className = "yts-chip";
    chip.textContent = fu.question;
    chip.addEventListener("click", () => {
      const wasActive = chip.classList.contains("yts-chip-active");
      chips.querySelectorAll(".yts-chip").forEach((c) => c.classList.remove("yts-chip-active"));
      if (wasActive) {
        answerBox.hidden = true;
      } else {
        chip.classList.add("yts-chip-active");
        answerBox.textContent = fu.answer;
        answerBox.hidden = false;
      }
    });
    chips.append(chip);
  }
  wrap.append(chips, answerBox);
  return wrap;
}

const DISCLOSURE_LABELS = {
  sponsored: ["💰", "Sponsored"],
  free_product: ["🎁", "Free product"],
  loaner: ["🔄", "Loaner unit"],
};

function buildDisclosureTag({ type, note }) {
  const [emoji, label] = DISCLOSURE_LABELS[type] || ["💰", "Paid review"];
  const tag = document.createElement("span");
  tag.className = "yts-disclosure";
  tag.textContent = `${emoji} ${label}`;
  // Hover popover with the creator's own disclosure words.
  if (note) {
    const pop = document.createElement("span");
    pop.className = "yts-disclosure-pop";
    pop.textContent = note;
    tag.append(pop);
  }
  return tag;
}

function buildTabs(labels, panels) {
  const bar = document.createElement("div");
  bar.className = "yts-tabs";
  labels.forEach((label, i) => {
    const tab = document.createElement("button");
    tab.className = "yts-tab" + (i === 0 ? " yts-tab-active" : "");
    tab.textContent = label;
    tab.addEventListener("click", () => {
      bar.querySelectorAll(".yts-tab").forEach((t) => t.classList.remove("yts-tab-active"));
      tab.classList.add("yts-tab-active");
      panels.forEach((p, j) => (p.hidden = j !== i));
      panels[i].closest(".yts-card-scroll")?.scrollTo(0, 0);
    });
    bar.append(tab);
  });
  panels.forEach((p, i) => (p.hidden = i !== 0));
  return bar;
}

// Winner banner + aspect-by-aspect table for "X vs Y (vs Z)" review videos.
function buildComparison({ products, rows, winner, winnerNote }) {
  const panel = document.createElement("div");

  const banner = document.createElement("p");
  banner.className = "yts-winner" + (winner ? "" : " yts-winner-none");
  banner.textContent = winner ? `🏆 Clear winner: ${winner}` : "No clear winner";
  panel.append(banner);
  if (winnerNote) {
    const note = document.createElement("p");
    note.className = "yts-winner-note";
    note.textContent = winnerNote;
    panel.append(note);
  }

  const table = document.createElement("table");
  table.className = "yts-table";
  const thead = document.createElement("thead");
  const headRow = document.createElement("tr");
  headRow.append(document.createElement("th"));
  for (const p of products) {
    const th = document.createElement("th");
    th.textContent = p;
    if (winner && p === winner) th.classList.add("yts-cell-win");
    headRow.append(th);
  }
  thead.append(headRow);

  const tbody = document.createElement("tbody");
  for (const row of rows) {
    const tr = document.createElement("tr");
    const th = document.createElement("th");
    th.textContent = row.aspect;
    tr.append(th);
    row.verdicts.forEach((v, i) => {
      const td = document.createElement("td");
      td.textContent = v;
      if (row.winnerIndex === i) td.classList.add("yts-cell-win");
      tr.append(td);
    });
    tbody.append(tr);
  }
  table.append(thead, tbody);
  panel.append(table);
  return panel;
}

// Best-to-worst table for top-N / tier-list videos. Items arrive pre-sorted
// best first; #1 is the declared best.
function buildRanking({ items, note }) {
  const panel = document.createElement("div");

  const banner = document.createElement("p");
  banner.className = "yts-winner";
  banner.textContent = `🏆 Best: ${items[0].name}`;
  panel.append(banner);
  if (note) {
    const noteEl = document.createElement("p");
    noteEl.className = "yts-winner-note";
    noteEl.textContent = note;
    panel.append(noteEl);
  }

  const table = document.createElement("table");
  table.className = "yts-table";
  const tbody = document.createElement("tbody");
  items.forEach((item, i) => {
    const tr = document.createElement("tr");
    if (i === 0) tr.classList.add("yts-row-win");

    const rank = document.createElement("th");
    rank.className = "yts-rank";
    rank.textContent = String(i + 1);

    const name = document.createElement("td");
    name.className = "yts-rank-name";
    name.textContent = item.name;
    if (item.award) {
      const award = document.createElement("span");
      award.className = "yts-award";
      award.textContent = item.award;
      name.append(award);
    }

    const verdict = document.createElement("td");
    verdict.textContent = item.verdict;

    tr.append(rank, name, verdict);
    tbody.append(tr);
  });
  table.append(tbody);
  panel.append(table);
  return panel;
}

// Ingredients tab: the full shopping list, amounts first.
function buildIngredients({ name, serves, totalTime, ingredients }) {
  const panel = document.createElement("div");
  const head = document.createElement("p");
  head.className = "yts-winner";
  head.textContent = name || "Ingredients";
  panel.append(head);
  const meta = [serves, totalTime].filter(Boolean).join(" · ");
  if (meta) {
    const m = document.createElement("p");
    m.className = "yts-winner-note";
    m.textContent = meta;
    panel.append(m);
  }
  const table = document.createElement("table");
  table.className = "yts-table";
  const tbody = document.createElement("tbody");
  for (const ing of ingredients) {
    const tr = document.createElement("tr");
    const amount = document.createElement("th");
    amount.className = "yts-ing-amount";
    amount.textContent = ing.amount || "—";
    const item = document.createElement("td");
    item.textContent = ing.item;
    tr.append(amount, item);
    tbody.append(tr);
  }
  table.append(tbody);
  panel.append(table);
  return panel;
}

// Steps tab: a timeline — cumulative time from the start on each step, the
// gap since the previous step as subtext, and the amounts added that step.
function buildSteps({ steps }) {
  const panel = document.createElement("div");
  const list = document.createElement("ol");
  list.className = "yts-steps";
  steps.forEach((step, i) => {
    const li = document.createElement("li");
    li.className = "yts-step";

    const time = document.createElement("div");
    time.className = "yts-step-time";
    if (step.startMin != null) {
      const at = document.createElement("span");
      at.className = "yts-step-at";
      at.textContent = formatMin(step.startMin);
      time.append(at);
      const prev = steps[i - 1];
      if (i > 0 && prev?.startMin != null && step.startMin > prev.startMin) {
        const delta = document.createElement("span");
        delta.className = "yts-step-delta";
        delta.textContent = `+${formatMin(step.startMin - prev.startMin)}`;
        time.append(delta);
      }
    }

    const stepBody = document.createElement("div");
    stepBody.className = "yts-step-body";
    const action = document.createElement("p");
    action.className = "yts-step-action";
    action.textContent = step.action;
    stepBody.append(action);
    if (step.ingredients.length) {
      const ing = document.createElement("p");
      ing.className = "yts-step-ing";
      ing.textContent = step.ingredients.join(" · ");
      stepBody.append(ing);
    }

    li.append(time, stepBody);
    list.append(li);
  });
  panel.append(list);
  return panel;
}

function formatMin(min) {
  if (min >= 60) {
    const h = Math.floor(min / 60);
    const m = min % 60;
    return m ? `${h}h ${m}m` : `${h}h`;
  }
  return `${min}m`;
}

function buildUsageLine({ model, inputTokens, outputTokens, cost }, cached) {
  const div = document.createElement("div");
  div.className = "yts-usage";
  const fmt = (n) => n.toLocaleString("en");
  let text = `${model.replace(/^claude-/, "")} · ${fmt(inputTokens)} tokens in / ${fmt(outputTokens)} out`;
  if (cost != null) text += ` · ~$${cost.toFixed(3)}`;
  if (cached) text = `⚡ cached (free) · ${text}`;
  div.textContent = text;
  return div;
}

// The card is "locked" — it stays until closed via the ✕ button or Escape.
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape") document.getElementById(CARD_ID)?.remove();
});
