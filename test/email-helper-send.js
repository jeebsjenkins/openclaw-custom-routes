#!/usr/bin/env node
require('dotenv').config();

const { sendEmail } = require('../src/emailHelper');

function parseArgs(argv) {
  const args = argv.slice(2);
  const out = {
    to: 'nbrownevs@gmail.com',
    subject: `emailHelper test ${new Date().toISOString()}`,
    text: 'This is a test email sent by test/email-helper-send.js using src/emailHelper.js.',
  };

  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if ((a === '--to' || a === '-t') && args[i + 1]) {
      out.to = args[++i];
      continue;
    }
    if ((a === '--subject' || a === '-s') && args[i + 1]) {
      out.subject = args[++i];
      continue;
    }
    if ((a === '--text' || a === '-b') && args[i + 1]) {
      out.text = args[++i];
      continue;
    }
  }

  return out;
}

async function main() {
  const { to, subject, text } = parseArgs(process.argv);

  if (!process.env.FASTMAIL_USER || !process.env.FASTMAIL_APP_PASSWORD) {
    console.error('Missing FASTMAIL_USER or FASTMAIL_APP_PASSWORD in environment.');
    process.exit(1);
  }

  console.log(`Sending test email to ${to}...`);
  const res = await sendEmail({
    to,
    subject,
    text,
  });

  console.log('Email sent.');
  console.log(JSON.stringify({
    messageId: res?.messageId || null,
    accepted: res?.accepted || [],
    rejected: res?.rejected || [],
    response: res?.response || null,
  }, null, 2));
}

main().catch((err) => {
  console.error(`Send failed: ${err.message}`);
  process.exit(1);
});

