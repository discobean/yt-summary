// YT Hover Summary — Copyright (C) 2026 discobean (github.com/discobean)
// Licensed under the GNU AGPL v3.0 or later; see the LICENSE file.
//
// Service worker.
// Owns the Anthropic API call so the API key never enters the page context,
// and so the request runs under the extension's host_permissions.

const API_URL = "https://api.anthropic.com/v1/messages";

const SYSTEM_PROMPT = [
  "You analyze YouTube videos. You receive a video's thumbnail image, title, channel name, and transcript.",
  "Write EVERY output field — question, answer, details, followup questions and answers, comparison and ranking content, recipe content, disclosure note — in the user's language, given as 'User language' in the message. Translate from the video's language when they differ. Keep product names and brand names untranslated.",
  "Convert every measurement in every field to the units conventional for the user's locale (from 'User language'): en-US gets ounces/pounds/cups, °F, miles, mpg; most other locales get grams/ml, °C, km, L/100km; en-GB gets metric weights but miles. Round converted values to sensible amounts (e.g. 7 oz, not 7.05 oz).",
  "The text overlaid on the thumbnail image is the primary thing to focus on — read it carefully first.",
  'Thumbnail text usually poses a question ("The future?") or a teaser claim without revealing the answer — that is the question the viewer wants answered.',
  "The episode title is second tier: use it for context, and as the source of the question only when the thumbnail has no text.",
  "title: the video's title in the user's language — translate it when it differs, return it unchanged when it's already in that language.",
  "question: the question being posed. Quote the thumbnail text near-verbatim when it asks one; otherwise derive it from the title. Use null only if the video genuinely teases nothing.",
  "answer: answer that question from the transcript in one very short line — a phrase or short sentence, well under 12 words. This is the payoff the viewer wants.",
  "details: 2-4 short plain-text lines expanding on the answer with the key specifics from the video. No markdown.",
  "followups: 3-5 interesting follow-up questions that the video also answers — things a curious viewer would want to drill into after the main answer. Each gets its own concise answer (1-3 sentences) drawn from the transcript. Don't repeat the main question, and only include questions the transcript genuinely answers.",
  "comparison: fill this ONLY when the video is a head-to-head comparison or versus-style review of 2-3 products (phone vs phone, tool A vs tool B vs tool C, etc). products = the 2-3 product names, short. rows = the 5-8 key aspects compared in the video (Battery, Camera, Price...), each with one very short verdict per product (a few words, same order as products) and winnerIndex = the index of the product that wins that aspect, or null for a tie. winner = the overall winning product name if the video declares or clearly implies one, else null. winnerNote = one short line on why it wins, or why there is no clear winner.",
  "ranking: fill this ONLY when the video ranks a larger set of products from best to worst (top-10 lists, 'every X ranked', tier lists, buyer's guides). items = every ranked product in order from BEST to WORST, each with its name, a very short verdict on why it ranks there, and award = the label the video gives it ('Best overall', 'Best budget') or null. note = one short line on the ranking criteria.",
  "recipe: fill ONLY when the video teaches how to make a dish or drink. name = the dish. serves and totalTime when stated or reasonably estimable, else null. ingredients = the COMPLETE shopping list, every ingredient with its amount. steps = the method in order: action = one short instruction; ingredients = the ingredients WITH amounts added during that step (empty array when none); startMin = estimated minutes from the start of cooking when the step begins — first step 0, then realistic cumulative times based on the video (include resting/marinating/oven time).",
  "comparison, ranking and recipe are mutually exclusive — fill at most ONE: a 2-3 product head-to-head is comparison, a bigger best-to-worst list is ranking, a cooking tutorial is recipe, anything else gets null for all three.",
  "disclosure: watch for a brand relationship between the creator and the maker of the REVIEWED product specifically. It is most often SPOKEN in the video — listen carefully to the transcript, especially the opening minutes — and sometimes in the description. Set type: 'sponsored' when the reviewed product's own company paid for the video or placement (a paid review), 'free_product' when the reviewed product was given to the creator free, 'loaner' when the reviewed product must go back ('review unit', 'on loan'). IMPORTANT: a sponsor read from a company UNRELATED to the reviewed product (VPNs, website builders, meal kits, apps...) is NOT a disclosure — ignore it entirely; viewers only care whether the review itself is compromised. Pick the strongest that applies (sponsored > free_product > loaner) and set note = the creator's OWN words: quote or closely paraphrase the sentence where they disclose it, e.g. Said \"huge thanks to Anker for sending this over\". Never a generic predefined reason. Use null when the creator bought the product themselves, when the only sponsorship is unrelated to the reviewed product, or when there is no sign of a brand relationship. Do not treat ordinary affiliate links alone as a disclosure.",
  "If the transcript never actually answers the tease, make answer say so plainly.",
].join(" ");

const OUTPUT_FORMAT = {
  type: "json_schema",
  schema: {
    type: "object",
    properties: {
      title: {
        type: "string",
        description:
          "The video's title in the user's language (translated when needed, unchanged when already in it).",
      },
      question: {
        anyOf: [{ type: "string" }, { type: "null" }],
        description:
          "The question posed — thumbnail overlay text takes priority over the title; near-verbatim when explicitly asked. Null if nothing is teased.",
      },
      answer: {
        type: "string",
        description: "Very short direct answer, well under 12 words.",
      },
      details: {
        type: "array",
        items: { type: "string" },
        description: "2-4 short lines expanding on the answer.",
      },
      followups: {
        type: "array",
        items: {
          type: "object",
          properties: {
            question: {
              type: "string",
              description: "Short follow-up question the video answers.",
            },
            answer: {
              type: "string",
              description: "Concise answer from the transcript, 1-3 sentences.",
            },
          },
          required: ["question", "answer"],
          additionalProperties: false,
        },
        description: "3-5 follow-up questions the video also answers, for drilling down.",
      },
      comparison: {
        anyOf: [
          { type: "null" },
          {
            type: "object",
            properties: {
              products: {
                type: "array",
                items: { type: "string" },
                description: "The 2-3 products being compared, short names.",
              },
              rows: {
                type: "array",
                items: {
                  type: "object",
                  properties: {
                    aspect: {
                      type: "string",
                      description: "What is being compared, e.g. Battery, Camera, Price.",
                    },
                    verdicts: {
                      type: "array",
                      items: { type: "string" },
                      description: "One very short verdict per product, same order as products.",
                    },
                    winnerIndex: {
                      anyOf: [{ type: "integer" }, { type: "null" }],
                      description: "Index into products of this aspect's winner; null for a tie.",
                    },
                  },
                  required: ["aspect", "verdicts", "winnerIndex"],
                  additionalProperties: false,
                },
                description: "5-8 key aspects compared in the video.",
              },
              winner: {
                anyOf: [{ type: "string" }, { type: "null" }],
                description: "Overall winning product name, or null if no clear winner.",
              },
              winnerNote: {
                type: "string",
                description: "One short line: why it wins, or why there's no clear winner.",
              },
            },
            required: ["products", "rows", "winner", "winnerNote"],
            additionalProperties: false,
          },
        ],
        description: "Only for 2-3 product head-to-head videos; null otherwise.",
      },
      ranking: {
        anyOf: [
          { type: "null" },
          {
            type: "object",
            properties: {
              items: {
                type: "array",
                items: {
                  type: "object",
                  properties: {
                    name: { type: "string", description: "Product name, short." },
                    verdict: {
                      type: "string",
                      description: "Very short: why it ranks here.",
                    },
                    award: {
                      anyOf: [{ type: "string" }, { type: "null" }],
                      description: "Label the video gives it ('Best overall'), or null.",
                    },
                  },
                  required: ["name", "verdict", "award"],
                  additionalProperties: false,
                },
                description: "Every ranked product, ordered best to worst.",
              },
              note: {
                type: "string",
                description: "One short line on the ranking criteria.",
              },
            },
            required: ["items", "note"],
            additionalProperties: false,
          },
        ],
        description:
          "Only for best-to-worst ranking videos; null otherwise. Mutually exclusive with comparison.",
      },
      recipe: {
        anyOf: [
          { type: "null" },
          {
            type: "object",
            properties: {
              name: {
                type: "string",
                description: "The dish, in the user's language.",
              },
              serves: {
                anyOf: [{ type: "string" }, { type: "null" }],
                description: "Servings, e.g. 'Serves 4', or null.",
              },
              totalTime: {
                anyOf: [{ type: "string" }, { type: "null" }],
                description: "Total time start to finish, e.g. '35 min', or null.",
              },
              ingredients: {
                type: "array",
                items: {
                  type: "object",
                  properties: {
                    item: { type: "string" },
                    amount: {
                      anyOf: [{ type: "string" }, { type: "null" }],
                      description: "Amount in the user's locale units, e.g. '200 g' or '7 oz'.",
                    },
                  },
                  required: ["item", "amount"],
                  additionalProperties: false,
                },
                description: "The complete shopping list.",
              },
              steps: {
                type: "array",
                items: {
                  type: "object",
                  properties: {
                    action: { type: "string", description: "One short instruction." },
                    ingredients: {
                      type: "array",
                      items: { type: "string" },
                      description:
                        "Ingredients WITH amounts added in this step, e.g. '2 tbsp honey'. Empty if none.",
                    },
                    startMin: {
                      anyOf: [{ type: "number" }, { type: "null" }],
                      description:
                        "Estimated minutes from the start of cooking when this step begins; first step 0.",
                    },
                  },
                  required: ["action", "ingredients", "startMin"],
                  additionalProperties: false,
                },
                description: "The method, in order.",
              },
            },
            required: ["name", "serves", "totalTime", "ingredients", "steps"],
            additionalProperties: false,
          },
        ],
        description: "Only when the video teaches making a dish/drink; null otherwise.",
      },
      disclosure: {
        anyOf: [
          { type: "null" },
          {
            type: "object",
            properties: {
              type: {
                type: "string",
                enum: ["sponsored", "free_product", "loaner"],
                description:
                  "Strongest applicable relationship with the REVIEWED product's maker. Sponsorships from unrelated companies don't count.",
              },
              note: {
                type: "string",
                description:
                  "The creator's own disclosure, quoted or closely paraphrased from the transcript/description — never a canned reason.",
              },
            },
            required: ["type", "note"],
            additionalProperties: false,
          },
        ],
        description:
          "Non-null only when the maker of the reviewed product paid for, gifted, or loaned it. Unrelated sponsor reads don't count.",
      },
    },
    required: ["title", "question", "answer", "details", "followups", "comparison", "ranking", "recipe", "disclosure"],
    additionalProperties: false,
  },
};

// $ per million tokens. Sonnet 5 has intro pricing ($2/$10) through
// 2026-08-31 — we show the standard rate, so real spend can be a bit lower
// until then.
const PRICING = {
  "claude-opus-5": { input: 5, output: 25 },
  "claude-sonnet-5": { input: 3, output: 15 },
  "claude-haiku-4-5": { input: 1, output: 5 },
};

// We don't use prompt caching, so the cache fields are normally zero; they're
// included so the token count stays honest if caching is ever added.
function buildUsage(model, usage) {
  if (!usage) return null;
  const inputTokens =
    (usage.input_tokens || 0) +
    (usage.cache_creation_input_tokens || 0) +
    (usage.cache_read_input_tokens || 0);
  const outputTokens = usage.output_tokens || 0;
  const price = PRICING[model];
  const cost = price
    ? (inputTokens * price.input + outputTokens * price.output) / 1e6
    : null;
  return { model, inputTokens, outputTokens, cost };
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg.type === "summarize") {
    handleSummarize(msg).then(sendResponse);
    return true; // keep the message channel open for the async response
  }
  if (msg.type === "open-options") {
    chrome.runtime.openOptionsPage();
  }
});

async function handleSummarize({ title, author, thumbnailUrl, transcript, description, language }) {
  const { apiKey, model } = await chrome.storage.local.get({
    apiKey: "",
    model: "claude-haiku-4-5",
  });
  if (!apiKey) return { ok: false, error: "no-key" };

  const body = {
    model,
    max_tokens: 4096,
    system: SYSTEM_PROMPT,
    output_config: { format: OUTPUT_FORMAT },
    messages: [
      {
        role: "user",
        content: [
          { type: "image", source: { type: "url", url: thumbnailUrl } },
          {
            type: "text",
            text:
              `User language: ${language || "en"}\n` +
              `Title: ${title}\nChannel: ${author}\n\n` +
              `Description (start):\n${description || "(none)"}\n\n` +
              `Transcript:\n${transcript}`,
          },
        ],
      },
    ],
  };
  // Summarization is a simple task — low effort keeps answers snappy.
  // Haiku 4.5 doesn't accept the effort parameter.
  if (!model.startsWith("claude-haiku")) {
    body.output_config.effort = "low";
  }

  let res;
  try {
    res = await fetch(API_URL, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
        "anthropic-dangerous-direct-browser-access": "true",
      },
      body: JSON.stringify(body),
    });
  } catch (err) {
    return { ok: false, error: `Network error calling the Anthropic API: ${err.message}` };
  }

  const data = await res.json().catch(() => null);
  if (!res.ok) {
    const detail = data?.error?.message || `HTTP ${res.status}`;
    if (res.status === 401) return { ok: false, error: `Invalid API key (${detail}).` };
    if (res.status === 429) return { ok: false, error: `Rate limited — try again shortly.` };
    return { ok: false, error: detail };
  }

  if (data.stop_reason === "refusal") {
    return { ok: false, error: "The model declined to answer for this video." };
  }

  const text = (data.content || [])
    .filter((b) => b.type === "text")
    .map((b) => b.text)
    .join("\n")
    .trim();
  if (!text) return { ok: false, error: "The model returned an empty response." };

  const usage = buildUsage(model, data.usage);

  // Structured outputs guarantees valid JSON matching OUTPUT_FORMAT, but
  // degrade to plain text just in case (e.g. truncation at max_tokens).
  let parsed = null;
  try {
    parsed = JSON.parse(text);
  } catch {}
  if (!parsed?.answer) {
    const [first, ...rest] = text.split("\n").filter((l) => l.trim());
    return {
      ok: true,
      question: null,
      answer: first || text,
      details: rest,
      followups: [],
      comparison: null,
      ranking: null,
      recipe: null,
      disclosure: null,
      titleTranslated: null,
      usage,
    };
  }
  const followups = (Array.isArray(parsed.followups) ? parsed.followups : [])
    .filter((f) => f?.question && f?.answer)
    .slice(0, 5);
  let comparison = sanitizeComparison(parsed.comparison);
  let ranking = sanitizeRanking(parsed.ranking);
  // Mutually exclusive; if the model filled both anyway, a bigger
  // best-to-worst list beats a head-to-head, and vice versa.
  if (comparison && ranking) {
    if (ranking.items.length >= 4) comparison = null;
    else ranking = null;
  }
  return {
    ok: true,
    question: parsed.question || null,
    answer: parsed.answer,
    details: Array.isArray(parsed.details) ? parsed.details : [],
    followups,
    comparison,
    ranking,
    recipe: sanitizeRecipe(parsed.recipe),
    disclosure: sanitizeDisclosure(parsed.disclosure),
    titleTranslated: parsed.title ? String(parsed.title) : null,
    usage,
  };
}

function sanitizeRecipe(r) {
  if (!r || !Array.isArray(r.ingredients) || !Array.isArray(r.steps)) return null;
  const ingredients = r.ingredients
    .filter((i) => i?.item)
    .slice(0, 30)
    .map((i) => ({ item: String(i.item), amount: i.amount ? String(i.amount) : null }));
  const steps = r.steps
    .filter((s) => s?.action)
    .slice(0, 25)
    .map((s) => ({
      action: String(s.action),
      ingredients: (Array.isArray(s.ingredients) ? s.ingredients : [])
        .filter(Boolean)
        .map(String)
        .slice(0, 10),
      startMin: Number.isFinite(s.startMin) && s.startMin >= 0 ? Math.round(s.startMin) : null,
    }));
  if (!ingredients.length || !steps.length) return null;
  return {
    name: r.name ? String(r.name) : "",
    serves: r.serves ? String(r.serves) : null,
    totalTime: r.totalTime ? String(r.totalTime) : null,
    ingredients,
    steps,
  };
}

function sanitizeDisclosure(d) {
  if (!d || !["sponsored", "free_product", "loaner"].includes(d.type)) return null;
  return { type: d.type, note: d.note ? String(d.note) : "" };
}

// Normalize the comparison so the card can render it blindly: 2-3 products,
// every row padded/truncated to one verdict per product, winnerIndex bounded.
function sanitizeComparison(c) {
  if (!c || !Array.isArray(c.products) || !Array.isArray(c.rows)) return null;
  const products = c.products.filter(Boolean).map(String).slice(0, 3);
  if (products.length < 2) return null;
  const rows = c.rows
    .filter((r) => r?.aspect && Array.isArray(r.verdicts))
    .slice(0, 10)
    .map((r) => ({
      aspect: String(r.aspect),
      verdicts: products.map((_, i) => String(r.verdicts[i] ?? "—")),
      winnerIndex:
        Number.isInteger(r.winnerIndex) && r.winnerIndex >= 0 && r.winnerIndex < products.length
          ? r.winnerIndex
          : null,
    }));
  if (!rows.length) return null;
  return {
    products,
    rows,
    winner: c.winner ? String(c.winner) : null,
    winnerNote: c.winnerNote ? String(c.winnerNote) : "",
  };
}

// A ranking needs at least 3 items to be worth a table; capped so a
// 50-product tier list doesn't overwhelm the card.
function sanitizeRanking(r) {
  if (!r || !Array.isArray(r.items)) return null;
  const items = r.items
    .filter((i) => i?.name && i?.verdict)
    .slice(0, 15)
    .map((i) => ({
      name: String(i.name),
      verdict: String(i.verdict),
      award: i.award ? String(i.award) : null,
    }));
  if (items.length < 3) return null;
  return { items, note: r.note ? String(r.note) : "" };
}
