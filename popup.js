(() => {
  const STORAGE_KEYS = {
    blockedStreets: "blockedStreets",
    addressCache: "addressCache",
  };
  const form = document.getElementById("street-form");
  const input = document.getElementById("street-input");
  const list = document.getElementById("street-list");
  const status = document.getElementById("status");
  const template = document.getElementById("street-item-template");
  const clearCacheButton = document.getElementById("clear-cache-button");

  init().catch((error) => {
    status.textContent = `Failed to load streets: ${error.message}`;
  });

  async function init() {
    const stored = await chrome.storage.local.get({ [STORAGE_KEYS.blockedStreets]: [] });
    renderList(sanitizeEntries(stored[STORAGE_KEYS.blockedStreets]));

    form.addEventListener("submit", async (event) => {
      event.preventDefault();

      const nextStreet = cleanText(input.value);

      if (!nextStreet) {
        status.textContent = "Enter a street name.";
        return;
      }

      const streets = sanitizeEntries(await getStoredStreets());
      streets.push(nextStreet);
      const sanitized = sanitizeEntries(streets);

      await chrome.storage.local.set({ [STORAGE_KEYS.blockedStreets]: sanitized });
      renderList(sanitized);
      input.value = "";
      status.textContent = `Added "${nextStreet}".`;
    });

    list.addEventListener("click", async (event) => {
      const button = event.target.closest("button[data-street]");

      if (!button) {
        return;
      }

      const streetToRemove = button.dataset.street || "";
      const streets = sanitizeEntries(await getStoredStreets()).filter((street) => street !== streetToRemove);

      await chrome.storage.local.set({ [STORAGE_KEYS.blockedStreets]: streets });
      renderList(streets);
      status.textContent = `Removed "${streetToRemove}".`;
    });

    clearCacheButton.addEventListener("click", async () => {
      await chrome.storage.local.remove(STORAGE_KEYS.addressCache);
      status.textContent = "Cleared address cache.";
    });
  }

  async function getStoredStreets() {
    const stored = await chrome.storage.local.get({ [STORAGE_KEYS.blockedStreets]: [] });
    return Array.isArray(stored[STORAGE_KEYS.blockedStreets]) ? stored[STORAGE_KEYS.blockedStreets] : [];
  }

  function renderList(streets) {
    list.textContent = "";

    for (const street of streets) {
      const fragment = template.content.cloneNode(true);
      const label = fragment.querySelector(".street-label");
      const button = fragment.querySelector(".remove-button");

      label.textContent = street;
      button.dataset.street = street;
      list.appendChild(fragment);
    }
  }

  function sanitizeEntries(entries) {
    const seen = new Set();
    const sanitized = [];

    for (const entry of Array.isArray(entries) ? entries : []) {
      const cleaned = cleanText(entry);
      const normalized = normalizeForMatch(cleaned);

      if (!cleaned || !normalized || seen.has(normalized)) {
        continue;
      }

      seen.add(normalized);
      sanitized.push(cleaned);
    }

    return sanitized;
  }

  function cleanText(value) {
    return String(value || "").replace(/\s+/g, " ").trim();
  }

  function normalizeForMatch(value) {
    return cleanText(value)
      .toLowerCase()
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "")
      .replace(/[^\p{L}\p{N}]+/gu, " ")
      .replace(/\s+/g, " ")
      .trim();
  }
})();
