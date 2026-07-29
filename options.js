// YT Hover Summary — Copyright (C) 2026 discobean (github.com/discobean)
// Licensed under the GNU AGPL v3.0 or later; see the LICENSE file.

const fields = {
  apiKey: document.getElementById("apiKey"),
  model: document.getElementById("model"),
  geminiApiKey: document.getElementById("geminiApiKey"),
  geminiModel: document.getElementById("geminiModel"),
};
const status = document.getElementById("status");
const tabs = [...document.querySelectorAll(".tab")];
const panels = [...document.querySelectorAll("[data-panel]")];

let activeProvider = "anthropic";

function showProvider(provider) {
  activeProvider = provider;
  tabs.forEach((t) => t.classList.toggle("tab-active", t.dataset.provider === provider));
  panels.forEach((p) => (p.hidden = p.dataset.panel !== provider));
}

tabs.forEach((t) => t.addEventListener("click", () => showProvider(t.dataset.provider)));

chrome.storage.local
  .get({
    provider: "anthropic",
    apiKey: "",
    model: "claude-haiku-4-5",
    geminiApiKey: "",
    geminiModel: "gemini-flash-latest",
  })
  .then((s) => {
    fields.apiKey.value = s.apiKey;
    fields.model.value = s.model;
    fields.geminiApiKey.value = s.geminiApiKey;
    fields.geminiModel.value = s.geminiModel;
    showProvider(s.provider === "gemini" ? "gemini" : "anthropic");
  });

document.getElementById("save").addEventListener("click", async () => {
  await chrome.storage.local.set({
    provider: activeProvider, // the open tab is the provider in use
    apiKey: fields.apiKey.value.trim(),
    model: fields.model.value,
    geminiApiKey: fields.geminiApiKey.value.trim(),
    geminiModel: fields.geminiModel.value,
  });
  status.textContent = `Saved ✓ using ${activeProvider === "gemini" ? "Gemini" : "Anthropic"}`;
  setTimeout(() => (status.textContent = ""), 2000);
});

const cacheStatus = document.getElementById("cacheStatus");

function refreshCacheCount() {
  chrome.runtime.sendMessage({ type: "cache-count" }).then((res) => {
    cacheStatus.textContent = `${res?.count ?? 0} cached`;
  });
}
refreshCacheCount();

document.getElementById("clearCache").addEventListener("click", async () => {
  const res = await chrome.runtime.sendMessage({ type: "clear-cache" });
  cacheStatus.textContent = `Cleared ${res?.cleared ?? 0} ✓`;
  setTimeout(refreshCacheCount, 1500);
});
