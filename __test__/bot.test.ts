import {
  activateNotary,
  runOnTeardown,
  sudo,
  teardown,
  TestMainchain,
  TestNotary,
} from '@argonprotocol/testing';
import { MiningRotations, mnemonicGenerate } from '@argonprotocol/mainchain';
import { afterAll, afterEach, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import Path from 'node:path';
import Bot from '../src/Bot.ts';
import * as BiddingCalculator from '../src/bidding-calculator/index.ts';

afterEach(teardown);
afterAll(teardown);

it('can autobid and store stats', async () => {
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

  const path = fs.mkdtempSync('/tmp/bot-');
  runOnTeardown(() => fs.promises.rm(path, { recursive: true, force: true }));

  const bot = new Bot({
    pair: sudo(),
    archiveRpcUrl: chain.address,
    localRpcUrl: chain.address,
    biddingRulesPath: Path.resolve(path, 'rules.json'),
    datadir: path,
    keysMnemonic: mnemonicGenerate(),
  });

  vi.spyOn(BiddingCalculator, 'createBidderParams').mockImplementation(async () => {
    return {
      maxSeats: 10,
      bidDelay: 0,
      maxBudget: 100_000_000n,
      maxBid: 1_000_000n,
      minBid: 10_000n,
      bidIncrement: 10_000n,
    };
  });

  await expect(bot.start()).resolves.toBeTruthy();
  const status = await bot.status();
  expect(status.lastBlockNumber).toBeGreaterThanOrEqual(status.lastFinalizedBlockNumber);
  console.log(status);
  let firstCohort = 1;
  // wait for the first rotation
  await new Promise(async resolve => {
    const unsubscribe = await client.query.miningSlot.activeMinersCount(async x => {
      if (x.toNumber() > 0) {
        unsubscribe();
        firstCohort = await client.query.miningSlot.nextCohortId().then(x => x.toNumber() - 1);
        resolve(x);
      }
    });
  });
  let voteBlocks = 0;
  let lastFinalizedBlockNumber = 0;
  const cohortFrameIdsWithEarnings = new Set<number>();
  // wait for first finalized vote block
  await new Promise(async resolve => {
    const unsubscribe = await client.rpc.chain.subscribeFinalizedHeads(async x => {
      const api = await client.at(x.hash);
      const isVoteBlock = await api.query.blockSeal.isBlockFromVoteSeal().then(x => x.isTrue);
      lastFinalizedBlockNumber = x.number.toNumber();
      if (isVoteBlock) {
        console.log(`Block ${x.number} is vote block`);
        const frameId = await new MiningRotations().getForHeader(client, x);
        if (frameId !== undefined) cohortFrameIdsWithEarnings.add(frameId);
        voteBlocks++;
        if (voteBlocks > 5) {
          unsubscribe();
          resolve(x);
        }
      }
    });
  });

  console.log(
    `Rotations with earnings: ${[...cohortFrameIdsWithEarnings]}. First cohort ${firstCohort}`,
  );
  expect(cohortFrameIdsWithEarnings.size).toBeGreaterThan(0);

  const cohort1Bids = await bot.storage.bidsFile(firstCohort).get();
  expect(cohort1Bids).toBeTruthy();
  console.log(`Cohort 1`, cohort1Bids);
  expect(cohort1Bids?.argonotsStakedPerSeat).toBeGreaterThanOrEqual(10000);
  expect(cohort1Bids?.seatsWon).toBe(10);
  expect(cohort1Bids?.argonsBidTotal).toBe(10_000n * 10n);

  // wait for sync state to equal latest finalized
  while (true) {
    await new Promise(resolve => setTimeout(resolve, 100));
    const status = await bot.status();
    if (status.lastBlockNumber >= lastFinalizedBlockNumber) break;
  }

  const cohortFrameIds = new Set<number>();
  let argonsMined = 0n;
  for (const frameId of cohortFrameIdsWithEarnings) {
    const earningsData = await bot.storage.earningsFile(frameId!).get();
    expect(earningsData).toBeDefined();
    expect(Object.keys(earningsData!.byCohortFrameId).length).toBeGreaterThanOrEqual(1);
    for (const [cohortFrameId, cohortData] of Object.entries(earningsData!.byCohortFrameId)) {
      cohortFrameIds.add(Number(cohortFrameId!));
      expect(Number(cohortFrameId)).toBeGreaterThan(0);
      expect(cohortData.argonsMined).toBeGreaterThan(0);
      argonsMined += cohortData.argonsMined;
    }
  }
  expect(argonsMined).toBeGreaterThanOrEqual(375_000 * voteBlocks);

  // wait for a clean stop
  const lastProcessed = bot.blockSync.lastProcessed;
  await new Promise(resolve => {
    bot.blockSync.didProcessFinalizedBlock = x => {
      if (x.frameId > lastProcessed!.frameId) {
        resolve(x);
      }
    };
  });
  console.log('Stopping bot 1', {
    cohortFrameIdsWithEarnings: [...cohortFrameIdsWithEarnings],
    cohortFrameIds: [...cohortFrameIds],
  });
  await bot.stop();

  // try to recover from blocks

  const path2 = fs.mkdtempSync('/tmp/bot2-');
  runOnTeardown(() => fs.promises.rm(path2, { recursive: true, force: true }));
  const botRestart = new Bot({
    pair: sudo(),
    archiveRpcUrl: chain.address,
    localRpcUrl: chain.address,
    biddingRulesPath: Path.resolve(path, 'rules.json'),
    datadir: path2,
    keysMnemonic: mnemonicGenerate(),
    oldestFrameIdToSync: Math.min(...cohortFrameIds) - 1,
  });
  console.log('Starting bot 2');
  await expect(botRestart.start()).resolves.toBeTruthy();
  console.log('Stopping bot 2');
  await botRestart.stop();

  // compare directories
  for (const cohortFrameId of cohortFrameIdsWithEarnings) {
    const earningsFile1 = await bot.storage.earningsFile(cohortFrameId).get();
    const earningsFile2 = await botRestart.storage.earningsFile(cohortFrameId).get();
    console.info('Checking earnings for rotation', cohortFrameId);
    expect(earningsFile1).toBeTruthy();
    expect(earningsFile2).toBeTruthy();
    expect(earningsFile1!).toEqual(earningsFile2!);
  }

  for (const cohortFrameId of cohortFrameIds) {
    const bidsFile1 = await bot.storage.bidsFile(cohortFrameId).get();
    const bidsFile2 = await botRestart.storage.bidsFile(cohortFrameId).get();
    console.info('Checking bidding for cohort', cohortFrameId);
    expect(bidsFile1).toBeTruthy();
    expect(bidsFile2).toBeTruthy();
    expect(bidsFile1!).toEqual(bidsFile2!);
  }
}, 180e3);
