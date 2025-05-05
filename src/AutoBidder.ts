import { type Accountset, CohortBidder, MiningBids } from '@argonprotocol/mainchain';
import type { CohortStorage } from './storage.ts';
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
    const params = await createBidderParams(cohortId, await this.accountset.client, biddingRules);
    if (params.maxSeats === 0) return;
    const startingStats = await this.storage.biddingsFile(cohortId).get();
    console.log(`Cohort ${cohortId} started bidding`, {
      hasStartingStats: !!startingStats,
      seatGoal: params.maxSeats,
    });

    const subaccounts: { index: number; isRebid: boolean; address: string }[] = [];
    if (startingStats && startingStats.subaccounts.length) {
      const miningAccounts = await this.accountset.loadRegisteredMiners(
        await this.accountset.client,
      );
      for (const subaccount of startingStats.subaccounts) {
        const account = miningAccounts.find(x => x.address === subaccount.address);
        if (account) {
          subaccounts.push({
            index: subaccount.subaccountIndex,
            isRebid: true,
            address: subaccount.address,
          });
        }
      }
    }
    // check if we need to add more seats
    if (subaccounts.length < params.maxSeats) {
      const neededSeats = params.maxSeats - subaccounts.length;
      const added = await this.accountset.getAvailableMinerAccounts(neededSeats);
      subaccounts.push(...added);
    }

    const activeBidder = new CohortBidder(this.accountset, cohortId, subaccounts, params);
    this.activeBidder = activeBidder;
    await activeBidder.start();
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
