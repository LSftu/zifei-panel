const ccxt = require('ccxt');
const express = require('express');
const cors = require('cors');
const axios = require('axios');

const app = express();
const port = 3000; // 使用3001端口避免与其他服务冲突

// 启用CORS和JSON中间件

// 设置静态文件目录
app.use(express.static('public'));

// 渲染index.html
app.get('/', (req, res) => {
    res.sendFile(__dirname + '/public/index.html');
});

// 配置CORS选项
const corsOptions = {
    origin: '*', // 允许所有域名访问，生产环境建议设置为具体的域名
    methods: ['GET', 'POST', 'OPTIONS'], // 允许的HTTP方法
    allowedHeaders: ['Content-Type', 'Authorization'], // 允许的请求头
    exposedHeaders: ['Content-Length', 'X-Foo', 'X-Bar'], // 允许客户端访问的响应头
    credentials: true, // 允许发送cookies
    maxAge: 86400 // 预检请求的缓存时间（秒）
};

// 启用CORS
app.use(cors(corsOptions));



// 存储最新的交易机会
let latestOpportunities = [];
let lastUpdateTime = null;
// 创建交易对支持映射
let symbolMap = {};
// 存储各交易所资金费率信息
let bybitFundingMap = {};
let bitgetFundingMap = {};
let okxFundingMap = {};
let binanceFundingMap = {};

// 获取Bybit资金费率信息的函数
async function fetchBybitFundingInfo() {
    try {
        // 获取交易对信息
        const instrumentsResponse = await axios.get('https://api.bybit.com/v5/market/instruments-info', {
            params: {
                category: 'linear',
                limit: 1000,
            }
        });

        // 获取当前资金费率信息
        const response = await axios.get('https://api.bybit.com/v5/market/tickers', {
            params: {
                category: 'linear'
            }
        });

        if (response.data.retCode === 0 && response.data.result.list) {

            for (const item of response.data.result.list) {
                // 将BTCUSDT转换为BTC/USDT:USDT格式
                const baseSymbol = item.symbol.replace('USDT', '/USDT:USDT');
                const symbol = `${baseSymbol}`;

                // 从instruments信息中获取fundingInterval
                const instrumentInfo = instrumentsResponse.data.result.list.find(
                    inst => inst.symbol === item.symbol
                );
                bybitFundingMap[symbol] = {
                    fundingRate: parseFloat(item.fundingRate),
                    fundingTime: parseInt(item.nextFundingTime),
                    fundingInterval: instrumentInfo ? (parseInt(instrumentInfo.fundingInterval) / 60) : 0 // 转换为小时，默认0
                };
            }
        }

        console.log(`Updated Bybit funding rates at ${new Date().toISOString()}`);
        console.log(`Total symbols with funding info: ${Object.keys(bybitFundingMap).length}`);
   

    } catch (error) {
        console.error('Error fetching Bybit funding rates:', error);
    }
}

// 获取Bitget资金费率信息的函数
async function fetchBitgetFundingInfo() {
    try {
        // 获取当前有套利机会的Bitget交易对
        const bitgetSymbols = new Set();
        for (const opportunity of latestOpportunities) {
            if (opportunity.exchangeA === 'BITGET' || opportunity.exchangeB === 'BITGET') {
                bitgetSymbols.add(opportunity.symbol);
            }
        }

        if (bitgetSymbols.size === 0) {
            console.log('No Bitget opportunities found, skipping funding rate update');
            return;
        }

        // 并行请求所有交易对的资金费率数据
        await Promise.all(Array.from(bitgetSymbols).map(async (symbol) => {
            try {
                // 转换符号格式 BTC/USDT:USDT -> BTCUSDT
                const paramsSymbol = symbol.split('/')[0] + 'USDT';

                // 获取具体交易对的资金费率信息
                const response = await axios.get('https://api.bitget.com/api/v2/mix/market/current-fund-rate', {
                    params: {
                        symbol: paramsSymbol,
                        productType: 'usdt-futures'
                    }
                });
                
                if (response.data.code === '00000' && response.data.data) {
                    const fundingData = response.data.data[0];
                    bitgetFundingMap[symbol] = {
                        fundingRate: parseFloat(fundingData.fundingRate) || 0,
                        fundingTime: parseInt(fundingData.nextUpdate) || 0,
                        fundingInterval: parseInt(fundingData.fundingRateInterval)  
                    };
                } 
            } catch (error) {
                console.error(`Error fetching funding rate for ${symbol}:`, error.response ? error.response.data : error.message);
            }
        }));

        console.log(`Updated Bitget funding rates at ${new Date().toISOString()}`);
        console.log(`Total symbols with funding info: ${Object.keys(bitgetFundingMap).length}`);

    } catch (error) {
        console.error('Error in fetchBitgetFundingInfo:', error);
    }
}

// 获取OKX资金费率信息的函数
async function fetchOKXFundingInfo() {
    try {
        // 获取当前有套利机会的OKX交易对
        const okxSymbols = new Set();
        for (const opportunity of latestOpportunities) {
            if (opportunity.exchangeA === 'OKX' || opportunity.exchangeB === 'OKX') {
                okxSymbols.add(opportunity.symbol);
            }
        }

        if (okxSymbols.size === 0) {
            console.log('No OKX opportunities found, skipping funding rate update');
            return;
        }

        // 并行请求所有交易对的资金费率数据
        await Promise.all(Array.from(okxSymbols).map(async (symbol) => {
            try {
                // 将 BTC/USDT:USDT 转换为 BTC-USDT-SWAP
                const okxSymbol = symbol.split('/')[0] + '-USDT-SWAP';

                const response = await axios.get('https://www.okx.com/api/v5/public/funding-rate', {
                    params: {
                        instId: okxSymbol
                    }
                });


                if (response.data.code === '0' && response.data.data && response.data.data.length > 0) {
                    const data = response.data.data[0];
                    const fundingTime = parseInt(data.fundingTime);
                    const nextFundingTime = parseInt(data.nextFundingTime);
                    const fundingInterval = Math.floor((nextFundingTime - fundingTime) / 1000 / 60 / 60); // 转换为小时

                    okxFundingMap[symbol] = {
                        fundingRate: parseFloat(data.fundingRate),
                        fundingTime: fundingTime,
                        fundingInterval: fundingInterval
                    };
                }
            } catch (error) {
                console.error(`Error fetching funding rate for ${symbol}:`, error.response ? error.response.data : error.message);
            }
        }));

        console.log(`Updated OKX funding rates at ${new Date().toISOString()}`);
        console.log(`Total symbols with funding info: ${Object.keys(okxFundingMap).length}`);

    } catch (error) {
        console.error('Error in fetchOKXFundingInfo:', error);
    }
}

// 获取Binance资金费率信息的函数
async function fetchBinanceFundingInfo() {
    try {
        // 获取资金费率数据
        const fundingResponse = await axios.get('https://fapi.binance.com/fapi/v1/premiumIndex');
        
        // 获取资金费率间隔数据
        const fundingInfoResponse = await axios.get('https://fapi.binance.com/fapi/v1/fundingInfo');

        // 处理资金费率数据
        for (const item of fundingResponse.data) {
            const symbol = item.symbol.replace('USDT', '/USDT:USDT');
            
            // 查找对应的fundingInterval
            const fundingInfo = fundingInfoResponse.data.find(info => info.symbol === item.symbol);
            const fundingInterval = fundingInfo ? parseInt(fundingInfo.fundingIntervalHours) : 8;

            binanceFundingMap[symbol] = {
                fundingRate: parseFloat(item.lastFundingRate),
                fundingTime: item.nextFundingTime,
                fundingInterval: fundingInterval
            };
        }

        console.log(`Updated Binance funding rates at ${new Date().toISOString()}`);
        console.log(`Total Binance symbols with funding info: ${Object.keys(binanceFundingMap).length}`);

    } catch (error) {
        console.error('Error fetching Binance funding rates:', error);
    }
}

// 筛选规则函数
function filterOpportunity(opportunity, okxTickers, bybitTickers, binanceTickers, bitgetTickers) {
    // 只对 Bitget 进行筛选
    if (opportunity.exchanges.includes('BITGET')) {
        // 获取 Bitget 的交易量
        const bitgetVolume = bitgetTickers[opportunity.symbol]?.volume || 0;
        
        // 获取 Bitget 的资金费率（根据是 A 还是 B 交易所选择正确的字段）
        const bitgetFundingRate = opportunity.exchanges[0] === 'BITGET' ? 
            Math.abs(opportunity['A-FUNDINGRATE']) : 
            Math.abs(opportunity['B-FUNDINGRATE']);
          
        // 交易量必须大于等于 100 万且资金费率绝对值大于等于 0.2%
        if (bitgetVolume < 1000000 || bitgetFundingRate < 0.001 ) {
            return false;
        }
    }

    return true;
}

async function main() {
    // 创建交易所实例
    const bitget = new ccxt.bitget();
    const okx = new ccxt.okx();
    const bybit = new ccxt.bybit();
    const binance = new ccxt.binance();

    try {
        // 先加载 Bitget 的市场数据和 ticker
        await bitget.loadMarkets();
        
        // 直接使用网络请求获取Bitget数据，包含资金费率
        const bitgetResponse = await axios.get('https://api.bitget.com/api/v2/mix/market/tickers', {
            params: {
                productType: 'USDT-FUTURES'
            }
        });
        
        // 处理 Bitget 数据
        const bitgetTickers = {};
        
        if (bitgetResponse.data.code === '00000' && bitgetResponse.data.data) {
            for (const item of bitgetResponse.data.data) {
                const baseSymbol = item.symbol.replace('USDT', '');
                const symbol = `${baseSymbol}/USDT:USDT`;
                
                // 直接添加到 bitgetTickers，不进行筛选
                bitgetTickers[symbol] = {
                    symbol: symbol,
                    last: parseFloat(item.lastPr),
                    bid: parseFloat(item.bidPr),
                    ask: parseFloat(item.askPr),
                    high: parseFloat(item.high24h),
                    low: parseFloat(item.low24h),
                    volume: parseFloat(item.usdtVolume),
                    timestamp: parseInt(item.ts)
                };
                
                // 更新全局的 bitgetFundingMap，只设置资金费率
                if (!bitgetFundingMap[symbol]) {
                    bitgetFundingMap[symbol] = {
                        fundingRate: parseFloat(item.fundingRate),
                        fundingTime: 0,
                        fundingInterval: 0
                    };
                } else {
                    // 只更新资金费率，保留其他字段的现有值
                    bitgetFundingMap[symbol].fundingRate = parseFloat(item.fundingRate);
                }
            }
        }

        // 加载其他交易所的市场数据
        await Promise.all([okx.loadMarkets(), bybit.loadMarkets(), binance.loadMarkets()]);

        // 获取其他交易所的ticker数据
        const [okxTickers, bybitTickers, binanceTickers] = await Promise.all([
            okx.fetchTickers(undefined, { 'type': 'swap' }),
            bybit.fetchTickers(undefined, { 'category': 'linear' }),
            binance.fetchTickers(undefined, { 'type': 'future' })
        ]);

        // 过滤掉超过12小时未更新的币种
        const currentTime = Date.now();
        const twelveHoursInMs = 12 * 60 * 60 * 1000;
        const filteredBinanceTickers = {};

        for (const [symbol, ticker] of Object.entries(binanceTickers)) {
            if (ticker.timestamp && (currentTime - ticker.timestamp) <= twelveHoursInMs) {
                filteredBinanceTickers[symbol] = ticker;
                filteredBinanceTickers[symbol].ask = ticker.last;
                filteredBinanceTickers[symbol].bid = ticker.last;
            }
        }

        // 清空之前的映射
        symbolMap = {};

        // 添加所有通过筛选的 Bitget 交易对
        for (const symbol in bitgetTickers) {
            symbolMap[symbol] = {
                okx: false,
                bitget: true,
                bybit: false,
                binance: false,
                tickers: {
                    bitget: bitgetTickers[symbol]
                }
            };
        }

        // 只为已有的 Bitget 交易对添加其他交易所的支持情况
        for (const symbol in symbolMap) {
            // 添加 OKX 支持
            if (okxTickers[symbol]) {
                symbolMap[symbol].okx = true;
                symbolMap[symbol].tickers.okx = okxTickers[symbol];
            }

            // 添加 Bybit 支持
            if (bybitTickers[symbol]) {
                symbolMap[symbol].bybit = true;
                symbolMap[symbol].tickers.bybit = bybitTickers[symbol];
            }

            // 添加 Binance 支持
            if (filteredBinanceTickers[symbol]) {
                symbolMap[symbol].binance = true;
                symbolMap[symbol].tickers.binance = filteredBinanceTickers[symbol];
            }
        }

        // 存储所有机会
        const opportunities = [];

        // 检查价差的函数
        function checkSpread(symbol, exchangeATicker, exchangeBTicker, exchangeAPair, exchangeBPair) {
            // 确保价格有效
            if (!exchangeATicker.last || !exchangeBTicker.last) return;

            // LASB = Long A Short B = A-ASK/B-BID
            const LASB = exchangeATicker.ask / exchangeBTicker.bid;
            // SALB = Short A Long B = A-BID/B-ASK
            const SALB = exchangeATicker.bid / exchangeBTicker.ask;

            // 获取资金费率
            let fundingRateA = 0;
            let fundingRateB = 0;

            if (exchangeAPair === 'BITGET' && bitgetFundingMap[symbol]) {
                fundingRateA = bitgetFundingMap[symbol].fundingRate;
            } else if (exchangeAPair === 'BYBIT' && bybitFundingMap[symbol]) {
                fundingRateA = bybitFundingMap[symbol].fundingRate || 0;
            } else if (exchangeAPair === 'OKX' && okxFundingMap[symbol]) {
                fundingRateA = okxFundingMap[symbol].fundingRate || 0;
            } else if (exchangeAPair === 'BINANCE' && binanceFundingMap[symbol]) {
                fundingRateA = binanceFundingMap[symbol].fundingRate || 0;
            }

            if (exchangeBPair === 'BITGET' && bitgetFundingMap[symbol]) {
                fundingRateB = bitgetFundingMap[symbol].fundingRate;
            } else if (exchangeBPair === 'BYBIT' && bybitFundingMap[symbol]) {
                fundingRateB = bybitFundingMap[symbol].fundingRate || 0;
            } else if (exchangeBPair === 'OKX' && okxFundingMap[symbol]) {
                fundingRateB = okxFundingMap[symbol].fundingRate || 0;
            } else if (exchangeBPair === 'BINANCE' && binanceFundingMap[symbol]) {
                fundingRateB = binanceFundingMap[symbol].fundingRate || 0;
            }

            // 方向判断修正
            let opportunityType = null;
            let opportunityValue = null;
            if (exchangeATicker.ask < exchangeBTicker.bid) {
                opportunityType = "LASB";
                opportunityValue = Math.abs(1 - LASB);
            } else if (exchangeATicker.bid > exchangeBTicker.ask) {
                opportunityType = "SALB";
                opportunityValue = Math.abs(1 - SALB);
            } else {
                // 没有套利空间
                return;
            }

            const opportunity = {
                symbol: symbol,
                exchanges: [exchangeAPair, exchangeBPair],
                'A-FUNDINGRATE': fundingRateA,
                'B-FUNDINGRATE': fundingRateB,
                LASB: LASB,
                SALB: SALB
            };

            // 使用筛选函数
            if (filterOpportunity(opportunity, okxTickers, bybitTickers, binanceTickers, bitgetTickers)) {
                const opportunityObj = {
                    "pair": "A-B",
                    "exchangeA": exchangeAPair,
                    "exchangeB": exchangeBPair,
                    "symbol": symbol,
                    "A-ASK": exchangeATicker.ask,
                    "A-BID": exchangeATicker.bid,
                    "A-LAST": exchangeATicker.last,
                    "B-ASK": exchangeBTicker.ask,
                    "B-BID": exchangeBTicker.bid,
                    "B-LAST": exchangeBTicker.last,
                    "LASB": LASB,
                    "SALB": SALB,
                    "timestamp": new Date().toISOString(),
                    "opportunity": opportunityType,
                    "opportunityValue": opportunityValue,
                    // 默认添加所有FUNDING字段
                    "A-FUNDINGRATE": fundingRateA,
                    "A-FUNDINGTIME": undefined,
                    "A-FUNDINGPERIOD": undefined,
                    "B-FUNDINGRATE": fundingRateB,
                    "B-FUNDINGTIME": undefined,
                    "B-FUNDINGPERIOD": undefined
                };

                // 添加各交易所资金费率信息
                if (exchangeAPair === 'BYBIT' && bybitFundingMap[symbol]) {
                    opportunityObj["A-FUNDINGRATE"] = bybitFundingMap[symbol].fundingRate;
                    opportunityObj["A-FUNDINGTIME"] = bybitFundingMap[symbol].fundingTime;
                    opportunityObj["A-FUNDINGPERIOD"] = bybitFundingMap[symbol].fundingInterval;
                }
                if (exchangeBPair === 'BYBIT' && bybitFundingMap[symbol]) {
                    opportunityObj["B-FUNDINGRATE"] = bybitFundingMap[symbol].fundingRate;
                    opportunityObj["B-FUNDINGTIME"] = bybitFundingMap[symbol].fundingTime;
                    opportunityObj["B-FUNDINGPERIOD"] = bybitFundingMap[symbol].fundingInterval;
                }

                if (exchangeAPair === 'BITGET' && bitgetFundingMap[symbol]) {
                    opportunityObj["A-FUNDINGRATE"] = bitgetFundingMap[symbol].fundingRate;
                    opportunityObj["A-FUNDINGTIME"] = bitgetFundingMap[symbol].fundingTime;
                    opportunityObj["A-FUNDINGPERIOD"] = bitgetFundingMap[symbol].fundingInterval;
                }
                if (exchangeBPair === 'BITGET' && bitgetFundingMap[symbol]) {
                    opportunityObj["B-FUNDINGRATE"] = bitgetFundingMap[symbol].fundingRate;
                    opportunityObj["B-FUNDINGTIME"] = bitgetFundingMap[symbol].fundingTime;
                    opportunityObj["B-FUNDINGPERIOD"] = bitgetFundingMap[symbol].fundingInterval;
                }

                if (exchangeAPair === 'OKX' && okxFundingMap[symbol]) {
                    opportunityObj["A-FUNDINGRATE"] = okxFundingMap[symbol].fundingRate;
                    opportunityObj["A-FUNDINGTIME"] = okxFundingMap[symbol].fundingTime;
                    opportunityObj["A-FUNDINGPERIOD"] = okxFundingMap[symbol].fundingInterval;
                }
                if (exchangeBPair === 'OKX' && okxFundingMap[symbol]) {
                    opportunityObj["B-FUNDINGRATE"] = okxFundingMap[symbol].fundingRate;
                    opportunityObj["B-FUNDINGTIME"] = okxFundingMap[symbol].fundingTime;
                    opportunityObj["B-FUNDINGPERIOD"] = okxFundingMap[symbol].fundingInterval;
                }

                if (exchangeAPair === 'BINANCE' && binanceFundingMap[symbol]) {
                    opportunityObj["A-FUNDINGRATE"] = binanceFundingMap[symbol].fundingRate;
                    opportunityObj["A-FUNDINGTIME"] = binanceFundingMap[symbol].fundingTime;
                    opportunityObj["A-FUNDINGPERIOD"] = binanceFundingMap[symbol].fundingInterval;
                }
                if (exchangeBPair === 'BINANCE' && binanceFundingMap[symbol]) {
                    opportunityObj["B-FUNDINGRATE"] = binanceFundingMap[symbol].fundingRate;
                    opportunityObj["B-FUNDINGTIME"] = binanceFundingMap[symbol].fundingTime;
                    opportunityObj["B-FUNDINGPERIOD"] = binanceFundingMap[symbol].fundingInterval;
                }

                opportunities.push(opportunityObj);
            }
        }

        // 遍历所有交易对，检查支持的交易所组合
        for (const symbol in symbolMap) {
            const support = symbolMap[symbol];
            const tickers = support.tickers;

            // Binance vs others
            if (support.binance) {
                if (support.okx) {
                    checkSpread(symbol, tickers.binance, tickers.okx, "BINANCE", "OKX");
                }
                if (support.bitget) {
                    checkSpread(symbol, tickers.binance, tickers.bitget, "BINANCE", "BITGET");
                }
                if (support.bybit) {
                    checkSpread(symbol, tickers.binance, tickers.bybit, "BINANCE", "BYBIT");
                }
            }

            // OKX vs others
            if (support.okx) {
                if (support.bitget) {
                    checkSpread(symbol, tickers.okx, tickers.bitget, "OKX", "BITGET");
                }
                if (support.bybit) {
                    checkSpread(symbol, tickers.okx, tickers.bybit, "OKX", "BYBIT");
                }
            }

            // BYBIT vs BITGET
            if (support.bybit && support.bitget) {
                checkSpread(symbol, tickers.bybit, tickers.bitget, "BYBIT", "BITGET");
            }
        }

        // 按照价差绝对值倒序排序
        opportunities.sort((a, b) => b.opportunityValue - a.opportunityValue);
        
        // 更新最新的交易机会和更新时间
        latestOpportunities = opportunities;
        lastUpdateTime = new Date().toISOString();

        // 输出到控制台
        if (opportunities.length > 0) {
            console.log("\nFound opportunities (sorted by spread):");

            console.log(`\nTotal opportunities found: ${opportunities.length}`);
            console.log(`Active Binance pairs: ${Object.keys(filteredBinanceTickers).length}`);
            console.log(`Bitget pairs with high funding rate: ${Object.keys(bitgetTickers).length}`);
        } else {
            console.log("\nNo opportunities found.");
        }

        console.log("\nCheck completed at:", lastUpdateTime);
        console.log("----------------------------------------");

    } catch (error) {
        console.error("Error:", error);
    }
}

// API路由

// 获取所有交易机会
app.get('/api/opportunities', (req, res) => {
    res.json({
        "success": true,
        "data": {
            "opportunities": latestOpportunities,
            "lastUpdate": lastUpdateTime,
            "count": latestOpportunities.length,
        }
    });
});

// 获取特定交易对的机会
app.get('/api/opportunities/:symbol', (req, res) => {
    const symbol = req.params.symbol.toUpperCase();
    const filteredOpportunities = latestOpportunities.filter(opp => opp.symbol === symbol);
    
    res.json({
        "success": true,
        "data": {
            "opportunities": filteredOpportunities,
            "lastUpdate": lastUpdateTime,
            "count": filteredOpportunities.length
        }
    });
});

// 获取特定交易所对的机会
app.get('/api/opportunities/pair/:pair', (req, res) => {
    const pair = req.params.pair.toUpperCase();
    const filteredOpportunities = latestOpportunities.filter(opp => opp.pair === pair);
    
    res.json({
        "success": true,
        "data": {
            "opportunities": filteredOpportunities,
            "lastUpdate": lastUpdateTime,
            "count": filteredOpportunities.length
        }
    });
});

// 获取状态信息
app.get('/api/status', (req, res) => {
    res.json({
        "success": true,
        "data": {
            "lastUpdate": lastUpdateTime,
            "totalOpportunities": latestOpportunities.length,
            "isRunning": true,
            // "bybitFundingMap": bybitFundingMap,
            "bitgetFundingMap": bitgetFundingMap,
            // "okxFundingMap": okxFundingMap,
            // "binanceFundingMap": binanceFundingMap
        }
    });
});

// K线数据接口
app.get('/api/kline', async (req, res) => {
    try {
        const { 
            exchange = 'binance',
            symbol = 'BTC/USDT', 
            timeframe = '1m', 
            limit = 1000 
        } = req.query;
        
        // 创建交易所实例
        const exchangeInstance = createExchange(exchange);
        
        // 获取K线数据
        const ohlcv = await exchangeInstance.fetchOHLCV(symbol, timeframe, undefined, 2000);
        
        // 格式化数据
        const klineData = ohlcv.map(item => ({
            timestamp: item[0],
            open: item[1],
            high: item[2],
            low: item[3],
            close: item[4],
            volume: item[5]
        }));

        res.json({
            success: true,
            data: klineData
        });
    } catch (error) {
        console.error('Error fetching kline data:', error);
        res.status(500).json({
            success: false,
            error: error.message
        });
    }
});
// 标准交易所ID列表（不包含别名）
const standardExchangeIds = [
    'binance',
    'okx',
    'bitget',
    'gateio',
    'bybit',
    'huobi',
    'kucoin',
    'mexc',
    'phemex'
];
// 支持的交易所列表和ID映射
const supportedExchanges = {
    // 标准ID映射
    'binance': ccxt.binance,
    'okx': ccxt.okx,
    'bitget': ccxt.bitget,
    'gateio': ccxt.gateio,
    'bybit': ccxt.bybit,
    // 别名映射
    'binanceus': ccxt.binanceus,
    'binanceusdm': ccxt.binanceusdm,
    'binancecoinm': ccxt.binancecoinm,
    'okex': ccxt.okx, // OKX的旧名称
    'gate': ccxt.gateio, // Gate.io的别名
    'huobi': ccxt.huobi,
    'kucoin': ccxt.kucoin,
    'mexc': ccxt.mexc,
    'phemex': ccxt.phemex
};

const createExchange = (exchangeId) => {
    const normalizedId = exchangeId.toLowerCase();
    if (!supportedExchanges[normalizedId]) {
        throw new Error(`Unsupported exchange: ${exchangeId}. Supported exchanges: ${standardExchangeIds.join(', ')}`);
    }
    return new supportedExchanges[normalizedId]({
        'options':{'defaultType':'swap','enableRateLimit': true,
    },
    });
};



// 启动Express服务器
app.listen(port, () => {
    console.log(`API server is running on http://localhost:${port}`);
});

// 每5秒运行一次主函数
setInterval(main, 5000);

// 每1分钟更新一次所有交易所的资金费率信息
setInterval(fetchBybitFundingInfo, 60000);
setInterval(fetchBitgetFundingInfo, 60000);
setInterval(fetchOKXFundingInfo, 60000);
setInterval(fetchBinanceFundingInfo, 60000);

// 立即运行
main().then(() => {
    // main 执行完成后立即获取 Bitget 和 OKX 的资金费率信息
    fetchBitgetFundingInfo();
    fetchOKXFundingInfo();
});

// 立即获取其他交易所的资金费率信息
fetchBybitFundingInfo();
fetchBinanceFundingInfo();
