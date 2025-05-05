import { type Accountset, CohortBidder, MiningBids } from '@argonprotocol/mainchain';
import type { CohortStorage, IBidsFile } from './storage.ts';
import { createBidderParams } from './bidding-calculator/index.ts';
import { readJsonFileOrNull } from './utils.ts';

/**
 * Creates a bidding process. Between each cohort, it will ask the callback for parameters for the next cohort.
 * @param accountset
 * @param storage
 * @param biddingRulesPath
 */
export class AutoBidder {
  public readonly miningBids: MiningBids;
  public activeBidder: CohortBidder | undefined;
  private unsubscribe?: () => void;

  constructor(
    readonly accountset: Accountset,
    readonly storage: CohortStorage,
    private biddingRulesPath: string,
  ) {
    this.miningBids = new MiningBids(accountset.client);
  }

  async start(localRpcUrl: string): Promise<void> {
    await this.accountset.registerKeys(localRpcUrl);
    const { unsubscribe } = await this.miningBids.onCohortChange({
      onBiddingStart: this.onBiddingStart.bind(this),
      onBiddingEnd: this.onBiddingEnd.bind(this),
    });
    this.unsubscribe = unsubscribe;
  }

  async restart() {
    if (this.activeBidder) {
      const frameIdAtCohortActivation = this.activeBidder.cohortId;
      await this.stopBidder();
      await this.onBiddingStart(frameIdAtCohortActivation);
    }
  }

  async stop() {
    this.unsubscribe?.();
    this.unsubscribe = undefined;
    await this.stopBidder();
  }

  private async onBiddingEnd(frameIdAtCohortActivation: number): Promise<void> {
    console.log(`Bidding for frame ${frameIdAtCohortActivation} ended`);
    if (this.activeBidder?.cohortId !== frameIdAtCohortActivation) return;
    await this.stopBidder();
  }

  private async onBiddingStart(frameIdAtCohortActivation: number) {
    if (this.activeBidder?.cohortId === frameIdAtCohortActivation) return;
    const biddingRules = readJsonFileOrNull(this.biddingRulesPath) || {};
    const params = await createBidderParams(
      frameIdAtCohortActivation,
      await this.accountset.client,
      biddingRules,
    );
    if (params.maxSeats === 0) return;
    
    const bidsFileData = await this.storage.bidsFile(frameIdAtCohortActivation).get();
    console.log(`Bidding for frame ${frameIdAtCohortActivation} started`, {
      hasStartingStats: !!bidsFileData,
      seatGoal: params.maxSeats,
    });
    
    const subaccounts: IBidsFile['subaccounts'] = [];
    if (bidsFileData && bidsFileData.subaccounts.length) {
      subaccounts.push(...bidsFileData.subaccounts);
    }
    // check if we need to add more seats
    if (subaccounts.length < params.maxSeats) {
      const neededSeats = params.maxSeats - subaccounts.length;
      const added = await this.accountset.getAvailableMinerAccounts(neededSeats);
      subaccounts.push(...added);
    }

    const activeBidder = new CohortBidder(this.accountset, frameIdAtCohortActivation, subaccounts, params);
    this.activeBidder = activeBidder;
    await activeBidder.start();
    if (!bidsFileData) {
      // only store the initial stats so we don't have to re-download the block
      const startingStats = activeBidder.stats;
      const frameIdAtCohortBidding = frameIdAtCohortActivation - 1;
      await this.storage.bidsFile(frameIdAtCohortActivation).mutate(x => {
        Object.assign(x, {
          frameIdAtCohortBidding,
          frameIdAtCohortActivation,
          subaccounts,
          lastBlockNumber: startingStats.lastBlock,
          argonotsStakedPerSeat: startingStats.argonotsPerSeat,
          argonotUsdPrice: startingStats.argonotUsdPrice,
          argonsToBeMinedPerBlock: startingStats.cohortArgonsPerBlock,
        });
      });
      await this.storage.syncStateFile().mutate(x => {
        x.bidsLastModifiedAt = new Date();
      });
    }
  }

  private async stopBidder() {
    const activeBidder = this.activeBidder;
    if (!activeBidder) return;
    this.activeBidder = undefined;
    const frameIdAtCohortActivation = activeBidder.cohortId;
    const stats = await activeBidder.stop();
    console.log('Bidding stopped', { frameIdAtCohortActivation, ...stats });
  }
}
