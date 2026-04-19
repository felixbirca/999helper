(() => {
  const FLAG = "__999helperInjected";
  const MESSAGE_SOURCE = "999helper-page";

  if (window[FLAG]) {
    return;
  }

  window[FLAG] = true;

  function isGraphqlUrl(url) {
    return typeof url === "string" && url.includes("/graphql");
  }

  function extractAdIds(payload) {
    const ads = payload && payload.data && payload.data.searchAds && payload.data.searchAds.ads;

    if (!Array.isArray(ads)) {
      return [];
    }

    return Array.from(
      new Set(
        ads
          .map((ad) => String((ad && ad.id) || "").trim())
          .filter((id) => /^\d+$/.test(id))
      )
    );
  }

  function emitAdIds(payload) {
    const adIds = extractAdIds(payload);

    if (!adIds.length) {
      return;
    }

    window.postMessage(
      {
        source: MESSAGE_SOURCE,
        type: "searchAdsResult",
        adIds,
      },
      window.location.origin
    );
  }

  function inspectJsonPayload(url, payload) {
    if (!isGraphqlUrl(url)) {
      return;
    }

    try {
      emitAdIds(payload);
    } catch {
      return;
    }
  }

  const originalFetch = window.fetch;

  window.fetch = function patchedFetch(...args) {
    return originalFetch.apply(this, args).then((response) => {
      try {
        const requestInfo = args[0];
        const url = response.url || (requestInfo && typeof requestInfo === "object" ? requestInfo.url : requestInfo);

        if (isGraphqlUrl(url)) {
          response
            .clone()
            .json()
            .then((payload) => inspectJsonPayload(url, payload))
            .catch(() => {});
        }
      } catch {
        return response;
      }

      return response;
    });
  };

  const originalOpen = XMLHttpRequest.prototype.open;
  const originalSend = XMLHttpRequest.prototype.send;

  XMLHttpRequest.prototype.open = function patchedOpen(method, url, ...rest) {
    this.__999helperUrl = url;
    return originalOpen.call(this, method, url, ...rest);
  };

  XMLHttpRequest.prototype.send = function patchedSend(...args) {
    this.addEventListener(
      "load",
      () => {
        try {
          const url = this.responseURL || this.__999helperUrl;

          if (!isGraphqlUrl(url) || typeof this.responseText !== "string") {
            return;
          }

          inspectJsonPayload(url, JSON.parse(this.responseText));
        } catch {
          return;
        }
      },
      { once: true }
    );

    return originalSend.apply(this, args);
  };
})();
