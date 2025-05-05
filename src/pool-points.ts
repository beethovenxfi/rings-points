import moment from 'moment-timezone';
import { formatEther, formatUnits, parseEther, parseUnits } from 'viem';

const GRAPH_BASE_URL = `https://gateway-arbitrum.network.thegraph.com/api/${process.env.GRAPH_API_KEY}/deployments/id/`;
const BALANCER_V3_GRAPH_DEPLOYMENT_ID = `QmUgRWkb5JUocGkVidpKtZFMHjexJzkBiSbjufURsXwn9X`;
const BLOCKS_GRAPH_DEPLOYMENT_ID = `QmZYZcSMaGY2rrq8YFP9avicWf2GM8R2vpB2Xuap1WhipT`;

const PRECISION_DECIMALS = 36;
const NUMBER_OF_SNAPSHOTS_PER_EPOCH = 56;

interface PoolTokenBalance {
    id: string;
    balance: bigint;
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

async function getV3PoolTokenBalances(tokenAddress: string, blockNumber: number): Promise<PoolTokenBalance[]> {
    const poolQuery = `
        {
        pools(where: {tokens_: {address_in: ["${tokenAddress}"]}}
        block: {number: ${blockNumber}}) {
            id
            tokens {
                address
                balance
            }
            }   
        }`;

    const poolsResponseV3 = (await fetch(GRAPH_BASE_URL + BALANCER_V3_GRAPH_DEPLOYMENT_ID, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
        },
        body: JSON.stringify({ query: poolQuery }),
    }).then((res) => res.json())) as {
        data: {
            pools: {
                id: string;
                tokens: {
                    address: string;
                    balance: string;
                }[];
            }[];
        };
    };

    const v3Result: PoolTokenBalance[] = [];

    for (const pool of poolsResponseV3.data.pools) {
        const tokenBalanceInPool = pool.tokens.find(
            (token) => token.address.toLowerCase() === tokenAddress.toLowerCase(),
        )?.balance;

        if (!tokenBalanceInPool) {
            new Error(`Token balance not found in pool ${pool.id}`);
        }

        v3Result.push({
            id: pool.id,
            balance: BigInt(parseEther(tokenBalanceInPool!)),
        });
    }

    return v3Result;
}

async function getBalancesForBlockRange(tokenAddress: string, startBlock: number, endBlock: number) {
    const tokensHeldByPool: Record<string, bigint> = {};

    const blockInterval = Math.floor((endBlock - startBlock) / NUMBER_OF_SNAPSHOTS_PER_EPOCH);

    for (let block = startBlock; block <= endBlock; block += blockInterval) {
        const poolTokenBalance = await getV3PoolTokenBalances(tokenAddress, block);
        for (const pool of poolTokenBalance) {
            if (tokensHeldByPool[pool.id]) {
                tokensHeldByPool[pool.id] += pool.balance;
            } else {
                tokensHeldByPool[pool.id] = pool.balance;
            }
        }
    }

    return tokensHeldByPool;
}

function getTokenWeightsFromBalances(balances: Record<string, bigint>) {
    const totalTokenBalance = Object.values(balances).reduce((acc, balance) => (acc += balance));

    const poolWeights: Record<string, bigint> = {};

    let lastPool = '';
    for (const pool in balances) {
        if (balances.hasOwnProperty(pool)) {
            const balance = balances[pool];
            poolWeights[pool] = (balance * parseUnits('1', PRECISION_DECIMALS)) / totalTokenBalance;
            lastPool = pool;
        }
    }

    // need to make sure total of all weights is 1, select an unlucky user
    const totalWeight = Object.values(poolWeights).reduce((acc, balance) => (acc += balance));
    if (totalWeight > parseUnits('1', PRECISION_DECIMALS)) {
        console.log(totalWeight);
        console.log(`sorry, need to deduct ${totalWeight - parseUnits('1', PRECISION_DECIMALS)} from ${lastPool}`);
        poolWeights[lastPool] = poolWeights[lastPool] - (totalWeight - parseUnits('1', PRECISION_DECIMALS));
    } else if (totalWeight < parseUnits('1', PRECISION_DECIMALS)) {
        console.log(totalWeight);
        console.log(`yay, need to add ${parseUnits('1', PRECISION_DECIMALS) - totalWeight} to ${lastPool}`);
        poolWeights[lastPool] = poolWeights[lastPool] + (parseUnits('1', PRECISION_DECIMALS) - totalWeight);
    }

    const totalWeightAfter = Object.values(poolWeights).reduce((acc, balance) => (acc += balance));

    if (totalWeightAfter !== parseUnits('1', PRECISION_DECIMALS)) {
        console.log(totalWeightAfter);
        throw Error('Did not add up to 1e36');
    }

    const weights: {
        poolId: string;
        weight: string;
    }[] = [];

    Object.entries(poolWeights).forEach(([userAddress, weight]) => {
        weights.push({
            poolId: userAddress,
            weight: weight.toString(),
        });
    });
    return weights;
}

async function getPoolWeights(tokenAddress: string, startTimestamp: number, endTimestamp: number) {
    const startBlock = await getBlockForTimestamp(startTimestamp);

    // for debug, so we can also run it in the middle of an epoch
    let endBlock = 0;
    if (endTimestamp > moment().unix()) {
        endBlock = await getBlockForTimestamp(moment().subtract(2, 'hours').unix());
    } else {
        endBlock = await getBlockForTimestamp(endTimestamp);
    }

    console.log(`Running for token ${tokenAddress}`);
    console.log(`Start block: ${startBlock}`);
    console.log(`Start time: ${moment.unix(startTimestamp).format('MM/DD/YYYY - HH:mm:ss ZZ')}`);
    console.log(`End block: ${endBlock}`);
    console.log(`End time: ${moment.unix(endTimestamp).format('MM/DD/YYYY - HH:mm:ss ZZ')}`);

    const totalBalances = await getBalancesForBlockRange(tokenAddress, startBlock, endBlock);

    const poolWeights = getTokenWeightsFromBalances(totalBalances);

    const filteredBalances: Record<string, bigint> = {};

    // filter any pools that have a weight of less that 1%
    poolWeights.forEach((pool) => {
        if (parseFloat(formatUnits(BigInt(pool.weight), PRECISION_DECIMALS)) > 0.01) {
            filteredBalances[pool.poolId] = totalBalances[pool.poolId];
        } else {
            console.log(
                `Pool ${pool.poolId} has a weight of less than 1%: ${formatUnits(
                    BigInt(pool.weight),
                    PRECISION_DECIMALS,
                )}`,
            );
        }
    });

    const filteredPoolWeights = getTokenWeightsFromBalances(filteredBalances);

    console.log(`poolId,weight`);
    filteredPoolWeights.forEach((pool) => {
        console.log(`${pool.poolId},${formatUnits(BigInt(pool.weight), 36)}`);
    });
}

async function runCycle() {
    await getPoolWeights('0x6646248971427b80ce531bdd793e2eb859347e55', 1745280000, 1746316800);
}

runCycle();
