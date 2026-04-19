# 999.md Street Filter

Chrome extension for `999.md` that hides apartment listings from the RO real-estate list when the resolved ad address contains a blocked street name.

## Current Scope

- Chrome only
- Romanian apartments list only
- Target page: `https://999.md/ro/list/real-estate/apartments-and-rooms*`
- Partial street matching

## How It Works

1. A page script intercepts GraphQL responses from `https://999.md/graphql`.
2. When a `SearchAds`-shaped response arrives, the extension collects the ad ids.
3. The content script fetches `https://999.md/ro/<adId>` for unseen ads.
4. It parses the detail page and extracts the `Regiunea:` address block.
5. If the normalized address contains a blocked street substring, the corresponding ad card is hidden from the UI.

## Load In Chrome

1. Open `chrome://extensions`.
2. Enable Developer mode.
3. Click Load unpacked.
4. Select this folder.

## Notes

- The address cache is stored in `chrome.storage.local`.
- The popup manages blocked street filters.
- The implementation only supports `/ro/...` pages for now.
