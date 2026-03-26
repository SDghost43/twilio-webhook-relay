const express = require('express');
const bodyParser = require('body-parser');
const twilio = require('twilio');
const fetch = require('node-fetch');

const app = express();
app.use(bodyParser.urlencoded({ extended: false }));

const TWILIO_ACCOUNT_SID = process.env.TWILIO_ACCOUNT_SID;   // Starts with AC
const TWILIO_API_KEY = process.env.TWILIO_API_KEY;             // Starts with SK
const TWILIO_API_SECRET = process.env.TWILIO_API_SECRET;       // The secret/token
const TWILIO_FROM_NUMBER = process.env.TWILIO_FROM_NUMBER;
const DAD_NUMBER = process.env.DAD_NUMBER;
const DISCORD_WEBHOOK_URL = process.env.DISCORD_WEBHOOK_URL;

// Support both auth methods: API Key (SK) or Auth Token (AC)
const twilioClient = TWILIO_API_KEY
  ? twilio(TWILIO_API_KEY, TWILIO_API_SECRET, { accountSid: TWILIO_ACCOUNT_SID })
  : twilio(TWILIO_ACCOUNT_SID, TWILIO_API_SECRET);

app.post('/webhook', async (req, res) => {
  const smsFrom = req.body.From;
  const smsBody = req.body.Body;

  console.log(`Received SMS from ${smsFrom}: ${smsBody}`);

  // Only process messages from Dad's number
  if (smsFrom !== DAD_NUMBER) {
    console.log('Message from unknown number, ignoring.');
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
