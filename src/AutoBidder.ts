import {
  type Accountset,
  CohortBidder,
  JsonExt,
  MiningBids,
} from "@argonprotocol/mainchain";
import type { CohortStorage, ICohortBiddingStats } from "./storage.ts";

export interface IBiddingRules {
  minBid: bigint;
  maxBid: bigint;
  maxBalance: bigint;
  maxSeats: number;
  bidIncrement: bigint;
  bidDelay: number;
}
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
  private readonly rulesFile: Bun.BunFile;

  constructor(
    readonly accountset: Accountset,
    readonly storage: CohortStorage,
    private biddingRulesPath: string
  ) {
    this.miningBids = new MiningBids(accountset.client);
    this.rulesFile = Bun.file(this.biddingRulesPath);
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

  async updateBiddingRules(rules: IBiddingRules): Promise<void> {
    await this.rulesFile.write(JsonExt.stringify(rules));
  }

  async createBiddingRules(cohortId: number): Promise<IBiddingRules> {
    console.log("Getting bidding rules for cohort", cohortId);
    return await this.rulesFile
      .text()
      .then(JsonExt.parse)
      .catch((err: Error) => {
        console.error("Error reading bidding rules", err);
        return {
          minBid: 0n,
          maxBid: 0n,
          maxBalance: 0n,
          maxSeats: 0,
          bidIncrement: 0n,
          bidDelay: 0,
        };
      });
  }

  private async onBiddingEnd(cohortId: number): Promise<void> {
    console.log(`Cohort ${cohortId} ended bidding`);
    if (this.activeBidder?.cohortId !== cohortId) return;
    await this.stopBidder();
  }

  private async onBiddingStart(cohortId: number) {
    if (this.activeBidder?.cohortId === cohortId) return;
    const rules = await this.createBiddingRules(cohortId);
    const startingStats = await this.storage.biddingFile(cohortId).get();
    console.log(`Cohort ${cohortId} started bidding`, {
      hasStartingStats: !!startingStats,
      seatGoal: rules.maxSeats,
    });
    let availability: ICohortBiddingStats["subaccounts"] | undefined;
    if (startingStats && startingStats.bids > 0) {
      availability = startingStats.subaccounts;
    }
    if (!availability) {
      availability = await this.accountset.getAvailableMinerAccounts(
        rules.maxSeats
      );
    }

    const activeBidder = new CohortBidder(
      this.accountset,
      cohortId,
      availability,
      rules
    );
    if (startingStats) {
      activeBidder.stats = startingStats;
    }
    this.activeBidder = activeBidder;
    await activeBidder.start();
    if (!startingStats) {
      await this.storeStats(cohortId, {
        subaccounts: availability,
        ...activeBidder.stats,
      });
    }
  }

  private async stopBidder() {
    const bidder = this.activeBidder;
    if (!bidder) return;
    this.activeBidder = undefined;
    const cohortId = bidder.cohortId;
    const subaccounts = bidder.subaccounts;
    const stats = await bidder.stop();
    console.log("Cohort bidding completed", { cohortId, ...stats });
    await this.storeStats(cohortId, {
      ...stats,
      subaccounts,
    });
  }

  private async storeStats(
    cohortId: number,
    stats: Partial<ICohortBiddingStats>
  ): Promise<void> {
    await this.storage.biddingFile(cohortId).mutate((x) => {
      Object.assign(x, stats);
    });
  }
}
