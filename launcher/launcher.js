require('dotenv').config();
const { chromium } = require('playwright');
const fetch = require('node-fetch');
const path = require('path');

const RAILWAY_URL = process.env.RAILWAY_URL;
const LAUNCHER_SECRET = process.env.LAUNCHER_SECRET;
const DD_EMAIL = process.env.DD_EMAIL;
const DD_PASSWORD = process.env.DD_PASSWORD;
const POLL_INTERVAL_MS = 30000; // poll every 30 seconds

// Persistent browser profile so DoorDash keeps us logged in
const USER_DATA_DIR = path.join(__dirname, 'chrome-profile');

// ── Menu mappings per restaurant ──────────────────────────────────────────────
// Each entry maps keywords to DoorDash search/item strings
const RESTAURANT_MAP = {
  "mcdonald's": { name: "McDonald's", keywords: ['mcdonald', 'mcdonalds', 'mickey d', 'big mac', 'quarter pounder', 'mcnugget', 'mcchicken', 'happy meal', 'fillet-o-fish'] },
  "taco bell": { name: "Taco Bell", keywords: ['taco bell', 'tacobell', 'taco', 'burrito', 'quesadilla', 'chalupa', 'crunchwrap', 'nacho', 'gordita', 'crunch wrap'] },
  "wendy's": { name: "Wendy's", keywords: ['wendy', 'wendys', 'baconator', 'frosty', 'dave', 'spicy chicken'] },
};

function detectRestaurant(restaurantText) {
  const lower = restaurantText.toLowerCase();
  for (const [key, val] of Object.entries(RESTAURANT_MAP)) {
    if (lower.includes(key) || val.keywords.some(k => lower.includes(k))) {
      return val.name;
    }
  }
  return restaurantText; // fallback: use as-is
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

async function placeOrder(order) {
  console.log(`\n🍔 New order detected!`);
  console.log(`   Restaurant: ${order.restaurant}`);
  console.log(`   Item: ${order.item}`);
  console.log(`   Address: ${order.address}`);

  const restaurantName = detectRestaurant(order.restaurant);
  console.log(`   Mapped to: ${restaurantName}`);

  const browser = await chromium.launchPersistentContext(USER_DATA_DIR, {
    headless: false,
    viewport: { width: 1280, height: 800 },
    args: ['--no-sandbox', '--disable-blink-features=AutomationControlled'],
  });

  const page = browser.pages()[0] || await browser.newPage();

  try {
    // ── Step 1: Go to DoorDash ────────────────────────────────────────────────
    console.log('  → Opening DoorDash...');
    await page.goto('https://www.doordash.com', { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.waitForTimeout(2000);

    // ── Step 2: Reuse saved login session if possible ────────────────────────
    // DoorDash changes selectors a lot, so prefer the persisted browser profile.
    const currentUrl = page.url();
    const looksLoggedOut = currentUrl.includes('/login') || currentUrl.includes('/consumer/login');

    if (looksLoggedOut) {
      console.log('  → DoorDash still wants login; trying once with saved credentials...');
      await page.goto('https://www.doordash.com/login', { waitUntil: 'domcontentloaded', timeout: 30000 });
      await page.waitForTimeout(2000);

      const emailInput = await page.$('input[name="email"], input[type="email"], input[autocomplete="email"]');
      const passwordInput = await page.$('input[name="password"], input[type="password"], input[autocomplete="current-password"]');

      if (!emailInput || !passwordInput) {
        throw new Error('DoorDash login page did not expose recognizable email/password fields. Log into the Playwright Chrome window manually once, then retry.');
      }

      await emailInput.fill(DD_EMAIL);
      await page.waitForTimeout(500);
      await passwordInput.fill(DD_PASSWORD);
      await page.waitForTimeout(500);

      const submitBtn = await page.$('button[type="submit"], button:has-text("Sign In"), button:has-text("Continue")');
      if (!submitBtn) {
        throw new Error('Could not find DoorDash login submit button.');
      }

      await submitBtn.click();
      await page.waitForTimeout(4000);
      console.log('  → Login submitted');
    } else {
      console.log('  → Reusing saved DoorDash session');
    }

    // ── Step 3: Search for restaurant ────────────────────────────────────────
    console.log(`  → Searching for ${restaurantName}...`);
    await page.goto(`https://www.doordash.com/search/store/${encodeURIComponent(restaurantName)}`, {
      waitUntil: 'domcontentloaded',
      timeout: 30000
    });
    await page.waitForTimeout(2000);

    // Open first restaurant result by href instead of clicking (DoorDash overlays intercept clicks)
    const storeLink = await page.$('a[data-anchor-id="StoreCard"], [data-anchor-id="StoreListItem"] a[href*="/store/"], a[href*="/store/"]');

    if (!storeLink) {
      throw new Error(`Could not find ${restaurantName} in search results`);
    }

    const href = await storeLink.getAttribute('href');
    if (!href) {
      throw new Error(`Found ${restaurantName} result but could not read its link`);
    }

    const storeUrl = href.startsWith('http') ? href : `https://www.doordash.com${href}`;
    console.log(`  → Opening store directly: ${storeUrl}`);
    await page.goto(storeUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.waitForTimeout(3000);
    console.log(`  → Opened ${restaurantName}`);

    // ── Step 4: Search for item ───────────────────────────────────────────────
    console.log(`  → Looking for item: ${order.item}`);

    // Try clicking the search icon within the restaurant
    const menuSearch = await page.$('[data-anchor-id="MenuSearch"]') ||
                       await page.$('input[placeholder*="Search"]') ||
                       await page.$('[aria-label*="Search"]');

    if (menuSearch) {
      await menuSearch.click();
      await page.waitForTimeout(500);

      // Extract core item name (first 1-2 words usually)
      const searchTerm = order.item.split(' ').slice(0, 3).join(' ');
      await page.keyboard.type(searchTerm, { delay: 80 });
      await page.waitForTimeout(1500);
    }

    // Click first menu item that appears
    const menuItem = await page.$('[data-anchor-id="MenuItem"]') ||
                     await page.$('[data-testid="menuItem"]') ||
                     await page.$('[data-anchor-id="MenuItemButton"]');

    if (!menuItem) {
      throw new Error(`Could not find item "${order.item}" on menu`);
    }
    await menuItem.click();
    await page.waitForTimeout(2000);
    console.log('  → Item selected');

    // ── Step 5: Handle modifiers/customization ────────────────────────────────
    // Click through any required modifier groups (pick first option)
    const requiredGroups = await page.$$('[data-anchor-id="ItemCustomizationSection"][data-required="true"]');
    for (const group of requiredGroups) {
      const firstOption = await group.$('input[type="radio"], input[type="checkbox"]');
      if (firstOption) await firstOption.click();
      await page.waitForTimeout(300);
    }

    // ── Step 6: Add to cart ───────────────────────────────────────────────────
    const addToCart = await page.$('[data-anchor-id="AddToOrderButton"]') ||
                      await page.$('button:has-text("Add to Order")') ||
                      await page.$('button:has-text("Add to Cart")');

    if (!addToCart) {
      throw new Error('Could not find Add to Cart button');
    }
    await addToCart.click();
    await page.waitForTimeout(2000);
    console.log('  → Added to cart');

    // ── Step 7: Go to checkout ────────────────────────────────────────────────
    const checkout = await page.$('[data-anchor-id="CheckoutButton"]') ||
                     await page.$('button:has-text("Go to Checkout")') ||
                     await page.$('a:has-text("Checkout")');

    if (checkout) {
      await checkout.click();
      await page.waitForTimeout(3000);
      console.log('  → At checkout');
    }

    // ── Step 8: Place order ───────────────────────────────────────────────────
    const placeOrderBtn = await page.$('[data-anchor-id="PlaceOrderButton"]') ||
                          await page.$('button:has-text("Place Order")');

    if (!placeOrderBtn) {
      throw new Error('Could not find Place Order button — may need manual review');
    }

    console.log('  → Placing order...');
    await placeOrderBtn.click();
    await page.waitForTimeout(5000);

    // Check if order was placed (look for confirmation)
    const confirmation = await page.$('[data-anchor-id="OrderConfirmation"]') ||
                         await page.$('text=Your order has been placed') ||
                         await page.$('text=Order Confirmed');

    if (confirmation) {
      console.log('  ✅ Order placed successfully!');
      await notifyDiscord(order, true);
    } else {
      console.log('  ⚠️  Could not confirm order placed — check browser window');
      await notifyDiscord(order, false);
    }

  } catch (err) {
    console.error(`  ❌ Error placing order: ${err.message}`);
    await notifyDiscord(order, false, err.message);
    // Leave browser open so James can manually complete
  }

  // Keep browser open for 5 minutes then close
  setTimeout(() => browser.close(), 5 * 60 * 1000);
}

async function notifyDiscord(order, success, error) {
  const webhookUrl = process.env.DISCORD_WEBHOOK_URL;
  if (!webhookUrl) return;

  const content = success
    ? `✅ **DoorDash order placed!**\n🏪 ${order.restaurant}\n🍔 ${order.item}\n📍 ${order.address}`
    : `⚠️ **Order automation failed** — please check the browser\n🏪 ${order.restaurant}\n🍔 ${order.item}\n${error ? `❌ ${error}` : ''}`;

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

// ── Main polling loop ─────────────────────────────────────────────────────────
async function main() {
  console.log('🚀 DD-Dad Launcher started');
  console.log(`   Polling Railway every ${POLL_INTERVAL_MS / 1000}s...`);

  while (true) {
    const order = await checkForOrder();
    if (order) {
      await placeOrder(order);
    }
    await new Promise(resolve => setTimeout(resolve, POLL_INTERVAL_MS));
  }
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
