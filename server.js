const express = require('express');
const cors = require('cors');
const { Pool } = require('pg');
const cron = require('node-cron');
const axios = require('axios');
const helmet = require('helmet');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 5000;

// Middleware
app.use(helmet());
app.use(cors());
app.use(express.json());

// Database connection
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: {
    rejectUnauthorized: false
  }
});

// Forex pairs to monitor
const FOREX_PAIRS = [
  'EUR/USD', 'GBP/USD', 'USD/JPY', 'USD/CHF', 
  'AUD/USD', 'USD/CAD', 'NZD/USD', 'EUR/GBP',
  'EUR/JPY', 'GBP/JPY'
];

// Initialize database table
const initDB = async () => {
  try {
    const client = await pool.connect();
    await client.query(`
      CREATE TABLE IF NOT EXISTS signals (
        id SERIAL PRIMARY KEY,
        pair VARCHAR(10) NOT NULL,
        signal VARCHAR(10) NOT NULL,
        confidence DECIMAL(5,2) NOT NULL,
        price DECIMAL(10,5) NOT NULL,
        rsi DECIMAL(5,2),
        created_at TIMESTAMP DEFAULT NOW()
      );
      
      CREATE INDEX IF NOT EXISTS idx_pair_created_at ON signals(pair, created_at);
    `);
    client.release();
    console.log('Database initialized successfully');
  } catch (err) {
    console.error('Database initialization error:', err);
  }
};

// Technical Analysis Functions
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

  static generateSignal(currentPrice, historicalPrices) {
    if (historicalPrices.length < 15) {
      return { signal: 'HOLD', confidence: 50 };
    }

    const rsi = this.calculateRSI(historicalPrices);
    const sma20 = this.calculateSMA(historicalPrices, 20);
    const sma50 = this.calculateSMA(historicalPrices, 50);
    
    let signal = 'HOLD';
    let confidence = 50;
    
    // RSI-based signals
    if (rsi < 30) {
      signal = 'BUY';
      confidence = 85 - (rsi / 30) * 35;
    } else if (rsi > 70) {
      signal = 'SELL';
      confidence = 85 - ((100 - rsi) / 30) * 35;
    }
    
    // Moving average crossover
    if (sma20 > sma50 && currentPrice > sma20) {
      if (signal === 'BUY') confidence += 10;
      else signal = 'BUY';
    } else if (sma20 < sma50 && currentPrice < sma20) {
      if (signal === 'SELL') confidence += 10;
      else signal = 'SELL';
    }
    
    // Confidence clamping
    confidence = Math.max(30, Math.min(95, confidence));
    
    return { signal, confidence: Math.round(confidence), rsi: Math.round(rsi * 100) / 100 };
  }
}

// Fetch Forex data from Finnhub
const fetchForexData = async (pair) => {
  try {
    // Convert pair format (EUR/USD -> OANDA:EUR_USD)
    const finnhubSymbol = `OANDA:${pair.replace('/', '_')}`;
    
    const response = await axios.get(`https://finnhub.io/api/v1/quote`, {
      params: {
        symbol: finnhubSymbol,
        token: process.env.FINNHUB_API_KEY
      }
    });
    
    return response.data;
  } catch (error) {
    console.error(`Error fetching data for ${pair}:`, error.message);
    return null;
  }
}

// Generate signals for all pairs
const generateSignals = async () => {
  console.log('Generating forex signals...');
  
  for (const pair of FOREX_PAIRS) {
    try {
      const data = await fetchForexData(pair);
      
      if (data && data.c) {
        const currentPrice = data.c;
        
        // Get recent prices for this pair for technical analysis
        const recentSignals = await pool.query(
          'SELECT price FROM signals WHERE pair = $1 ORDER BY created_at DESC LIMIT 50',
          [pair]
        );
        
        const historicalPrices = recentSignals.rows.map(row => parseFloat(row.price));
        historicalPrices.push(currentPrice);
        
        const { signal, confidence, rsi } = TechnicalAnalysis.generateSignal(currentPrice, historicalPrices);
        
        // Store the new signal
        await pool.query(
          'INSERT INTO signals (pair, signal, confidence, price, rsi) VALUES ($1, $2, $3, $4, $5)',
          [pair, signal, confidence, currentPrice, rsi]
        );
        
        console.log(`Generated ${signal} signal for ${pair} with ${confidence}% confidence`);
      }
    } catch (error) {
      console.error(`Error generating signal for ${pair}:`, error);
    }
  }
}

// API Routes
app.get('/api/health', (req, res) => {
  res.json({ status: 'OK', message: 'Forex Signal API is running' });
});

// Get latest signals
app.get('/api/signals', async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT DISTINCT ON (pair) 
        pair, signal, confidence, price, rsi, created_at
      FROM signals 
      ORDER BY pair, created_at DESC
    `);
    
    res.json(result.rows);
  } catch (error) {
    console.error('Error fetching signals:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Get signal history
app.get('/api/signals/history', async (req, res) => {
  try {
    const { pair, hours = 24 } = req.query;
    
    let query = `
      SELECT pair, signal, confidence, price, rsi, created_at
      FROM signals 
      WHERE created_at >= NOW() - INTERVAL '${hours} hours'
    `;
    let params = [];
    
    if (pair) {
      query += ' AND pair = $1';
      params.push(pair);
    }
    
    query += ' ORDER BY created_at DESC';
    
    const result = await pool.query(query, params);
    res.json(result.rows);
  } catch (error) {
    console.error('Error fetching signal history:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Manual signal generation trigger
app.post('/api/generate', async (req, res) => {
  try {
    await generateSignals();
    res.json({ message: 'Signals generated successfully' });
  } catch (error) {
    console.error('Error in manual generation:', error);
    res.status(500).json({ error: 'Failed to generate signals' });
  }
});

// Start server and initialize
const startServer = async () => {
  await initDB();
  
  // Generate initial signals
  await generateSignals();
  
  // Schedule signal generation every 5 minutes
  cron.schedule('*/5 * * * *', generateSignals);
  
  app.listen(PORT, () => {
    console.log(`🚀 Forex Signal API running on port ${PORT}`);
    console.log(`📊 Monitoring ${FOREX_PAIRS.length} currency pairs`);
  });
};

startServer();
