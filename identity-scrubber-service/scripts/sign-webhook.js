// Sign a Polar webhook payload and print a ready-to-run curl command.
//
// This stands in for Polar (the sender): it computes the Standard Webhooks
// signature over the exact bytes you'll POST, so the service's verifyAndParse()
// accepts the replay. Only needed for local/offline testing — in production
// Polar signs real deliveries itself.
//
// Usage:
//   node scripts/sign-webhook.js [payloadFile] [url]
//   node scripts/sign-webhook.js /tmp/polar_payload.json http://localhost:3030/api/polar/webhook
//
// The signature is valid for ~5 minutes (Standard Webhooks timestamp
// tolerance). Re-run to mint a fresh one. The key handling mirrors the SDK's
// validateEvent exactly (base64(utf8(secret))), so the request verifies.

require('dotenv/config');
const fs = require('fs');
const { Webhook } = require('standardwebhooks');

const payloadFile = process.argv[2] || '/tmp/polar_payload.json';
const url =
  process.argv[3] ||
  `http://localhost:${process.env.PORT ?? 3030}/api/polar/webhook`;

const secret = process.env.POLAR_WEBHOOK_SECRET;
if (!secret) {
  console.error('POLAR_WEBHOOK_SECRET is not set (load it from .env)');
  process.exit(1);
}

// Read the EXACT bytes we'll send so the signature matches what curl posts.
const body = fs.readFileSync(payloadFile, 'utf8');

// Mirror the SDK: validateEvent does new Webhook(base64(utf8(secret))).
const wh = new Webhook(Buffer.from(secret, 'utf-8').toString('base64'));

const msgId = `msg_test_${Date.now()}`;
const ts = new Date();
const signature = wh.sign(msgId, ts, body); // returns "v1,<base64sig>"
const webhookTimestamp = Math.floor(ts.getTime() / 1000);

const curl = [
  `curl -sS -i -X POST '${url}'`,
  `  -H 'Content-Type: application/json'`,
  `  -H 'webhook-id: ${msgId}'`,
  `  -H 'webhook-timestamp: ${webhookTimestamp}'`,
  `  -H 'webhook-signature: ${signature}'`,
  `  --data-binary @${payloadFile}`,
].join(' \\\n');

console.log(curl);
