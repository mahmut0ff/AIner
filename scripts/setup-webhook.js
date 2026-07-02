'use strict';

// Run this once after deploying to Netlify to register the webhook:
// TELEGRAM_TOKEN=xxx NETLIFY_URL=https://your-site.netlify.app node scripts/setup-webhook.js

const token = process.env.TELEGRAM_TOKEN;
const url = process.env.NETLIFY_URL;

if (!token || !url) {
  console.error('Usage: TELEGRAM_TOKEN=xxx NETLIFY_URL=https://your-site.netlify.app node scripts/setup-webhook.js');
  process.exit(1);
}

const webhookUrl = `${url}/.netlify/functions/webhook`;

fetch(`https://api.telegram.org/bot${token}/setWebhook`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ url: webhookUrl, drop_pending_updates: true }),
})
  .then((r) => r.json())
  .then((data) => {
    if (data.ok) {
      console.log(`✅ Webhook set: ${webhookUrl}`);
    } else {
      console.error('❌ Failed:', data);
    }
  })
  .catch(console.error);
