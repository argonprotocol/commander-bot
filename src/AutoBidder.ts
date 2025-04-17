import {
  type Accountset,
  CohortBidder,
  MiningBids,
} from "@argonprotocol/mainchain";
import { type BunFile } from "bun";
import type { CohortStorage } from "./storage.ts";

/**
 * Creates a bidding process. Between each cohort, it will ask the callback for parameters for the next cohort.
 * @param accountset
 * @param storage
 * @param biddingRulesPath
 */
export class AutoBidder {
  public readonly miningBids: MiningBids;
  public readonly rulesFile: BunFile;
  public activeBidder: CohortBidder | undefined;
  private unsubscribe?: () => void;

  constructor(
    readonly accountset: Accountset,
    readonly storage: CohortStorage,
    private biddingRulesPath: string
  ) {
    this.miningBids = new MiningBids(accountset.client);
    this.rulesFile = Bun.file(this.biddingRulesPath);
  }

  async start(): Promise<void> {
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

  async createBiddingRules(cohortId: number) {
    console.log("Getting bidding rules for cohort", cohortId);
    const rules = await this.rulesFile.json();
    // TODO: add calculation

    return {
      minBid: rules.minBid,
      maxBid: rules.maxBid,
      maxBalance: rules.maxBalance,
      maxSeats: rules.maxSeats,
      bidIncrement: rules.bidIncrement,
      bidDelay: rules.bidDelay,
    };
  }

  private async onBiddingEnd(cohortId: number): Promise<void> {
    console.log(`Cohort ${cohortId} ended bidding`);
    if (this.activeBidder?.cohortId !== cohortId) return;
    await this.stopBidder();
  }

  private async onBiddingStart(cohortId: number) {
    if (this.activeBidder?.cohortId === cohortId) return;
    console.log(`Cohort ${cohortId} started bidding`);
    const rules = await this.createBiddingRules(cohortId);
    const startingStats = await this.storage.biddingFile(cohortId).get();
    const availability =
      startingStats?.subaccounts ??
      (await this.accountset.getAvailableMinerAccounts(rules.maxSeats));

    const activeBidder = new CohortBidder(
      this.accountset,
      cohortId,
      availability,
      rules
    );
    activeBidder.stats = startingStats;
    this.activeBidder = activeBidder;
    await activeBidder.start();
  }

  private async stopBidder() {
    const bidder = this.activeBidder;
    if (!bidder) return;
    this.activeBidder = undefined;
    const cohortId = bidder.cohortId;
    const subaccounts = bidder.subaccounts;
    const stats = await bidder.stop();
    await this.storage.biddingFile(cohortId).mutate((x) => {
      Object.assign(x, stats);
      x.subaccounts = subaccounts;
    });
  }
}
