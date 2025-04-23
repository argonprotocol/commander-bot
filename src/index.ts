import { keyringFromFile, waitForLoad } from '@argonprotocol/mainchain';
import { jsonExt, onExit, requireAll, requireEnv } from './utils.ts';
import Bot from './Bot.ts';
import express from 'express';
import createBiddingRules from './createBiddingRules.js';

// wait for crypto wasm to be loaded
await waitForLoad();

let oldestRotationToSync: number | undefined;
if (process.env.OLDEST_ROTATION_TO_SYNC) {
  oldestRotationToSync = parseInt(process.env.OLDEST_ROTATION_TO_SYNC, 10);
}
const pair = await keyringFromFile({
  filePath: requireEnv('KEYPAIR_PATH'),
  passphrase: process.env.KEYPAIR_PASSPHRASE,
});
const bot = new Bot({
  oldestRotationToSync,
  ...requireAll({
    datadir: process.env.DATADIR!,
    pair,
    biddingRulesPath: process.env.BIDDING_RULES_PATH,
    archiveRpcUrl: process.env.ARCHIVE_NODE_URL,
    localRpcUrl: process.env.LOCAL_RPC_URL,
    keysMnemonic: process.env.SESSION_KEYS_MNEMONIC,
  }),
});

const app = express();

app.get('/status', async (_req, res) => {
  const status = await bot.status();
  jsonExt(status, res);
});
app.get('/earnings/:rotationId', async (req, res) => {
  const rotationId = req.params.rotationId;
  const data = await bot.storage.earningsFile(Number(rotationId)).get();
  jsonExt(data, res);
});
app.get('/bidding/:cohortId', async (req, res) => {
  const cohortId = req.params.cohortId;
  const data = await bot.storage.biddingFile(Number(cohortId)).get();
  jsonExt(data, res);
});
app.post('/restart-bidder', async (_req, res) => {
  await bot.autobidder.restart();
  res.status(200).json({ ok: true });
});
app.use((_req, res) => {
  res.status(404).send('Not Found');
});
const server = app.listen(process.env.PORT ?? 3000, () => {
  console.log(`Server is running on port ${process.env.PORT ?? 3000}`);
});
onExit(() => new Promise<void>(resolve => server.close(() => resolve())));

await createBiddingRules(1, await bot.accountset.client, process.env.BIDDING_RULES_PATH!);
await bot.start();
onExit(() => bot.stop());
