require('dotenv').config();
const gateway = require('../src/gateway');

async function main() {
  console.log('Connecting to gateway...');
  await gateway.connect();
  console.log('Connected. Sending test with bad param to see schema...');

  const id = gateway.generateId();
  const res = await gateway.send({
    id,
    type: 'req',
    method: 'send',
    params: {
      channel: 'slack',
      to: '#mobey',
      message: 'schema test - ignore',
      idempotencyKey: id,
      replyTo: 'test',
      BOGUS: 'trigger-validation',
    },
  });

  console.log('Response:', JSON.stringify(res, null, 2));
  process.exit(0);
}

main().catch((err) => {
  console.error('Error:', err.message);
  process.exit(1);
});
