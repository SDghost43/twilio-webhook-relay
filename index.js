const express = require('express');
const bodyParser = require('body-parser');
const twilio = require('twilio');
const fetch = require('node-fetch');

const app = express();
app.use(bodyParser.urlencoded({ extended: false }));
app.use(bodyParser.json());

const TWILIO_ACCOUNT_SID = process.env.TWILIO_ACCOUNT_SID;
const TWILIO_AUTH_TOKEN = process.env.TWILIO_AUTH_TOKEN;
const TWILIO_FROM_NUMBER = process.env.TWILIO_FROM_NUMBER;
const DAD_NUMBER = process.env.DAD_NUMBER;
const JAMES_NUMBER = process.env.JAMES_NUMBER;
const DISCORD_WEBHOOK_URL = process.env.DISCORD_WEBHOOK_URL;
const DAD_ADDRESS = process.env.DAD_ADDRESS || '2713 Emerald Ct., Atwater, CA 95301';
const LAUNCHER_SECRET = process.env.LAUNCHER_SECRET || 'doordash-secret';

const twilioClient = twilio(TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN);

// In-memory state
const conversations = new Map(); // phone -> { state, order, restaurant, address }
let pendingOrder = null; // Order waiting for launcher to pick up

// States
const STATE = {
  IDLE: 'idle',
  AWAITING_ITEM_CONFIRM: 'awaiting_item_confirm',
  AWAITING_JAMES_CONFIRM: 'awaiting_james_confirm',
  CONFIRMED: 'confirmed'
};

// Simple menu suggestions
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
    if (match) {
      return { item: match[1].trim(), restaurant: match[2].trim() };
    }
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
    await twilioClient.messages.create({
      body: message,
      from: TWILIO_FROM_NUMBER,
      to: to
    });
  } catch (err) {
    console.error('SMS send error:', err.message);
  }
}

async function notifyDiscord(order) {
  if (!DISCORD_WEBHOOK_URL) return;
  await fetch(DISCORD_WEBHOOK_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      content: [
        `📦 **NEW ORDER FROM DAD**`,
        `👤 From: ${DAD_NUMBER}`,
        `🏪 Restaurant: **${order.restaurant}**`,
        `🍔 Item: **${order.item}**`,
        `📍 Deliver to: **${order.address}**`,
        ``,
        `✅ Reply CONFIRM to Twilio (${TWILIO_FROM_NUMBER}) to place order`,
        `❌ Reply CANCEL to reject`
      ].join('\n')
    })
  });
}

// Main SMS webhook
app.post('/webhook', async (req, res) => {
  const smsFrom = req.body.From;
  const smsBody = (req.body.Body || '').trim();

  console.log(`SMS from ${smsFrom}: ${smsBody}`);
  res.send('<Response></Response>');

  const TEST_NUMBER = process.env.TEST_NUMBER;
  const isFromDad = smsFrom === DAD_NUMBER || smsFrom === TEST_NUMBER;
  const isFromJames = smsFrom === JAMES_NUMBER;

  console.log(`DAD_NUMBER="${DAD_NUMBER}" JAMES_NUMBER="${JAMES_NUMBER}" FROM="${smsFrom}" isFromDad=${isFromDad} isFromJames=${isFromJames}`);

  // ── JAMES confirming/cancelling ──
  // If number matches both (testing), route to James only when there's a pending order to approve
  const hasPendingOrder = conversations.has('james_pending');
  if (isFromJames && (!isFromDad || hasPendingOrder)) {
    if (isConfirmation(smsBody) && conversations.get('james_pending')) {
      const order = conversations.get('james_pending');
      conversations.delete('james_pending');

      // Set pending order for laptop to pick up
      pendingOrder = { ...order, confirmedAt: Date.now() };

      await sendSMS(JAMES_NUMBER, `✅ Got it! Opening DoorDash on your laptop now...`);
      await sendSMS(DAD_NUMBER, `Great news! Your order is being placed now. 🍔 Estimated arrival: 35-45 mins. Enjoy!`);

      // Notify Discord
      if (DISCORD_WEBHOOK_URL) {
        await fetch(DISCORD_WEBHOOK_URL, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            content: `✅ **Order confirmed by James!** Opening DoorDash now...\n🏪 ${order.restaurant} — ${order.item}\n📍 ${order.address}`
          })
        });
      }

    } else if (isCancellation(smsBody) && conversations.get('james_pending')) {
      conversations.delete('james_pending');
      await sendSMS(JAMES_NUMBER, `❌ Order cancelled.`);
      await sendSMS(DAD_NUMBER, `Hey! We had a small issue with your order. Please try texting again or call James. Sorry about that!`);
    } else {
      console.log(`James said: ${smsBody} — no pending order or unrecognized`);
    }
    return;
  }

  // ── DAD's conversation ──
  if (!isFromDad) {
    console.log(`Unknown number ${smsFrom}, ignoring`);
    return;
  }

  const conv = conversations.get(DAD_NUMBER) || { state: STATE.IDLE };

  if (conv.state === STATE.AWAITING_ITEM_CONFIRM) {
    if (isConfirmation(smsBody)) {
      // Dad confirmed the order
      const order = conv.order;
      conversations.set(DAD_NUMBER, { state: STATE.AWAITING_JAMES_CONFIRM, order });

      // Store for James
      conversations.set('james_pending', order);

      await sendSMS(DAD_NUMBER, `Perfect! I'm sending it to James for approval. You'll get a text once it's placed! 🍔`);
      await sendSMS(JAMES_NUMBER,
        `📦 Dad's DoorDash Order:\n` +
        `🏪 ${order.restaurant}\n` +
        `🍔 ${order.item}\n` +
        `📍 ${order.address}\n\n` +
        `Reply CONFIRM to place or CANCEL to reject.`
      );
      await notifyDiscord(order);

    } else if (isCancellation(smsBody)) {
      conversations.set(DAD_NUMBER, { state: STATE.IDLE });
      await sendSMS(DAD_NUMBER, `No problem! Order cancelled. Text me anytime you want to order food! 😊`);

    } else {
      // Dad is changing/clarifying the order
      const { item, restaurant } = parseOrder(smsBody);
      const suggestion = suggestItem(item);
      const finalItem = suggestion || item;
      const finalRestaurant = restaurant || conv.order.restaurant;
      const order = { item: finalItem, restaurant: finalRestaurant, address: DAD_ADDRESS };

      conversations.set(DAD_NUMBER, { state: STATE.AWAITING_ITEM_CONFIRM, order });
      await sendSMS(DAD_NUMBER,
        `Got it! So you want:\n` +
        `🍔 ${finalItem}\n` +
        `🏪 from ${finalRestaurant}\n` +
        `📍 to ${DAD_ADDRESS}\n\n` +
        `Does that sound right? (Yes/No)`
      );
    }
    return;
  }

  // New order (idle state)
  const { item, restaurant } = parseOrder(smsBody);

  if (!restaurant) {
    await sendSMS(DAD_NUMBER, `Hey! What restaurant do you want to order from? For example: "I want a burger from McDonald's"`);
    return;
  }

  const suggestion = suggestItem(item);
  const finalItem = suggestion || item;
  const order = { item: finalItem, restaurant, address: DAD_ADDRESS };

  conversations.set(DAD_NUMBER, { state: STATE.AWAITING_ITEM_CONFIRM, order });

  await sendSMS(DAD_NUMBER,
    `Hey! Got your order 😊\n` +
    `🍔 ${finalItem}\n` +
    `🏪 from ${restaurant}\n` +
    `📍 to ${DAD_ADDRESS}\n\n` +
    `Does that sound right? Reply YES to confirm or tell me what to change.`
  );
});

// ── Laptop polling endpoint ──
app.get('/api/pending-order', (req, res) => {
  const secret = req.headers['x-launcher-secret'] || req.query.secret;
  if (secret !== LAUNCHER_SECRET) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  if (pendingOrder) {
    const order = pendingOrder;
    pendingOrder = null; // Clear after pickup
    return res.json({ order });
  }

  res.json({ order: null });
});

app.get('/', (req, res) => res.send('DoorDash Order Bot is running! 🍔'));

const PORT = process.env.PORT || 5000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
