declare module 'bun' {
  interface Env {
    PORT: string;
    KEYPAIR_PATH: string;
    KEYPAIR_PASSPHRASE?: string;
    LOCAL_RPC_URL: string;
    ARCHIVE_NODE_URL: string;
    BIDDING_RULES_PATH: string;
    DATADIR: string;
  }
}
