import { CohortStorage } from './storage.ts';
import { BlockSync } from './BlockSync.ts';
import { Accountset, getClient, keyringFromFile } from '@argonprotocol/mainchain';
import { jsonExt, onExit } from './utils.ts';
import { AutoBidder } from './AutoBidder.ts';

const storage = new CohortStorage(Bun.env.DATADIR);

const pair = await keyringFromFile({
  filePath: Bun.env.KEYPAIR_PATH,
  passphrase: Bun.env.KEYPAIR_PASSPHRASE,
});
const client = getClient(Bun.env.LOCAL_RPC_URL);
const accountset = new Accountset({
  client,
  seedAccount: pair,
});

const autoBidder = new AutoBidder(
  accountset,
  storage,
  Bun.env.BIDDING_RULES_PATH
);
const blockSync = new BlockSync(accountset, storage, Bun.env.ARCHIVE_NODE_URL);

Bun.serve({
  port: Bun.env.PORT ?? 3000,
  routes: {
    "/status": async () => {
      const status = await blockSync.status();
      return Response.json(status);
    },
    "/earnings/:rotationId": async (req) => {
      const rotationId = req.params.rotationId;
      const data = await storage.earningsFile(Number(rotationId)).get();
      return jsonExt(data);
    },
    "/bidding/:cohortId": async (req) => {
      const cohortId = req.params.cohortId;
      const data = await storage.biddingFile(Number(cohortId)).get();
      return jsonExt(data);
    },
    "/bidding-rules": {
      POST: async (req) => {
        const body = await req.json();
        await autoBidder.rulesFile.write(JSON.stringify(body));
        await autoBidder.restart();
        return Response.json({ saved: true });
      },
    },
  },
  // fallback handler
  fetch(_req) {
    return new Response("Not Found", { status: 404 });
  },
});

await blockSync.start();
await autoBidder.start();
onExit(async () => {
  await blockSync.stop();
  await autoBidder.stop();
});
