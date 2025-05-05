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
import { type CohortStorage, type ISubaccount, type ISyncState, JsonStore } from './storage.ts';

const defaultCohort = {
  blocksMined: 0,
  argonotsMined: 0n,
  argonsMined: 0n,
  argonsMinted: 0n,
  lastBlockMinedAt: '',
};

export interface ILastProcessed {
  frameId: number;
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
    private oldestFrameIdToSync?: number,
  ) {
    this.scheduleNext = this.scheduleNext.bind(this);
    this.statusFile = this.storage.syncStateFile();
  }

  async status() {
    const state = await this.statusFile.get();
    return {
      bidsLastModifiedAt: state?.bidsLastModifiedAt ?? '',
      earningsLastModifiedAt: state?.earningsLastModifiedAt ?? '',
      hasWonSeats: state?.hasWonSeats ?? false,
      lastSynchedBlockNumber: state?.lastBlockNumber ?? 0,
      lastFinalizedBlockNumber: this.latestFinalizedHeader.number.toNumber(),
      oldestFrameId: state?.oldestFrameId ?? 0,
      currentFrameId: state?.currentFrameId ?? 0,
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
    await this.setOldestFrameIdIfNeeded();

    const state = (await this.statusFile.get())!;

    let header = this.latestFinalizedHeader;
    // plug any gaps in the sync state
    while (
      header.number.toNumber() > state.lastBlockNumber + 1 &&
      (await this.getCurrentFrameId(header)) >= state.oldestFrameId
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
    const currentFrameId = await this.getCurrentFrameId(header);

    if (!tick || !author) {
      console.warn('No tick or author found for header', header.number.toNumber());
      return;
    }

    const client = this.getRpcClient(header);
    const api = await client.at(header.hash);
    const events = await api.query.system.events();
    const { rotation: _r, ...cohortActivationAtFrameIds } = await this.accountMiners.onBlock(
      header,
      { tick, author },
      events.map(x => x.event),
    );

    await this.syncBidding(header, events);
    await this.storage.earningsFile(currentFrameId).mutate(x => {
      if (x.lastBlockNumber >= header.number.toNumber()) {
        console.warn('Already processed block', {
          lastStored: x.lastBlockNumber,
          blockNumber: header.number.toNumber(),
        });
        return false;
      }
      x.lastBlockNumber = header.number.toNumber();
      for (const [cohortActivationAtFrameIdStr, earnings] of Object.entries(cohortActivationAtFrameIds)) {
        const cohortActivationAtFrameId = Number(cohortActivationAtFrameIdStr);
        const { argonsMinted, argonotsMined, argonsMined } = earnings;
        x.byFrameIdAtCohortActivation[cohortActivationAtFrameId] ??= structuredClone(defaultCohort);
        x.byFrameIdAtCohortActivation[cohortActivationAtFrameId].argonotsMined += argonotsMined;
        x.byFrameIdAtCohortActivation[cohortActivationAtFrameId].argonsMined += argonsMined;
        x.byFrameIdAtCohortActivation[cohortActivationAtFrameId].argonsMinted += argonsMinted;
        if (argonsMined > 0n) {
          x.byFrameIdAtCohortActivation[cohortActivationAtFrameId].blocksMined += 1;
          x.byFrameIdAtCohortActivation[cohortActivationAtFrameId].lastBlockMinedAt = new Date(tick * 60e3).toISOString();
        }
      }

      console.log('Processed finalized block', {
        currentFrameId,
        blockNumber: header.number.toNumber(),
      });
    });
    await this.statusFile.mutate(x => {
      if (x.lastBlockNumber >= header.number.toNumber()) {
        return false;
      }
      x.earningsLastModifiedAt = new Date();
      x.lastBlockNumber = header.number.toNumber();
      x.currentFrameId = currentFrameId;
      x.lastBlockNumberByFrameId[currentFrameId] = header.number.toNumber();
    });
    this.lastProcessed = { blockNumber: header.number.toNumber(), frameId: currentFrameId, date: new Date() };
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

  private async setOldestFrameIdIfNeeded() {
    const state = await this.statusFile.get();
    if (state && state.oldestFrameId > 0) return;
    const oldestFrameId =
      this.oldestFrameIdToSync ?? (await this.getCurrentFrameId(this.latestFinalizedHeader));
    await this.statusFile.mutate(x => {
      x.oldestFrameId = oldestFrameId;
    });
  }

  private async getParentHeader(header: Header): Promise<Header> {
    return this.getRpcClient(header).rpc.chain.getHeader(header.parentHash);
  }

  private async getCurrentFrameId(header: Header): Promise<number> {
    const currentFrameId = await new MiningRotations().getForHeader(this.localClient, header);
    if (currentFrameId === undefined) {
      throw new Error(`Error getting frame id for header ${header.number.toNumber()}`);
    }
    return currentFrameId;
  }

  private async syncBidding(header: Header, events: Vec<FrameSystemEventRecord>) {
    const client = this.getRpcClient(header);
    const api = await client.at(header.hash);

    let block: SignedBlock | undefined;
    const blockNumber = header.number.toNumber();

    for (const { event, phase } of events) {
      if (phase.isApplyExtrinsic) {
        const frameIdAtCohortActivation = await api.query.miningSlot.nextCohortId().then(x => x.toNumber());
        const extrinsicIndex = phase.asApplyExtrinsic.toNumber();
        const extrinsicEvents = events.filter(
          x => x.phase.isApplyExtrinsic && x.phase.asApplyExtrinsic.toNumber() === extrinsicIndex,
        );
        await this.processExtrinsicEvent(
          client,
          event,
          extrinsicEvents,
          frameIdAtCohortActivation,
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
        const [_startIndex, newMiners, _released, frameIdAtCohortActivationRaw] = event.data;
        const frameIdAtCohortActivation = frameIdAtCohortActivationRaw.toNumber();

        await this.storage.bidsFile(frameIdAtCohortActivation).mutate(x => {
          if (x.lastBlockNumber >= blockNumber) {
            console.warn('Already processed cohort block', {
              lastBlockNumber: x.lastBlockNumber,
              frameIdAtCohortActivation,
              blockNumber,
            });
            return false;
          }
          x.seatsWon = 0;
          x.argonsBidTotal = 0n;
          x.subaccounts = [];
          x.lastBlockNumber = blockNumber;
          for (const miner of newMiners) {
            const address = miner.accountId.toHuman();
            const ourMiner = this.accountset.subAccountsByAddress[address];
            if (!ourMiner) continue;

            const argonsBid = miner.bid.toBigInt();
            x.seatsWon += 1;
            x.argonsBidTotal += argonsBid;
            x.subaccounts.push({
              index: ourMiner.index,
              address,
              argonsBid,
              isRebid: false,
            });
          }
          hasWonSeats = x.seatsWon > 0;
        });
        await this.statusFile.mutate(x => {
          x.bidsLastModifiedAt = new Date();
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
    frameIdAtCohortBidding: number,
    header: Header,
    getExtrinsic: () => Promise<GenericExtrinsic>,
  ) {
    const blockNumber = header.number.toNumber();
    const transactionFee = await this.extractTransactionFee(client, event, extrinsicEvents);
    if (transactionFee === 0n) return;

    const api = await client.at(header.hash);
    const bidsFile = this.storage.bidsFile(frameIdAtCohortBidding);
    const bidsFileData = await bidsFile.get();
    
    if (bidsFileData) {
      await bidsFile.mutate(x => {
        if (x.lastBlockNumber >= blockNumber) {
          console.warn('Already processed block', {
            lastStored: x.lastBlockNumber,
            blockNumber: blockNumber,
          });
          return false;
        }
        x.transactionFees += transactionFee;
        x.lastBlockNumber = blockNumber;
      });
      // don't back fill
      return;
    }

    console.log('Back-filling stats for cohort bidding', {
      frameIdAtCohortBidding,
      blockNumber,
    });
    const decoded = await getExtrinsic();
    const subaccounts: ISubaccount[] = [];

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
        const [argonsBid, _rewardDestination, _keys, miningAccountId] = call.args;
        const address = miningAccountId.value.toHuman();
        const ourMiner = this.accountset.subAccountsByAddress[address];
        if (!ourMiner) continue;

        subaccounts.push({
          address,
          index: ourMiner.index,
          argonsBid: argonsBid.toBigInt(),
          // TODO: we aren't recovering this properly
          isRebid: false,
        });
      }
    }

    console.info('Bids found for cohort', {
      frameIdAtCohortBidding,
      blockNumber,
      transactionFees: transactionFee,
      subaccounts,
    });
    const defaultStats = await CohortBidder.getStartingData(api);
    await bidsFile.mutate(x => {
      Object.assign(x, {
        ...defaultStats,
        transactionFees: transactionFee,
        subaccounts,
        blockNumber,
      });
    });
  }

  private async extractTransactionFee(
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
        client.events.miningSlot.SlotBidderAdded.is(x.event)
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
