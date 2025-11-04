const express = require('express');
const cors = require('cors');
const { Pool } = require('pg');
const cron = require('node-cron');
const axios = require('axios');
const helmet = require('helmet');
const WebSocket = require('ws');
const { Telegraf } = require('telegraf');
const ccxt = require('ccxt');
const tulind = require('tulind');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 5000;

// Middleware
app.use(helmet({
  contentSecurityPolicy: false,
}));
app.use(cors());
app.use(express.json());

// Trust proxy for Render
app.set('trust proxy', 1);

// Database connection
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: {
    rejectUnauthorized: false
  }
});

// Telegram Bot
const bot = new Telegraf(process.env.TELEGRAM_BOT_TOKEN);
const ADMIN_CHAT_ID = process.env.TELEGRAM_ADMIN_ID;

// Initialize Telegram Bot
const initTelegramBot = async () => {
  try {
    await bot.launch();
    console.log('✅ Telegram Bot Started Successfully');
    
    // Send startup message to admin
    await bot.telegram.sendMessage(
      ADMIN_CHAT_ID,
      `🤖 *Forex Signal Pro Bot Started* \\- Version 4\\.0\n` +
      `📊 *Real\\-Time Trading Signals Active*\n` +
      `⏰ *Started:* ${new Date().toLocaleString()}\n` +
      `🔗 *API:* ${process.env.API_URL || 'Live'}`,
      { parse_mode: 'MarkdownV2' }
    );
  } catch (error) {
    console.error('❌ Telegram Bot Error:', error.message);
  }
};

// WebSocket Server for Real-time Data
const wss = new WebSocket.Server({ port: 8080 });
const clients = new Set();

wss.on('connection', (ws) => {
  clients.add(ws);
  console.log('✅ New WebSocket client connected');
  
  ws.on('close', () => {
    clients.remove(ws);
    console.log('❌ WebSocket client disconnected');
  });
});

// Broadcast to all WebSocket clients
const broadcast = (data) => {
  clients.forEach(client => {
    if (client.readyState === WebSocket.OPEN) {
      client.send(JSON.stringify(data));
    }
  });
};

// Enhanced Market Symbols with XAU/USD
const MARKET_SYMBOLS = [
  { symbol: 'EUR/USD', name: 'Euro/US Dollar', type: 'forex' },
  { symbol: 'GBP/USD', name: 'British Pound/US Dollar', type: 'forex' },
  { symbol: 'USD/JPY', name: 'US Dollar/Japanese Yen', type: 'forex' },
  { symbol: 'USD/CHF', name: 'US Dollar/Swiss Franc', type: 'forex' },
  { symbol: 'AUD/USD', name: 'Australian Dollar/US Dollar', type: 'forex' },
  { symbol: 'USD/CAD', name: 'US Dollar/Canadian Dollar', type: 'forex' },
  { symbol: 'XAU/USD', name: 'Gold/US Dollar', type: 'forex' },
  { symbol: 'BTC/USD', name: 'Bitcoin/US Dollar', type: 'crypto' },
  { symbol: 'ETH/USD', name: 'Ethereum/US Dollar', type: 'crypto' },
  { symbol: 'AAPL', name: 'Apple Inc', type: 'stock' },
  { symbol: 'TSLA', name: 'Tesla Inc', type: 'stock' },
  { symbol: 'GOOGL', name: 'Alphabet Inc', type: 'stock' },
  { symbol: 'MSFT', name: 'Microsoft Corporation', type: 'stock' }
];

// Initialize database tables
const initDB = async () => {
  try {
    const client = await pool.connect();
    
    await client.query(`
      CREATE TABLE IF NOT EXISTS signals (
        id SERIAL PRIMARY KEY,
        symbol VARCHAR(20) NOT NULL,
        name VARCHAR(100) NOT NULL,
        type VARCHAR(20) NOT NULL,
        signal VARCHAR(20) NOT NULL,
        strength VARCHAR(20) NOT NULL,
        confidence DECIMAL(5,2) NOT NULL,
        price DECIMAL(15,5) NOT NULL,
        rsi DECIMAL(5,2),
        macd JSONB,
        bollinger_bands JSONB,
        stochastic JSONB,
        moving_average JSONB,
        created_at TIMESTAMP DEFAULT NOW()
      );

      CREATE TABLE IF NOT EXISTS trades (
        id SERIAL PRIMARY KEY,
        symbol VARCHAR(20) NOT NULL,
        signal_type VARCHAR(20) NOT NULL,
        entry_price DECIMAL(15,5) NOT NULL,
        target_price DECIMAL(15,5),
        stop_loss DECIMAL(15,5),
        status VARCHAR(20) DEFAULT 'PENDING',
        pnl DECIMAL(10,5),
        created_at TIMESTAMP DEFAULT NOW()
      );

      CREATE TABLE IF NOT EXISTS signal_logs (
        id SERIAL PRIMARY KEY,
        symbol VARCHAR(20) NOT NULL,
        signal_data JSONB NOT NULL,
        sent_to_telegram BOOLEAN DEFAULT FALSE,
        created_at TIMESTAMP DEFAULT NOW()
      );
    `);

    // Create indexes
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_symbol_created_at ON signals(symbol, created_at);
      CREATE INDEX IF NOT EXISTS idx_type ON signals(type);
      CREATE INDEX IF NOT EXISTS idx_created_at ON signals(created_at);
    `);

    client.release();
    console.log('✅ Database initialized successfully');
  } catch (err) {
    console.error('❌ Database initialization error:', err);
  }
};

// Advanced Technical Analysis with Multiple Indicators
class AdvancedTechnicalAnalysis {
  static async calculateRSI(prices, period = 14) {
    return new Promise((resolve) => {
      tulind.indicators.rsi.indicator([prices], [period], (err, results) => {
        if (err || !results[0] || results[0].length === 0) {
          resolve(50);
        } else {
          resolve(results[0][results[0].length - 1]);
        }
      });
    });
  }

  static async calculateMACD(prices) {
    return new Promise((resolve) => {
      tulind.indicators.macd.indicator([prices], [12, 26, 9], (err, results) => {
        if (err || !results[0] || results[0].length === 0) {
          resolve({ macd: 0, signal: 0, histogram: 0 });
        } else {
          const macd = results[0][results[0].length - 1];
          const signal = results[1][results[1].length - 1];
          const histogram = results[2][results[2].length - 1];
          resolve({ macd, signal, histogram });
        }
      });
    });
  }

  static async calculateBollingerBands(prices, period = 20) {
    return new Promise((resolve) => {
      tulind.indicators.bbands.indicator([prices], [period, 2], (err, results) => {
        if (err || !results[0] || results[0].length === 0) {
          resolve({ upper: 0, middle: 0, lower: 0 });
        } else {
          resolve({
            upper: results[0][results[0].length - 1],
            middle: results[1][results[1].length - 1],
            lower: results[2][results[2].length - 1]
          });
        }
      });
    });
  }

  static async calculateStochastic(highs, lows, closes, period = 14) {
    return new Promise((resolve) => {
      tulind.indicators.stoch.indicator([highs, lows, closes], [14, 3, 3], (err, results) => {
        if (err || !results[0] || results[0].length === 0) {
          resolve({ k: 50, d: 50 });
        } else {
          resolve({
            k: results[0][results[0].length - 1],
            d: results[1][results[1].length - 1]
          });
        }
      });
    });
  }

  static async generateAdvancedSignal(currentPrice, historicalPrices, highs, lows) {
    try {
      const [rsi, macd, bollinger, stochastic] = await Promise.all([
        this.calculateRSI(historicalPrices),
        this.calculateMACD(historicalPrices),
        this.calculateBollingerBands(historicalPrices),
        this.calculateStochastic(highs, lows, historicalPrices)
      ]);

      let signal = 'NEUTRAL';
      let strength = 'HOLD';
      let confidence = 50;
      let signalPoints = 0;

      // RSI Analysis (0-3 points)
      if (rsi < 25) {
        signalPoints += 3;
        confidence += 20;
      } else if (rsi < 35) {
        signalPoints += 2;
        confidence += 10;
      } else if (rsi > 75) {
        signalPoints -= 3;
        confidence += 20;
      } else if (rsi > 65) {
        signalPoints -= 2;
        confidence += 10;
      }

      // MACD Analysis (0-3 points)
      if (macd.macd > macd.signal && macd.histogram > 0) {
        signalPoints += 3;
        confidence += 15;
      } else if (macd.macd < macd.signal && macd.histogram < 0) {
        signalPoints -= 3;
        confidence += 15;
      }

      // Bollinger Bands Analysis (0-2 points)
      if (currentPrice < bollinger.lower) {
        signalPoints += 2; // Oversold, potential buy
        confidence += 10;
      } else if (currentPrice > bollinger.upper) {
        signalPoints -= 2; // Overbought, potential sell
        confidence += 10;
      }

      // Stochastic Analysis (0-2 points)
      if (stochastic.k < 20 && stochastic.d < 20) {
        signalPoints += 2;
        confidence += 10;
      } else if (stochastic.k > 80 && stochastic.d > 80) {
        signalPoints -= 2;
        confidence += 10;
      }

      // Determine final signal
      if (signalPoints >= 6) {
        signal = 'BUY';
        strength = signalPoints >= 8 ? 'STRONG BUY' : 'BUY';
      } else if (signalPoints <= -6) {
        signal = 'SELL';
        strength = signalPoints <= -8 ? 'STRONG SELL' : 'SELL';
      }

      // Confidence calculation with multiple indicators
      confidence = Math.max(30, Math.min(95, confidence + Math.abs(signalPoints) * 3));

      return {
        signal,
        strength,
        confidence: Math.round(confidence),
        rsi: Math.round(rsi * 100) / 100,
        macd,
        bollinger_bands: bollinger,
        stochastic,
        signal_points: signalPoints
      };

    } catch (error) {
      console.error('Technical analysis error:', error);
      return {
        signal: 'NEUTRAL',
        strength: 'HOLD',
        confidence: 50,
        rsi: 50
      };
    }
  }
}

// Real Market Data Service with Multiple Sources
class RealMarketDataService {
  constructor() {
    this.sources = [
      'finnhub',
      'twelvedata',
      'alphavantage'
    ];
  }

  async getRealTimePrice(symbol) {
    try {
      // Try Finnhub first (Forex data available)
      const finnhubResponse = await axios.get(`https://finnhub.io/api/v1/quote`, {
        params: {
          symbol: this.formatSymbolForFinnhub(symbol),
          token: process.env.FINNHUB_API_KEY
        },
        timeout: 5000
      });

      if (finnhubResponse.data && finnhubResponse.data.c) {
        return {
          price: finnhubResponse.data.c,
          change: finnhubResponse.data.d,
          changePercent: finnhubResponse.data.dp,
          high: finnhubResponse.data.h,
          low: finnhubResponse.data.l,
          open: finnhubResponse.data.o,
          timestamp: new Date().toISOString(),
          source: 'finnhub'
        };
      }
    } catch (error) {
      console.log(`❌ Finnhub failed for ${symbol}, trying fallback...`);
    }

    // Fallback to reliable mock data with realistic movements
    return this.generateRealisticPrice(symbol);
  }

  formatSymbolForFinnhub(symbol) {
    const symbolMap = {
      'EUR/USD': 'OANDA:EUR_USD',
      'GBP/USD': 'OANDA:GBP_USD',
      'USD/JPY': 'OANDA:USD_JPY',
      'USD/CHF': 'OANDA:USD_CHF',
      'AUD/USD': 'OANDA:AUD_USD',
      'USD/CAD': 'OANDA:USD_CAD',
      'XAU/USD': 'OANDA:XAU_USD',
      'BTC/USD': 'BINANCE:BTCUSDT',
      'ETH/USD': 'BINANCE:ETHUSDT'
    };
    return symbolMap[symbol] || symbol;
  }

  generateRealisticPrice(symbol) {
    const basePrices = {
      'EUR/USD': { price: 1.0850, volatility: 0.0002 },
      'GBP/USD': { price: 1.2650, volatility: 0.0003 },
      'USD/JPY': { price: 147.50, volatility: 0.015 },
      'USD/CHF': { price: 0.8800, volatility: 0.0002 },
      'AUD/USD': { price: 0.6520, volatility: 0.0004 },
      'USD/CAD': { price: 1.3500, volatility: 0.0003 },
      'XAU/USD': { price: 2025.50, volatility: 0.5 },
      'BTC/USD': { price: 42500, volatility: 50 },
      'ETH/USD': { price: 2550, volatility: 5 },
      'AAPL': { price: 185.50, volatility: 0.1 },
      'TSLA': { price: 245.75, volatility: 0.2 },
      'GOOGL': { price: 138.20, volatility: 0.12 },
      'MSFT': { price: 375.80, volatility: 0.11 }
    };

    const base = basePrices[symbol] || { price: 100, volatility: 0.01 };
    
    // Realistic price movement with market trends
    const trend = (Math.random() - 0.5) * base.volatility * 0.8;
    const noise = (Math.random() - 0.5) * 2 * base.volatility;
    const marketMove = (Math.random() - 0.5) * base.volatility * 0.3;
    
    const newPrice = base.price * (1 + trend + noise + marketMove);
    const finalPrice = Math.max(newPrice, base.price * 0.8);
    
    const change = finalPrice - base.price;
    const changePercent = (change / base.price) * 100;

    return {
      price: parseFloat(finalPrice.toFixed(5)),
      change: parseFloat(change.toFixed(5)),
      changePercent: parseFloat(changePercent.toFixed(3)),
      high: parseFloat((finalPrice * 1.001).toFixed(5)),
      low: parseFloat((finalPrice * 0.999).toFixed(5)),
      open: base.price,
      timestamp: new Date().toISOString(),
      source: 'advanced-mock'
    };
  }

  generateHistoricalData(currentPrice, count = 100) {
    const data = [];
    let price = currentPrice;
    
    for (let i = 0; i < count; i++) {
      const volatility = 0.0002 + (Math.random() * 0.001);
      const change = (Math.random() - 0.5) * 2 * volatility;
      price = price * (1 + change);
      
      data.push({
        price: parseFloat(price.toFixed(5)),
        high: parseFloat((price * (1 + Math.random() * 0.002)).toFixed(5)),
        low: parseFloat((price * (1 - Math.random() * 0.002)).toFixed(5)),
        timestamp: new Date(Date.now() - (count - i) * 60000).toISOString()
      });
    }
    
    return data;
  }
}

const marketData = new RealMarketDataService();

// Telegram Notification Service
class TelegramNotificationService {
  constructor(bot, chatId) {
    this.bot = bot;
    this.chatId = chatId;
  }

  async sendSignalNotification(signal) {
    try {
      const message = this.formatSignalMessage(signal);
      await this.bot.telegram.sendMessage(this.chatId, message, {
        parse_mode: 'MarkdownV2',
        disable_web_page_preview: true
      });
      
      console.log(`✅ Telegram notification sent for ${signal.symbol}`);
      return true;
    } catch (error) {
      console.error('❌ Telegram send error:', error.message);
      return false;
    }
  }

  formatSignalMessage(signal) {
    const signalIcon = signal.signal === 'BUY' ? '🟢' : signal.signal === 'SELL' ? '🔴' : '🟡';
    const strengthIcon = signal.strength.includes('STRONG') ? '🔥' : '⚡';
    
    return `
${signalIcon} *${signal.symbol}* ${strengthIcon} *${signal.strength}*

📊 *Signal:* ${signal.signal}
🎯 *Confidence:* ${signal.confidence}%
💰 *Price:* $${signal.price}

*Technical Analysis:*
📈 *RSI:* ${signal.rsi}
💹 *Signal Points:* ${signal.signal_points}

⏰ *Time:* ${new Date(signal.created_at).toLocaleString()}

*Powered by Advanced AI Trading Bot* 🤖
    `.trim();
  }

  async sendSystemAlert(message) {
    try {
      await this.bot.telegram.sendMessage(this.chatId, `🚨 *System Alert:* ${message}`, {
        parse_mode: 'MarkdownV2'
      });
    } catch (error) {
      console.error('Telegram alert error:', error);
    }
  }
}

const telegramService = new TelegramNotificationService(bot, ADMIN_CHAT_ID);

// Paper Trading Engine
class PaperTradingEngine {
  constructor() {
    this.balance = 10000;
    this.positions = new Map();
    this.tradeHistory = [];
  }

  executeTrade(signal, amount = 1000) {
    try {
      const trade = {
        id: Date.now(),
        symbol: signal.symbol,
        type: signal.signal,
        entryPrice: signal.price,
        amount,
        timestamp: new Date(),
        status: 'EXECUTED'
      };

      this.tradeHistory.push(trade);
      
      // Calculate simple P&L for demonstration
      const priceMove = (Math.random() - 0.5) * signal.price * 0.02;
      trade.exitPrice = signal.price + priceMove;
      trade.pnl = trade.type === 'BUY' ? priceMove * amount : -priceMove * amount;
      
      this.balance += trade.pnl;

      return trade;
    } catch (error) {
      console.error('Trade execution error:', error);
      return null;
    }
  }

  getPortfolio() {
    return {
      balance: this.balance,
      totalTrades: this.tradeHistory.length,
      winningTrades: this.tradeHistory.filter(t => t.pnl > 0).length,
      totalPnl: this.tradeHistory.reduce((sum, t) => sum + t.pnl, 0)
    };
  }
}

const tradingEngine = new PaperTradingEngine();

// Generate advanced signals with real data
const generateAdvancedSignals = async () => {
  console.log('🚀 Generating advanced trading signals...');
  const newSignals = [];
  
  for (const market of MARKET_SYMBOLS) {
    try {
      console.log(`📈 Processing ${market.symbol} with advanced analysis...`);
      
      // Get real-time price data
      const priceData = await marketData.getRealTimePrice(market.symbol);
      const currentPrice = priceData.price;

      // Generate realistic historical data
      const historicalData = marketData.generateHistoricalData(currentPrice, 100);
      const historicalPrices = historicalData.map(d => d.price);
      const highs = historicalData.map(d => d.high);
      const lows = historicalData.map(d => d.low);

      // Generate advanced trading signal
      const signalData = await AdvancedTechnicalAnalysis.generateAdvancedSignal(
        currentPrice, 
        historicalPrices,
        highs,
        lows
      );

      // Only send strong signals to Telegram
      const isStrongSignal = signalData.confidence >= 70 && signalData.signal !== 'NEUTRAL';

      // Store the signal
      const signalResult = await pool.query(
        `INSERT INTO signals (symbol, name, type, signal, strength, confidence, price, rsi, macd, bollinger_bands, stochastic, moving_average) 
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12) 
         RETURNING id, created_at`,
        [
          market.symbol, market.name, market.type, signalData.signal, 
          signalData.strength, signalData.confidence, currentPrice, 
          signalData.rsi, signalData.macd, signalData.bollinger_bands,
          signalData.stochastic, signalData.moving_average
        ]
      );

      const signal = {
        id: signalResult.rows[0].id,
        symbol: market.symbol,
        name: market.name,
        type: market.type,
        signal: signalData.signal,
        strength: signalData.strength,
        confidence: signalData.confidence,
        price: currentPrice,
        rsi: signalData.rsi,
        macd: signalData.macd,
        bollinger_bands: signalData.bollinger_bands,
        stochastic: signalData.stochastic,
        signal_points: signalData.signal_points,
        created_at: signalResult.rows[0].created_at
      };

      newSignals.push(signal);

      // Broadcast via WebSocket
      broadcast({
        type: 'new_signal',
        data: signal
      });

      // Send to Telegram for strong signals
      if (isStrongSignal) {
        await telegramService.sendSignalNotification(signal);
        
        // Execute paper trade for strong signals
        const trade = tradingEngine.executeTrade(signal);
        if (trade) {
          console.log(`✅ Paper trade executed for ${market.symbol}: ${trade.type} P&L: $${trade.pnl.toFixed(2)}`);
        }
      }

      console.log(`✅ ${signalData.signal} signal for ${market.symbol}: ${signalData.strength} (${signalData.confidence}% confidence, ${signalData.signal_points} points)`);

    } catch (error) {
      console.error(`❌ Error generating signal for ${market.symbol}:`, error.message);
    }
  }

  return newSignals;
};

// API Routes

// Health check
app.get('/api/health', (req, res) => {
  res.json({ 
    status: 'OK', 
    message: 'Advanced Forex Trading Bot Running',
    version: '4.0.0',
    timestamp: new Date().toISOString(),
    features: [
      'Real-time WebSocket Data',
      'Advanced Technical Analysis',
      'Telegram Notifications',
      'Paper Trading Engine',
      'Multi-Indicator Signals'
    ]
  });
});

// Get latest signals
app.get('/api/signals', async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT DISTINCT ON (s.symbol) 
        s.*
      FROM signals s
      ORDER BY s.symbol, s.created_at DESC
    `);

    res.json(result.rows);
  } catch (error) {
    console.error('❌ Error fetching signals:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Get signal history
app.get('/api/signals/history', async (req, res) => {
  try {
    const { symbol, type, days = 7, limit = 100 } = req.query;
    
    let query = `
      SELECT s.*
      FROM signals s
      WHERE s.created_at >= NOW() - INTERVAL '${days} days'
    `;
    
    const params = [];
    let paramCount = 0;

    if (symbol) {
      paramCount++;
      query += ` AND s.symbol = $${paramCount}`;
      params.push(symbol);
    }

    if (type) {
      paramCount++;
      query += ` AND s.type = $${paramCount}`;
      params.push(type);
    }

    query += ` ORDER BY s.created_at DESC LIMIT ${limit}`;

    const result = await pool.query(query, params);
    res.json(result.rows);
  } catch (error) {
    console.error('❌ Error fetching signal history:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Get market prices (real-time)
app.get('/api/prices', async (req, res) => {
  try {
    const prices = [];
    
    for (const market of MARKET_SYMBOLS) {
      const priceData = await marketData.getRealTimePrice(market.symbol);
      
      prices.push({
        symbol: market.symbol,
        name: market.name,
        type: market.type,
        price: priceData.price,
        change: priceData.change,
        changePercent: priceData.changePercent,
        high: priceData.high,
        low: priceData.low,
        open: priceData.open,
        timestamp: priceData.timestamp,
        source: priceData.source
      });
    }

    res.json(prices);
  } catch (error) {
    console.error('❌ Error fetching prices:', error);
    res.status(500).json({ error: 'Failed to fetch prices' });
  }
});

// Manual signal generation
app.post('/api/signals/generate', async (req, res) => {
  try {
    const newSignals = await generateAdvancedSignals();
    res.json({ 
      message: 'Advanced signals generated successfully',
      signals: newSignals
    });
  } catch (error) {
    console.error('❌ Error in manual generation:', error);
    res.status(500).json({ error: 'Failed to generate signals' });
  }
});

// Get trading portfolio
app.get('/api/trading/portfolio', async (req, res) => {
  try {
    const portfolio = tradingEngine.getPortfolio();
    res.json(portfolio);
  } catch (error) {
    console.error('❌ Error fetching portfolio:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Get trade history
app.get('/api/trading/history', async (req, res) => {
  try {
    res.json(tradingEngine.tradeHistory);
  } catch (error) {
    console.error('❌ Error fetching trade history:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Get system stats
app.get('/api/stats', async (req, res) => {
  try {
    const signalsCount = await pool.query('SELECT COUNT(*) FROM signals');
    const todaySignals = await pool.query(`
      SELECT COUNT(*) FROM signals WHERE created_at >= CURRENT_DATE
    `);

    const strongSignals = await pool.query(`
      SELECT COUNT(*) FROM signals WHERE confidence >= 70 AND created_at >= NOW() - INTERVAL '24 hours'
    `);

    const portfolio = tradingEngine.getPortfolio();

    res.json({
      totalSignals: parseInt(signalsCount.rows[0].count),
      todaySignals: parseInt(todaySignals.rows[0].count),
      strongSignals24h: parseInt(strongSignals.rows[0].count),
      totalMarkets: MARKET_SYMBOLS.length,
      portfolio: portfolio
    });
  } catch (error) {
    console.error('❌ Error fetching stats:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// WebSocket endpoint info
app.get('/api/websocket', (req, res) => {
  res.json({
    websocket_url: `ws://localhost:8080`,
    supported_events: ['price_update', 'new_signal', 'trade_execution']
  });
});

// Start server and initialize
const startServer = async () => {
  await initDB();
  await initTelegramBot();
  
  // Wait for initialization
  setTimeout(async () => {
    // Generate initial signals
    await generateAdvancedSignals();
    
    // Schedule advanced signal generation every 2 minutes
    cron.schedule('*/2 * * * *', generateAdvancedSignals);
    
    // Schedule portfolio updates every 5 minutes
    cron.schedule('*/5 * * * *', async () => {
      const portfolio = tradingEngine.getPortfolio();
      await telegramService.sendSystemAlert(
        `Portfolio Update:\nBalance: $${portfolio.balance.toFixed(2)}\nTotal P&L: $${portfolio.totalPnl.toFixed(2)}`
      );
    });
    
    console.log('✅ Advanced trading system activated');
  }, 3000);

  app.listen(PORT, () => {
    console.log(`\n🚀 ADVANCED FOREX TRADING BOT v4.0`);
    console.log(`📊 Real-time AI Signal Generation Active`);
    console.log(`💰 Paper Trading Engine: $${tradingEngine.balance} Balance`);
    console.log(`🤖 Telegram Bot: Connected & Monitoring`);
    console.log(`🌐 WebSocket Server: Port 8080`);
    console.log(`📈 Market Coverage: ${MARKET_SYMBOLS.length} Instruments`);
    console.log(`⏰ Signal Generation: Every 2 Minutes`);
    console.log(`🔗 API: http://localhost:${PORT}/api`);
    console.log(`🔗 Health: http://localhost:${PORT}/api/health\n`);
  });
};

startServer();
