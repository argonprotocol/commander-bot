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
      maxBalance: 100_000_000n,
      maxBid: 1_000_000n,
      minBid: 10_000n,
      bidIncrement: 10_000n,
    };
  });

  await expect(bot.start()).resolves.toBeTruthy();
  const status = await bot.status();
  expect(status.lastSynchedBlockNumber).toBeGreaterThanOrEqual(status.lastFinalizedBlockNumber);
  console.log(status);
  // wait for the first rotation
  await new Promise(async resolve => {
    const unsubscribe = await client.query.miningSlot.activeMinersCount(x => {
      if (x.toNumber() > 0) {
        unsubscribe();
        resolve(x);
      }
    });
  });
  let voteBlocks = 0;
  let lastFinalizedBlockNumber = 0;
  const rotationsWithEarnings = new Set<number>();
  // wait for first finalized vote block
  await new Promise(async resolve => {
    const unsubscribe = await client.rpc.chain.subscribeFinalizedHeads(async x => {
      const api = await client.at(x.hash);
      const isVoteBlock = await api.query.blockSeal.isBlockFromVoteSeal().then(x => x.isTrue);
      lastFinalizedBlockNumber = x.number.toNumber();
      if (isVoteBlock) {
        console.log(`Block ${x.number} is vote block`);
        const rotation = await new MiningRotations().getForHeader(client, x);
        if (rotation !== undefined) rotationsWithEarnings.add(rotation);
        voteBlocks++;
        if (voteBlocks > 5) {
          unsubscribe();
          resolve(x);
        }
      }
    });
  });

  console.log(`Rotations with earnings: ${[...rotationsWithEarnings]}`);
  expect(rotationsWithEarnings.size).toBeGreaterThan(0);

  const cohort1Stats = await bot.storage.biddingsFile(1).get();
  expect(cohort1Stats).toBeTruthy();
  console.log(`Cohort 1: ${cohort1Stats}`);
  expect(cohort1Stats?.argonotsPerSeat).toBeGreaterThanOrEqual(10000);
  expect(cohort1Stats?.maxBidPerSeat).toBeGreaterThan(0);
  expect(cohort1Stats?.seats).toBe(10);
  expect(cohort1Stats?.totalArgonsBid).toBe(10_000n * 10n);

  // wait for sync state to equal latest finalized
  while (true) {
    await new Promise(resolve => setTimeout(resolve, 100));
    const status = await bot.status();
    if (status.lastSynchedBlockNumber >= lastFinalizedBlockNumber) break;
  }

  const cohorts = new Set<number>();
  let argonsMined = 0n;
  for (const rotationId of rotationsWithEarnings) {
    const data = await bot.storage.earningsFile(rotationId!).get();
    expect(data).toBeDefined();
    expect(Object.keys(data!.byCohortId).length).toBeGreaterThanOrEqual(1);
    for (const [cohortId, cohortData] of Object.entries(data!.byCohortId)) {
      cohorts.add(Number(cohortId!));
      expect(Number(cohortId)).toBeGreaterThan(0);
      expect(cohortData.argonsMined).toBeGreaterThan(0);
      argonsMined += cohortData.argonsMined;
    }
  }
  expect(argonsMined).toBeGreaterThanOrEqual(375_000 * voteBlocks);

  // wait for a clean stop
  const lastProcessed = bot.blockSync.lastProcessed;
  await new Promise(resolve => {
    bot.blockSync.didProcessFinalizedBlock = x => {
      if (x.rotationId > lastProcessed!.rotationId) {
        resolve(x);
      }
    };
  });
  console.log('Stopping bot 1', {
    rotationsWithEarnings: [...rotationsWithEarnings],
    cohorts: [...cohorts],
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
    oldestRotationToSync: Math.min(...cohorts) - 1,
  });
  console.log('Starting bot 2');
  await expect(botRestart.start()).resolves.toBeTruthy();
  console.log('Stopping bot 2');
  await botRestart.stop();

  // compare directories
  for (const rotation of rotationsWithEarnings) {
    const earningsFile = await bot.storage.earningsFile(rotation).get();
    const earningsFile2 = await botRestart.storage.earningsFile(rotation).get();
    console.info('Checking earnings for rotation', rotation);
    expect(earningsFile).toBeTruthy();
    expect(earningsFile2).toBeTruthy();
    expect(earningsFile!).toEqual(earningsFile2!);
  }

  for (const cohort of cohorts) {
    const biddingsFile = await bot.storage.biddingsFile(cohort).get();
    const biddingsFile2 = await botRestart.storage.biddingsFile(cohort).get();
    console.info('Checking bidding for cohort', cohort);
    expect(biddingsFile).toBeTruthy();
    expect(biddingsFile2).toBeTruthy();
    expect(biddingsFile!).toEqual(biddingsFile2!);
  }
}, 180e3);
