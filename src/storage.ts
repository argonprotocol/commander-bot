import Path from "node:path";
import { LRU } from "tiny-lru";
import * as fs from "node:fs";
import { JsonExt } from "@argonprotocol/mainchain";

export interface ILastModified {
  lastModified?: Date;
}
export interface IRotationEarnings extends ILastModified {
  lastBlock: number;
  byCohortId: {
    [cohortId: number]: {
      argonsMined: bigint;
      argonsMinted: bigint;
      argonotsMined: bigint;
    };
  };
}

export interface ICohortBiddingStats extends ILastModified {
  cohortId: number;
  lastBlock: number;
  subaccounts: { isRebid: boolean; index: number; address: string }[];
  seats: number;
  totalArgonsBid: bigint;
  bids: number;
  fees: bigint;
  maxBidPerSeat: bigint;
  argonotsPerSeat: bigint;
  argonotUsdPrice: number;
  cohortArgonsPerBlock: bigint;
}

export interface ISyncState extends ILastModified {
  lastBlock: number;
  firstRotation: number;
  lastBlockByRotation: {
    [rotationId: number]: number;
  };
}

async function atomicWrite(path: string, contents: string) {
  const tmp = `${path}.tmp`;
  await Bun.write(tmp, contents);
  fs.renameSync(tmp, path);
}

export class JsonStore<T extends Record<string, any> & ILastModified> {
  private data: T | undefined;

  constructor(
    private path: string,
    private defaults: Omit<T, "lastModified">
  ) {}

  public async mutate(mutateFn: (data: T) => void): Promise<void> {
    await this.load();
    if (!this.data) {
      this.data = structuredClone(this.defaults) as T;
    }
    mutateFn(this.data!);
    this.data!.lastModified = new Date();
    // filter non properties
    this.data = Object.fromEntries(
      Object.entries(this.data!).filter(([key]) => key in this.defaults)
    ) as T;
    await atomicWrite(this.path, JsonExt.stringify(this.data, 2));
  }

  public async exists(): Promise<boolean> {
    try {
      const stats = await Bun.file(this.path).stat();
      return stats.isFile();
    } catch (e) {
      return false;
    }
  }

  public async get(): Promise<T | undefined> {
    await this.load();
    return structuredClone(this.data!);
  }

  private async load(): Promise<void> {
    if (this.data === undefined) {
      try {
        const data = await Bun.file(this.path).text().then(JsonExt.parse);
        if (data.lastModified) {
          data.lastModified = new Date(data.lastModified);
        }
        this.data = data;
      } catch {}
    }
  }
}

export class CohortStorage {
  constructor(private basedir: string) {}
  private lruCache = new LRU<JsonStore<any>>(100);

  public syncStateFile(): JsonStore<ISyncState> {
    const key = `sync-state.json`;
    let entry = this.lruCache.get(key);
    if (!entry) {
      entry = new JsonStore<ISyncState>(Path.join(this.basedir, key), {
        lastBlock: 0,
        firstRotation: 0,
        lastBlockByRotation: {},
      });
      this.lruCache.set(key, entry);
    }
    return entry;
  }

  /**
   * @param rotation - a rotation number, which is always 1 less than the next cohort id
   */
  public earningsFile(rotation: number): JsonStore<IRotationEarnings> {
    const key = `earnings/rotation-${rotation}.json`;
    let entry = this.lruCache.get(key);
    if (!entry) {
      entry = new JsonStore<IRotationEarnings>(Path.join(this.basedir, key), {
        lastBlock: 0,
        byCohortId: {},
      });
      this.lruCache.set(key, entry);
    }
    return entry;
  }

  public biddingFile(cohortId: number): JsonStore<ICohortBiddingStats> {
    const key = `bidding/cohort-${cohortId}.json`;
    let entry = this.lruCache.get(key);
    if (!entry) {
      entry = new JsonStore<ICohortBiddingStats>(Path.join(this.basedir, key), {
        cohortId,
        lastBlock: 0,
        seats: 0,
        totalArgonsBid: 0n,
        bids: 0,
        fees: 0n,
        maxBidPerSeat: 0n,
        argonotsPerSeat: 0n,
        argonotUsdPrice: 0,
        cohortArgonsPerBlock: 0n,
        subaccounts: [],
      });
      this.lruCache.set(key, entry);
    }
    return entry;
  }
}
