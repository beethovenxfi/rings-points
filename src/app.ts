import moment from 'moment-timezone';
import { createPublicClient, formatEther, formatUnits, http, parseAbi, parseEther, parseUnits } from 'viem';
import { sonic } from 'viem/chains';
import * as fs from 'fs';

const GRAPH_BASE_URL = `https://gateway-arbitrum.network.thegraph.com/api/${process.env.GRAPH_API_KEY}/deployments/id/`;
const BALANCER_GRAPH_DEPLOYMENT_ID = `Qmbt2NyWBL8WKV5EuBDbByUEUETfhUBVpsLpptFbnwEyrK`;
const BALANCER_V3_GRAPH_DEPLOYMENT_ID = `QmR1ZDqDUyXih88ytCdaK3hV4ynrJJWst8UjeTg82PGwAf`;
const GAUGE_GRAPH_DEPLOYMENT_ID = `QmSRNzwTmLu55ZxxyxYULS5T1Kar7upz1jzL5FsMzLpB2e`;
const BLOCKS_GRAPH_DEPLOYMENT_ID = `QmZYZcSMaGY2rrq8YFP9avicWf2GM8R2vpB2Xuap1WhipT`;

const API_URL = `https://backend-v3.beets-ftm-node.com/graphql`;

const RPC_URL = `https://rpc.soniclabs.com`;
const BALANCER_VAULT_ADDRESS = '0xBA12222222228d8Ba445958a75a0704d566BF2C8';

const PRECISION_DECIMALS = 36;

const ONE_WEEK_IN_SECONDS = 604800;

const SCUSD_ADDRESS = '0xd3dce716f3ef535c5ff8d041c1a41c3bd89b97ae';
const SCETH_ADDRESS = '0x3bce5cb273f0f148010bbea2470e7b5df84c7812';

const NUMBER_OF_SNAPSHOTS_PER_EPOCH = 56;

interface PoolUserBalance {
    id: string;
    totalShares: string;
    tokens: {
        address: string;
        balance: string;
    }[];
    shares: {
        userAddress: string;
        balance: string;
    }[];
}

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

async function getUserBalances(tokenAddress: string, blockNumber: number): Promise<PoolUserBalance[]> {
    const query = `
    {
    pools(
        where: {tokensList_contains_nocase: ["${tokenAddress}"], totalShares_gt: 0}
        block: {number: ${blockNumber}}
    ) {
        id
        totalShares
        tokens {
            address
            balance
        }
        shares(
        where: {userAddress_: {id_not: "0x0000000000000000000000000000000000000000"}, balance_gt: 0}, first: 1000
        ) {
            balance
            userAddress {
                id
            }
        }
    }
    }`;

    const poolsResponseV2 = (await fetch(GRAPH_BASE_URL + BALANCER_GRAPH_DEPLOYMENT_ID, {
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

    const result = poolsResponseV2.data.pools.map((pool) => {
        return {
            id: pool.id,
            totalShares: pool.totalShares,
            tokens: pool.tokens.map((token) => {
                return {
                    address: token.address,
                    balance: token.balance,
                };
            }),
            shares: pool.shares.map((share) => {
                return {
                    balance: share.balance,
                    userAddress: share.userAddress.id,
                };
            }),
        };
    });

    const poolIdQuery = `
        {
        pools(where: {tokens_: {address_in: ["${tokenAddress}"]}}
        block: {number: ${blockNumber}}) {
            id
            }   
        }`;

    const poolIdsV3 = (await fetch(GRAPH_BASE_URL + BALANCER_V3_GRAPH_DEPLOYMENT_ID, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
        },
        body: JSON.stringify({ query: poolIdQuery }),
    }).then((res) => res.json())) as {
        data: {
            pools: {
                id: string;
            }[];
        };
    };

    const sharesQueryV3 = `
    {
    poolShares(
        where: {pool_in: ["${poolIdsV3.data.pools
            .map((pool) => pool.id)
            .join('", "')}"], balance_gt: 0, user_: {id_not: "0x0000000000000000000000000000000000000000"}}
        block: {number: ${blockNumber}}
    ) {
        user {
            id
        }
        balance
        pool {
            id
            totalShares
            tokens {
                address
                balance
            }
        }
    }
    }`;

    const poolsResponseV3 = (await fetch(GRAPH_BASE_URL + BALANCER_V3_GRAPH_DEPLOYMENT_ID, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
        },
        body: JSON.stringify({ query: sharesQueryV3 }),
    }).then((res) => res.json())) as {
        data: {
            poolShares: {
                user: { id: string };
                balance: string;
                pool: {
                    id: string;
                    totalShares: string;
                    tokens: {
                        address: string;
                        balance: string;
                    }[];
                };
            }[];
        };
    };

    const v3Result: PoolUserBalance[] = [];

    for (const share of poolsResponseV3.data.poolShares) {
        const pool = v3Result.find((pool) => pool.id === share.pool.id);

        if (!pool) {
            v3Result.push({
                id: share.pool.id,
                totalShares: share.pool.totalShares,
                tokens: share.pool.tokens.map((token) => {
                    return {
                        address: token.address,
                        balance: token.balance,
                    };
                }),
                shares: [
                    {
                        balance: share.balance,
                        userAddress: share.user.id,
                    },
                ],
            });
        } else {
            pool.shares.push({
                balance: share.balance,
                userAddress: share.user.id,
            });
        }
    }

    return [...result, ...v3Result];
}

async function getBalancesForBlock(tokenAddress: string, startBlock: number, endBlock: number) {
    const tokensOwned: Record<string, bigint> = {};

    const blockInterval = Math.floor((endBlock - startBlock) / NUMBER_OF_SNAPSHOTS_PER_EPOCH);

    for (let i = startBlock; i <= endBlock; i += blockInterval) {
        const poolsResponse = await getUserBalances(tokenAddress, i);

        const apiGauges = (await fetch(API_URL, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
            },
            body: JSON.stringify({
                query: `{
                        poolGetPools(
                            where: {chainIn: [SONIC], idIn: ["${poolsResponse.map((pool) => pool.id).join('", "')}"]}
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

        for (const pool of poolsResponse) {
            const tokenBalanceInPool = pool.tokens.find(
                (token) => token.address.toLowerCase() === tokenAddress.toLowerCase(),
            )?.balance;

            if (!tokenBalanceInPool) {
                new Error(`Token balance not found in pool ${pool.id}`);
            }

            let totalBalances = 0;
            let totalTokensOwned = 0n;

            for (const user of pool.shares) {
                totalBalances += parseFloat(user.balance);

                if (parseFloat(user.balance) > 0) {
                    const usersShareOfPool = (parseFloat(user.balance!) / parseFloat(pool.totalShares)).toFixed(18);
                    const tokensOwnedByUser =
                        (BigInt(parseEther(tokenBalanceInPool!)) * BigInt(parseEther(`${usersShareOfPool}`))) /
                        parseEther('1');

                    totalTokensOwned += tokensOwnedByUser;

                    if (tokensOwned[user.userAddress]) {
                        tokensOwned[user.userAddress] = tokensOwned[user.userAddress] + tokensOwnedByUser;
                    } else {
                        tokensOwned[user.userAddress] = tokensOwnedByUser;
                    }
                }
            }

            // sanity check to make sure we are not missing any user shares
            if (
                totalBalances - parseFloat(pool.totalShares!) > 1 ||
                totalBalances - parseFloat(pool.totalShares!) < -1
            ) {
                throw Error(`TotalSupply diff greater than 1, expected ${pool.totalShares} but got ${totalBalances}`);
            }
            if (
                parseFloat(tokenBalanceInPool!) - parseFloat(formatEther(totalTokensOwned)) > 1 ||
                parseFloat(tokenBalanceInPool!) - parseFloat(formatEther(totalTokensOwned)) < -1
            ) {
                throw Error(
                    `TokenBalance diff greater than 1, expected ${tokenBalanceInPool} but got ${parseFloat(
                        formatEther(totalTokensOwned),
                    )}`,
                );
            }

            const apiPool = apiGauges.data.poolGetPools.find((p) => p.id === pool.id);

            if (apiPool?.staking) {
                const query = `
                            {
                            liquidityGauge(id: "${apiPool.staking.gauge.id}",
                            block: {number: ${i}}) {
                                shares(where: {balance_gt: 0}, first: 1000) {
                                    user {
                                            id
                                        }
                                    balance
                                    }
                                totalSupply   
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
                            totalSupply: string;
                        };
                    };
                };

                if (gaugeReponse.data.liquidityGauge) {
                    delete tokensOwned[apiPool.staking.gauge.id];

                    let totalShares = 0;
                    for (const share of gaugeReponse.data.liquidityGauge.shares) {
                        if (parseFloat(share.balance) > 0) {
                            totalShares += parseFloat(share.balance);

                            const userShareOfPool = (parseFloat(share.balance!) / parseFloat(pool.totalShares)).toFixed(
                                18,
                            );
                            const tokensOwnedByUser =
                                (BigInt(parseEther(tokenBalanceInPool!)) * BigInt(parseEther(`${userShareOfPool}`))) /
                                parseEther('1');

                            if (tokensOwned[share.user.id]) {
                                tokensOwned[share.user.id] = tokensOwned[share.user.id] + tokensOwnedByUser;
                            } else {
                                tokensOwned[share.user.id] = tokensOwnedByUser;
                            }
                        }
                    }

                    // sanity check to make sure we are not missing any user shares
                    if (
                        totalShares - parseFloat(gaugeReponse.data.liquidityGauge.totalSupply) > 1 ||
                        totalShares - parseFloat(gaugeReponse.data.liquidityGauge.totalSupply) < -1
                    ) {
                        throw Error(
                            `TotalShares diff in gauge greater than 1, expected ${gaugeReponse.data.liquidityGauge.totalSupply} but got ${totalShares}`,
                        );
                    }
                }
            }
        }
    }

    return tokensOwned;
}

async function getAverageTokenBalance(tokenAddress: string, startBlock: number, endBlock: number) {
    const blockInterval = Math.floor((endBlock - startBlock) / NUMBER_OF_SNAPSHOTS_PER_EPOCH);

    let sumOfTokenBalance = 0n;
    const client = createPublicClient({
        chain: sonic,
        transport: http(),
    });

    for (let i = startBlock; i <= endBlock; i += blockInterval) {
        const balance = (await client.readContract({
            address: tokenAddress as `0x${string}`,
            abi: parseAbi(['function balanceOf(address) view returns (uint256)']),
            functionName: 'balanceOf',
            args: [BALANCER_VAULT_ADDRESS],
            blockNumber: BigInt(i),
        })) as bigint;

        sumOfTokenBalance += balance;
    }

    return sumOfTokenBalance / BigInt(NUMBER_OF_SNAPSHOTS_PER_EPOCH);
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
    let endOfEpochTimestamp = startOfEpochTimestamp + ONE_WEEK_IN_SECONDS; // epoch 1 end

    // make sure we can also just pass a cycle number if we want to recompute
    if (cycle === 0) {
        startOfEpochTimestamp = startOfEpochZero;
        endOfEpochTimestamp = endOfEpochZero;
    } else if (cycle < 0) {
        cycle = Math.floor((moment().unix() - startOfEpochTimestamp) / ONE_WEEK_IN_SECONDS);
        startOfEpochTimestamp = startOfEpochTimestamp + (cycle - 1) * ONE_WEEK_IN_SECONDS;
        endOfEpochTimestamp = startOfEpochTimestamp + ONE_WEEK_IN_SECONDS;
    } else {
        startOfEpochTimestamp = startOfEpochTimestamp + (cycle - 1) * ONE_WEEK_IN_SECONDS;
        endOfEpochTimestamp = startOfEpochTimestamp + ONE_WEEK_IN_SECONDS;
    }

    const startBlock = await getBlockForTimestamp(startOfEpochTimestamp);

    // for debug, so we can also run it in the middle of an epoch
    let endBlock = 0;
    if (endOfEpochTimestamp > moment().unix()) {
        endBlock = await getBlockForTimestamp(moment().subtract(2, 'hours').unix());
    } else {
        endBlock = await getBlockForTimestamp(endOfEpochTimestamp);
    }

    console.log(`Running for cycle: ${cycle} for token: ${tokenName}`);
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

    if (tokenName === 'scUSD') {
        const userPoints: Record<string, number> = {};
        const averageBalance = await getAverageTokenBalance(tokenAddress, startBlock, endBlock);
        console.log(formatUnits(averageBalance, 6));

        for (const userAddress in userWeights) {
            const weight = userWeights[userAddress];
            const points =
                parseFloat(formatUnits(weight, PRECISION_DECIMALS)) *
                parseFloat(formatUnits(averageBalance, 6)) *
                36 *
                7;

            if (userPoints[userAddress]) {
                userPoints[userAddress] = userPoints[userAddress] + points;
            } else {
                userPoints[userAddress] = points;
            }
        }

        const pointsResult: {
            user: string;
            points: string;
        }[] = [];

        const fileName = `rings_cycle_${cycle}_${tokenName}_beets_points.json`;

        Object.entries(userPoints).forEach(([userAddress, points]) => {
            pointsResult.push({
                user: userAddress,
                points: points.toString(),
            });
        });

        fs.writeFile(fileName, JSON.stringify(pointsResult), function (err) {
            if (err) {
                return console.error(err);
            }
            console.log(`File created: ${fileName}`);
        });
    }
}

async function runCycle() {
    await getUserWeights('scUSD');
    await getUserWeights('scETH');
}

runCycle();
