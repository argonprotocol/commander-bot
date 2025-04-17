import {
  AccountMiners,
  type Accountset,
  type ArgonClient,
  convertFixedU128ToBigNumber,
  type FrameSystemEventRecord,
  type GenericEvent,
  getAuthorFromHeader,
  getClient,
  getTickFromHeader,
  type Header,
  MiningRotations,
  type SignedBlock,
  type Vec,
} from '@argonprotocol/mainchain';
import type { CohortStorage } from './storage.ts';

const defaultCohort = {
  argonotsMined: 0n,
  argonsMined: 0n,
  argonsMinted: 0n,
};

/**
 * Monitor the accountset for new cohorts and earnings. Store the earnings and bidding to files.
 * @param accountset
 * @param storage
 * @param archiveUrl - a url to an archive server in case we need to sync history
 */
export class BlockSync {
  queue: Header[] = [];
  lastProcessed?: Date;
  accountMiners: AccountMiners;
  archiveClient!: ArgonClient;
  localClient!: ArgonClient;
  latestFinalizedHeader!: Header;

  gapSynchingUntil?: number;
  unsubscribe?: () => void;

  constructor(
    public accountset: Accountset,
    public storage: CohortStorage,
    public archiveUrl: string
  ) {
    this.accountMiners = new AccountMiners(accountset);
    this.dequeuePending = this.dequeuePending.bind(this);
  }

  async status() {
    const state = await this.storage.syncStateFile().get();
    return {
      latestSynched: state.lastBlock,
      latestFinalized: this.latestFinalizedHeader.number.toNumber(),
      firstRotation: state.firstRotation,
      queueDepth: this.queue.length,
      lastProcessed: this.lastProcessed,
    };
  }

  async stop() {
    if (this.unsubscribe) {
      this.unsubscribe();
      this.unsubscribe = undefined;
    }
    await this.archiveClient.disconnect();
    await this.localClient.disconnect();
  }

  async start() {
    this.archiveClient = await getClient(this.archiveUrl);
    this.localClient = await this.accountset.client;
    const finalizedHash = await this.localClient.rpc.chain.getFinalizedHead();
    this.latestFinalizedHeader = await this.localClient.rpc.chain.getHeader(
      finalizedHash
    );
    await this.setFirstRotationIfNeeded();

    const state = await this.storage.syncStateFile().get();
    let hasGap = false;
    let header = this.latestFinalizedHeader;
    // plug any gaps in the sync state
    while (
      header.number.toNumber() > state.lastBlock + 1 &&
      (await this.getRotation(header)) >= state.firstRotation
    ) {
      this.queue.unshift(header);
      header = await this.getRpcClient(header).rpc.chain.getHeader(
        header.parentHash
      );
      hasGap = true;
    }
    this.gapSynchingUntil = hasGap
      ? this.latestFinalizedHeader.number.toNumber()
      : undefined;

    // catchup now
    while (this.queue.length) {
      const header = this.queue.shift()!;
      await this.processHeader(header);
    }

    this.unsubscribe = await this.localClient.rpc.chain.subscribeFinalizedHeads(
      (header) => {
        if (this.latestFinalizedHeader.hash === header.hash) {
          return;
        }
        this.latestFinalizedHeader = header;
        this.queue.push(header);
        this.queue.sort((a, b) => a.number.toNumber() - b.number.toNumber());
      }
    );
    await this.dequeuePending();
  }

  async dequeuePending() {
    let waitTime = 500;
    if (this.queue.length) {
      let header = this.queue.shift()!;
      await this.processHeader(header);
      if (this.queue.length) waitTime = 0;
    }
    setTimeout(this.dequeuePending, waitTime);
  }

  async processHeader(header: Header) {
    const author = getAuthorFromHeader(this.localClient, header);
    const tick = getTickFromHeader(this.localClient, header);

    if (!tick || !author) {
      console.warn("No tick or author found for header", header.number);
      return;
    }

    const client = this.getRpcClient(header);
    const api = await client.at(header.hash);
    const events = await api.query.system.events();
    const { rotation, ...cohortIds } = await this.accountMiners.onBlock(
      header,
      { tick, author },
      events.map((x) => x.event)
    );

    if (
      this.gapSynchingUntil &&
      header.number.toNumber() < this.gapSynchingUntil
    ) {
      await this.gapSyncBidding(header, events);
    }
    await this.storage.earningsFile(rotation).mutate((x) => {
      if (x.lastBlock <= header.number.toNumber()) {
        console.warn("Already processed block", {
          lastStored: x.lastBlock,
          blockNumber: header.number.toNumber(),
        });
        return;
      }
      x.lastBlock = header.number.toNumber();
      for (const [id, earnings] of Object.entries(cohortIds)) {
        const cohortId = Number(id);
        const { argonsMinted, argonotsMined, argonsMined } = earnings;
        x.byCohortId[cohortId] ??= structuredClone(defaultCohort);
        x.byCohortId[cohortId].argonotsMined += argonotsMined;
        x.byCohortId[cohortId].argonsMined += argonsMined;
        x.byCohortId[cohortId].argonsMinted += argonsMinted;
      }
    });
    await this.storage.syncStateFile().mutate((x) => {
      x.lastBlock = header.number.toNumber();
      x.lastBlockByRotation[rotation] = header.number.toNumber();
    });
    this.lastProcessed = new Date();
  }

  /**
   * Gets an appropriate client for this header. The local node will be pruned to 256 finalized blocks.
   * @param headerOrNumber
   */
  private getRpcClient(headerOrNumber: Header | number): ArgonClient {
    let headerNumber =
      typeof headerOrNumber === "number"
        ? headerOrNumber
        : headerOrNumber.number.toNumber();
    if (headerNumber < this.latestFinalizedHeader.number.toNumber() - 256) {
      return this.archiveClient;
    }
    return this.localClient;
  }

  private async setFirstRotationIfNeeded() {
    const state = await this.storage.syncStateFile().get();
    if (state.firstRotation > 0) return;
    const rotation = await this.getRotation(this.latestFinalizedHeader);
    await this.storage.syncStateFile().mutate((x) => {
      x.firstRotation = rotation;
    });
  }

  private async getRotation(header: Header): Promise<number> {
    const rotation = await new MiningRotations().getForHeader(
      this.localClient,
      header
    );
    if (!rotation) {
      throw new Error(
        `Error getting rotation for header ${header.number.toNumber()}`
      );
    }
    return rotation;
  }

  private async gapSyncBidding(
    header: Header,
    events: Vec<FrameSystemEventRecord>
  ) {
    const client = this.getRpcClient(header);
    const api = await client.at(header.hash);

    const biddingCohort = await api.query.miningSlot
      .nextCohortId()
      .then((x) => x.toNumber());

    const biddingFile = this.storage.biddingFile(biddingCohort);
    if (!(await biddingFile.exists())) {
      const argonotsPerSeat = await api.query.miningSlot
        .argonotsPerMiningSeat()
        .then((x) => x.toBigInt());
      const argonotUsdPrice = await api.query.priceIndex.current().then((x) => {
        if (x.isNone) return 0;
        return convertFixedU128ToBigNumber(
          x.unwrap().argonotUsdPrice.toBigInt()
        ).toNumber();
      });
      const cohortArgonsPerBlock = await api.query.blockRewards
        .argonsPerBlock()
        .then((x) => x.toBigInt());

      await biddingFile.mutate((x) => {
        Object.assign(x, {
          argonotsPerSeat,
          argonotUsdPrice,
          cohortArgonsPerBlock,
        });
      });
    }

    let block: SignedBlock | undefined;
    for (const { event } of events) {
      const miningFee = await this.hasMiningFee(client, event, events);
      if (miningFee > 0n) {
        block ??= await client.rpc.chain.getBlock(header.hash);
        const ext = block.block.extrinsics.at(event.index as any)!;
        const decoded = client.registry.createType("Extrinsic", ext);

        // TODO: handle proxies
        if (client.tx.utility.batch.is(decoded)) {
          const [calls] = decoded.args;
          const accounts: { address: string; bid: bigint }[] = [];
          for (const call of calls) {
            if (client.tx.miningSlot.bid.is(call)) {
              const [bid, _rewardDestination, _keys, miningAccountId] =
                call.args;
              const address = miningAccountId.value.toHuman();
              accounts.push({ address, bid: bid.toBigInt() });
            }
          }
          await biddingFile.mutate((x) => {
            x.fees += miningFee;
            x.bids += accounts.length;
            for (const { bid } of accounts) {
              if (bid > x.maxBidPerSeat) {
                x.maxBidPerSeat = bid;
              }
            }
            x.subaccounts = accounts.map(({ address }) => {
              const ourMiner = this.accountset.subAccountsByAddress[address];
              return {
                index: ourMiner.index,
                address,
                // TODO: we aren't recovering this properly
                isRebid: false,
              };
            });
          });
        }
      }
      if (client.events.miningSlot.NewMiners.is(event)) {
        const [_startIndex, newMiners, _released, cohortId] = event.data;
        await this.storage.biddingFile(cohortId.toNumber()).mutate((x) => {
          x.seats = 0;
          x.totalArgonsBid = 0n;
          x.subaccounts = [];
          for (const miner of newMiners) {
            const address = miner.accountId.toHuman();
            const bidAmount = miner.bid.toBigInt();
            const ourMiner = this.accountset.subAccountsByAddress[address];
            if (ourMiner) {
              x.seats += 1;
              x.totalArgonsBid += bidAmount;
              if (bidAmount > x.maxBidPerSeat) {
                x.maxBidPerSeat = bidAmount;
              }
              x.subaccounts.push({
                index: ourMiner.index,
                address,
                isRebid: false,
              });
            }
          }
        });
      }
    }
  }

  private async hasMiningFee(
    client: ArgonClient,
    event: GenericEvent,
    events: Vec<FrameSystemEventRecord>
  ) {
    if (!client.events.transactionPayment.TransactionFeePaid.is(event)) {
      return 0n;
    }

    const [account, fee] = event.data;
    if (account.toHuman() !== this.accountset.txSubmitterPair.address) {
      return 0n;
    }
    const extrinsicEvents = events.filter((x) => x.event.index === event.index);
    const hasMiningEvents = extrinsicEvents.some(
      (x) =>
        client.events.miningSlot.SlotBidderAdded.is(x.event) ||
        client.events.miningSlot.SlotBidderDropped.is(x.event)
    );
    const isMiningError = extrinsicEvents.some((x) => {
      if (client.events.utility.BatchInterrupted.is(x.event)) {
        const [_index, error] = x.event.data;
        if (error.isModule) {
          const decoded = client.registry.findMetaError(error.asModule);
          if (decoded.section === "miningSlot") {
            return true;
          }
        }
      }
    });
    if (isMiningError && hasMiningEvents) {
      return fee.toBigInt();
    }
    return 0n;
  }
}
