require('dotenv').config();
const gateway = require('../src/gateway');
const { sendSlackMessage } = require('../src/gatewayHelper');

async function main() {
  console.log('Connecting to gateway...');
  await gateway.connect();
  console.log('Connected. Sending Slack message...');

  const res = await sendSlackMessage({
    target: '#mobey',
    message: 'yo',
    replyTo: null,
  });

  console.log('Response:', JSON.stringify(res, null, 2));
  process.exit(0);
}

main().catch((err) => {
  console.error('Error:', err.message);
  process.exit(1);
});
