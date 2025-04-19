import {
  activateNotary,
  addTeardown,
  sudo,
  teardown,
  TestMainchain,
  TestNotary,
} from "@argonprotocol/testing";
import { MiningRotations, mnemonicGenerate } from "@argonprotocol/mainchain";
import { afterAll, afterEach, expect, it } from "bun:test";
import Bot from "../src/Bot.ts";
import * as fs from "node:fs";
import Path from "node:path";

afterEach(teardown);
afterAll(teardown);

it("can autobid and store stats", async () => {
  const chain = new TestMainchain();
  await chain.launch({ miningThreads: 1 });
  const notary = new TestNotary();
  await notary.start({
    uuid: chain.uuid,
    mainchainUrl: chain.address,
  });
  const clientPromise = chain.client();
  const client = await clientPromise;
  await activateNotary(sudo(), client, notary);

  const path = fs.mkdtempSync("/tmp/bot-");
  addTeardown({
    teardown(): Promise<void> {
      return fs.promises.rm(path, { recursive: true, force: true });
    },
  });

  const bot = new Bot({
    pair: sudo(),
    archiveRpcUrl: chain.address,
    localRpcUrl: chain.address,
    biddingRulesPath: Path.resolve(path, "rules.json"),
    datadir: path,
    keysMnemonic: mnemonicGenerate(),
  });
  await bot.autobidder.updateBiddingRules({
    maxSeats: 10,
    bidDelay: 0,
    maxBalance: 100_000_000n,
    maxBid: 1_000_000n,
    minBid: 10_000n,
    bidIncrement: 10_000n,
  });

  await expect(bot.start()).resolves.toBeTruthy();
  const status = await bot.status();
  expect(status.latestSynched).toBeGreaterThanOrEqual(status.latestFinalized);
  console.log(status);
  // wait for the first rotation
  await new Promise(async (resolve) => {
    const unsubscribe = await client.query.miningSlot.nextSlotCohort((x) => {
      if (x.length) {
        unsubscribe();
        resolve(x);
      }
    });
  });
  let voteBlocks = 0;
  let latestFinalized = 0;
  const rotationsWithEarnings = new Set<number>();
  // wait for first finalized vote block
  await new Promise(async (resolve) => {
    const unsubscribe = await client.rpc.chain.subscribeFinalizedHeads(
      async (x) => {
        const api = await client.at(x.hash);
        const isVoteBlock = await api.query.blockSeal
          .isBlockFromVoteSeal()
          .then((x) => x.isTrue);
        latestFinalized = x.number.toNumber();
        console.log(`Block ${x.number} is vote block: ${isVoteBlock}`);
        if (isVoteBlock) {
          const rotation = await new MiningRotations().getForHeader(client, x);
          if (rotation !== undefined) rotationsWithEarnings.add(rotation);
          voteBlocks++;
          if (voteBlocks > 5) {
            unsubscribe();
            resolve(x);
          }
        }
      }
    );
  });

  console.log(`First rotation earnings: ${[...rotationsWithEarnings]}`);
  expect(rotationsWithEarnings.size).toBeGreaterThan(0);

  const cohort1Stats = await bot.storage.biddingFile(1).get();
  expect(cohort1Stats).toBeTruthy();
  expect(cohort1Stats?.bids).toBeGreaterThan(0);
  expect(cohort1Stats?.argonotsPerSeat).toBeGreaterThanOrEqual(10000);
  expect(cohort1Stats?.maxBidPerSeat).toBeGreaterThan(0);
  expect(cohort1Stats?.seats).toBe(10);
  expect(cohort1Stats?.totalArgonsBid).toBe(10_000n * 10n);

  // wait for sync state to equal latest finalized
  while(true) {
    await new Promise((resolve) => setTimeout(resolve, 100));
    const status = await bot.status();
    if (status.latestSynched >= latestFinalized) break;
  }

  let argonsMined = 0n;
  for (const rotationId of rotationsWithEarnings) {
    const data = await bot.storage.earningsFile(rotationId!).get();
    expect(data).toBeDefined();
    expect(Object.keys(data!.byCohortId).length).toBeGreaterThanOrEqual(1);
    for (const [cohortId, cohortData] of Object.entries(data!.byCohortId)) {
      expect(Number(cohortId)).toBeGreaterThan(0);
      expect(cohortData.argonsMined).toBeGreaterThan(0);
      argonsMined += cohortData.argonsMined;
    }
  }
  expect(argonsMined).toBeGreaterThanOrEqual(375_000 * voteBlocks);
}, 180e3);
