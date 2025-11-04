const express = require('express');
const cors = require('cors');
const { Pool } = require('pg');
const cron = require('node-cron');
const helmet = require('helmet');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 5000;

// Middleware - FIXED rate limiting issue
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

// Market symbols to monitor
const MARKET_SYMBOLS = [
  { symbol: 'EUR/USD', name: 'Euro/US Dollar', type: 'forex' },
  { symbol: 'GBP/USD', name: 'British Pound/US Dollar', type: 'forex' },
  { symbol: 'USD/JPY', name: 'US Dollar/Japanese Yen', type: 'forex' },
  { symbol: 'USD/CHF', name: 'US Dollar/Swiss Franc', type: 'forex' },
  { symbol: 'AUD/USD', name: 'Australian Dollar/US Dollar', type: 'forex' },
  { symbol: 'USD/CAD', name: 'US Dollar/Canadian Dollar', type: 'forex' },
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
    
    // Create signals table only
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
        moving_average JSONB,
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

// Technical Analysis Class
class TechnicalAnalysis {
  static calculateRSI(prices, period = 14) {
    if (prices.length < period + 1) return 50;
    
    let gains = 0;
    let losses = 0;
    
    for (let i = 1; i <= period; i++) {
      const difference = prices[i] - prices[i - 1];
      if (difference >= 0) {
        gains += difference;
      } else {
        losses -= difference;
      }
    }
    
    const avgGain = gains / period;
    const avgLoss = losses / period;
    
    if (avgLoss === 0) return 100;
    
    const rs = avgGain / avgLoss;
    return 100 - (100 / (1 + rs));
  }

  static calculateSMA(prices, period) {
    if (prices.length < period) return prices[prices.length - 1];
    const sum = prices.slice(-period).reduce((a, b) => a + b, 0);
    return sum / period;
  }

  static calculateEMA(prices, period) {
    if (prices.length < period) return prices[prices.length - 1];
    
    let ema = prices[0];
    const multiplier = 2 / (period + 1);
    
    for (let i = 1; i < prices.length; i++) {
      ema = (prices[i] - ema) * multiplier + ema;
    }
    
    return ema;
  }

  static generateSignal(currentPrice, historicalPrices) {
    if (historicalPrices.length < 20) {
      return { 
        signal: 'NEUTRAL', 
        strength: 'HOLD',
        confidence: 50 
      };
    }

    const rsi = this.calculateRSI(historicalPrices);
    const sma20 = this.calculateSMA(historicalPrices, 20);
    const sma50 = this.calculateSMA(historicalPrices, 50);
    const ema12 = this.calculateEMA(historicalPrices, 12);
    const ema26 = this.calculateEMA(historicalPrices, 26);
    
    let signal = 'NEUTRAL';
    let strength = 'HOLD';
    let confidence = 50;
    
    // RSI-based signals
    if (rsi < 25) {
      signal = 'BUY';
      strength = 'STRONG BUY';
      confidence = 85 - (rsi / 25) * 35;
    } else if (rsi < 35) {
      signal = 'BUY';
      strength = 'BUY';
      confidence = 75 - ((rsi - 25) / 10) * 25;
    } else if (rsi > 75) {
      signal = 'SELL';
      strength = 'STRONG SELL';
      confidence = 85 - ((100 - rsi) / 25) * 35;
    } else if (rsi > 65) {
      signal = 'SELL';
      strength = 'SELL';
      confidence = 75 - ((75 - rsi) / 10) * 25;
    }
    
    // Moving average crossover
    if (sma20 > sma50 && currentPrice > sma20) {
      if (signal === 'BUY') confidence += 10;
      else {
        signal = 'BUY';
        strength = confidence > 60 ? 'BUY' : 'WEAK BUY';
      }
    } else if (sma20 < sma50 && currentPrice < sma20) {
      if (signal === 'SELL') confidence += 10;
      else {
        signal = 'SELL';
        strength = confidence > 60 ? 'SELL' : 'WEAK SELL';
      }
    }

    // EMA crossover
    if (ema12 > ema26 && signal === 'BUY') {
      confidence += 5;
    } else if (ema12 < ema26 && signal === 'SELL') {
      confidence += 5;
    }
    
    // Confidence clamping and rounding
    confidence = Math.max(20, Math.min(95, Math.round(confidence)));
    
    return { 
      signal, 
      strength,
      confidence, 
      rsi: Math.round(rsi * 100) / 100,
      moving_average: {
        sma_20: Math.round(sma20 * 100000) / 100000,
        sma_50: Math.round(sma50 * 100000) / 100000,
        ema_12: Math.round(ema12 * 100000) / 100000,
        ema_26: Math.round(ema26 * 100000) / 100000
      }
    };
  }
}

// Mock Data Service
class MockDataService {
  generatePrice(symbol) {
    const basePrices = {
      'EUR/USD': { price: 1.0850, volatility: 0.002 },
      'GBP/USD': { price: 1.2650, volatility: 0.003 },
      'USD/JPY': { price: 147.50, volatility: 0.015 },
      'USD/CHF': { price: 0.8800, volatility: 0.002 },
      'AUD/USD': { price: 0.6520, volatility: 0.004 },
      'USD/CAD': { price: 1.3500, volatility: 0.003 },
      'BTC/USD': { price: 42500, volatility: 0.02 },
      'ETH/USD': { price: 2550, volatility: 0.025 },
      'AAPL': { price: 185.50, volatility: 0.01 },
      'TSLA': { price: 245.75, volatility: 0.02 },
      'GOOGL': { price: 138.20, volatility: 0.012 },
      'MSFT': { price: 375.80, volatility: 0.011 }
    };

    const base = basePrices[symbol] || { price: 100, volatility: 0.01 };
    
    // Generate realistic price movement with trend
    const trend = (Math.random() - 0.5) * base.volatility * 0.5;
    const noise = (Math.random() - 0.5) * 2 * base.volatility;
    const newPrice = base.price * (1 + trend + noise);
    
    // Ensure price doesn't go negative
    const finalPrice = Math.max(newPrice, base.price * 0.1);
    
    return {
      price: parseFloat(finalPrice.toFixed(5)),
      timestamp: new Date().toISOString()
    };
  }

  generateHistoricalPrices(currentPrice, count = 50) {
    const prices = [currentPrice];
    
    for (let i = 1; i < count; i++) {
      const previousPrice = prices[i - 1];
      const volatility = 0.002 + (Math.random() * 0.01);
      const change = (Math.random() - 0.5) * 2 * volatility;
      const newPrice = previousPrice * (1 + change);
      prices.unshift(Math.max(newPrice, previousPrice * 0.8));
    }
    
    return prices;
  }
}

const mockData = new MockDataService();

// Generate signals for all symbols
const generateSignals = async () => {
  console.log('🔄 Generating trading signals with mock data...');
  const newSignals = [];
  
  for (const market of MARKET_SYMBOLS) {
    try {
      console.log(`📈 Processing ${market.symbol}...`);
      
      // Get current price from mock data
      const priceData = mockData.generatePrice(market.symbol);
      const currentPrice = priceData.price;

      // Generate historical data
      const historicalPrices = mockData.generateHistoricalPrices(currentPrice, 50);

      // Generate trading signal
      const signalData = TechnicalAnalysis.generateSignal(currentPrice, historicalPrices);

      // Store the signal
      const signalResult = await pool.query(
        `INSERT INTO signals (symbol, name, type, signal, strength, confidence, price, rsi, moving_average) 
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) 
         RETURNING id, created_at`,
        [market.symbol, market.name, market.type, signalData.signal, signalData.strength, 
         signalData.confidence, currentPrice, signalData.rsi, signalData.moving_average]
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
        moving_average: signalData.moving_average,
        created_at: signalResult.rows[0].created_at
      };

      newSignals.push(signal);

      console.log(`✅ ${signalData.signal} signal for ${market.symbol}: ${signalData.strength} (${signalData.confidence}% confidence)`);

    } catch (error) {
      console.error(`❌ Error generating signal for ${market.symbol}:`, error.message);
    }
  }

  return newSignals;
};

// API Routes - ALL PUBLIC

// Health check
app.get('/api/health', (req, res) => {
  res.json({ 
    status: 'OK', 
    message: 'Forex Signal API is running',
    version: '3.0.0',
    timestamp: new Date().toISOString(),
    dataSource: 'Mock Data - Realistic Algorithm'
  });
});

// Get latest signals (PUBLIC)
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

// Get signal history (PUBLIC)
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

// Get market prices (PUBLIC)
app.get('/api/prices', async (req, res) => {
  try {
    const prices = [];
    
    for (const market of MARKET_SYMBOLS) {
      const priceData = mockData.generatePrice(market.symbol);
      
      prices.push({
        symbol: market.symbol,
        name: market.name,
        type: market.type,
        price: priceData.price,
        timestamp: priceData.timestamp
      });
    }

    res.json(prices);
  } catch (error) {
    console.error('❌ Error generating prices:', error);
    res.status(500).json({ error: 'Failed to generate prices' });
  }
});

// Manual signal generation (PUBLIC - for testing)
app.post('/api/signals/generate', async (req, res) => {
  try {
    const newSignals = await generateSignals();
    res.json({ 
      message: 'Signals generated successfully',
      signals: newSignals
    });
  } catch (error) {
    console.error('❌ Error in manual generation:', error);
    res.status(500).json({ error: 'Failed to generate signals' });
  }
});

// Get stats (PUBLIC)
app.get('/api/stats', async (req, res) => {
  try {
    const signalsCount = await pool.query('SELECT COUNT(*) FROM signals');
    const todaySignals = await pool.query(`
      SELECT COUNT(*) FROM signals WHERE created_at >= CURRENT_DATE
    `);

    const popularSignals = await pool.query(`
      SELECT symbol, COUNT(*) as signal_count 
      FROM signals 
      WHERE created_at >= NOW() - INTERVAL '7 days'
      GROUP BY symbol 
      ORDER BY signal_count DESC 
      LIMIT 5
    `);

    res.json({
      totalSignals: parseInt(signalsCount.rows[0].count),
      todaySignals: parseInt(todaySignals.rows[0].count),
      popularSignals: popularSignals.rows,
      totalMarkets: MARKET_SYMBOLS.length
    });
  } catch (error) {
    console.error('❌ Error fetching stats:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Start server and initialize
const startServer = async () => {
  await initDB();
  
  // Wait a bit for database to initialize
  setTimeout(async () => {
    // Generate initial signals
    await generateSignals();
    
    // Schedule signal generation every 2 minutes
    cron.schedule('*/2 * * * *', generateSignals);
    
    console.log('✅ Auto-signal generation scheduled every 2 minutes');
  }, 3000);

  app.listen(PORT, () => {
    console.log(`\n🚀 PUBLIC Forex Signal API running on port ${PORT}`);
    console.log(`📊 Monitoring ${MARKET_SYMBOLS.length} markets (Forex, Crypto, Stocks)`);
    console.log(`💰 Data Source: 100% Mock Data - Realistic Algorithm`);
    console.log(`⏰ Auto-signal generation: Every 2 minutes`);
    console.log(`🔓 Authentication: None - Public Access`);
    console.log(`🔗 Health check: https://forex-signal-backend-hx79.onrender.com/api/health`);
    console.log(`🌐 Frontend URL: Your Vercel deployment`);
    console.log(`\n📡 Available Endpoints:`);
    console.log(`   GET  /api/health          - Health check`);
    console.log(`   GET  /api/signals         - Latest signals`);
    console.log(`   GET  /api/signals/history - Signal history`);
    console.log(`   GET  /api/prices          - Market prices`);
    console.log(`   GET  /api/stats           - System stats`);
    console.log(`   POST /api/signals/generate - Manual signal generation\n`);
  });
};

startServer();
