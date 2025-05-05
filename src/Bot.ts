import { CohortStorage } from './storage.ts';
import { Accountset, getClient, type KeyringPair } from '@argonprotocol/mainchain';
import { AutoBidder } from './AutoBidder.ts';
import { BlockSync } from './BlockSync.ts';

export default class Bot {
  readonly autobidder: AutoBidder;
  readonly accountset: Accountset;
  readonly blockSync: BlockSync;
  readonly storage: CohortStorage;

  constructor(
    readonly options: {
      datadir: string;
      pair: KeyringPair;
      localRpcUrl: string;
      archiveRpcUrl: string;
      biddingRulesPath: string;
      keysMnemonic: string;
      oldestFrameIdToSync?: number;
    },
  ) {
    this.storage = new CohortStorage(options.datadir);
    const client = getClient(options.localRpcUrl);
    this.accountset = new Accountset({
      client,
      seedAccount: options.pair,
      sessionKeyMnemonic: options.keysMnemonic,
      subaccountRange: new Array(99).fill(0).map((_, i) => i),
    });
    this.autobidder = new AutoBidder(this.accountset, this.storage, options.biddingRulesPath);
    this.blockSync = new BlockSync(
      this.accountset,
      this.storage,
      options.archiveRpcUrl,
      options.oldestFrameIdToSync,
    );
  }

  async currentFrameId() {
    const state = await this.storage.syncStateFile().get();
    return state?.currentFrameId ?? 0;
  }

  async status() {
    return this.blockSync.status();
  }

  async start() {
    try {
      await this.blockSync.start();
    } catch (error) {
      console.error('Error starting block sync', error);
      throw error;
    }
    try {
      await this.autobidder.start(this.options.localRpcUrl);
    } catch (error) {
      console.error('Error starting autobidder', error);
      throw error;
    }
    const status = await this.blockSync.status();
    console.log('Block sync updated', status);
    return status;
  }

  async stop() {
    await this.blockSync.stop();
    await this.autobidder.stop();
    await this.accountset.client.then(x => x.disconnect());
  }
}
