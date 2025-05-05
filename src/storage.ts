import Path from 'node:path';
import { LRU } from 'tiny-lru';
import * as fs from 'node:fs';
import { JsonExt } from '@argonprotocol/mainchain';

export interface ILastModifiedAt {
  lastModifiedAt?: Date;
}

export interface ISubaccount {
  isRebid: boolean;
  index: number;
  address: string;
  argonsBid?: bigint;
}

export interface IBidsFile extends ILastModifiedAt {
  frameIdAtCohortBidding: number;
  frameIdAtCohortActivation: number;
  frameBiddingProgress: number;
  lastBlockNumber: number;
  argonsToBeMinedPerBlock: bigint;
  argonsBidTotal: bigint;
  transactionFees: bigint;
  argonotsStakedPerSeat: bigint;
  argonotUsdPrice: number;
  subaccounts: Array<ISubaccount>;
  seatsWon: number;
}

export interface IEarningsFile extends ILastModifiedAt {
  frameProgress: number;
  lastBlockNumber: number;
  byFrameIdAtCohortActivation: {
    [frameId: number]: {
      lastBlockMinedAt: string;
      blocksMined: number;
      argonsMined: bigint;
      argonsMinted: bigint;
      argonotsMined: bigint;
    };
  };
}

export interface ISyncState extends ILastModifiedAt {
  lastBlockNumber: number;
  oldestFrameId: number;
  currentFrameId: number;
  bidsLastModifiedAt: Date;
  earningsLastModifiedAt: Date;
  hasWonSeats: boolean;
  lastBlockNumberByFrameId: {
    [frameId: number]: number;
  };
}

async function atomicWrite(path: string, contents: string) {
  const tmp = `${path}.tmp`;
  await fs.promises.writeFile(tmp, contents);
  await fs.promises.rename(tmp, path);
}

export class JsonStore<T extends Record<string, any> & ILastModifiedAt> {
  private data: T | undefined;

  constructor(
    private path: string,
    private defaults: Omit<T, 'lastModified'>,
  ) {}

  public async mutate(mutateFn: (data: T) => boolean | void): Promise<void> {
    await this.load();
    if (!this.data) {
      this.data = structuredClone(this.defaults) as T;
    }
    const result = mutateFn(this.data!);
    if (result === false) return;
    this.data!.lastModifiedAt = new Date();
    // filter non properties
    this.data = Object.fromEntries(
      Object.entries(this.data!).filter(([key]) => key in this.defaults),
    ) as T;
    await atomicWrite(this.path, JsonExt.stringify(this.data, 2));
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
        if (data.lastModifiedAt) {
          data.lastModifiedAt = new Date(data.lastModifiedAt);
        }
        this.data = data;
      } catch {}
    }
  }
}

export class CohortStorage {
  constructor(private basedir: string) {
    fs.mkdirSync(this.basedir, { recursive: true });
    fs.mkdirSync(Path.join(this.basedir, 'bids'), { recursive: true });
    fs.mkdirSync(Path.join(this.basedir, 'earnings'), { recursive: true });
  }
  private lruCache = new LRU<JsonStore<any>>(100);

  public syncStateFile(): JsonStore<ISyncState> {
    const key = `sync-state.json`;
    let entry = this.lruCache.get(key);
    if (!entry) {
      entry = new JsonStore<ISyncState>(Path.join(this.basedir, key), {
        lastBlockNumber: 0,
        oldestFrameId: 0,
        currentFrameId: 0,
        lastBlockNumberByFrameId: {},
        bidsLastModifiedAt: new Date(),
        earningsLastModifiedAt: new Date(),
        hasWonSeats: false,
      });
      this.lruCache.set(key, entry);
    }
    return entry;
  }

  public bidsFile(frameIdAtCohortActivation: number): JsonStore<IBidsFile> {
    const frameIdAtCohortBidding = frameIdAtCohortActivation - 1;
    const key = `bids/frame-${frameIdAtCohortBidding}${frameIdAtCohortActivation}.json`;
    let entry = this.lruCache.get(key);
    if (!entry) {
      entry = new JsonStore<IBidsFile>(Path.join(this.basedir, key), {
        frameIdAtCohortBidding: frameIdAtCohortBidding,
        frameIdAtCohortActivation,
        frameBiddingProgress: 0,
        lastBlockNumber: 0,
        argonsBidTotal: 0n,
        transactionFees: 0n,
        argonotsStakedPerSeat: 0n,
        argonotUsdPrice: 0,
        argonsToBeMinedPerBlock: 0n,
        subaccounts: [],
        seatsWon: 0,
      });
      this.lruCache.set(key, entry);
    }
    return entry;
  }

  /**
   * @param frameId - the frame id of the last block mined
   */
  public earningsFile(frameId: number): JsonStore<IEarningsFile> {
    const key = `earnings/frame-${frameId}.json`;
    let entry = this.lruCache.get(key);
    if (!entry) {
      entry = new JsonStore<IEarningsFile>(Path.join(this.basedir, key), {
        frameProgress: 0,
        lastBlockNumber: 0,
        byFrameIdAtCohortActivation: {},
      });
      this.lruCache.set(key, entry);
    }
    return entry;
  }
}
