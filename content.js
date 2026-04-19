(() => {
  if (window.top !== window) {
    return;
  }

  const STORAGE_KEYS = {
    blockedStreets: "blockedStreets",
    addressCache: "addressCache",
  };
  const PAGE_MESSAGE_SOURCE = "999helper-page";
  const HIDDEN_ATTRIBUTE = "data-999helper-hidden";
  const HIDDEN_STYLE_ID = "999helper-hidden-style";
  const SLICK_TRACK_SELECTOR = '[data-testid="slick-track"]';
  const LIST_PAGE_URL_FRAGMENT = "https://999.md/ro/list/real-estate/apartments-and-rooms?";
  const LIST_CARD_SELECTORS = [
    '[data-testid="infinite-ads-list"] > div > a',
    '[data-testid="infinite-ads-list"] div > a',
  ];
  const MAX_CONCURRENT_FETCHES = 4;
  const RESCAN_DELAY_MS = 120;
  const CACHE_WRITE_DELAY_MS = 750;
  const state = {
    blockedStreets: [],
    addressCache: {},
    queuedIds: [],
    pendingIds: new Set(),
    activeFetches: 0,
    fetchControllers: new Map(),
    scanTimer: null,
    cacheWriteTimer: null,
  };

  init().catch(() => {});

  async function init() {
    removeSlickTrackElements();
    injectPageScript();
    installHiddenStyle();
    installPageLifecycleHandlers();
    window.addEventListener("message", handlePageMessage);
    chrome.storage.onChanged.addListener(handleStorageChange);

    const stored = await chrome.storage.local.get({
      [STORAGE_KEYS.blockedStreets]: [],
      [STORAGE_KEYS.addressCache]: {},
    });

    state.blockedStreets = sanitizeBlockedStreets(stored[STORAGE_KEYS.blockedStreets]);
    state.addressCache = sanitizeAddressCache(stored[STORAGE_KEYS.addressCache]);

    observeDom();
    scheduleRescan("init");
  }

  function injectPageScript() {
    const script = document.createElement("script");
    script.src = chrome.runtime.getURL("injected.js");
    script.async = false;
    script.onload = () => {
      script.remove();
    };
    (document.head || document.documentElement).appendChild(script);
  }

  function installHiddenStyle() {
    if (document.getElementById(HIDDEN_STYLE_ID)) {
      return;
    }

    const style = document.createElement("style");
    style.id = HIDDEN_STYLE_ID;
    style.textContent = `[${HIDDEN_ATTRIBUTE}="true"] { display: none !important; }`;
    (document.head || document.documentElement).appendChild(style);
  }

  function installPageLifecycleHandlers() {
    window.addEventListener("load", () => {
      scheduleRescan("load");
    });

    window.addEventListener("pageshow", () => {
      scheduleRescan("pageshow");
    });
  }

  function observeDom() {
    const observer = new MutationObserver(() => {
      removeSlickTrackElements();
      scheduleRescan("mutation");
    });

    observer.observe(document.documentElement, {
      childList: true,
      subtree: true,
    });
  }

  function removeSlickTrackElements() {
    if (!window.location.href.includes(LIST_PAGE_URL_FRAGMENT)) {
      return;
    }

    for (const element of document.querySelectorAll(SLICK_TRACK_SELECTOR)) {
      element.remove();
    }
  }

  function handlePageMessage(event) {
    if (event.source !== window || !event.data || event.data.source !== PAGE_MESSAGE_SOURCE) {
      return;
    }

    const adIds = Array.isArray(event.data.adIds) ? event.data.adIds : [];

    for (const adId of adIds) {
      queueAddressLookup(adId);
    }

    scheduleRescan("graphql");
  }

  function handleStorageChange(changes, areaName) {
    if (areaName !== "local") {
      return;
    }

    if (changes[STORAGE_KEYS.blockedStreets]) {
      state.blockedStreets = sanitizeBlockedStreets(changes[STORAGE_KEYS.blockedStreets].newValue);
    }

    if (changes[STORAGE_KEYS.addressCache]) {
      state.addressCache = sanitizeAddressCache(changes[STORAGE_KEYS.addressCache].newValue);

      if (isAddressCacheCleared(changes[STORAGE_KEYS.addressCache])) {
        resetAddressLookupState();
      }
    }

    scheduleRescan("storage");
  }

  function scheduleRescan(reason) {
    clearTimeout(state.scanTimer);
    state.scanTimer = window.setTimeout(() => {
      rescanPage(reason).catch(() => {});
    }, RESCAN_DELAY_MS);
  }

  async function rescanPage(reason) {
    const cards = collectListingCards();

    for (const card of cards) {
      const adId = getAdIdFromCard(card);

      if (!adId) {
        continue;
      }

      queueAddressLookup(adId);
    }

    applyHiddenState(cards);
  }

  function collectListingCards() {
    const cardList = getListingCardList();

    for (const selector of LIST_CARD_SELECTORS) {
      const directCards = Array.from(document.querySelectorAll(selector));

      if (directCards.length) {
        return directCards;
      }
    }

    const fallbackCards = [];
    const seen = new Set();

    for (const link of document.querySelectorAll('a[href*="/ro/"]')) {
      if (cardList && !cardList.contains(link)) {
        continue;
      }

      const adId = getAdIdFromHref(link.getAttribute("href") || link.href);

      if (!adId) {
        continue;
      }

      const card = findCardElement(link);

      if (card && !seen.has(card)) {
        seen.add(card);
        fallbackCards.push(card);
      }
    }

    return fallbackCards;
  }

  function getAdIdFromCard(card) {
    if (card && card.matches && card.matches('a[href*="/ro/"]')) {
      const directAdId = getAdIdFromHref(card.getAttribute("href") || card.href);

      if (directAdId) {
        return directAdId;
      }
    }

    for (const link of card.querySelectorAll('a[href*="/ro/"]')) {
      const adId = getAdIdFromHref(link.getAttribute("href") || link.href);

      if (adId) {
        return adId;
      }
    }

    return "";
  }

  function queueAddressLookup(adId) {
    if (!/^\d+$/.test(adId)) {
      console.log("[999helper] skipping address lookup for invalid ad id", { adId });
      return;
    }

    if (state.pendingIds.has(adId)) {
      console.log("[999helper] skipping address lookup for pending ad", { adId });
      return;
    }

    if (hasCachedAddress(adId)) {
      console.log("[999helper] skipping address lookup for cached ad", {
        adId,
        cachedAddress: state.addressCache[adId],
      });
      return;
    }

    state.pendingIds.add(adId);
    state.queuedIds.push(adId);
    console.log("[999helper] queued address lookup", { adId });
    pumpAddressQueue();
  }

  function pumpAddressQueue() {
    while (state.activeFetches < MAX_CONCURRENT_FETCHES && state.queuedIds.length) {
      const adId = state.queuedIds.shift();

      if (!adId) {
        continue;
      }

      state.activeFetches += 1;
      const controller = new AbortController();
      state.fetchControllers.set(adId, controller);
      console.log("[999helper] starting address fetch", { adId });
      resolveAddressForAd(adId, controller.signal)
        .catch(() => {})
        .finally(() => {
          state.pendingIds.delete(adId);
          state.fetchControllers.delete(adId);
          state.activeFetches -= 1;
          scheduleRescan("detail-fetch");
          pumpAddressQueue();
        });
    }
  }

  async function resolveAddressForAd(adId, signal) {
    const response = await fetch(`https://999.md/ro/${adId}`, { signal });

    if (!response.ok) {
      throw new Error(`Request failed with ${response.status}`);
    }

    const html = await response.text();

    console.log("[999helper] fetched ad html", { adId, html });

    const addressDebug = inspectDetailHtml(html);

    const address = addressDebug.address;

    if (!address) {
      return;
    }

    cacheAddress(adId, address, "detail");
  }

  function extractAddressFromHtml(html) {
    return inspectDetailHtml(html).address;
  }

  function inspectDetailHtml(html) {
    const doc = new DOMParser().parseFromString(html, "text/html");
    const bodyText = cleanText((doc.body && doc.body.textContent) || "");
    const title = cleanText((doc.querySelector("title") && doc.querySelector("title").textContent) || "");
    const metaDescription = cleanText(
      (doc.querySelector('meta[name="description"]') &&
        doc.querySelector('meta[name="description"]').getAttribute("content")) || ""
    );
    const selectedAddress = extractAddressFromDetailDom(doc);

    if (selectedAddress.address) {
      return {
        address: selectedAddress.address,
        title,
        metaDescription: truncateForDebug(metaDescription, 300),
        matchedSource: selectedAddress.source,
        regionSnippet: truncateForDebug(selectedAddress.address, 400),
        bodySnippet: truncateForDebug(bodyText, 500),
      };
    }

    const regionMatch = bodyText.match(
      /Regiunea:\s*(.+?)(?=Contacte:|Adaugă în favorite|Reclamați[ea]|Imprimare|Calculator ipotecar|Data actualizării:|Tipul:|Vizualizări:|$)/i
    );

    if (regionMatch && regionMatch[1]) {
      return {
        address: cleanText(regionMatch[1]),
        title,
        metaDescription: truncateForDebug(metaDescription, 300),
        matchedSource: "regex:Regiunea",
        regionSnippet: truncateForDebug(regionMatch[0], 400),
        bodySnippet: truncateForDebug(bodyText, 500),
      };
    }

    const regionIndex = bodyText.indexOf("Regiunea:");
    const regionSnippet = regionIndex >= 0 ? bodyText.slice(regionIndex, regionIndex + 400) : "";

    return {
      address: "",
      title,
      metaDescription: truncateForDebug(metaDescription, 300),
      matchedSource: "",
      regionSnippet: truncateForDebug(regionSnippet, 400),
      bodySnippet: truncateForDebug(bodyText, 500),
    };
  }

  function extractAddressFromDetailDom(doc) {
    const selector = '[class*="styles_map__title"]';
    const node = doc.querySelector(selector);
    const text = cleanText((node && node.textContent) || "");

    if (text) {
      return {
        address: text,
        source: `selector:${selector}`,
      };
    }

    return {
      address: "",
      source: "",
    };
  }

  function applyHiddenState(cards) {
    for (const card of cards) {
      const adId = getAdIdFromCard(card);

      if (!adId) {
        continue;
      }

      const addressEntry = state.addressCache[adId];
      const address = (addressEntry && addressEntry.address) || "";
      const normalizedAddress = (addressEntry && addressEntry.normalizedAddress) || "";
      const matchedStreet = state.blockedStreets.find((street) => normalizedAddress.includes(street)) || "";
      const shouldHide = Boolean(matchedStreet);

      if (shouldHide) {
        console.log("[999helper] attempting to hide card", { adId, matchedStreet, address });
        card.setAttribute(HIDDEN_ATTRIBUTE, "true");
      } else {
        card.removeAttribute(HIDDEN_ATTRIBUTE);
      }
    }
  }

  function findCardElement(link) {
    const cardList = getListingCardList();

    if (cardList && cardList.contains(link)) {
      let node = link;

      while (node && node.parentElement && node.parentElement !== cardList) {
        node = node.parentElement;
      }

      if (node && node.parentElement === cardList && node.matches && node.matches("a")) {
        return node;
      }
    }

    let node = link;

    while (node && node !== document.body) {
      const text = cleanText(node.textContent || "");

      if (text.length > 40 && node.querySelector && node.querySelector("img")) {
        return node;
      }

      node = node.parentElement;
    }

    return link;
  }

  function getListingCardList() {
    const adsList = document.querySelector('[data-testid="infinite-ads-list"]');

    if (!adsList) {
      return null;
    }

    return adsList.querySelector(":scope > div") || adsList.querySelector("div");
  }

  function getAdIdFromHref(href) {
    if (!href) {
      return "";
    }

    try {
      const url = new URL(href, window.location.origin);

      if (url.origin !== window.location.origin) {
        return "";
      }

      const match = url.pathname.match(/^\/ro\/(\d{6,})(?:\/)?$/);
      return match ? match[1] : "";
    } catch {
      return "";
    }
  }

  function hasCachedAddress(adId) {
    return Boolean(state.addressCache[adId] && state.addressCache[adId].normalizedAddress);
  }

  function cacheAddress(adId, address, source) {
    const cleanAddress = cleanText(address);

    if (!cleanAddress) {
      return false;
    }

    const normalizedAddress = normalizeForMatch(cleanAddress);
    const existing = state.addressCache[adId];

    if (existing && existing.normalizedAddress === normalizedAddress) {
      return false;
    }

    state.addressCache[adId] = {
      address: cleanAddress,
      normalizedAddress,
      updatedAt: Date.now(),
    };

    scheduleCacheWrite();
    return true;
  }

  function scheduleCacheWrite() {
    clearTimeout(state.cacheWriteTimer);
    state.cacheWriteTimer = window.setTimeout(() => {
      chrome.storage.local
        .set({ [STORAGE_KEYS.addressCache]: state.addressCache })
        .catch(() => {});
    }, CACHE_WRITE_DELAY_MS);
  }

  function isAddressCacheCleared(change) {
    if (!change || !("newValue" in change)) {
      return true;
    }

    const nextCache = sanitizeAddressCache(change.newValue);
    return !Object.keys(nextCache).length;
  }

  function resetAddressLookupState() {
    clearTimeout(state.cacheWriteTimer);
    state.cacheWriteTimer = null;
    state.queuedIds = [];
    state.pendingIds.clear();

    for (const controller of state.fetchControllers.values()) {
      controller.abort();
    }

    state.fetchControllers.clear();
  }

  function sanitizeBlockedStreets(value) {
    const streets = Array.isArray(value) ? value : [];
    const seen = new Set();
    const sanitized = [];

    for (const street of streets) {
      const normalizedStreet = normalizeForMatch(street);

      if (!normalizedStreet || seen.has(normalizedStreet)) {
        continue;
      }

      seen.add(normalizedStreet);
      sanitized.push(normalizedStreet);
    }

    return sanitized;
  }

  function sanitizeAddressCache(value) {
    const cache = value && typeof value === "object" ? value : {};
    const sanitized = {};

    for (const [adId, entry] of Object.entries(cache)) {
      if (!/^\d+$/.test(adId) || !entry || typeof entry !== "object") {
        continue;
      }

      const address = typeof entry.address === "string" ? cleanText(entry.address) : "";

      if (!address) {
        continue;
      }

      sanitized[adId] = {
        address,
        normalizedAddress: normalizeForMatch(entry.normalizedAddress || address),
        updatedAt: Number(entry.updatedAt) || 0,
      };
    }

    return sanitized;
  }

  function cleanText(value) {
    return String(value || "")
      .replace(/\u00a0/g, " ")
      .replace(/\s+/g, " ")
      .trim();
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

  function truncateForDebug(value, maxLength) {
    const cleanValue = cleanText(value);

    if (cleanValue.length <= maxLength) {
      return cleanValue;
    }

    return `${cleanValue.slice(0, maxLength)}...`;
  }

})();
