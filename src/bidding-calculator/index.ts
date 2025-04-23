import { type ArgonClient } from '@argonprotocol/mainchain';
import type { IBidderParams } from '../IBidderParams.ts';

export default async function createBidderParams(
  cohortId: number,
  client: ArgonClient,
  rulesPath: string,
): Promise<IBidderParams> {
  const blockNumber = await client.rpc.chain.getHeader().then(x => x.number.toNumber());
  console.warn('Bidding rules are not implemented yet', { cohortId, rulesPath, blockNumber });
  return {
    minBid: 0n,
    maxBid: 0n,
    maxBalance: 0n,
    bidIncrement: 0n,
    maxSeats: 0,
    bidDelay: 0,
  };
}
