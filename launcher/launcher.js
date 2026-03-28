/**
 * DD-Dad Launcher — DoorDash auto-ordering bot
 * Uses DoorDash GraphQL API to find menu items (not DOM scraping)
 * then navigates to the item page and places the order.
 */
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
const DRY_RUN = process.env.DRY_RUN === 'true'; // When true, goes through full flow but doesn't place the DoorDash order

const USER_DATA_DIR = path.join(__dirname, 'chrome-profile');
const ARTIFACTS_DIR = path.join(__dirname, 'artifacts');
fs.mkdirSync(ARTIFACTS_DIR, { recursive: true });

// ── Restaurant mapping ───────────────────────────────────────────────────────
// storeId = DoorDash store ID for Atwater, CA area
// keywords = phrases that map to this restaurant in a free-text order
// usualItems = dad's known usual orders (used for high-confidence fast matching)
const RESTAURANT_MAP = {
  "mcdonald's":    { name: "McDonald's",               storeId: '658754',    keywords: ['mcdonald', 'mcdonalds', 'mickey d', 'big mac', 'quarter pounder', 'mcnugget', 'mcchicken', 'happy meal', 'filet-o-fish', 'hotcake', 'hash brown', 'mcdouble', 'french fries'],
    usualItems: ['Big Mac® Meal', 'Hotcakes and Sausage', 'Apple Pie', 'Hash Browns', 'McDouble®', 'French Fries', 'Big Mac®'] },
  'taco bell':     { name: 'Taco Bell',                storeId: '27489317',  keywords: ['taco bell', 'tacobell', 'nachos bellgrande', 'crunchy taco', 'cheese quesadilla', 'soft taco', 'nacho'],
    usualItems: ['Nachos BellGrande®', 'Pepsi®', '3 Crunchy Tacos Supreme® Combo', 'Mild Sauce Packet', 'Cheese Quesadilla', 'Soft Taco Supreme®', 'Nachos BellGrande® Combo'] },
  "wendy's":       { name: "Wendy's",                  storeId: '1287957',   keywords: ['wendy', 'wendys', 'baconator', 'frosty', 'jr bacon', 'chili', 'breakfast burrito', 'seasoned potato'],
    usualItems: ['Chili', 'Jr. Bacon Cheeseburger', 'Breakfast Burrito (Sausage)', 'Seasoned Potatoes'] },
  "applebee's":    { name: "Applebee's Grill & Bar",   storeId: '519727',    keywords: ['applebee', 'applebees', 'riblet', 'baby back rib', 'half rack'],
    usualItems: ["Applebee's® Riblets Platter", 'Double-Glazed Baby Back Ribs', 'Half Rack Double-Glazed Baby Back Ribs'] },
  'burger king':   { name: 'Burger King',              storeId: '335111',    keywords: ['burger king', 'bk', 'whopper', 'have-sies', 'impossible whopper', 'double cheeseburger'],
    usualItems: ['Double Cheeseburger', 'Impossible™ Whopper', 'Have-sies™', 'Coca-Cola Zero Sugar', 'Impossible™ Whopper Meal'] },
  'chipotle':      { name: 'Chipotle Mexican Grill',   storeId: '350689',    keywords: ['chipotle', 'burrito bowl', 'chips salsa', 'tomatillo'],
    usualItems: ['Burrito', 'Chips & Tomatillo-Green Chili Salsa'] },
  'cold stone':    { name: 'Cold Stone Creamery',      storeId: '1361819',   keywords: ['cold stone', 'coldstone', 'ice cream creation', 'create your own'],
    usualItems: ['Create Your Own Creation'] },
  'hong kong':     { name: 'Hong Kong Chinese Restaurant', storeId: '865766', keywords: ['hong kong', 'broccoli beef', 'steam rice', 'chinese'],
    usualItems: ['Broccoli Beef', 'Steam Rice (small)'] },
  'jack in the box': { name: 'Jack in the Box',        storeId: '288286',    keywords: ['jack in the box', 'jack', 'french toast sticks', 'sourdough jack'],
    usualItems: ['6pc Classic French Toast Sticks Combo'] },
  'panda express': { name: 'Panda Express',            storeId: '24852387',  keywords: ['panda express', 'panda', 'orange chicken', 'bigger plate', 'teriyaki'],
    usualItems: ['Bowl', 'Bigger Plate', 'Plate', 'Teriyaki Sauce'] },
  'pizza hut':     { name: 'Pizza Hut',                storeId: '23701962',  keywords: ['pizza hut', 'personal pan', 'pan pizza'],
    usualItems: ['Personal Pan Pizza®'] },
  'popeyes':       { name: 'Popeyes Louisiana Kitchen', storeId: '287302',   keywords: ['popeyes', 'popeye', 'signature chicken', '2pc chicken'],
    usualItems: ['2Pc Signature Chicken Combo'] },
  'round table':   { name: 'Round Table Pizza',        storeId: '380264',    keywords: ['round table', 'garlic parmesan twist', 'classic wings', 'mozzarella stick'],
    usualItems: ['Garlic Parmesan Twists', 'Classic Wings', 'Mozzarella Sticks'] },
  'wingstop':      { name: 'Wingstop',                 storeId: '784614',    keywords: ['wingstop', 'wing combo', 'seasoned fries', '6 pc wing', '10 wings'],
    usualItems: ['Ultimate Meal Deals', '6 pc Wing Combo', '10 Wings', 'Seasoned Fries', '10 pc Wing Combo'] },
};

function detectRestaurant(text) {
  const lower = (text || '').toLowerCase();
  for (const [key, val] of Object.entries(RESTAURANT_MAP)) {
    if (lower.includes(key) || val.keywords.some(k => lower.includes(k))) return val;
  }
  return null;
}

function checkUsualItem(restaurantInfo, requestedItem) {
  if (!restaurantInfo || !restaurantInfo.usualItems) return null;
  const req = normalize(requestedItem);
  let best = null, bestScore = 0;
  for (const usual of restaurantInfo.usualItems) {
    const s = score(requestedItem, usual);
    if (s > bestScore) { bestScore = s; best = usual; }
  }
  // If high-confidence match against known usual item, return it
  if (bestScore >= 0.75) return { name: best, score: bestScore, isUsual: true };
  return null;
}

// ── Text normalization & scoring ─────────────────────────────────────────────
function normalize(text) {
  return (text || '')
    .toLowerCase()
    .replace(/[®™''.,()/:-]/g, ' ')
    .replace(/\bcombo\b/g, ' meal ')
    .replace(/\blg\b/g, ' large ')
    .replace(/\s+/g, ' ')
    .trim();
}

function extractBase(text) {
  return normalize(text).replace(/\b(large|medium|small)\b/g, ' ').replace(/\s+/g, ' ').trim();
}

function score(requested, candidate) {
  const req = extractBase(requested);
  const cand = normalize(candidate);
  const rt = req.split(' ').filter(Boolean);
  const ct = cand.split(' ').filter(Boolean);
  if (!ct.length) return 0;
  let s = (rt.filter(t => ct.includes(t)).length / Math.max(rt.length, 1)) * 0.60;
  if (cand.includes(req)) s += 0.25;
  if (req.includes('meal') && cand.includes('meal')) s += 0.10;
  if (req.includes('mac') && cand.includes('mac')) s += 0.08;
  if (req.includes('meal') && !cand.includes('meal')) s -= 0.15;
  if (req.includes('mac') && !cand.includes('mac')) s -= 0.35;
  if (cand.includes('double') && !req.includes('double')) s -= 0.15;
  return Math.max(0, Math.min(1, s));
}

function bestMatch(requested, items) {
  const scored = items
    .map(item => ({ ...item, score: score(requested, item.name) }))
    .filter(c => c.score > 0.35)
    .sort((a, b) => b.score - a.score);

  if (!scored.length) return null;
  const best = scored[0];
  if (best.score >= 0.78) return best; // take first high-confidence match (dupes are fine — same item)
  return null;
}

// ── Railway API ──────────────────────────────────────────────────────────────
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

// ── Discord notifications ────────────────────────────────────────────────────
async function notifyDiscord(order, success, message) {
  const webhookUrl = process.env.DISCORD_WEBHOOK_URL;
  if (!webhookUrl) return;
  const content = success
    ? `✅ **DoorDash order placed!**\n🏪 ${order.restaurant}\n🍔 ${order.item}\n📍 ${order.address}`
    : `⚠️ **Order failed** — ${message || 'check the browser'}\n🏪 ${order.restaurant}\n🍔 ${order.item}`;
  try {
    await fetch(webhookUrl, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ content }) });
  } catch {}
}

async function screenshot(page, tag) {
  const f = path.join(ARTIFACTS_DIR, `${Date.now()}-${tag}.png`);
  await page.screenshot({ path: f, fullPage: false }).catch(() => {});
  return f;
}

// ── Main order flow ──────────────────────────────────────────────────────────
async function placeOrder(order) {
  console.log(`\n🍔 New order!`);
  console.log(`   Restaurant: ${order.restaurant} | Item: ${order.item}`);

  const restaurant = detectRestaurant(order.restaurant) || detectRestaurant(order.item);
  if (!restaurant) {
    console.error('❌ Could not identify restaurant');
    await notifyDiscord(order, false, 'Could not identify restaurant');
    return;
  }
  console.log(`   Mapped to: ${restaurant.name} (store ${restaurant.storeId || 'unknown'})`);

  const browser = await chromium.launchPersistentContext(USER_DATA_DIR, {
    headless: false,
    viewport: { width: 1440, height: 900 },
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
    locale: 'en-US',
    timezoneId: 'America/Los_Angeles',
    args: ['--no-sandbox', '--disable-blink-features=AutomationControlled', '--start-maximized'],
  });
  const page = browser.pages()[0] || await browser.newPage();
  await page.addInitScript(() => { Object.defineProperty(navigator, 'webdriver', { get: () => undefined }); }).catch(() => {});

  try {
    // ── Step 1: Open DoorDash and ensure login ────────────────────────────────
    console.log('  → Opening DoorDash...');
    await page.goto('https://www.doordash.com', { waitUntil: 'load', timeout: 30000 });
    await page.waitForTimeout(2000);
    if (page.url().includes('/login')) {
      console.log('  → Logging in...');
      await page.fill('input[name="email"], input[type="email"]', DD_EMAIL);
      await page.fill('input[name="password"], input[type="password"]', DD_PASSWORD);
      await page.click('button[type="submit"]');
      await page.waitForTimeout(4000);
    } else {
      console.log('  → Session active');
    }

    // ── Step 2: Navigate to store and capture menu API ────────────────────────
    const storeId = restaurant.storeId;
    if (!storeId) throw new Error(`No storeId configured for ${restaurant.name} — need to add it`);

    // Intercept storepageFeed to get all menu items with IDs
    const menuItemsPromise = new Promise((resolve) => {
      const items = [];
      const handler = async (resp) => {
        if (resp.url().includes('storepageFeed') && resp.status() === 200) {
          try {
            const body = await resp.text();
            const regex = /"id":"(\d+)","name":"([^"]+)"/g;
            const seen = new Set();
            let m;
            while ((m = regex.exec(body)) !== null) {
              if (!seen.has(m[1]) && +m[1] > 100000) {
                seen.add(m[1]);
                items.push({ id: m[1], name: m[2] });
              }
            }
          } catch {}
          page.off('response', handler);
          resolve(items);
        }
      };
      page.on('response', handler);
      setTimeout(() => { page.off('response', handler); resolve(items); }, 15000);
    });

    console.log(`  → Loading store ${storeId}...`);
    await page.goto(`https://www.doordash.com/store/${storeId}/`, { waitUntil: 'load', timeout: 60000 });
    await page.waitForLoadState('networkidle', { timeout: 8000 }).catch(() => {});

    const menuItems = await menuItemsPromise;
    console.log(`  → Menu loaded: ${menuItems.length} items`);
    if (!menuItems.length) throw new Error('No menu items captured from API');

    // ── Step 3: Find best matching item ──────────────────────────────────────
    console.log(`  → Finding: "${order.item}"`);
    // Check usual items first — fast path for repeat orders
    const usualCheck = checkUsualItem(restaurant, order.item);
    if (usualCheck) console.log(`  → Usual item match: "${usualCheck.name}" (${usualCheck.score.toFixed(2)})`);
    const match = bestMatch(order.item, menuItems);

    if (!match) {
      const top5 = menuItems
        .map(i => ({ ...i, score: score(order.item, i.name) }))
        .filter(c => c.score > 0.3)
        .sort((a, b) => b.score - a.score)
        .slice(0, 5);
      const dbg = top5.map(c => `${c.name} (${c.score.toFixed(2)})`).join('; ');
      await screenshot(page, 'item-not-found');
      throw new Error(`Could not confidently match "${order.item}". Top candidates: ${dbg || 'none found'}`);
    }

    console.log(`  → Matched: "${match.name}" (${match.score.toFixed(2)}) — id ${match.id}`);

    // ── Step 4: Navigate to item page by ID ──────────────────────────────────
    const itemUrl = `https://www.doordash.com/store/${storeId}/item/${match.id}/`;
    console.log(`  → Opening item: ${itemUrl}`);
    await page.goto(itemUrl, { waitUntil: 'load', timeout: 30000 });
    await page.waitForLoadState('networkidle', { timeout: 5000 }).catch(() => {});
    await page.waitForTimeout(2000);

    // ── Step 5: Handle modifiers ─────────────────────────────────────────────
    const modalText = await page.evaluate(() => document.body.innerText.substring(0, 200));
    console.log(`  → Item page: ${modalText.replace(/\s+/g, ' ').substring(0, 100)}`);

    // Accept required options (pick first available for each required group)
    const requiredGroups = await page.$$('fieldset, [role="group"]');
    for (const group of requiredGroups.slice(0, 8)) {
      const radio = await group.$('input[type="radio"], button[role="radio"]');
      if (radio) { await radio.click().catch(() => {}); await page.waitForTimeout(200); }
    }

    // ── Step 6: Add to cart ───────────────────────────────────────────────────
    const addBtns = [
      'button:has-text("Add to Order")',
      'button:has-text("Add to Cart")',
      'button:has-text("Add to cart")',
      '[data-anchor-id="AddToOrderButton"]',
    ];
    let added = false;
    for (const sel of addBtns) {
      const btn = await page.$(sel);
      if (btn) {
        await btn.click();
        added = true;
        console.log('  → Added to cart');
        break;
      }
    }
    if (!added) {
      await screenshot(page, 'no-add-btn');
      throw new Error('Could not find Add to Cart button');
    }
    await page.waitForTimeout(2500);

    // ── Step 7: Checkout ──────────────────────────────────────────────────────
    const checkoutBtns = [
      '[data-anchor-id="CheckoutButton"]',
      'button:has-text("Go to Checkout")',
      'a:has-text("Checkout")',
      'button:has-text("Checkout")',
    ];
    for (const sel of checkoutBtns) {
      const btn = await page.$(sel);
      if (btn) { await btn.click().catch(() => {}); break; }
    }
    await page.waitForTimeout(3000);

    // ── Step 8: Place order ───────────────────────────────────────────────────
    await screenshot(page, 'pre-submit');

    if (DRY_RUN) {
      console.log('  ⚠️  DRY RUN — stopping before Place Order click');
      await notifyDiscord(order, false, '🧪 DRY RUN: Cart built successfully — order NOT placed (dry run mode)');
      await notifyDiscord(order, true); // send success-style Discord message
      console.log('  ✅ Dry run complete — cart ready, order not submitted');
      setTimeout(() => browser.close(), 5 * 60 * 1000);
      return;
    }

    const placeOrderBtns = [
      '[data-anchor-id="PlaceOrderButton"]',
      'button:has-text("Place Order")',
      'button:has-text("Place order")',
    ];
    let placed = false;
    for (const sel of placeOrderBtns) {
      const btn = await page.$(sel);
      if (btn) {
        await btn.click();
        placed = true;
        console.log('  → Order submitted!');
        break;
      }
    }
    if (!placed) throw new Error('Could not find Place Order button');

    await page.waitForTimeout(5000);
    const confirmed = await page.$('text=Your order has been placed, text=Order Confirmed, text=order is on its way').catch(() => null);
    if (confirmed) {
      await screenshot(page, 'confirmed');
      console.log('  ✅ Order confirmed!');
      await notifyDiscord(order, true);
    } else {
      await screenshot(page, 'submit-unknown');
      console.log('  ⚠️  Submit outcome unknown — check browser');
      await notifyDiscord(order, false, 'Submit outcome unknown — check browser');
    }
  } catch (err) {
    console.error(`  ❌ ${err.message}`);
    await notifyDiscord(order, false, err.message);
  }

  // Keep browser open 5 min for review then close
  setTimeout(() => browser.close(), 5 * 60 * 1000);
}

// ── Polling loop ─────────────────────────────────────────────────────────────
async function main() {
  console.log('🚀 DD-Dad Launcher started');
  console.log(`   Polling every ${POLL_INTERVAL_MS / 1000}s...`);
  while (true) {
    const order = await checkForOrder();
    if (order) await placeOrder(order);
    await new Promise(r => setTimeout(r, POLL_INTERVAL_MS));
  }
}

main().catch(err => { console.error('Fatal:', err); process.exit(1); });
