import {
  AccountMiners,
  type Accountset,
  type ArgonClient,
  type Call,
  CohortBidder,
  type FrameSystemEventRecord,
  type GenericEvent,
  type GenericExtrinsic,
  getAuthorFromHeader,
  getClient,
  getTickFromHeader,
  type Header,
  MiningRotations,
  type SignedBlock,
  type Vec,
} from '@argonprotocol/mainchain';
import { type CohortStorage, type ISyncState, JsonStore } from './storage.ts';

const defaultCohort = {
  blocksMined: 0,
  argonotsMined: 0n,
  argonsMined: 0n,
  argonsMinted: 0n,
  lastBlockMinedAt: '',
};

export interface ILastProcessed {
  rotationId: number;
  date: Date;
  blockNumber: number;
}

/**
 * Monitor the accountset for new cohorts and earnings. Store the earnings and bidding to files.
 * @param accountset
 * @param storage
 * @param archiveUrl - a url to an archive server in case we need to sync history
 */
export class BlockSync {
  queue: Header[] = [];
  lastProcessed?: ILastProcessed;
  accountMiners!: AccountMiners;
  archiveClient!: ArgonClient;
  localClient!: ArgonClient;
  latestFinalizedHeader!: Header;
  scheduleTimer?: NodeJS.Timeout;
  statusFile: JsonStore<ISyncState>;

  didProcessFinalizedBlock?: (info: ILastProcessed) => void;

  private unsubscribe?: () => void;
  private isStopping: boolean = false;

  constructor(
    public accountset: Accountset,
    public storage: CohortStorage,
    public archiveUrl: string,
    private oldestRotationToSync?: number,
  ) {
    this.scheduleNext = this.scheduleNext.bind(this);
    this.statusFile = this.storage.syncStateFile();
  }

  async status() {
    const state = await this.statusFile.get();
    return {
      biddingsLastUpdatedAt: state?.biddingsLastUpdatedAt ?? '',
      earningsLastUpdatedAt: state?.earningsLastUpdatedAt ?? '',
      hasWonSeats: state?.hasWonSeats ?? false,
      lastSynchedBlockNumber: state?.lastBlockNumber ?? 0,
      lastFinalizedBlockNumber: this.latestFinalizedHeader.number.toNumber(),
      firstRotationId: state?.firstRotationId ?? 0,
      currentRotationId: state?.currentRotationId ?? 0,
      queueDepth: this.queue.length,
      lastProcessed: this.lastProcessed,
    };
  }

  async stop() {
    if (this.isStopping) return;
    this.isStopping = true;
    if (this.unsubscribe) {
      this.unsubscribe();
      this.unsubscribe = undefined;
    }
    if (this.scheduleTimer) {
      clearTimeout(this.scheduleTimer);
      this.scheduleTimer = undefined;
    }
    await this.archiveClient.disconnect();
    // local client is not owned by this service
  }

  async start() {
    this.isStopping = false;
    this.archiveClient = await getClient(this.archiveUrl);
    this.localClient = await this.accountset.client;
    const finalizedHash = await this.localClient.rpc.chain.getFinalizedHead();
    this.latestFinalizedHeader = await this.localClient.rpc.chain.getHeader(finalizedHash);
    await this.setFirstRotationIfNeeded();

    const state = (await this.statusFile.get())!;

    let header = this.latestFinalizedHeader;
    // plug any gaps in the sync state
    while (
      header.number.toNumber() > state.lastBlockNumber + 1 &&
      (await this.getRotation(header)) >= state.firstRotationId
    ) {
      this.queue.unshift(header);
      header = await this.getParentHeader(header);
    }
    console.log('Sync starting', {
      ...state,
      queue: `${this.queue.at(0)?.number.toNumber()}..${this.queue.at(-1)?.number.toNumber()}`,
    });

    const loadAt = this.queue.at(0) ?? this.latestFinalizedHeader;
    const api = await this.getRpcClient(loadAt).at(loadAt.hash);
    const startingMinerState = await this.accountset.loadRegisteredMiners(api);

    this.accountMiners = new AccountMiners(
      this.accountset,
      startingMinerState.filter(x => x.cohortId !== undefined) as any,
    );

    // catchup now
    while (this.queue.length) {
      const header = this.queue.shift()!;
      await this.processHeader(header);
    }

    this.unsubscribe = await this.localClient.rpc.chain.subscribeFinalizedHeads(header => {
      if (this.latestFinalizedHeader.hash === header.hash) {
        return;
      }
      this.latestFinalizedHeader = header;
      this.queue.push(header);
      this.queue.sort((a, b) => a.number.toNumber() - b.number.toNumber());
    });
    await this.scheduleNext();
  }

  async scheduleNext() {
    if (this.scheduleTimer) clearTimeout(this.scheduleTimer);
    let waitTime = 500;
    if (this.queue.length) {
      // plug any gaps in the sync state
      const state = (await this.statusFile.get())!;
      let first = this.queue.at(0)!;
      while (first.number.toNumber() > state.lastBlockNumber + 1) {
        first = await this.getParentHeader(first);
        this.queue.unshift(first);
      }

      // now process the next header
      const header = this.queue.shift()!;
      try {
        await this.processHeader(header);
      } catch (e) {
        console.error(`Error processing block ${header.number.toNumber()} header`, e);
        if (this.isStopping) return;
        throw e;
      }
      if (this.queue.length) waitTime = 0;
    }
    this.scheduleTimer = setTimeout(this.scheduleNext, waitTime);
  }

  async processHeader(header: Header) {
    const author = getAuthorFromHeader(this.localClient, header);
    const tick = getTickFromHeader(this.localClient, header);
    const rotationId = await this.getRotation(header);

    if (!tick || !author) {
      console.warn('No tick or author found for header', header.number.toNumber());
      return;
    }

    const client = this.getRpcClient(header);
    const api = await client.at(header.hash);
    const events = await api.query.system.events();
    const { rotation: _r, ...cohortIds } = await this.accountMiners.onBlock(
      header,
      { tick, author },
      events.map(x => x.event),
    );

    await this.syncBidding(header, events);
    await this.storage.earningsFile(rotationId).mutate(x => {
      if (x.lastBlockNumber >= header.number.toNumber()) {
        console.warn('Already processed block', {
          lastStored: x.lastBlockNumber,
          blockNumber: header.number.toNumber(),
        });
        return false;
      }
      x.lastBlockNumber = header.number.toNumber();
      for (const [id, earnings] of Object.entries(cohortIds)) {
        const cohortId = Number(id);
        const { argonsMinted, argonotsMined, argonsMined } = earnings;
        x.byCohortId[cohortId] ??= structuredClone(defaultCohort);
        x.byCohortId[cohortId].argonotsMined += argonotsMined;
        x.byCohortId[cohortId].argonsMined += argonsMined;
        x.byCohortId[cohortId].argonsMinted += argonsMinted;
        if (argonsMined > 0n) {
          x.byCohortId[cohortId].blocksMined += 1;
          x.byCohortId[cohortId].lastBlockMinedAt = new Date().toISOString();
        }
      }

      console.log('Processed finalized block', {
        rotationId,
        blockNumber: header.number.toNumber(),
      });
    });
    await this.statusFile.mutate(x => {
      if (x.lastBlockNumber >= header.number.toNumber()) {
        return false;
      }
      x.earningsLastUpdatedAt = new Date().toISOString();
      x.lastBlockNumber = header.number.toNumber();
      x.currentRotationId = rotationId;
      x.lastBlockNumberByRotationId[rotationId] = header.number.toNumber();
    });
    this.lastProcessed = { blockNumber: header.number.toNumber(), rotationId, date: new Date() };
    this.didProcessFinalizedBlock?.(this.lastProcessed);
  }

  /**
   * Gets an appropriate client for this header. The local node will be pruned to 256 finalized blocks.
   * @param headerOrNumber
   */
  private getRpcClient(headerOrNumber: Header | number): ArgonClient {
    let headerNumber =
      typeof headerOrNumber === 'number' ? headerOrNumber : headerOrNumber.number.toNumber();
    // TODO: this is currently broken when using fast sync, so setting to 0
    const SYNCHED_STATE_DEPTH = 0;
    if (headerNumber < this.latestFinalizedHeader.number.toNumber() - SYNCHED_STATE_DEPTH) {
      return this.archiveClient;
    }
    return this.localClient;
  }

  private async setFirstRotationIfNeeded() {
    const state = await this.statusFile.get();
    if (state && state.firstRotationId > 0) return;
    const rotationId =
      this.oldestRotationToSync ?? (await this.getRotation(this.latestFinalizedHeader));
    await this.statusFile.mutate(x => {
      x.firstRotationId = rotationId;
    });
  }

  private async getParentHeader(header: Header): Promise<Header> {
    return this.getRpcClient(header).rpc.chain.getHeader(header.parentHash);
  }

  private async getRotation(header: Header): Promise<number> {
    const rotation = await new MiningRotations().getForHeader(this.localClient, header);
    if (rotation === undefined) {
      throw new Error(`Error getting rotation for header ${header.number.toNumber()}`);
    }
    return rotation;
  }

  private async syncBidding(header: Header, events: Vec<FrameSystemEventRecord>) {
    const client = this.getRpcClient(header);
    const api = await client.at(header.hash);

    let block: SignedBlock | undefined;
    const blockNumber = header.number.toNumber();
    const biddingCohort = await api.query.miningSlot.nextCohortId().then(x => x.toNumber());

    for (const { event, phase } of events) {
      if (phase.isApplyExtrinsic) {
        const extrinsicIndex = phase.asApplyExtrinsic.toNumber();
        const extrinsicEvents = events.filter(
          x => x.phase.isApplyExtrinsic && x.phase.asApplyExtrinsic.toNumber() === extrinsicIndex,
        );
        await this.processExtrinsicEvent(
          client,
          event,
          extrinsicEvents,
          biddingCohort,
          header,
          async () => {
            block ??= await client.rpc.chain.getBlock(header.hash);
            const ext = block.block.extrinsics.at(extrinsicIndex)!;
            return client.registry.createType('Extrinsic', ext);
          },
        );
      }
      if (client.events.miningSlot.NewMiners.is(event)) {
        let hasWonSeats = false;
        const [_startIndex, newMiners, _released, cohortId] = event.data;
        await this.storage.biddingsFile(cohortId.toNumber()).mutate(x => {
          if (x.lastBlockNumber >= blockNumber) {
            console.warn('Already processed cohort block', {
              lastStored: x.lastBlockNumber,
              cohortId: cohortId.toNumber(),
              blockNumber: blockNumber,
            });
            return false;
          }
          x.seats = 0;
          x.totalArgonsBid = 0n;
          x.subaccounts = [];
          x.lastBlockNumber = blockNumber;
          for (const miner of newMiners) {
            const address = miner.accountId.toHuman();
            const bidAmount = miner.bid.toBigInt();
            const ourMiner = this.accountset.subAccountsByAddress[address];
            if (ourMiner) {
              hasWonSeats = true;
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
        await this.statusFile.mutate(x => {
          x.biddingsLastUpdatedAt = new Date().toISOString();
          if (hasWonSeats) {
            x.hasWonSeats = true;
          }
        });
      }
    }
  }

  private async processExtrinsicEvent(
    client: ArgonClient,
    event: GenericEvent,
    extrinsicEvents: FrameSystemEventRecord[],
    biddingCohort: number,
    header: Header,
    getExtrinsic: () => Promise<GenericExtrinsic>,
  ) {
    const blockNumber = header.number.toNumber();
    const miningFee = await this.hasMiningFee(client, event, extrinsicEvents);
    if (miningFee === 0n) return;
    const api = await client.at(header.hash);
    const biddingsFile = this.storage.biddingsFile(biddingCohort);
    const biddingsStats = await biddingsFile.get();
    if (biddingsStats) {
      await biddingsFile.mutate(x => {
        if (x.lastBlockNumber >= blockNumber) {
          console.warn('Already processed block', {
            lastStored: x.lastBlockNumber,
            blockNumber: blockNumber,
          });
          return false;
        }
        x.fees += miningFee;
        x.lastBlockNumber = blockNumber;
      });
      // don't back fill
      return;
    }

    console.log('Back-filling stats for bidding cohort', {
      cohortId: biddingCohort,
      blockNumber: blockNumber,
    });
    const decoded = await getExtrinsic();
    const subaccounts: {
      address: string;
      bid: bigint;
      index: number;
      isRebid: false;
    }[] = [];

    let calls: Call[] = [];
    if (client.tx.proxy.proxy.is(decoded)) {
      const [address, proxyType, call] = decoded.args;
      if (proxyType.value.isMiningBid && this.accountset.seedAddress === address.toHuman()) {
        if (client.tx.utility.batch.is(call)) {
          calls = call.args[0];
        }
      }
    } else if (client.tx.utility.batch.is(decoded)) {
      calls = decoded.args[0];
    }
    for (const call of calls) {
      if (client.tx.miningSlot.bid.is(call)) {
        const [bid, _rewardDestination, _keys, miningAccountId] = call.args;
        const address = miningAccountId.value.toHuman();
        const ourMiner = this.accountset.subAccountsByAddress[address];
        subaccounts.push({
          address,
          index: ourMiner.index,
          bid: bid.toBigInt(),
          // TODO: we aren't recovering this properly
          isRebid: false,
        });
      }
    }
    console.info('Bids found for cohort', {
      biddingCohort,
      blockNumber,
      fees: miningFee,
      bids: subaccounts.length,
      subaccounts,
    });
    const defaultStats = await CohortBidder.getStartingData(api);
    await biddingsFile.mutate(x => {
      Object.assign(x, {
        ...defaultStats,
        fees: miningFee,
        subaccounts,
        blockNumber,
      });
    });
  }

  private async hasMiningFee(
    client: ArgonClient,
    event: GenericEvent,
    extrinsicEvents: FrameSystemEventRecord[],
  ) {
    if (!client.events.transactionPayment.TransactionFeePaid.is(event)) {
      return 0n;
    }

    const [account, fee] = event.data;
    if (account.toHuman() !== this.accountset.txSubmitterPair.address) {
      return 0n;
    }
    const hasMiningEvents = extrinsicEvents.some(
      x =>
        client.events.miningSlot.SlotBidderAdded.is(x.event) ||
        client.events.miningSlot.SlotBidderDropped.is(x.event),
    );
    const isMiningError = extrinsicEvents.some(x => {
      if (client.events.utility.BatchInterrupted.is(x.event)) {
        const [_index, error] = x.event.data;
        if (error.isModule) {
          const decoded = client.registry.findMetaError(error.asModule);
          if (decoded.section === 'miningSlot') {
            return true;
          }
        }
      }
    });
    if (isMiningError || hasMiningEvents) {
      return fee.toBigInt();
    }
    return 0n;
  }
}
