import Path from 'node:path';
import { LRU } from 'tiny-lru';
import * as fs from 'node:fs';
import { JsonExt } from '@argonprotocol/mainchain';

export interface ILastModified {
  lastModified?: Date;
}
export interface IRotationEarnings extends ILastModified {
  lastBlockNumber: number;
  byCohortId: {
    [cohortId: number]: {
      lastBlockMinedAt: string;
      blocksMined: number;
      argonsMined: bigint;
      argonsMinted: bigint;
      argonotsMined: bigint;
    };
  };
}

export interface ICohortBiddingStats extends ILastModified {
  cohortId: number;
  lastBlockNumber: number;
  subaccounts: {
    subaccountIndex: number;
    address: string;
    bidPlace?: number;
    lastBidAtTick?: number;
  }[];
  seats: number;
  totalArgonsBid: bigint;
  fees: bigint;
  maxBidPerSeat: bigint;
  argonotsPerSeat: bigint;
  argonotUsdPrice: number;
  cohortArgonsPerBlock: bigint;
}

export interface ISyncState extends ILastModified {
  lastBlockNumber: number;
  firstRotationId: number;
  currentRotationId: number;
  biddingsLastUpdatedAt: string;
  earningsLastUpdatedAt: string;
  hasWonSeats: boolean;
  lastBlockNumberByRotationId: {
    [rotationId: number]: number;
  };
}

async function atomicWrite(path: string, contents: string) {
  const tmp = `${path}.tmp`;
  await fs.promises.writeFile(tmp, contents);
  await fs.promises.rename(tmp, path);
}

export class JsonStore<T extends Record<string, any> & ILastModified> {
  private data: T | undefined;

  constructor(
    private path: string,
    private defaults: Omit<T, 'lastModified'>,
  ) {}

  public async mutate(
    mutateFn: (data: T) => boolean | void | Promise<boolean | void>,
  ): Promise<boolean> {
    await this.load();
    if (!this.data) {
      this.data = structuredClone(this.defaults) as T;
    }
    const result = await mutateFn(this.data!);
    if (result === false) return false;
    this.data!.lastModified = new Date();
    // filter non properties
    this.data = Object.fromEntries(
      Object.entries(this.data!).filter(([key]) => key in this.defaults),
    ) as T;
    await atomicWrite(this.path, JsonExt.stringify(this.data, 2));
    return true;
  }

  public async exists(): Promise<boolean> {
    try {
      const stats = await fs.promises.stat(this.path);
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
        const data = await fs.promises.readFile(this.path, 'utf-8').then(JsonExt.parse);
        if (data.lastModified) {
          data.lastModified = new Date(data.lastModified);
        }
        this.data = data;
      } catch {}
    }
  }
}

export class CohortStorage {
  constructor(private basedir: string) {
    fs.mkdirSync(this.basedir, { recursive: true });
    fs.mkdirSync(Path.join(this.basedir, 'earnings'), { recursive: true });
    fs.mkdirSync(Path.join(this.basedir, 'biddings'), { recursive: true });
  }
  private lruCache = new LRU<JsonStore<any>>(100);

  public syncStateFile(): JsonStore<ISyncState> {
    const key = `sync-state.json`;
    let entry = this.lruCache.get(key);
    if (!entry) {
      entry = new JsonStore<ISyncState>(Path.join(this.basedir, key), {
        lastBlockNumber: 0,
        firstRotationId: 0,
        currentRotationId: 0,
        lastBlockNumberByRotationId: {},
        biddingsLastUpdatedAt: new Date().toISOString(),
        earningsLastUpdatedAt: new Date().toISOString(),
        hasWonSeats: false,
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
        lastBlockNumber: 0,
        byCohortId: {},
      });
      this.lruCache.set(key, entry);
    }
    return entry;
  }

  public biddingsFile(cohortId: number): JsonStore<ICohortBiddingStats> {
    const key = `biddings/cohort-${cohortId}.json`;
    let entry = this.lruCache.get(key);
    if (!entry) {
      entry = new JsonStore<ICohortBiddingStats>(Path.join(this.basedir, key), {
        cohortId,
        lastBlockNumber: 0,
        seats: 0,
        totalArgonsBid: 0n,
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
