# YT Hover Summary

A browser extension that answers the question a YouTube video is teasing —
without you having to watch it.

Hover any thumbnail on youtube.com and a ✨ badge appears (bottom-left of the
video, including on the inline hover preview once it starts playing). Click it
and the extension pulls the transcript, title, description, and
full-resolution thumbnail, sends them to Claude, and docks a card under the
video with:

- the **question** the thumbnail/title poses and a **very short direct
  answer**, plus a few lines of detail;
- **follow-up question chips** — click to reveal answers the video also gives;
- a **Review tab** for product videos: a head-to-head table for "X vs Y"
  reviews (2-3 products, per-aspect winners, 🏆 overall verdict) or a ranked
  best-to-worst table for top-N / tier-list videos;
- **Ingredients + Steps tabs** for recipe videos: full shopping list, then a
  step timeline (cumulative time, gap since the previous step, and the
  amounts added at each step);
- a **disclosure tag** (💰 Sponsored / 🎁 Free product / 🔄 Loaner unit) next
  to the close button when the reviewed product's maker paid for, gifted, or
  loaned it — hover it to see the creator's own words. Unrelated sponsor
  reads (VPNs etc.) are ignored;
- everything in **your browser's language and units** (grams vs ounces, °C vs
  °F, km vs miles, L/100km vs mpg);
- a footer with exact token usage and the **estimated cost of that click**.

No account, no server — it talks directly to the Anthropic API with your own
key. A typical video costs ~0.5–10¢ depending on model and video length.

## Setup

### 1. Get an Anthropic API key

1. Sign up / sign in at [console.anthropic.com](https://console.anthropic.com).
2. Add billing under **Settings → Billing** (trial credits or a small top-up —
   $5 lasts a long time).
3. Go to **Settings → API keys** → **Create Key**, name it (e.g.
   `yt-summary`), and copy the `sk-ant-…` key. It's shown only once.

### 2. Get the code

```bash
git clone https://github.com/discobean/yt-summary.git
```

```bash
cd yt-summary
```

(Or just download the folder — there's no build step; the folder is the
extension.)

### 3. Install into Brave

1. Open a new tab and go to `brave://extensions`.
2. Turn on **Developer mode** (toggle, top-right).
3. Click **Load unpacked** (top-left) and select the `yt-summary` folder.
4. "YT Hover Summary" appears in the list. Optionally pin it: puzzle-piece
   icon in the toolbar → pin.

> Chrome / Edge / Arc: identical steps at `chrome://extensions` (Edge:
> `edge://extensions`).

### 4. Add your key to the extension

1. Click the extension's toolbar icon.
2. Paste your `sk-ant-…` key.
3. Pick a model and **Save**:

| Model | Quality | Typical cost per video |
| --- | --- | --- |
| Claude Haiku 4.5 (default) | Good — great fit for this task | ~0.5–2¢ |
| Claude Sonnet 5 | Better on long/nuanced videos | ~1.5–5¢ |
| Claude Opus 5 | Best | ~3–10¢ |

The key is stored in `chrome.storage.local` on this machine only and is sent
only to `api.anthropic.com`.

### 5. Use it

Go to [youtube.com](https://www.youtube.com), hover a video, click the ✨
badge (bottom-left of the thumbnail — it's on the inline preview too once
playback starts). The card docks under the video; close it with ✕ or Escape.

### When it can't summarize

- *"This video has no captions"* / *"YouTube blocked the caption download"* —
  no transcript to work from (common on music, Shorts, very new uploads).
  Nothing is sent to the API, so it costs nothing.
- *"No Anthropic API key configured yet"* — open settings via the button on
  the card and paste your key.
- Rate-limit or invalid-key errors are shown verbatim in the card.

## How it works (developer notes)

| File | Role |
| --- | --- |
| `content.js` | Runs on youtube.com. Injects the hover badge (proactive sweep via MutationObserver + hover fast-path), fetches oEmbed metadata + transcript + description, renders the docked card with its tabs. |
| `background.js` | Service worker. Owns the Anthropic API call (`POST /v1/messages`) so the key never enters the page context; defines the JSON output schema; computes per-request cost from a pricing table. |
| `options.html/js` | Toolbar popup + options page: API key and model selection. |
| `content.css` | Badge, card, tabs, tables, and timeline styling. |

Flow: badge click → oEmbed for title/channel → transcript + description → the
service worker sends the thumbnail (image-URL content block), title, channel,
description, transcript, and browser language to Claude with a JSON schema
(structured outputs), getting back `{title, question, answer, details,
followups[], comparison|ranking|recipe, disclosure}` plus exact token usage.

Design decisions:

- **Transcript from the content script** — YouTube endpoints are same-origin
  there, so no CORS and requests look like the site's own.
- **API call from the service worker** — `host_permissions` covers
  `api.anthropic.com`, and the key stays out of the page.
- **Thumbnail as a URL image block** (`maxresdefault` when it exists,
  `hqdefault` otherwise) — the API fetches it server-side; full resolution
  matters because thumbnail overlay text is the primary signal.
- **Transcript capped at 150k chars** (~40k tokens) to bound cost on
  multi-hour videos.
- **`effort: low`** for Opus/Sonnet keeps answers snappy (Haiku doesn't
  accept the parameter).

### Known fragile points

1. **Transcript scraping is unofficial.** YouTube has no public transcript
   API. Primary route: the InnerTube `player` endpoint queried as the
   **Android client**, whose caption URLs are served without the
   proof-of-origin token that now blocks the web-client ones (the web caption
   URLs return HTTP 200 with an empty body, and the `get_transcript` panel
   endpoint 400s outside the real player). Fallback: the caption URL from the
   watch-page HTML. The Android `clientVersion` is hardcoded in `content.js`
   — bump it if the route starts failing.
2. **DOM selectors churn.** Badges target `ytd-thumbnail` (classic),
   `yt-thumbnail-view-model` (newer lockup markup), and the hover-preview
   overlay. If badges stop appearing on some surface, the `HOST_SELECTOR`
   list in `content.js` is the first place to look. Video ids come from the
   tile's `watch?v=` anchor, or — on the newer lockup tiles used by search
   results, which have no watch link — from the `content-id-<id>` wrapper
   class. Ad tiles are skipped.
3. **The hover preview is quirky** (all measured against the live site):
   the `#video-preview` wrapper and its `a#media-container-link` both report
   zero-height boxes, the media link's `href` is usually *empty*, and Chrome
   fires no mouse events when the preview mounts under a stationary cursor.
   Hence: badge injection via MutationObserver, the badge attaching to
   `#media-container` (the element with the video's real box), and the video
   id being remembered from the tile hovered just before the preview opened.

### Iterating

Edit a file → `brave://extensions` (or `chrome://extensions`) → ↻ on the
extension card → refresh the YouTube tab. Debugging surfaces:

- Content script: DevTools console on the YouTube tab.
- Service worker (API call): the extensions page → "Inspect views:
  service worker".
- Options popup: right-click it → Inspect.

## License

Copyright (C) 2026 [discobean](https://github.com/discobean)

This program is free software, licensed under the
**GNU Affero General Public License v3.0** — see [LICENSE](LICENSE).

In short: you may use, modify, and redistribute this code, but if you
distribute a modified version — or run one as a network service — you must
make your source code available under the same license. There is no warranty.
