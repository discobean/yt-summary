// YT Hover Summary — Copyright (C) 2026 discobean (github.com/discobean)
// Licensed under the GNU AGPL v3.0 or later; see the LICENSE file.

const apiKeyInput = document.getElementById("apiKey");
const modelSelect = document.getElementById("model");
const status = document.getElementById("status");

chrome.storage.local
  .get({ apiKey: "", model: "claude-haiku-4-5" })
  .then(({ apiKey, model }) => {
    apiKeyInput.value = apiKey;
    modelSelect.value = model;
  });

document.getElementById("save").addEventListener("click", async () => {
  await chrome.storage.local.set({
    apiKey: apiKeyInput.value.trim(),
    model: modelSelect.value,
  });
  status.textContent = "Saved ✓";
  setTimeout(() => (status.textContent = ""), 1500);
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
