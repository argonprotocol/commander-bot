import { type Accountset, CohortBidder, MiningBids } from '@argonprotocol/mainchain';
import type { CohortStorage, ICohortBiddingStats } from './storage.ts';
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
      const cohortId = this.activeBidder.cohortId;
      await this.stopBidder();
      await this.onBiddingStart(cohortId);
    }
  }

  async stop() {
    this.unsubscribe?.();
    this.unsubscribe = undefined;
    await this.stopBidder();
  }

  private async onBiddingEnd(cohortId: number): Promise<void> {
    console.log(`Cohort ${cohortId} ended bidding`);
    if (this.activeBidder?.cohortId !== cohortId) return;
    await this.stopBidder();
  }

  private async onBiddingStart(cohortId: number) {
    if (this.activeBidder?.cohortId === cohortId) return;
    const biddingRules = readJsonFileOrNull(this.biddingRulesPath) || {};
    const params = await createBidderParams(
      cohortId,
      await this.accountset.client,
      biddingRules,
    );
    if (params.maxSeats === 0) return;
    const startingStats = await this.storage.biddingFile(cohortId).get();
    console.log(`Cohort ${cohortId} started bidding`, {
      hasStartingStats: !!startingStats,
      seatGoal: params.maxSeats,
    });
    let subaccounts: ICohortBiddingStats['subaccounts'] | undefined;
    if (startingStats && startingStats.subaccounts.length) {
      subaccounts = startingStats.subaccounts;
    }
    subaccounts ??= await this.accountset.getAvailableMinerAccounts(params.maxSeats);

    const activeBidder = new CohortBidder(this.accountset, cohortId, subaccounts, params);
    this.activeBidder = activeBidder;
    await activeBidder.start();
    if (!startingStats) {
      // only store the initial stats so we don't have to re-download the block
      const startingStats = activeBidder.stats;
      await this.storage.biddingFile(cohortId).mutate(x => {
        Object.assign(x, {
          cohortId,
          subaccounts,
          lastBlock: startingStats.lastBlock,
          argonotsPerSeat: startingStats.argonotsPerSeat,
          argonotUsdPrice: startingStats.argonotUsdPrice,
          cohortArgonsPerBlock: startingStats.cohortArgonsPerBlock,
        });
      });
    }
  }

  private async stopBidder() {
    const bidder = this.activeBidder;
    if (!bidder) return;
    this.activeBidder = undefined;
    const cohortId = bidder.cohortId;
    const stats = await bidder.stop();
    console.log('Cohort bidding completed', { cohortId, ...stats });
  }
}
