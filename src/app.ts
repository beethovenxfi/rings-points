import moment from 'moment-timezone';
import { formatEther, parseEther, parseUnits } from 'viem';

const GRAPH_BASE_URL = `https://gateway-arbitrum.network.thegraph.com/api/${process.env.GRAPH_API_KEY}/deployments/id/`;
const BALANCER_GRAPH_DEPLOYMENT_ID = `Qmbt2NyWBL8WKV5EuBDbByUEUETfhUBVpsLpptFbnwEyrK`;
const BALANCER_V3_GRAPH_DEPLOYMENT_ID = `QmR1ZDqDUyXih88ytCdaK3hV4ynrJJWst8UjeTg82PGwAf`;
const GAUGE_GRAPH_DEPLOYMENT_ID = `QmSRNzwTmLu55ZxxyxYULS5T1Kar7upz1jzL5FsMzLpB2e`;
const BLOCKS_GRAPH_DEPLOYMENT_ID = `QmZYZcSMaGY2rrq8YFP9avicWf2GM8R2vpB2Xuap1WhipT`;

const API_URL = `https://backend-v3.beets-ftm-node.com/graphql`;

const PRECISION_DECIMALS = 36;

const ONE_WEEK_IN_SECONDS = 604800;

const SCUSD_ADDRESS = '0xd3dce716f3ef535c5ff8d041c1a41c3bd89b97ae';
const SCETH_ADDRESS = '0x3bce5cb273f0f148010bbea2470e7b5df84c7812';
const WSTKSCUSD_ADDRESS = '0x9fb76f7ce5fceaa2c42887ff441d46095e494206';
const WSTKSCETH_ADDRESS = '0x24c74b30d1a4261608e84bf5a618693032681dac';

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

async function getV2PoolUserBalances(tokenAddress: string, blockNumber: number): Promise<PoolUserBalance[]> {
    let hasMore = true;
    let id = `0`;
    const pageSize = 1000;
    const v2PoolIds: string[] = [];

    while (hasMore) {
        const query = `
        {
        pools(
            where: {tokensList_contains_nocase: ["${tokenAddress}"], totalShares_gt: 0, id_gt: "${id}"}
            orderBy: id
            orderDirection: asc
            first: ${pageSize}
            block: {number: ${blockNumber}}
        ) {
            id
        }
        }`;

        const pools = (await fetch(GRAPH_BASE_URL + BALANCER_GRAPH_DEPLOYMENT_ID, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
            },
            body: JSON.stringify({ query: query }),
        }).then((res) => res.json())) as {
            data: {
                pools: {
                    id: string;
                }[];
            };
        };

        if (pools.data.pools.length === 0) {
            break;
        }

        if (pools.data.pools.length < pageSize) {
            hasMore = false;
        }

        v2PoolIds.push(...pools.data.pools.map((pool) => pool.id));

        id = pools.data.pools[pools.data.pools.length - 1].id;
    }

    hasMore = true;
    id = `0`;
    const allPoolShares: {
        id: string;
        userAddress: { id: string };
        poolId: {
            id: string;
            totalShares: string;
            tokens: { address: string; balance: string }[];
        };
        balance: string;
    }[] = [];

    while (hasMore) {
        const query = `
        {
        poolShares(
            where: {poolId_in:["${v2PoolIds.join(
                '", "',
            )}"], userAddress_: {id_not: "0x0000000000000000000000000000000000000000"}, balance_gt:0, id_gt : "${id}"}
            orderBy: id
            orderDirection: asc
            first: ${pageSize}
            block: {number: ${blockNumber}}
        ) {
            id
            userAddress {
                id
            }
            poolId {
                id
                totalShares
                tokens{
                    address
                    balance
                }
            }
            balance
        }
        }`;

        const shares = (await fetch(GRAPH_BASE_URL + BALANCER_GRAPH_DEPLOYMENT_ID, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
            },
            body: JSON.stringify({ query: query }),
        }).then((res) => res.json())) as {
            data: {
                poolShares: {
                    id: string;
                    userAddress: { id: string };
                    poolId: {
                        id: string;
                        totalShares: string;
                        tokens: { address: string; balance: string }[];
                    };
                    balance: string;
                }[];
            };
        };

        if (shares.data.poolShares.length === 0) {
            break;
        }

        if (shares.data.poolShares.length < pageSize) {
            hasMore = false;
        }

        allPoolShares.push(...shares.data.poolShares);

        id = shares.data.poolShares[shares.data.poolShares.length - 1].id;
    }

    const result: PoolUserBalance[] = [];

    for (const share of allPoolShares) {
        const pool = result.find((pool) => pool.id === share.poolId.id);

        if (!pool) {
            result.push({
                id: share.poolId.id,
                totalShares: share.poolId.totalShares,
                tokens: share.poolId.tokens.map((token) => {
                    return {
                        address: token.address,
                        balance: token.balance,
                    };
                }),
                shares: [
                    {
                        balance: share.balance,
                        userAddress: share.userAddress.id,
                    },
                ],
            });
        } else {
            pool.shares.push({
                balance: share.balance,
                userAddress: share.userAddress.id,
            });
        }
    }

    return result;
}

async function getV3PoolUserBalances(tokenAddress: string, blockNumber: number): Promise<PoolUserBalance[]> {
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
        first: 1000
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
    return v3Result;
}

async function getApiGauges(poolIds: string[]) {
    const apiGauges = (await fetch(API_URL, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
        },
        body: JSON.stringify({
            query: `{
                    poolGetPools(
                        where: {chainIn: [SONIC], idIn: ["${poolIds.join('", "')}"]}
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

    return apiGauges;
}

async function getBalancesForBlock(tokenAddress: string, startBlock: number, endBlock: number) {
    const tokensOwnedInV2: Record<string, bigint> = {};
    const tokensOwnedInV3: Record<string, bigint> = {};

    const blockInterval = Math.floor((endBlock - startBlock) / NUMBER_OF_SNAPSHOTS_PER_EPOCH);

    for (let block = startBlock; block <= endBlock; block += blockInterval) {
        const v2PoolUserBalances = await getV2PoolUserBalances(tokenAddress, block);
        const v3PoolUserBalances = await getV3PoolUserBalances(tokenAddress, block);

        const v2ApiGauges = await getApiGauges(v2PoolUserBalances.map((pool) => pool.id));
        const v3ApiGauges = await getApiGauges(v3PoolUserBalances.map((pool) => pool.id));

        await getTokensOwnedByUser(v2PoolUserBalances, tokenAddress, tokensOwnedInV2, v2ApiGauges, block);
        await getTokensOwnedByUser(v3PoolUserBalances, tokenAddress, tokensOwnedInV3, v3ApiGauges, block);
    }

    return {
        v2: tokensOwnedInV2,
        v3: tokensOwnedInV3,
    };
}

async function getTokensOwnedByUser(
    poolUserBalances: PoolUserBalance[],
    tokenAddress: string,
    tokensOwned: Record<string, bigint>,
    apiGauges: {
        data: {
            poolGetPools: {
                id: string;
                staking: {
                    gauge: { id: string };
                };
            }[];
        };
    },
    blockNumber: number,
) {
    for (const pool of poolUserBalances) {
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
        if (totalBalances - parseFloat(pool.totalShares!) > 1 || totalBalances - parseFloat(pool.totalShares!) < -1) {
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
            let hasMore = true;
            let id = `0`;
            const pageSize = 1000;
            const allGaugeShares: {
                id: string;
                user: { id: string };
                balance: string;
                gauge: {
                    totalSupply: string;
                };
            }[] = [];

            while (hasMore) {
                const query = `
                {
                gaugeShares(
                    where: {gauge_:{id:"${apiPool.staking.gauge.id}"}, balance_gt:0, id_gt : "${id}"}
                    orderBy: id
                    orderDirection: asc
                    first: ${pageSize}
                    block: {number: ${blockNumber}}
                ) {
                    id
                    user{
                        id
                    }
                    balance
                    gauge{
                        totalSupply
                    }
                }
                }`;

                const shares = (await fetch(GRAPH_BASE_URL + GAUGE_GRAPH_DEPLOYMENT_ID, {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                    },
                    body: JSON.stringify({ query: query }),
                }).then((res) => res.json())) as {
                    data: {
                        gaugeShares: {
                            id: string;
                            user: { id: string };
                            balance: string;
                            gauge: {
                                totalSupply: string;
                            };
                        }[];
                    };
                };

                if (shares.data.gaugeShares.length === 0) {
                    break;
                }

                if (shares.data.gaugeShares.length < pageSize) {
                    hasMore = false;
                }

                allGaugeShares.push(...shares.data.gaugeShares);

                id = shares.data.gaugeShares[shares.data.gaugeShares.length - 1].id;
            }

            if (allGaugeShares.length > 0) {
                delete tokensOwned[apiPool.staking.gauge.id];

                let totalShares = 0;
                for (const share of allGaugeShares) {
                    if (parseFloat(share.balance) > 0) {
                        totalShares += parseFloat(share.balance);

                        const userShareOfPool = (parseFloat(share.balance!) / parseFloat(pool.totalShares)).toFixed(18);
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
                    totalShares - parseFloat(allGaugeShares[0].gauge.totalSupply) > 1 ||
                    totalShares - parseFloat(allGaugeShares[0].gauge.totalSupply) < -1
                ) {
                    throw Error(
                        `TotalShares diff in gauge greater than 1, expected ${allGaugeShares[0].gauge.totalSupply} but got ${totalShares}`,
                    );
                }
            }
        }
    }
}

function getUserWeightsFromBalances(balances: Record<string, bigint>) {
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

    Object.entries(userWeights).forEach(([userAddress, weight]) => {
        weights.push({
            user: userAddress,
            weight: weight.toString(),
        });
    });
    return weights;
}

async function getUserWeights(tokenName: 'scUSD' | 'scETH' | 'wstkscUSD' | 'wstkscETH', cycle: number = -1) {
    const startOfEpochZero = 1734627600; // has an odd start
    const endOfEpochZero = 1735340400; // therefore also odd end

    let tokenAddress = '';
    let type = '';

    switch (tokenName) {
        case 'scUSD':
            tokenAddress = SCUSD_ADDRESS;
            type = 'holding-usd';
            break;
        case 'wstkscUSD':
            tokenAddress = WSTKSCUSD_ADDRESS;
            type = 'wrapped-staking-usd';
            break;
        case 'scETH':
            tokenAddress = SCETH_ADDRESS;
            type = 'holding-eth';
            break;
        case 'wstkscETH':
            tokenAddress = WSTKSCETH_ADDRESS;
            type = 'wrapped-staking-eth';
            break;
        default:
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

    // const type = tokenName === 'scUSD' ? 'holding-usd' : 'holding-eth';

    // calculate weights
    if (Object.keys(balances.v2).length > 0) {
        const userWeightsV2: { user: string; weight: string }[] = getUserWeightsFromBalances(balances.v2);
        console.log(`Sending v2 payload for cycle: ${cycle} for token: ${tokenName}`);
        await sendPayload(cycle, type, { pools: { '0xBA12222222228d8Ba445958a75a0704d566BF2C8': userWeightsV2 } });
    } else {
        console.log(`No balances found for cycle: ${cycle} for token: ${tokenName}`);
    }
    if (Object.keys(balances.v3).length > 0) {
        const userWeightsV3: { user: string; weight: string }[] = getUserWeightsFromBalances(balances.v3);
        console.log(`Sending v3 payload for cycle: ${cycle} for token: ${tokenName}`);
        await sendPayload(cycle, type, { pools: { '0xbA1333333333a1BA1108E8412f11850A5C319bA9': userWeightsV3 } });
    } else {
        console.log(`No balances found for cycle: ${cycle} for token: ${tokenName}`);
    }
}

async function sendPayload(cycle: number, type: string, payload: any) {
    const response = await fetch(`https://points-api.rings.money/protocol-points/beets/${cycle}/${type}`, {
        method: 'POST',
        headers: new Headers({
            Authorization: `Bearer ${process.env.RINGS_API_KEY}`,
            'Content-Type': 'application/json',
        }),
        body: JSON.stringify(payload),
    });
    if (response.status !== 201) {
        console.log(await response.text());
    } else {
        console.log('Success');
    }
}

async function runCycle() {
    await getUserWeights('scUSD', 15);
    await getUserWeights('scETH', 15);
    await getUserWeights('wstkscETH', 15);
    await getUserWeights('wstkscUSD', 15);
}

runCycle();
