// Amazon.ca — Phase 2, BEST-EFFORT. Aggressive anti-bot; expect frequent
// breakage and CAPTCHAs. Marked 'beta'. Uses Playwright and reads the standard
// price containers. Never let its failures affect other dealers.
import { makeLoader, parsePrice, result } from './base.js';

const CURRENCY_RE = /([\d]{1,3}(?:,\d{3})*(?:\.\d{2})|\d+\.\d{2})/;

export default {
  dealer: 'Amazon.ca',
  needsJs: true,

  async scrape(productUrl) {
    const load = makeLoader({ needsJs: true, waitFor: '#corePrice_feature_div, #corePriceDisplay_desktop_feature_div, .a-price' });
    const $ = await load(productUrl);

    const readPrice = (sel) => {
      const whole = $(sel).find('.a-price-whole').first().text().replace(/[^\d]/g, '');
      const frac = $(sel).find('.a-price-fraction').first().text().replace(/[^\d]/g, '');
      if (whole) return parsePrice(`${whole}.${frac || '00'}`);
      const off = $(sel).find('.a-offscreen').first().text();
      const m = off.match(CURRENCY_RE);
      return m ? parsePrice(m[1]) : null;
    };

    let price = readPrice('#corePriceDisplay_desktop_feature_div') ?? readPrice('#corePrice_feature_div') ?? readPrice('body');
    let regular_price = null;
    const wasTxt = $('.basisPrice .a-offscreen, [data-a-strike="true"] .a-offscreen').first().text();
    const wm = wasTxt.match(CURRENCY_RE);
    if (wm) regular_price = parsePrice(wm[1]);

    if (price == null) throw new Error('Amazon.ca price not found (likely bot-check / CAPTCHA)');

    const bodyTxt = $('#availability').text().toLowerCase() || $('body').text().toLowerCase();
    let in_stock = null;
    if (/in stock/.test(bodyTxt)) in_stock = true;
    else if (/out of stock|unavailable|currently unavailable/.test(bodyTxt)) in_stock = false;

    return result({ price, regular_price, in_stock });
  },

  async search(modelNumber) {
    const load = makeLoader({ needsJs: true, waitFor: 'a[href*="/dp/"]' });
    let $;
    try { $ = await load(`https://www.amazon.ca/s?k=${encodeURIComponent(modelNumber)}`); } catch { return []; }
    const seen = new Set();
    const out = [];
    $('a[href*="/dp/"]').each((_, el) => {
      let href = $(el).attr('href') || '';
      const m = href.match(/\/dp\/([A-Z0-9]{10})/);
      if (!m) return;
      const clean = `https://www.amazon.ca/dp/${m[1]}`;
      if (seen.has(clean)) return;
      seen.add(clean);
      const title = $(el).text().trim().slice(0, 160);
      out.push({ url: clean, title, price: null });
    });
    return out.slice(0, 15);
  },
};
