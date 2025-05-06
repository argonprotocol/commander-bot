## Commander Bot

Commander bot activates a service to run alongside an Argon miner. The bot auto-bids against other miners to win the
right to mine a block. It has apis started on port 3000 that allow a querier to access bidding and earnings stats. These
are grouped into "rotations" (eg, the period from noon edt to noon edt that bidding rotates out a cohort of miners)

### Usage

This bot is intended to be run as a docker container. You can build the image with the following command:

```bash
docker build -t commander-bot -f Containerfile .
```

You can also access the latest built images from: `ghcr.io/argonprotocol/commander-bot:latest`. Images can be verified
with attestations published from the repository.

### Environment Variables

You need to provide the settings from the env.ts file as environment variables. A .env file passed to a docker is a good
way to do so.

```dotenv
# Port for the bot to run on
PORT=number
# Path to a wallet keypair file exported from polkadotjs
KEYPAIR_PATH=string
# Optional passphrase for the keypair
KEYPAIR_PASSPHRASE=string
 # URL for the local RPC node (usually ws://localhost:9944)
LOCAL_RPC_URL=string
# URL to an archive node (eg, wss://rpc.argon.network)
ARCHIVE_NODE_URL=string
# A path to a mounted volume with the bidding rules file (or where you will write it)
BIDDING_RULES_PATH=string
# Path to a mounted volume for the bot's data files
DATADIR=string
# Mnemonic for the session keys
SESSION_KEYS_MNEMONIC=string
# Optional number of earliest rotation to sync. Otherwise defaults to current.
EARLIEST_FRAME_ID_TO_SYNC=number
```
