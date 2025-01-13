import moment from 'moment-timezone';
import { parseEther, parseUnits } from 'viem';
import * as fs from 'fs';

const GRAPH_BASE_URL = `https://gateway-arbitrum.network.thegraph.com/api/${process.env.GRAPH_API_KEY}/deployments/id/`;
const BALANCER_GRAPH_DEPLOYMENT_ID = `Qmbt2NyWBL8WKV5EuBDbByUEUETfhUBVpsLpptFbnwEyrK`;
const GAUGE_GRAPH_DEPLOYMENT_ID = `QmSRNzwTmLu55ZxxyxYULS5T1Kar7upz1jzL5FsMzLpB2e`;
const BLOCKS_GRAPH_DEPLOYMENT_ID = `QmZYZcSMaGY2rrq8YFP9avicWf2GM8R2vpB2Xuap1WhipT`;

const API_URL = `https://backend-v3.beets-ftm-node.com/graphql`;

const PRECISION_DECIMALS = 36;

const ONE_WEEK_IN_SECONDS = 604800;

const SCUSD_ADDRESS = '0xd3dce716f3ef535c5ff8d041c1a41c3bd89b97ae';
const SCETH_ADDRESS = '0x3bce5cb273f0f148010bbea2470e7b5df84c7812';

const NUMBER_OF_SNAPSHOTS_PER_EPOCH = 56;

async function getBlockForTimestamp(timestmap: number): Promise<number> {
    const query = `
    {
      blocks(where: {timestamp_gte: ${timestmap}}, orderBy: number, orderDirection: asc) {
        number
      }
    }`;

    const blocksResponse = (await fetch(GRAPH_BASE_URL + BLOCKS_GRAPH_DEPLOYMENT_ID, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
        },
        body: JSON.stringify({ query: query }),
    }).then((res) => res.json())) as {
        data: { blocks: { number: string }[] };
    };

    return parseFloat(blocksResponse.data.blocks[0].number);
}

async function getBalancesForBlock(tokenAddress: string, startBlock: number, endBlock: number) {
    const tokensOwned: Record<string, bigint> = {};

    const blockInterval = Math.floor((endBlock - startBlock) / NUMBER_OF_SNAPSHOTS_PER_EPOCH);

    for (let i = startBlock; i <= endBlock; i += blockInterval) {
        const query = `
        {
        pools(
            where: {tokensList_contains_nocase: ["${tokenAddress}"], totalShares_gt: 0}
            block: {number: ${i}}
        ) {
            id
            totalShares
            tokens {
                address
                balance
            }
            shares(
            where: {userAddress_: {id_not: "0x0000000000000000000000000000000000000000"}}
            ) {
                balance
                userAddress {
                    id
                }
            }
        }
        }`;

        const poolsResponse = (await fetch(GRAPH_BASE_URL + BALANCER_GRAPH_DEPLOYMENT_ID, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
            },
            body: JSON.stringify({ query: query }),
        }).then((res) => res.json())) as {
            data: {
                pools: {
                    totalShares: string;
                    id: string;
                    tokens: { address: string; balance: string }[];
                    shares: { balance: string; userAddress: { id: string } }[];
                }[];
            };
        };

        const apiGauges = (await fetch(API_URL, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
            },
            body: JSON.stringify({
                query: `{
                        poolGetPools(
                            where: {chainIn: [SONIC], idIn: ["${poolsResponse.data.pools
                                .map((pool) => pool.id)
                                .join('", "')}"]}
                        ) {
                            id
                            staking {
                            gauge {
                                id
                            }
                            }
                        }
                        }`,
            }),
        }).then((res) => res.json())) as {
            data: {
                poolGetPools: {
                    id: string;
                    staking: {
                        gauge: { id: string };
                    };
                }[];
            };
        };

        for (const pool of poolsResponse.data.pools) {
            const tokenBalanceInPool = pool.tokens.find(
                (token) => token.address.toLowerCase() === tokenAddress.toLowerCase(),
            )?.balance;

            if (!tokenBalanceInPool) {
                new Error(`Token balance not found in pool ${pool.id}`);
            }

            const tokenPercentageOfTotalShares = (
                parseFloat(tokenBalanceInPool!) / parseFloat(pool.totalShares)
            ).toFixed(18);

            for (const user of pool.shares) {
                if (parseFloat(user.balance) > 0) {
                    if (tokensOwned[user.userAddress.id]) {
                        tokensOwned[user.userAddress.id] =
                            tokensOwned[user.userAddress.id] +
                            (BigInt(parseEther(user.balance)) * BigInt(parseEther(`${tokenPercentageOfTotalShares}`))) /
                                parseEther('100');
                    } else {
                        tokensOwned[user.userAddress.id] =
                            (BigInt(parseEther(user.balance)) * BigInt(parseEther(`${tokenPercentageOfTotalShares}`))) /
                            parseEther('100');
                    }
                }
            }

            const apiPool = apiGauges.data.poolGetPools.find((p) => p.id === pool.id);

            if (apiPool?.staking) {
                const query = `
                            {
                            liquidityGauge(id: "${apiPool.staking.gauge.id}",
                            block: {number: ${i}}) {
                                shares(where: {balance_gt: 0}) {
                                user {
                                    id
                                }
                                balance
                                }
                            }
                            }`;

                const gaugeReponse = (await fetch(GRAPH_BASE_URL + GAUGE_GRAPH_DEPLOYMENT_ID, {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                    },
                    body: JSON.stringify({ query: query }),
                }).then((res) => res.json())) as {
                    data: {
                        liquidityGauge: {
                            shares: { balance: string; user: { id: string } }[];
                        };
                    };
                };

                if (gaugeReponse.data.liquidityGauge) {
                    delete tokensOwned[apiPool.staking.gauge.id];

                    for (const share of gaugeReponse.data.liquidityGauge.shares) {
                        if (parseFloat(share.balance) > 0) {
                            if (tokensOwned[share.user.id]) {
                                tokensOwned[share.user.id] =
                                    tokensOwned[share.user.id] +
                                    (BigInt(parseEther(share.balance)) *
                                        BigInt(parseEther(`${tokenPercentageOfTotalShares}`))) /
                                        parseEther('100');
                            } else {
                                tokensOwned[share.user.id] =
                                    (BigInt(parseEther(share.balance)) *
                                        BigInt(parseEther(`${tokenPercentageOfTotalShares}`))) /
                                    parseEther('100');
                            }
                        }
                    }
                }
            }
        }
    }

    return tokensOwned;
}

async function getUserWeights(tokenName: string, cycle: number = -1) {
    const startOfEpochZero = 1734627600; // has an odd start
    const endOfEpochZero = 1735340400; // therefore also odd end

    let tokenAddress = '';

    if (tokenName === 'scUSD') {
        tokenAddress = SCUSD_ADDRESS;
    } else if (tokenName === 'scETH') {
        tokenAddress = SCETH_ADDRESS;
    } else {
        throw Error('Invalid token name');
    }

    let startOfEpochTimestamp = 1735340400; // epoch 1 start
    let endtOfEpochTimestamp = startOfEpochTimestamp + ONE_WEEK_IN_SECONDS; // epoch 1 end

    // make sure we can also just pass a cycle number if we want to recompute
    if (cycle === 0) {
        startOfEpochTimestamp = startOfEpochZero;
        endtOfEpochTimestamp = endOfEpochZero;
    } else if (cycle < 0) {
        cycle = Math.floor((moment().unix() - startOfEpochTimestamp) / ONE_WEEK_IN_SECONDS);
        startOfEpochTimestamp = startOfEpochTimestamp + (cycle - 1) * ONE_WEEK_IN_SECONDS;
        endtOfEpochTimestamp = startOfEpochTimestamp + ONE_WEEK_IN_SECONDS;
    } else {
        startOfEpochTimestamp = startOfEpochTimestamp + (cycle - 1) * ONE_WEEK_IN_SECONDS;
        endtOfEpochTimestamp = startOfEpochTimestamp + ONE_WEEK_IN_SECONDS;
    }

    const startBlock = await getBlockForTimestamp(startOfEpochTimestamp);

    const endOfEpochTimestamp = moment.unix(startOfEpochTimestamp).add(1, 'weeks').unix();

    // for debug, so we can also run it in the middle of an epoch
    let endBlock = 0;
    if (endOfEpochTimestamp > moment().unix()) {
        endBlock = await getBlockForTimestamp(moment().subtract(2, 'hours').unix());
    } else {
        endBlock = await getBlockForTimestamp(endOfEpochTimestamp);
    }

    console.log(`Running for cycle: ${cycle} for token: ${tokenAddress}`);
    console.log(`Start block: ${startBlock}`);
    console.log(`Start time: ${moment.unix(startOfEpochTimestamp).format('MM/DD/YYYY - HH:mm:ss ZZ')}`);
    console.log(`End block: ${endBlock}`);
    console.log(`End time: ${moment.unix(endOfEpochTimestamp).format('MM/DD/YYYY - HH:mm:ss ZZ')}`);

    const balances = await getBalancesForBlock(tokenAddress, startBlock, endBlock);

    const totalTokenBalance = Object.values(balances).reduce((acc, balance) => (acc += balance));

    const userWeights: Record<string, bigint> = {};

    let lastUser = '';
    for (const user in balances) {
        if (balances.hasOwnProperty(user)) {
            const balance = balances[user];
            userWeights[user] = (balance * parseUnits('1', PRECISION_DECIMALS)) / totalTokenBalance;
            lastUser = user;
        }
    }

    // need to make sure total of all weights is 1, select an unlucky user
    const totalWeight = Object.values(userWeights).reduce((acc, balance) => (acc += balance));
    if (totalWeight > parseUnits('1', PRECISION_DECIMALS)) {
        console.log(totalWeight);
        console.log(`sorry, need to deduct ${totalWeight - parseUnits('1', PRECISION_DECIMALS)} from ${lastUser}`);
        userWeights[lastUser] = userWeights[lastUser] - (totalWeight - parseUnits('1', PRECISION_DECIMALS));
    } else if (totalWeight < parseUnits('1', PRECISION_DECIMALS)) {
        console.log(totalWeight);
        console.log(`yay, need to add ${parseUnits('1', PRECISION_DECIMALS) - totalWeight} to ${lastUser}`);
        userWeights[lastUser] = userWeights[lastUser] + (parseUnits('1', PRECISION_DECIMALS) - totalWeight);
    }

    const totalWeightAfter = Object.values(userWeights).reduce((acc, balance) => (acc += balance));

    if (totalWeightAfter !== parseUnits('1', PRECISION_DECIMALS)) {
        console.log(totalWeightAfter);
        throw Error('Did not add up to 1e36');
    }

    const weights: {
        user: string;
        weight: string;
    }[] = [];

    const fileName = `rings_cycle_${cycle}_${tokenName}_beets.json`;

    Object.entries(userWeights).forEach(([userAddress, weight]) => {
        weights.push({
            user: userAddress,
            weight: weight.toString(),
        });
    });

    fs.writeFile(fileName, JSON.stringify(weights), function (err) {
        if (err) {
            return console.error(err);
        }
        console.log(`File created: ${fileName}`);
    });
}

async function runCycle() {
    await getUserWeights('scUSD');
    await getUserWeights('scETH');
}

runCycle();
