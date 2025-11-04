const express = require('express');
const cors = require('cors');
const { Pool } = require('pg');
const cron = require('node-cron');
const axios = require('axios');
const helmet = require('helmet');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const rateLimit = require('express-rate-limit');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 5000;

// Middleware
app.use(helmet());
app.use(cors());
app.use(express.json());

// Rate limiting
const limiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 100
});
app.use(limiter);

// Database connection
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: {
    rejectUnauthorized: false
  }
});

// JWT Secret
const JWT_SECRET = process.env.JWT_SECRET || 'forex-signal-secret-2024';

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
    
    // Check if tables exist, if not create them
    const tablesExist = await client.query(`
      SELECT EXISTS (
        SELECT FROM information_schema.tables 
        WHERE table_name = 'users'
      );
    `);
    
    if (!tablesExist.rows[0].exists) {
      console.log('🔄 Creating database tables...');
      
      await client.query(`
        CREATE TABLE users (
          id SERIAL PRIMARY KEY,
          email VARCHAR(255) UNIQUE NOT NULL,
          password VARCHAR(255) NOT NULL,
          name VARCHAR(100) NOT NULL,
          is_admin BOOLEAN DEFAULT FALSE,
          created_at TIMESTAMP DEFAULT NOW(),
          last_login TIMESTAMP
        );

        CREATE TABLE signals (
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

        CREATE TABLE user_signals (
          id SERIAL PRIMARY KEY,
          user_id INTEGER REFERENCES users(id),
          signal_id INTEGER REFERENCES signals(id),
          viewed BOOLEAN DEFAULT FALSE,
          notified BOOLEAN DEFAULT FALSE,
          created_at TIMESTAMP DEFAULT NOW()
        );
      `);

      // Create indexes
      await client.query(`
        CREATE INDEX idx_symbol_created_at ON signals(symbol, created_at);
        CREATE INDEX idx_type ON signals(type);
        CREATE INDEX idx_created_at ON signals(created_at);
      `);
    }

    // Create admin user if not exists
    const adminEmail = 'admin@forexsignal.com';
    const adminExists = await client.query('SELECT * FROM users WHERE email = $1', [adminEmail]);
    
    if (adminExists.rows.length === 0) {
      const hashedPassword = await bcrypt.hash('admin123', 10);
      await client.query(
        'INSERT INTO users (email, password, name, is_admin) VALUES ($1, $2, $3, $4)',
        [adminEmail, hashedPassword, 'System Admin', true]
      );
      console.log('✅ Admin user created');
    }

    client.release();
    console.log('✅ Database initialized successfully');
  } catch (err) {
    console.error('❌ Database initialization error:', err);
  }
};

// Authentication middleware
const authenticateToken = (req, res, next) => {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1];

  if (!token) {
    return res.status(401).json({ error: 'Access token required' });
  }

  jwt.verify(token, JWT_SECRET, (err, user) => {
    if (err) {
      return res.status(403).json({ error: 'Invalid token' });
    }
    req.user = user;
    next();
  });
};

// Admin middleware
const requireAdmin = (req, res, next) => {
  if (!req.user.isAdmin) {
    return res.status(403).json({ error: 'Admin access required' });
  }
  next();
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

// Mock Data Service - COMPLETELY REPLACES TwelveData
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
      prices.unshift(Math.max(newPrice, previousPrice * 0.8)); // Prevent prices from dropping too low
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

      // Notify all users about new signal
      const users = await pool.query('SELECT id FROM users');
      for (const user of users.rows) {
        await pool.query(
          'INSERT INTO user_signals (user_id, signal_id) VALUES ($1, $2)',
          [user.id, signal.id]
        );
      }

      console.log(`✅ ${signalData.signal} signal for ${market.symbol}: ${signalData.strength} (${signalData.confidence}% confidence)`);

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
    message: 'Forex Signal API is running',
    version: '2.0.0',
    timestamp: new Date().toISOString(),
    dataSource: 'Mock Data (TwelveData API limit exceeded)'
  });
});

// User registration - SIMPLIFIED AND FIXED
app.post('/api/users/register', async (req, res) => {
  let client;
  try {
    const { email, password, name } = req.body;

    console.log('📝 Registration attempt for:', email);

    // Basic validation
    if (!email || !password || !name) {
      return res.status(400).json({ error: 'All fields are required' });
    }

    if (password.length < 6) {
      return res.status(400).json({ error: 'Password must be at least 6 characters' });
    }

    // Get a client from the pool for transaction
    client = await pool.connect();

    // Check if user exists
    const userExists = await client.query('SELECT id FROM users WHERE email = $1', [email]);
    if (userExists.rows.length > 0) {
      return res.status(400).json({ error: 'User already exists with this email' });
    }

    // Hash password
    const hashedPassword = await bcrypt.hash(password, 10);

    // Create user
    const result = await client.query(
      'INSERT INTO users (email, password, name) VALUES ($1, $2, $3) RETURNING id, email, name, created_at, is_admin',
      [email, hashedPassword, name]
    );

    const user = result.rows[0];

    // Generate JWT token
    const token = jwt.sign(
      { 
        userId: user.id, 
        email: user.email,
        isAdmin: user.is_admin 
      },
      JWT_SECRET,
      { expiresIn: '24h' }
    );

    console.log('✅ User registered successfully:', email);

    res.status(201).json({
      message: 'User created successfully',
      user: {
        id: user.id,
        email: user.email,
        name: user.name,
        isAdmin: user.is_admin
      },
      token
    });

  } catch (error) {
    console.error('❌ Registration error:', error);
    
    // Specific error handling
    if (error.code === '23505') {
      return res.status(400).json({ error: 'User already exists with this email' });
    }
    
    res.status(500).json({ error: 'Failed to create account. Please try again.' });
  } finally {
    if (client) client.release();
  }
});

// User login
app.post('/api/users/login', async (req, res) => {
  try {
    const { email, password } = req.body;

    console.log('🔐 Login attempt for:', email);

    if (!email || !password) {
      return res.status(400).json({ error: 'Email and password are required' });
    }

    // Find user
    const result = await pool.query('SELECT * FROM users WHERE email = $1', [email]);
    if (result.rows.length === 0) {
      return res.status(400).json({ error: 'Invalid email or password' });
    }

    const user = result.rows[0];

    // Check password
    const validPassword = await bcrypt.compare(password, user.password);
    if (!validPassword) {
      return res.status(400).json({ error: 'Invalid email or password' });
    }

    // Update last login
    await pool.query('UPDATE users SET last_login = NOW() WHERE id = $1', [user.id]);

    // Generate JWT token
    const token = jwt.sign(
      { 
        userId: user.id, 
        email: user.email,
        isAdmin: user.is_admin 
      },
      JWT_SECRET,
      { expiresIn: '24h' }
    );

    console.log('✅ User logged in successfully:', email);

    res.json({
      message: 'Login successful',
      user: {
        id: user.id,
        email: user.email,
        name: user.name,
        isAdmin: user.is_admin
      },
      token
    });

  } catch (error) {
    console.error('❌ Login error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Get latest signals (protected)
app.get('/api/signals', authenticateToken, async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT DISTINCT ON (s.symbol) 
        s.*,
        us.viewed as user_viewed,
        us.notified as user_notified
      FROM signals s
      LEFT JOIN user_signals us ON s.id = us.signal_id AND us.user_id = $1
      ORDER BY s.symbol, s.created_at DESC
    `, [req.user.userId]);

    // Mark signals as viewed for this user
    for (const signal of result.rows) {
      if (!signal.user_viewed) {
        await pool.query(
          `UPDATE user_signals SET viewed = true 
           WHERE user_id = $1 AND signal_id = $2`,
          [req.user.userId, signal.id]
        );
      }
    }

    res.json(result.rows);
  } catch (error) {
    console.error('❌ Error fetching signals:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Get signal history (protected)
app.get('/api/signals/history', authenticateToken, async (req, res) => {
  try {
    const { symbol, type, days = 7, limit = 50 } = req.query;
    
    let query = `
      SELECT s.*, us.viewed
      FROM signals s
      JOIN user_signals us ON s.id = us.signal_id
      WHERE us.user_id = $1 
        AND s.created_at >= NOW() - INTERVAL '${days} days'
    `;
    
    const params = [req.user.userId];
    let paramCount = 1;

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

// Get market prices (public) - USING MOCK DATA ONLY
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

// Manual signal generation (protected - admin only)
app.post('/api/signals/generate', authenticateToken, requireAdmin, async (req, res) => {
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

// Get user profile (protected)
app.get('/api/users/profile', authenticateToken, async (req, res) => {
  try {
    const result = await pool.query(
      'SELECT id, email, name, created_at, last_login, is_admin FROM users WHERE id = $1',
      [req.user.userId]
    );
    
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'User not found' });
    }

    // Get user stats
    const statsResult = await pool.query(`
      SELECT 
        COUNT(DISTINCT us.signal_id) as total_signals,
        COUNT(DISTINCT CASE WHEN us.viewed = false THEN us.signal_id END) as unread_signals,
        MIN(s.created_at) as first_signal_date
      FROM user_signals us
      JOIN signals s ON us.signal_id = s.id
      WHERE us.user_id = $1
    `, [req.user.userId]);

    const user = result.rows[0];
    const stats = statsResult.rows[0];

    res.json({
      ...user,
      stats: {
        totalSignals: parseInt(stats.total_signals) || 0,
        unreadSignals: parseInt(stats.unread_signals) || 0,
        memberSince: user.created_at
      }
    });
  } catch (error) {
    console.error('❌ Error fetching profile:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Get admin stats (protected - admin only)
app.get('/api/admin/stats', authenticateToken, requireAdmin, async (req, res) => {
  try {
    const usersCount = await pool.query('SELECT COUNT(*) FROM users');
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
      totalUsers: parseInt(usersCount.rows[0].count),
      totalSignals: parseInt(signalsCount.rows[0].count),
      todaySignals: parseInt(todaySignals.rows[0].count),
      popularSignals: popularSignals.rows
    });
  } catch (error) {
    console.error('❌ Error fetching admin stats:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Get unread signals count (protected)
app.get('/api/signals/unread-count', authenticateToken, async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT COUNT(*) 
      FROM user_signals us
      JOIN signals s ON us.signal_id = s.id
      WHERE us.user_id = $1 AND us.viewed = false
    `, [req.user.userId]);

    res.json({ count: parseInt(result.rows[0].count) });
  } catch (error) {
    console.error('❌ Error fetching unread count:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Reset database (for development only)
app.post('/api/reset-db', async (req, res) => {
  try {
    await initDB();
    res.json({ message: 'Database reset successfully' });
  } catch (error) {
    console.error('❌ Error resetting database:', error);
    res.status(500).json({ error: 'Failed to reset database' });
  }
});

// Start server and initialize
const startServer = async () => {
  await initDB();
  
  // Wait a bit for database to initialize
  setTimeout(async () => {
    // Generate initial signals
    await generateSignals();
    
    // Schedule signal generation every 2 minutes (less frequent to avoid spam)
    cron.schedule('*/2 * * * *', generateSignals);
    
    console.log('✅ Auto-signal generation scheduled every 2 minutes');
  }, 3000);

  app.listen(PORT, () => {
    console.log(`\n🚀 FIXED Forex Signal API running on port ${PORT}`);
    console.log(`📊 Monitoring ${MARKET_SYMBOLS.length} markets (Forex, Crypto, Stocks)`);
    console.log(`💰 Data Source: 100% Mock Data (No API limits)`);
    console.log(`⏰ Auto-signal generation: Every 2 minutes`);
    console.log(`🔐 JWT Authentication: Enabled`);
    console.log(`👑 Admin access: admin@forexsignal.com / admin123`);
    console.log(`🔗 Health check: https://forex-signal-backend-hx79.onrender.com/api/health\n`);
  });
};

startServer();
