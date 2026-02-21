require('dotenv').config();
const { sendSlackMessage } = require('../src/slackHelper');

async function main() {
  console.log('Sending Slack message...');

  const res = await sendSlackMessage({
    channel: '#mobey',
    message: 'yo',
  });

  console.log('Response:', JSON.stringify(res, null, 2));
  process.exit(0);
}

main().catch((err) => {
  console.error('Error:', err.message);
  process.exit(1);
});
