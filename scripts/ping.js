require('dotenv').config();

const target = process.env.KEEP_ALIVE_URL || process.env.PUBLIC_URL;
if (!target) {
  console.error('Set KEEP_ALIVE_URL or PUBLIC_URL before running the health pinger.');
  process.exit(1);
}

fetch(`${target.replace(/\/$/, '')}/healthz`)
  .then(async (response) => {
    if (!response.ok) throw new Error(`Health check returned ${response.status}`);
    console.log(`Healthy: ${await response.text()}`);
  })
  .catch((error) => {
    console.error(`Health check failed: ${error.message}`);
    process.exitCode = 1;
  });
