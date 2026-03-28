require('dotenv').config();
const { chromium } = require('playwright');
const fetch = require('node-fetch');
const path = require('path');
const fs = require('fs');

const RAILWAY_URL = process.env.RAILWAY_URL;
const LAUNCHER_SECRET = process.env.LAUNCHER_SECRET;
const DD_EMAIL = process.env.DD_EMAIL;
const DD_PASSWORD = process.env.DD_PASSWORD;
const POLL_INTERVAL_MS = 30000;

const USER_DATA_DIR = path.join(__dirname, 'chrome-profile');
const ARTIFACTS_DIR = path.join(__dirname, 'artifacts');
fs.mkdirSync(ARTIFACTS_DIR, { recursive: true });

const AUTO_MATCH_THRESHOLD = 0.78;

const RESTAURANT_MAP = {
  "mcdonald's": { name: "McDonald's", keywords: ['mcdonald', 'mcdonalds', 'mickey d', 'big mac', 'quarter pounder', 'mcnugget', 'mcchicken', 'happy meal', 'fillet-o-fish'] },
  'taco bell': { name: 'Taco Bell', keywords: ['taco bell', 'tacobell', 'taco', 'burrito', 'quesadilla', 'chalupa', 'crunchwrap', 'nacho', 'gordita'] },
  "wendy's": { name: "Wendy's", keywords: ['wendy', 'wendys', 'baconator', 'frosty', 'dave', 'spicy chicken'] },
};

const ITEM_ALIASES = {
  "McDonald's": {
    'big mac meal': ['big mac meal', 'big mac® meal', 'big mac combo'],
    'quarter pounder meal': ['quarter pounder with cheese meal', 'quarter pounder® with cheese meal', 'quarter pounder meal'],
    'mcchicken meal': ['mcchicken meal', 'mcchicken® meal'],
    '10 piece nuggets meal': ['10 pc. chicken mcnuggets® meal', '10 pc nuggets meal', '10 piece nuggets meal']
  },
  'Taco Bell': {},
  "Wendy's": {}
};

function detectRestaurant(restaurantText) {
  const lower = (restaurantText || '').toLowerCase();
  for (const [key, val] of Object.entries(RESTAURANT_MAP)) {
    if (lower.includes(key) || val.keywords.some(k => lower.includes(k))) return val.name;
  }
  return restaurantText;
}

function normalizeText(text) {
  return (text || '')
    .toLowerCase()
    .replace(/[®™'’.,()/:-]/g, ' ')
    .replace(/\bcombo\b/g, ' meal ')
    .replace(/\blg\b/g, ' large ')
    .replace(/\bsm\b/g, ' small ')
    .replace(/\bmed\b/g, ' medium ')
    .replace(/\s+/g, ' ')
    .trim();
}

function extractBaseItem(itemText) {
  let t = normalizeText(itemText);
  t = t.replace(/\b(large|medium|small)\b/g, ' ').replace(/\s+/g, ' ').trim();
  return t;
}

function buildSearchTerms(restaurantName, itemText) {
  const base = extractBaseItem(itemText);
  const aliases = ITEM_ALIASES[restaurantName] || {};
  const terms = new Set([base]);
  for (const [canonical, vals] of Object.entries(aliases)) {
    if (base.includes(canonical) || canonical.includes(base)) {
      vals.forEach(v => terms.add(normalizeText(v)));
    }
  }
  const words = base.split(' ').filter(Boolean);
  if (words.length >= 2) terms.add(words.slice(0, 2).join(' '));
  if (words.length >= 1) terms.add(words[0]);
  return [...terms].filter(Boolean);
}

function scoreCandidate(requestedItem, candidateText) {
  const req = extractBaseItem(requestedItem);
  const cand = normalizeText(candidateText);
  const reqTokens = req.split(' ').filter(Boolean);
  const candTokens = cand.split(' ').filter(Boolean);
  if (!candTokens.length) return 0;

  let score = 0;
  const overlap = reqTokens.filter(t => candTokens.includes(t)).length;
  score += (overlap / Math.max(reqTokens.length, 1)) * 0.65;
  if (cand.includes(req)) score += 0.22;
  if (req.includes('meal') && cand.includes('meal')) score += 0.08;
  if (req.includes('mac') && cand.includes('mac')) score += 0.10;
  if (req.includes('meal') && !cand.includes('meal')) score -= 0.15;
  if (req.includes('mac') && !cand.includes('mac')) score -= 0.35;
  if (cand.includes('double') && !req.includes('double')) score -= 0.15;
  return Math.max(0, Math.min(1, score));
}

async function collectTextCandidates(page) {
  // DoorDash doesn't use data-anchor-id on menu items — extract via page text + elements
  const results = await page.evaluate(() => {
    const items = [];
    const seen = new Set();
    // Walk all leaf-ish elements
    const els = document.querySelectorAll('span, p, h1, h2, h3, h4, button, a, div[role="button"]');
    for (const el of els) {
      const t = (el.textContent || '').trim();
      if (!t || t.length < 4 || t.length > 120) continue;
      if (seen.has(t)) continue;
      seen.add(t);
      // Get a clickable ancestor
      let clickable = el;
      let parent = el.parentElement;
      for (let i = 0; i < 5 && parent; i++) {
        if (parent.tagName === 'A' || parent.tagName === 'BUTTON' ||
            parent.getAttribute('role') === 'button' ||
            parent.onclick) {
          clickable = parent;
          break;
        }
        parent = parent.parentElement;
      }
      items.push({ text: t, tag: clickable.tagName, selector: null });
    }
    return items;
  });

  // Now get actual handles for the menu-relevant items
  const out = [];
  const seen = new Set();
  for (const item of results) {
    const norm = normalizeText(item.text);
    if (!norm || norm.length < 4 || norm.length > 80) continue;
    if (seen.has(norm)) continue;
    seen.add(norm);
    // Find clickable handle by exact text match
    const handle = await page.locator(`text="${item.text}"`).first().elementHandle().catch(() => null);
    if (handle) out.push({ handle, text: norm, raw: item.text });
  }
  return out;
}

async function tryBuyAgain(page, itemText) {
  const candidates = await collectTextCandidates(page);
  const matches = candidates
    .map(c => ({ ...c, score: scoreCandidate(itemText, c.text) + (c.text.includes('again') ? 0.05 : 0) }))
    .filter(c => c.score >= 0.55 && (/again|buy again|reorder|order again|recent/i.test(c.raw)));
  matches.sort((a, b) => b.score - a.score);
  return matches[0] || null;
}

async function clearMenuSearch(page) {
  const menuSearch = await page.$('[data-anchor-id="MenuSearch"], input[placeholder*="Search"], [aria-label*="Search"]');
  if (!menuSearch) return false;
  await menuSearch.click().catch(() => {});
  await page.waitForTimeout(250);
  try { await page.keyboard.press('Control+A'); } catch {}
  try { await page.keyboard.press('Meta+A'); } catch {}
  await page.keyboard.press('Backspace').catch(() => {});
  await page.waitForTimeout(600);
  return true;
}

async function checkForOrder() {
  try {
    const resp = await fetch(`${RAILWAY_URL}/api/pending-order?secret=${LAUNCHER_SECRET}`);
    const data = await resp.json();
    return data.order || null;
  } catch (err) {
    console.error('Poll error:', err.message);
    return null;
  }
}

async function takeScreenshot(page, prefix) {
  const file = path.join(ARTIFACTS_DIR, `${Date.now()}-${prefix}.png`);
  await page.screenshot({ path: file, fullPage: true }).catch(() => {});
  return file;
}

async function findMenuItem(page, restaurantName, itemText) {
  const searchTerms = buildSearchTerms(restaurantName, itemText);
  console.log(`  → Search terms: ${searchTerms.join(' | ')}`);

  // Pass 0: try Buy Again / Recently Ordered / Order Again shortcuts first
  const buyAgain = await tryBuyAgain(page, itemText);
  if (buyAgain && buyAgain.score >= 0.75) {
    console.log(`  → Buy Again candidate: ${buyAgain.text} (${buyAgain.score.toFixed(2)})`);
    return { handle: buyAgain.handle, debug: [`buy-again: ${buyAgain.text} (${buyAgain.score.toFixed(2)})`] };
  }

  let bestOverall = [];

  // Pass 1-3: search terms
  for (const term of searchTerms.slice(0, 3)) {
    const menuSearch = await page.$('[data-anchor-id="MenuSearch"], input[placeholder*="Search"], [aria-label*="Search"]');
    if (menuSearch) {
      await clearMenuSearch(page);
      await page.keyboard.type(term, { delay: 60 });
      await page.waitForTimeout(1800);
    }

    const candidates = (await collectTextCandidates(page))
      .map(c => ({ ...c, score: scoreCandidate(itemText, c.text) }))
      .filter(c => c.score > 0.42)
      .sort((a, b) => b.score - a.score);

    if (candidates.length) {
      console.log(`  → Candidates for "${term}":`);
      candidates.slice(0, 3).forEach(c => console.log(`     - ${c.text} (${c.score.toFixed(2)})`));
      bestOverall = [...bestOverall, ...candidates.slice(0, 5)];
      const best = candidates[0];
      const second = candidates[1];
      if (best.score >= AUTO_MATCH_THRESHOLD && (!second || best.score - second.score >= 0.08)) {
        return { handle: best.handle, debug: candidates.slice(0, 3).map(c => `${c.text} (${c.score.toFixed(2)})`) };
      }
    }
  }

  // Pass 4: clear search and scan full visible menu / categories
  await clearMenuSearch(page);
  await page.waitForTimeout(800);
  for (let i = 0; i < 3; i++) {
    await page.mouse.wheel(0, 900).catch(() => {});
    await page.waitForTimeout(700);
  }
  const pageWideCandidates = (await collectTextCandidates(page))
    .map(c => ({ ...c, score: scoreCandidate(itemText, c.text) }))
    .filter(c => c.score > 0.38)
    .sort((a, b) => b.score - a.score);

  if (pageWideCandidates.length) {
    console.log('  → Page-wide candidates:');
    pageWideCandidates.slice(0, 5).forEach(c => console.log(`     - ${c.text} (${c.score.toFixed(2)})`));
    bestOverall = [...bestOverall, ...pageWideCandidates.slice(0, 5)];
    const best = pageWideCandidates[0];
    const second = pageWideCandidates[1];
    if (best.score >= AUTO_MATCH_THRESHOLD && (!second || best.score - second.score >= 0.08)) {
      return { handle: best.handle, debug: pageWideCandidates.slice(0, 5).map(c => `${c.text} (${c.score.toFixed(2)})`) };
    }
  }

  const dedup = [];
  const seen = new Set();
  for (const c of bestOverall.sort((a, b) => b.score - a.score)) {
    const key = c.text;
    if (seen.has(key)) continue;
    seen.add(key);
    dedup.push(c);
  }

  return { handle: null, debug: dedup.slice(0, 5).map(c => `${c.text} (${c.score.toFixed(2)})`) };
}

async function placeOrder(order) {
  console.log(`\n🍔 New order detected!`);
  console.log(`   Restaurant: ${order.restaurant}`);
  console.log(`   Item: ${order.item}`);
  console.log(`   Address: ${order.address}`);

  const restaurantName = detectRestaurant(order.restaurant);
  console.log(`   Mapped to: ${restaurantName}`);

  const browser = await chromium.launchPersistentContext(USER_DATA_DIR, {
    headless: false,
    viewport: { width: 1440, height: 900 },
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
    locale: 'en-US',
    timezoneId: 'America/Los_Angeles',
    args: ['--no-sandbox', '--disable-blink-features=AutomationControlled', '--start-maximized'],
  });
  const page = browser.pages()[0] || await browser.newPage();
  // Mask webdriver detection
  await page.addInitScript(() => {
    Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
  }).catch(() => {});

  try {
    console.log('  → Opening DoorDash...');
    await page.goto('https://www.doordash.com', { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.waitForTimeout(2000);

    const currentUrl = page.url();
    const looksLoggedOut = currentUrl.includes('/login') || currentUrl.includes('/consumer/login');
    if (looksLoggedOut) {
      console.log('  → DoorDash still wants login; trying once with saved credentials...');
      await page.goto('https://www.doordash.com/login', { waitUntil: 'domcontentloaded', timeout: 30000 });
      await page.waitForTimeout(2000);
      const emailInput = await page.$('input[name="email"], input[type="email"], input[autocomplete="email"]');
      const passwordInput = await page.$('input[name="password"], input[type="password"], input[autocomplete="current-password"]');
      if (!emailInput || !passwordInput) throw new Error('DoorDash login fields not found.');
      await emailInput.fill(DD_EMAIL);
      await passwordInput.fill(DD_PASSWORD);
      const submitBtn = await page.$('button[type="submit"], button:has-text("Sign In"), button:has-text("Continue")');
      if (!submitBtn) throw new Error('Could not find DoorDash login submit button.');
      await submitBtn.click();
      await page.waitForTimeout(4000);
      console.log('  → Login submitted');
    } else {
      console.log('  → Reusing saved DoorDash session');
    }

    console.log(`  → Searching for ${restaurantName}...`);
    await page.goto(`https://www.doordash.com/search/store/${encodeURIComponent(restaurantName)}`, {
      waitUntil: 'domcontentloaded', timeout: 30000
    });
    await page.waitForTimeout(2000);

    const storeLink = await page.$('a[data-anchor-id="StoreCard"], [data-anchor-id="StoreListItem"] a[href*="/store/"], a[href*="/store/"]');
    if (!storeLink) throw new Error(`Could not find ${restaurantName} in search results`);
    const href = await storeLink.getAttribute('href');
    if (!href) throw new Error(`Found ${restaurantName} result but could not read its link`);
    // Strip cursor/junk params — stale cursor causes DoorDash to not load menu
    const rawUrl = href.startsWith('http') ? href : `https://www.doordash.com${href}`;
    let storeUrl;
    try {
      const u = new URL(rawUrl);
      u.searchParams.delete('cursor');
      u.searchParams.delete('pi');
      // Keep pickup=false so it stays in delivery mode
      storeUrl = u.toString();
    } catch {
      storeUrl = rawUrl;
    }

    // Log all menu/store API responses so we can see if data is fetching
    page.on('response', resp => {
      const url = resp.url();
      if (/store|menu|item/i.test(url) && !/analytics|segment|sentry|cdn|image|font/i.test(url)) {
        console.log(`  → API ${resp.status()} ${url.substring(0, 120)}`);
      }
    });

    console.log(`  → Opening store: ${storeUrl}`);
    await page.goto(storeUrl, { waitUntil: 'load', timeout: 60000 });

    // Wait for networkidle briefly
    await page.waitForLoadState('networkidle', { timeout: 8000 }).catch(() => {});
    await page.waitForTimeout(1500);

    // Scroll to trigger intersection-observer lazy sections
    console.log('  → Scrolling to trigger lazy content...');
    for (let i = 0; i < 10; i++) {
      await page.mouse.wheel(0, 900).catch(() => {});
      await page.waitForTimeout(500);
    }
    await page.mouse.wheel(0, -99999).catch(() => {});
    await page.waitForTimeout(1000);

    // Wait for visible menu content — DoorDash uses no data-anchor-id on menu items
    // Items appear as span/div/p text nodes inside clickable containers
    const menuSelectors = [
      'span:has-text("Big Mac")',
      'span:has-text("Extra Value Meals")',
      'span:has-text("Burgers")',
      'span:has-text("Chicken")',
      'div:has-text("Add to Cart")',
      'button:has-text("Add")',
    ];
    let foundMenuSelector = null;
    for (const sel of menuSelectors) {
      try {
        await page.locator(sel).first().waitFor({ state: 'visible', timeout: 3000 });
        foundMenuSelector = sel;
        console.log(`  → Menu visible via: ${sel}`);
        break;
      } catch {}
    }
    if (!foundMenuSelector) console.log('  ⚠️  No menu selector matched, doing broad text scan');

    // Quick text sample
    const pageText = await page.evaluate(() => document.body.innerText.substring(0, 600));
    const textSample = pageText.replace(/\s+/g, ' ').substring(0, 250);
    console.log(`  → Page text: ${textSample}`);

    console.log(`  → Looking for item: ${order.item}`);
    const match = await findMenuItem(page, restaurantName, order.item);
    if (!match.handle) {
      const screenshot = await takeScreenshot(page, 'item-not-found');
      throw new Error(`Could not confidently find item "${order.item}" on menu. Screenshot: ${screenshot}${match.debug.length ? ` | Candidates: ${match.debug.join('; ')}` : ''}`);
    }

    await match.handle.click();
    await page.waitForTimeout(2000);
    console.log('  → Item selected');

    const requiredGroups = await page.$$('[data-anchor-id="ItemCustomizationSection"], [data-testid*="customization"], fieldset');
    for (const group of requiredGroups.slice(0, 8)) {
      const firstOption = await group.$('input[type="radio"], input[type="checkbox"], button[role="radio"], button[role="checkbox"]');
      if (firstOption) {
        await firstOption.click().catch(() => {});
        await page.waitForTimeout(250);
      }
    }

    const addToCart = await page.$('[data-anchor-id="AddToOrderButton"], button:has-text("Add to Order"), button:has-text("Add to cart"), button:has-text("Add to Cart")');
    if (!addToCart) {
      const screenshot = await takeScreenshot(page, 'missing-add-to-cart');
      throw new Error(`Could not find Add to Cart button. Screenshot: ${screenshot}`);
    }
    await addToCart.click();
    await page.waitForTimeout(2500);
    console.log('  → Added to cart');

    const checkout = await page.$('[data-anchor-id="CheckoutButton"], button:has-text("Go to Checkout"), a:has-text("Checkout")');
    if (checkout) {
      await checkout.click().catch(() => {});
      await page.waitForTimeout(3000);
      console.log('  → At checkout');
    }

    const preSubmitShot = await takeScreenshot(page, 'pre-submit');
    const placeOrderBtn = await page.$('[data-anchor-id="PlaceOrderButton"], button:has-text("Place Order")');
    if (!placeOrderBtn) {
      throw new Error(`Could not find Place Order button — manual review needed. Screenshot: ${preSubmitShot}`);
    }

    console.log('  → Placing order...');
    await placeOrderBtn.click();
    await page.waitForTimeout(5000);

    const confirmation = await page.$('[data-anchor-id="OrderConfirmation"], text=Your order has been placed, text=Order Confirmed');
    if (confirmation) {
      const confirmShot = await takeScreenshot(page, 'order-confirmed');
      console.log('  ✅ Order placed successfully!');
      await notifyDiscord(order, true, `Confirmation screenshot: ${confirmShot}`);
    } else {
      const screenshot = await takeScreenshot(page, 'submit-unknown');
      console.log('  ⚠️  Could not confirm order placed — check browser window');
      await notifyDiscord(order, false, `Submit outcome unknown. Screenshot: ${screenshot}`);
    }
  } catch (err) {
    console.error(`  ❌ Error placing order: ${err.message}`);
    await notifyDiscord(order, false, err.message);
  }

  setTimeout(() => browser.close(), 5 * 60 * 1000);
}

async function notifyDiscord(order, success, error) {
  const webhookUrl = process.env.DISCORD_WEBHOOK_URL;
  if (!webhookUrl) return;
  const content = success
    ? `✅ **DoorDash order placed!**\n🏪 ${order.restaurant}\n🍔 ${order.item}\n📍 ${order.address}\n${error || ''}`
    : `⚠️ **Order automation failed**\n🏪 ${order.restaurant}\n🍔 ${order.item}\n${error ? `❌ ${error}` : ''}`;
  try {
    await fetch(webhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content })
    });
  } catch (err) {
    console.error('Discord notify error:', err.message);
  }
}

async function main() {
  console.log('🚀 DD-Dad Launcher started');
  console.log(`   Polling Railway every ${POLL_INTERVAL_MS / 1000}s...`);
  while (true) {
    const order = await checkForOrder();
    if (order) await placeOrder(order);
    await new Promise(resolve => setTimeout(resolve, POLL_INTERVAL_MS));
  }
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
