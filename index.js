const express = require('express');
const bodyParser = require('body-parser');
const twilio = require('twilio');
const fetch = require('node-fetch');

const app = express();
app.use(bodyParser.urlencoded({ extended: false }));

const TWILIO_ACCOUNT_SID = process.env.TWILIO_ACCOUNT_SID;
const TWILIO_AUTH_TOKEN = process.env.TWILIO_AUTH_TOKEN;
const TWILIO_FROM_NUMBER = process.env.TWILIO_FROM_NUMBER;
const DAD_NUMBER = process.env.DAD_NUMBER;
const DISCORD_WEBHOOK_URL = process.env.DISCORD_WEBHOOK_URL;

const twilioClient = twilio(TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN);

app.post('/webhook', async (req, res) => {
  const smsFrom = req.body.From;
  const smsBody = req.body.Body;

  console.log(`Received SMS from ${smsFrom}: ${smsBody}`);

  // Log all incoming messages for debugging
  console.log(`DAD_NUMBER configured as: ${DAD_NUMBER}`);
  console.log(`Message from: ${smsFrom}`);

  // Only process messages from Dad's number (or any number if DAD_NUMBER not set)
  if (DAD_NUMBER && smsFrom !== DAD_NUMBER) {
    console.log('Message from unknown number, ignoring.');
    // Still forward to Discord for debugging
    if (DISCORD_WEBHOOK_URL) {
      await fetch(DISCORD_WEBHOOK_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          content: `⚠️ **SMS received from unknown number** (${smsFrom}):\n> ${smsBody}\n*(Not forwarded — not Dad's number)*`
        })
      });
    }
    return res.send('<Response></Response>');
  }

  // Forward to Discord channel via webhook
  if (DISCORD_WEBHOOK_URL) {
    await fetch(DISCORD_WEBHOOK_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        content: `📦 **ORDER from Dad** (+${smsFrom}):\n> ${smsBody}`
      })
    });
  }

  // Send acknowledgment SMS back to Dad
  await twilioClient.messages.create({
    body: "Got your order! I'm working on it now. You'll get a confirmation once it's placed. 🍔",
    from: TWILIO_FROM_NUMBER,
    to: DAD_NUMBER
  });

  res.send('<Response></Response>');
});

app.get('/', (req, res) => res.send('Twilio Webhook Relay is running!'));

const PORT = process.env.PORT || 5000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
