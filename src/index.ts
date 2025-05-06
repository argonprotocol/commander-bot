import { waitForLoad } from '@argonprotocol/mainchain';
import { keyringFromFile } from '@argonprotocol/mainchain/clis';
import { jsonExt, onExit, requireAll, requireEnv } from './utils.ts';
import Bot from './Bot.ts';
import express from 'express';

// wait for crypto wasm to be loaded
await waitForLoad();

let earliestFrameIdToSync: number | undefined;
if (process.env.EARLIEST_FRAME_ID_TO_SYNC) {
  earliestFrameIdToSync = parseInt(process.env.EARLIEST_FRAME_ID_TO_SYNC, 10);
}
const pair = await keyringFromFile({
  filePath: requireEnv('KEYPAIR_PATH'),
  passphrase: process.env.KEYPAIR_PASSPHRASE,
});
const bot = new Bot({
  earliestFrameIdToSync: earliestFrameIdToSync,
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
app.get('/bids', async (_req, res) => {
  const currentFrameId = await bot.currentFrameId();
  const nextFrameId = currentFrameId + 1;
  const data = await bot.storage.bidsFile(nextFrameId).get();
  jsonExt(data, res);
});
app.get('/bids/:frameIdAtCohortActivation', async (req, res) => {
  const frameIdAtCohortActivation = Number(req.params.frameIdAtCohortActivation);
  const data = await bot.storage.bidsFile(frameIdAtCohortActivation).get();
  jsonExt(data, res);
});
app.get('/earnings/:frameIdAtCohortActivation', async (req, res) => {
  const frameIdAtCohortActivation = Number(req.params.frameIdAtCohortActivation);
  const data = await bot.storage.earningsFile(frameIdAtCohortActivation).get();
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

await bot.start();
onExit(() => bot.stop());
