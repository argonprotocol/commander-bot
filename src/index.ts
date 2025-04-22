import { keyringFromFile } from '@argonprotocol/mainchain';
import { jsonExt, onExit, requireAll, requireEnv } from './utils.ts';
import Bot from './Bot.ts';
import createBiddingRules from './createBiddingRules.js';

let oldestRotationToSync: number | undefined;
if (Bun.env.OLDEST_ROTATION_TO_SYNC) {
  oldestRotationToSync = parseInt(Bun.env.OLDEST_ROTATION_TO_SYNC, 10);
}
const pair = await keyringFromFile({
  filePath: requireEnv('KEYPAIR_PATH'),
  passphrase: Bun.env.KEYPAIR_PASSPHRASE,
});
const bot = new Bot({
  oldestRotationToSync,
  ...requireAll({
    datadir: Bun.env.DATADIR!,
    pair,
    biddingRulesPath: Bun.env.BIDDING_RULES_PATH,
    archiveRpcUrl: Bun.env.ARCHIVE_NODE_URL,
    localRpcUrl: Bun.env.LOCAL_RPC_URL,
    keysMnemonic: Bun.env.SESSION_KEYS_MNEMONIC,
  }),
});

const server = Bun.serve({
  port: Bun.env.PORT ?? 3000,
  routes: {
    '/status': async () => {
      const status = await bot.status();
      return Response.json(status);
    },
    '/earnings/:rotationId': async req => {
      const rotationId = req.params.rotationId;
      const data = await bot.storage.earningsFile(Number(rotationId)).get();
      return jsonExt(data);
    },
    '/bidding/:cohortId': async req => {
      const cohortId = req.params.cohortId;
      const data = await bot.storage.biddingFile(Number(cohortId)).get();
      return jsonExt(data);
    },
    '/restart-bidder': {
      POST: async () => {
        await bot.autobidder.restart();
        return Response.json({ ok: true });
      },
    },
  },
  // fallback handler
  fetch(_req) {
    return new Response('Not Found', { status: 404 });
  },
});
onExit(() => server.stop(true));

await createBiddingRules(1, await bot.accountset.client, Bun.env.BIDDING_RULES_PATH!);
await bot.start();
onExit(() => bot.stop());
