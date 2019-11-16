## Table of contents

-   [Introduction](#introduction)
-   [Getting started](#getting-started)
-   [Commands](#commands)
-   [Database](#database)
-   [Deployment](#deployment)
-   [Legal Disclaimer](#legal-disclaimer)

## Introduction

A [reference implementation](https://github.com/0xProject/0x-protocol-specification/blob/master/v2/coordinator-specification.md#reference-coordinator-server) of the coordinator server. To learn more about coordinators, check out the [coordinator specification](https://github.com/0xProject/0x-protocol-specification/blob/master/v2/coordinator-specification.md). To learn more about the specific design decisions of this implementation, read the [design choices section](https://github.com/0xProject/0x-protocol-specification/blob/master/v2/coordinator-specification.md#design-choices).

Fork this repository to get started!

## Getting started

#### Pre-requirements

-   [Node.js](https://nodejs.org/en/download/) > v8.x
-   [Yarn](https://yarnpkg.com/en/) > v1.x

To develop ontop of `0x-coordinator-server`, follow the following instructions:

1. Fork this repository

2. Clone your fork of this repository

3. Make sure you have [Yarn](https://yarnpkg.com/en/) installed.

4. Install the dependencies:

    ```sh
    yarn
    ```

5. Edit the `src/production_configs.ts` file to work with your relayer:

-   `FEE_RECIPIENTS` - Should include the addresses and private keys of the `feeRecipientAddress`'s you enforce for your orders (per chainId). Your coordinator's signatures will be generated using these private keys.
-   `SELECTIVE_DELAY_MS` - An optional selective delay between fill request receipt and approval. Adding a delay here can help market makers cancel orders without competing on speed with arbitrageurs.
-   `EXPIRATION_DURATION_SECONDS` - How long an issued signature should be valid for. This value should be long enough for someone to concievably fill an order, but short enough where off-chain cancellations take effect after some reasonable upper-bound.
-   `RPC_URL` - The backing Ethereum node to use for JSON RPC queries. Please add your **own** Infura API key if using Infura.

6. Build the project

    ```sh
    yarn build
    ```

    or build & watch:

    ```sh
    yarn watch
    ```

7. Start the Coordinator server

    ```sh
    yarn start
    ```

## Commands

-   `yarn build` - Build the code
-   `yarn lint` - Lint the code
-   `yarn start` - Starts the relayer
-   `yarn watch` - Watch the source code and rebuild on change
-   `yarn prettier` - Auto-format the code

## Database

This project uses [TypeORM](https://github.com/typeorm/typeorm). It makes it easier for anyone to switch out the backing database used by this project. By default, this project uses an [SQLite](https://sqlite.org/docs.html) database.

Before deploying the coordinator to production, make sure to remove the following line from `ormconfig.json`:

```
"synchronize": true,
```

Otherwise the database schema will be auto-created on every application launch. Read more [here](https://typeorm.io/#/connection-options/common-connection-options).

## Deployment

`0x-coordinator-server` ships as a docker container. First, install Docker ([mac](https://docs.docker.com/docker-for-mac/install/), [windows](https://docs.docker.com/docker-for-windows/install/)). Before you can build the image, make sure you've edited your configs as outlined in step 5 of [Pre-Requirements](#pre-requirements).

To build the image run:

```sh
docker build -t 0x-coordinator-server .
```

You can check that the image was built by running:

```sh
docker images
```

And launch it with

```sh
docker run -p 3000:3000 -d 0x-coordinator-server
```

## Legal Disclaimer

The laws and regulations applicable to the use and exchange of digital assets and blockchain-native tokens, including through any software developed using the licensed work created by ZeroEx Intl. as described here (the “Work”), vary by jurisdiction. As set forth in the Apache License, Version 2.0 applicable to the Work, developers are “solely responsible for determining the appropriateness of using or redistributing the Work,” which includes responsibility for ensuring compliance with any such applicable laws and regulations.
See the Apache License, Version 2.0 for the specific language governing all applicable permissions and limitations: http://www.apache.org/licenses/LICENSE-2.0
