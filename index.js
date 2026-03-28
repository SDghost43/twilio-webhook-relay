const express = require('express');
const bodyParser = require('body-parser');
const fetch = require('node-fetch');

const app = express();
app.use(bodyParser.urlencoded({ extended: false }));
app.use(bodyParser.json());

const SW_PROJECT_ID = process.env.SW_PROJECT_ID;
const SW_API_TOKEN = process.env.SW_API_TOKEN;
const SW_SPACE_URL = process.env.SW_SPACE_URL;
const FROM_NUMBER = process.env.TWILIO_FROM_NUMBER;
const DAD_NUMBER = process.env.DAD_NUMBER;
const JAMES_NUMBER = process.env.JAMES_NUMBER;
const TEST_NUMBER = process.env.TEST_NUMBER;
const DEBUG_MODE = process.env.DEBUG_MODE === 'true'; // When true, all SMS go to James instead of dad

function smsTo(number) {
  // In debug mode, redirect dad's number to James so we don't bother dad
  if (DEBUG_MODE && number === DAD_NUMBER) {
    console.log(`[DEBUG] Redirecting SMS from ${number} to ${JAMES_NUMBER}`);
    return JAMES_NUMBER;
  }
  return number;
}
const DISCORD_WEBHOOK_URL = process.env.DISCORD_WEBHOOK_URL;
const DAD_ADDRESS = process.env.DAD_ADDRESS || '2713 Emerald Ct., Atwater, CA 95301';
const LAUNCHER_SECRET = process.env.LAUNCHER_SECRET || 'doordash-secret';

// Use direct HTTPS instead of the SDK — avoids trial verification check bug

// In-memory state
const conversations = new Map();
let pendingOrder = null;

const STATE = {
  IDLE: 'idle',
  AWAITING_ITEM_CONFIRM: 'awaiting_item_confirm',
  AWAITING_JAMES_CONFIRM: 'awaiting_james_confirm',
};

const menuMap = {
  'hamburger': 'Big Mac Meal (Large)',
  'burger': 'Big Mac Meal (Large)',
  'big mac': 'Big Mac Meal (Large)',
  'whopper': 'Whopper Meal (Large)',
  'fries': 'Large Fries',
  'chicken': 'Chicken Sandwich Meal',
  'pizza': 'Large Pizza',
  'taco': 'Taco Combo Meal',
  'burrito': 'Burrito',
  'nuggets': 'Chicken McNuggets (10 pc)',
};

function suggestItem(text) {
  const lower = text.toLowerCase();
  for (const [key, val] of Object.entries(menuMap)) {
    if (lower.includes(key)) return val;
  }
  return null;
}

function parseOrder(text) {
  const patterns = [
    /(?:i want|get me|order|id like|i'd like|gimme|can i get)\s+(?:a|an|some)?\s*(.+?)\s+from\s+(.+)/i,
    /(.+?)\s+from\s+(.+)/i,
  ];
  for (const pattern of patterns) {
    const match = text.match(pattern);
    if (match) return { item: match[1].trim(), restaurant: match[2].trim() };
  }
  return { item: text.trim(), restaurant: null };
}

function isConfirmation(text) {
  return /^(yes|yep|yeah|yup|y|ok|okay|sure|correct|confirm|right|thats right|that's right|sounds good|go ahead|do it|1)$/i.test(text.trim());
}

function isCancellation(text) {
  return /^(no|nope|cancel|stop|nevermind|never mind|n)$/i.test(text.trim());
}

async function sendSMS(to, message) {
  try {
    const url = `https://${SW_SPACE_URL}/api/laml/2010-04-01/Accounts/${SW_PROJECT_ID}/Messages.json`;
    const auth = Buffer.from(`${SW_PROJECT_ID}:${SW_API_TOKEN}`).toString('base64');
    const params = new URLSearchParams({ From: FROM_NUMBER, To: to, Body: message });
    const resp = await fetch(url, {
      method: 'POST',
      headers: {
        'Authorization': `Basic ${auth}`,
        'Content-Type': 'application/x-www-form-urlencoded'
      },
      body: params.toString()
    });
    const data = await resp.json();
    if (!resp.ok) {
      console.error(`SMS send error (HTTP ${resp.status}): ${JSON.stringify(data)}`);
    } else {
      console.log(`SMS sent to ${to} — status: ${data.status}`);
    }
  } catch (err) {
    console.error('SMS send error:', err.message);
  }
}

async function notifyDiscord(content) {
  if (!DISCORD_WEBHOOK_URL) return;
  try {
    await fetch(DISCORD_WEBHOOK_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content })
    });
  } catch (err) {
    console.error('Discord notify error:', err.message);
  }
}

app.post('/webhook', async (req, res) => {
  const smsFrom = req.body.From;
  const smsBody = (req.body.Body || '').trim();

  console.log(`SMS from ${smsFrom}: ${smsBody}`);
  res.send('<Response></Response>');

  const isFromDad = smsFrom === DAD_NUMBER || smsFrom === TEST_NUMBER;
  const isFromJames = smsFrom === JAMES_NUMBER;
  const hasPendingOrder = conversations.has('james_pending');

  console.log(`isFromDad=${isFromDad} isFromJames=${isFromJames} hasPendingOrder=${hasPendingOrder}`);

  // James approval flow (only when pending order exists or not also dad)
  if (isFromJames && (!isFromDad || hasPendingOrder)) {
    if (isConfirmation(smsBody) && hasPendingOrder) {
      const order = conversations.get('james_pending');
      conversations.delete('james_pending');
      pendingOrder = { ...order, confirmedAt: Date.now() };

      await sendSMS(JAMES_NUMBER, `✅ Got it! Opening DoorDash on your laptop now...`);
      await sendSMS(smsTo(DAD_NUMBER), `Great news! Your order is being placed now. 🍔 Estimated arrival: 35-45 mins. Enjoy!`);
      await notifyDiscord(`✅ **Order confirmed by James!** Opening DoorDash now...\n🏪 ${order.restaurant} — ${order.item}\n📍 ${order.address}`);

    } else if (isCancellation(smsBody) && hasPendingOrder) {
      conversations.delete('james_pending');
      await sendSMS(JAMES_NUMBER, `❌ Order cancelled.`);
      await sendSMS(smsTo(DAD_NUMBER), `Hey! We had a small issue with your order. Please try again or call James. Sorry!`);
    } else {
      console.log(`James: no pending order or unrecognized message`);
    }
    return;
  }

  if (!isFromDad) {
    console.log(`Unknown number ${smsFrom}, ignoring`);
    return;
  }

  // Dad's conversation flow
  const conv = conversations.get(DAD_NUMBER) || { state: STATE.IDLE };

  if (conv.state === STATE.AWAITING_ITEM_CONFIRM) {
    if (isConfirmation(smsBody)) {
      const order = conv.order;
      conversations.set(DAD_NUMBER, { state: STATE.AWAITING_JAMES_CONFIRM, order });
      conversations.set('james_pending', order);

      await sendSMS(smsTo(DAD_NUMBER), `Perfect! I'm sending it to James for approval. You'll get a text once it's placed! 🍔`);
      await sendSMS(JAMES_NUMBER,
        `📦 Dad's DoorDash Order:\n🏪 ${order.restaurant}\n🍔 ${order.item}\n📍 ${order.address}\n\nReply CONFIRM to place or CANCEL to reject.`
      );
      await notifyDiscord(
        `📦 **NEW ORDER FROM DAD**\n👤 From: ${DAD_NUMBER}\n🏪 Restaurant: **${order.restaurant}**\n🍔 Item: **${order.item}**\n📍 Deliver to: **${order.address}**\n\nWaiting for James to reply CONFIRM/CANCEL via SMS.`
      );

    } else if (isCancellation(smsBody)) {
      conversations.set(DAD_NUMBER, { state: STATE.IDLE });
      await sendSMS(smsTo(DAD_NUMBER), `No problem! Order cancelled. Text me anytime! 😊`);

    } else {
      const { item, restaurant } = parseOrder(smsBody);
      const finalItem = suggestItem(item) || item;
      const finalRestaurant = restaurant || conv.order.restaurant;
      const order = { item: finalItem, restaurant: finalRestaurant, address: DAD_ADDRESS };
      conversations.set(DAD_NUMBER, { state: STATE.AWAITING_ITEM_CONFIRM, order });
      await sendSMS(smsTo(DAD_NUMBER),
        `Got it! So you want:\n🍔 ${finalItem}\n🏪 from ${finalRestaurant}\n📍 to ${DAD_ADDRESS}\n\nDoes that sound right? (Yes/No)`
      );
    }
    return;
  }

  // New order
  const { item, restaurant } = parseOrder(smsBody);
  if (!restaurant) {
    await sendSMS(smsTo(DAD_NUMBER), `Hey! What restaurant do you want? Example: "I want a burger from McDonald's"`);
    return;
  }

  const finalItem = suggestItem(item) || item;
  const order = { item: finalItem, restaurant, address: DAD_ADDRESS };
  conversations.set(DAD_NUMBER, { state: STATE.AWAITING_ITEM_CONFIRM, order });

  await sendSMS(smsTo(DAD_NUMBER),
    `Hey! Got your order 😊\n🍔 ${finalItem}\n🏪 from ${restaurant}\n📍 to ${DAD_ADDRESS}\n\nDoes that sound right? Reply YES to confirm or tell me what to change.`
  );
});

// Laptop polling endpoint
app.get('/api/pending-order', (req, res) => {
  const secret = req.headers['x-launcher-secret'] || req.query.secret;
  if (secret !== LAUNCHER_SECRET) return res.status(401).json({ error: 'Unauthorized' });
  if (pendingOrder) {
    const order = pendingOrder;
    pendingOrder = null;
    return res.json({ order });
  }
  res.json({ order: null });
});

app.get('/', (req, res) => res.send('DoorDash Order Bot is running! 🍔'));

const PORT = process.env.PORT || 5000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
