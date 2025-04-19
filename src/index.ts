import { JsonExt, keyringFromFile } from '@argonprotocol/mainchain';
import { jsonExt, onExit, requireAll, requireEnv } from "./utils.ts";
import Bot from "./Bot.ts";

const pair = await keyringFromFile({
  filePath: requireEnv("KEYPAIR_PATH"),
  passphrase: Bun.env.KEYPAIR_PASSPHRASE,
});
const bot = new Bot(
  requireAll({
    datadir: Bun.env.DATADIR!,
    pair,
    biddingRulesPath: Bun.env.BIDDING_RULES_PATH,
    archiveRpcUrl: Bun.env.ARCHIVE_NODE_URL,
    localRpcUrl: Bun.env.LOCAL_RPC_URL,
    keysMnemonic: Bun.env.SESSION_KEYS_MNEMONIC,
  })
);

const server = Bun.serve({
  port: Bun.env.PORT ?? 3000,
  routes: {
    "/status": async () => {
      const status = await bot.status();
      return Response.json(status);
    },
    "/earnings/:rotationId": async (req) => {
      const rotationId = req.params.rotationId;
      const data = await bot.storage.earningsFile(Number(rotationId)).get();
      return jsonExt(data);
    },
    "/bidding/:cohortId": async (req) => {
      const cohortId = req.params.cohortId;
      const data = await bot.storage.biddingFile(Number(cohortId)).get();
      return jsonExt(data);
    },
    "/bidding-rules": {
      POST: async (req) => {
        const body = await req.text();
        const rules = JsonExt.parse(body)
        await bot.autobidder.updateBiddingRules(rules);
        await bot.autobidder.restart();
        return Response.json({ saved: true });
      },
    },
  },
  // fallback handler
  fetch(_req) {
    return new Response("Not Found", { status: 404 });
  },
});
onExit(() => server.stop(true));

await bot.start();
onExit(() => bot.stop());
